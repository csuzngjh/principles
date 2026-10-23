// PRI-1002 — PRR real A/C runner: the MINIMAL authorized execution path
// (owner-directed task, 2026-10-23).
//
// This module is OFF by default and FAIL-CLOSED by construction:
//   - the PRR freeze gate (prr-freeze.mjs validateFreezeForRealRun) must pass
//     with zero problems — an Owner-frozen record, a matching protocol
//     approval digest, a trusted running commit SHA and a verified decision
//     record are ALL mandatory;
//   - real transports are ONLY built through the existing PRI-966
//     authorization chain (lib/actor.mjs createAuthorizedPiTransport →
//     g2-real-run-authorization.v1, OD-1/OD-2/OD-3, budgeted fetch). A
//     missing/stale authorization means ZERO HTTP requests — the transport
//     never even exists (P1-02);
//   - mock transports are injected; tests never touch a real model.
//
// Nothing here reads real workspaces or sends real history without the
// frozen, Owner-approved dataset the gate has verified.

import { composeActorPrompt, deliverPayload } from '../../lib/g2.mjs';
import { adjudicatePrr } from './prr-adjudicate.mjs';
import { buildPairedReport } from './prr-paired.mjs';
import { validateFreezeForRealRun } from './prr-freeze.mjs';

export const PRR_REAL_RUNNER_SCHEMA = 'prr-real-run.v0.1';

/** The single delivery composition for both groups (same channel contract). */
export function composeGroupPrompt({ group, task, principleText }) {
  const content = group === 'A'
    ? principleText
    : `${principleText}\n\n--- 历史证据（经授权披露，长度受限） ---\n${task.historyMaterial.text}`;
  return { content, taskText: task.taskText };
}

/**
 * Map one transport failure to the B0 §8.2 failure classification.
 * The row stays in the denominator with its own reason code.
 */
export function classifyTransportFailure(error) {
  const kind = error?.kind ?? error?.code ?? '';
  if (kind === 'timeout') return { status: 'TIMEOUT', runStatus: 'FAILED' };
  if (kind === 'no_response') return { status: 'NO_RESPONSE', runStatus: 'NO_RESPONSE' };
  if (kind === 'budget_exhausted') return { status: 'INTERRUPTED', runStatus: 'STOPPED_BUDGET' };
  return { status: 'INVALID_OUTPUT', runStatus: 'FAILED' };
}

/**
 * Parse one model round payload into the adjudicator's expected behavior
 * shape. Unparseable/invalid payloads become INVALID_OUTPUT rows (rc-3):
 * they stay in the denominator, they never crash the run.
 */
export function behaviorFromRoundPayload(payload, usage) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (typeof payload !== 'object' || payload === null) {
    return { status: 'INVALID_OUTPUT', usage: usage ?? {} };
  }
  const decisionId = typeof payload.decisionId === 'string' && payload.decisionId !== '' ? payload.decisionId : null;
  const evidenceRefs = Array.isArray(payload.evidenceRefs) && payload.evidenceRefs.every((r) => typeof r === 'string') ? payload.evidenceRefs : null;
  if (decisionId === null || evidenceRefs === null) {
    return { status: 'INVALID_OUTPUT', usage: usage ?? {} };
  }
  return {
    status: 'OK',
    output: { decisionId, evidenceRefs, hedging: payload.hedging === true ? true : undefined },
    usage: {
      requests: num(usage?.requests) ?? 1,
      modelRounds: num(usage?.modelRounds) ?? 1,
      toolCalls: num(usage?.toolCalls) ?? 0,
      tokensIn: num(usage?.tokensIn),
      tokensOut: num(usage?.tokensOut),
      wallMs: num(usage?.wallMs),
      ownerAsks: 0,
      ownerCorrections: 0,
    },
  };
}

/**
 * Run the frozen A/C study. `transportFor` is called once per (group, task)
 * as `transportFor({ group, taskId })` → `{ complete }` (per-arm isolation).
 * The caller owns transport construction; the REAL factory must be the
 * PRI-966 authorized chain. The runner itself never opens a socket.
 *
 * Returns a machine-readable result; the caller persists it.
 */
export async function runPrrRealAc({
  studyId,
  freeze,
  preregBody,
  dataset,
  verifyOwnerApproval,
  runningCommitSha,
  transportFor,
}) {
  // ── Gate chain — zero problems or nothing runs ──
  const gate = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval, dataset, runningCommitSha });
  if (gate.problems.length > 0) {
    return {
      schemaVersion: PRR_REAL_RUNNER_SCHEMA,
      studyId,
      executed: false,
      refusalReasons: gate.problems,
      adjudications: [],
      pairedReport: null,
    };
  }

  const systemPrompt = [
    'You are an agent making a decision under an operating principle.',
    'Answer with a single JSON object: {"decisionId": "<id>", "evidenceRefs": ["<id>", ...]} and nothing else.',
    'Every conclusion component must reference one of the citable evidence ids available to you.',
  ].join('\n');

  const adjudications = [];
  const exclusions = [];
  const stopEvents = [];
  const maxRequestsPerTask = Number.isSafeInteger(dataset.manifest.maxRequestsPerTask) ? dataset.manifest.maxRequestsPerTask : null;
  const cBudget = dataset.manifest.cMaterialBudgetChars;

  for (const task of dataset.tasks.tasks) {
    const principle = dataset.principlesById.get(task.principleId);
    if (!principle) {
      throw new Error(`runPrrRealAc: task ${task.taskId} references unknown principle — frozen dataset inconsistency`);
    }
    for (const group of ['A', 'C']) {
      const armId = `${group}:${task.taskId}`;
      if (group === 'C' && task.historyMaterial.disclosureStatus === 'unauthorized') {
        exclusions.push({ taskId: task.taskId, group, reasonCode: 'unauthorized_history_material', note: 'excluded before exposure (B0 §8.2)' });
        continue;
      }
      const { content, taskText } = composeGroupPrompt({ group, task, principleText: principle.text });
      const delivery = deliverPayload({ armId, content, budgetChars: cBudget });
      const userPrompt = composeActorPrompt({ taskText, delivery });
      const transport = transportFor({ group, taskId: task.taskId });
      if (!transport || typeof transport.complete !== 'function') {
        throw new Error(`runPrrRealAc: transportFor returned no usable transport for ${armId} — refusing to run without one`);
      }
      let behavior;
      try {
        const round = await transport.complete({
          systemPrompt,
          userPrompt,
          outputSchemaRef: undefined,
          maxTokens: 1024,
          timeoutMs: 60_000,
          taskId: armId,
        });
        behavior = behaviorFromRoundPayload(round?.payload, round?.usage);
      } catch (error) {
        const classified = classifyTransportFailure(error);
        behavior = { status: classified.status, usage: { requests: 1 } };
      }
      const budgetExhausted = maxRequestsPerTask !== null
        && Number.isFinite(behavior.usage?.requests)
        && behavior.usage.requests > maxRequestsPerTask;
      if (budgetExhausted) {
        stopEvents.push({ type: 'AC-S4_BUDGET_STOP', group, taskId: task.taskId, requests: behavior.usage.requests, cap: maxRequestsPerTask });
      }
      adjudications.push(adjudicatePrr({
        studyId,
        group,
        taskId: task.taskId,
        taskType: task.taskType,
        goldRecord: dataset.goldByTask[task.taskId],
        behavior,
        budgetExhausted,
      }));
    }
  }

  const taskTypeById = new Map(dataset.tasks.tasks.map((t) => [t.taskId, t.taskType]));
  const pairedReport = buildPairedReport({ studyId, adjudications, exclusions, taskTypeById });

  return {
    schemaVersion: PRR_REAL_RUNNER_SCHEMA,
    studyId,
    executed: true,
    freezeGate: { status: freeze.status, protocolDigestVerified: true, runningCommitSha },
    dataset: { datasetId: dataset.manifest.datasetId, fixtureHash: dataset.fixtureHash },
    adjudications,
    exclusions,
    stopEvents,
    pairedReport,
    note: 'Full denominators retained: failures, INCONCLUSIVE and NOT_APPLICABLE rows are listed, never dropped. This file is evidence of EXECUTION, not of value — the verdict is GO/STOP/UNPROVEN per the frozen FZ-09/10 criteria, decided by the Owner.',
  };
}
