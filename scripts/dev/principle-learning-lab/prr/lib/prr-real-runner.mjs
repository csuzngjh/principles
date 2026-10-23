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
 *
 * Unknown usage fields stay null — the actual HTTP request count of a round
 * is owned by the budget-ledger telemetry, never inferred (owner review
 * round 6).
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
      requests: num(usage?.requests),
      modelRounds: num(usage?.modelRounds),
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
 * as `transportFor({ group, taskId })` → `{ complete }` — the transport
 * OBJECT ITSELF (not wrapped), with a `complete()` method. Transports must
 * be stateless per round (single-turn decisions): A/C isolation comes from
 * the isolated delivery content and the absence of shared session state,
 * which the preregistration requires.
 *
 * `studyRequestCap` — the frozen FZ-06 whole-study HTTP request ceiling.
 * `budgetTelemetry` — optional `() => { levels: [{scope, cap, used}] }`
 * (the live budget-ledger snapshot). When present it is the AUTHORITATIVE
 * request counter for the AC-S4 global stop; task-reported usage numbers are
 * never invented to fill it. When absent, only task-reported finite request
 * counts accumulate. On a global stop, execution halts immediately and every
 * remaining (group, task) is listed in `notExecutedTasks` with its own
 * reason code — retained, never dropped, never adjudicated as if run.
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
  studyRequestCap = null,
  budgetTelemetry = null,
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
      notExecutedTasks: [],
      pairedReport: null,
    };
  }

  const systemPrompt = [
    'You are an agent making a decision under an operating principle.',
    'Answer with a single JSON object: {"decisionId": "<id>", "evidenceRefs": ["<id>", ...]} and nothing else.',
    'Every conclusion component must reference one of the citable evidence ids available to you.',
  ].join('\n');

  const ledgerUsedRequests = () => {
    if (typeof budgetTelemetry !== 'function') return null;
    try {
      const snap = budgetTelemetry();
      const studyLevel = (snap?.levels ?? []).find((l) => typeof l?.scope === 'string' && l.scope.startsWith('study:'));
      return studyLevel && Number.isFinite(studyLevel.used) ? studyLevel.used : null;
    } catch {
      return null;
    }
  };

  const adjudications = [];
  const notExecutedTasks = [];
  const exclusions = [];
  const stopEvents = [];
  let executedRequests = 0; // authoritative only when a counter source says so
  let globalStop = null;

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
      // Defense-in-depth: C material may only be delivered with an explicitly
      // legal disclosure status — missing/unknown states never reach a model
      // (owner review round 6; healthCheckPrrDataset is the first gate).
      if (group === 'C' && task.historyMaterial.disclosureStatus !== 'authorized_synthetic') {
        throw new Error(`runPrrRealAc: task ${task.taskId} C material has non-authorized disclosure status '${task.historyMaterial.disclosureStatus}' — refusing to deliver`);
      }
      // AC-S4 pre-call check: the live ledger (authoritative) or accumulated
      // task-reported counts at/above the study cap stop execution BEFORE the
      // next model call — never after the budget is already blown.
      const usedBeforeCall = ledgerUsedRequests() ?? executedRequests;
      if (studyRequestCap !== null && usedBeforeCall >= studyRequestCap) {
        globalStop = { reasonCode: 'study_budget_exhausted' };
        stopEvents.push({
          type: 'AC-S4_BUDGET_STOP',
          group,
          taskId: task.taskId,
          requests: null,
          studyRequestsUsed: usedBeforeCall,
          counterBasis: ledgerUsedRequests() !== null ? 'budget_ledger' : 'task_reported',
          cap: null,
          studyCap: studyRequestCap,
          action: 'pre-call stop; remaining tasks listed as notExecuted; partial results reported as-is',
        });
        notExecutedTasks.push({ group, taskId: task.taskId, taskType: task.taskType, reasonCode: globalStop.reasonCode });
        continue;
      }
      const { content, taskText } = composeGroupPrompt({ group, task, principleText: principle.text });
      const delivery = deliverPayload({ armId, content, budgetChars: dataset.manifest.cMaterialBudgetChars });
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
        behavior = { status: classified.status, usage: {} };
      }
      // Task-reported request counts accumulate ONLY when finite; the live
      // ledger snapshot (when present) is the authoritative AC-S4 counter.
      if (Number.isFinite(behavior.usage?.requests)) executedRequests += behavior.usage.requests;
      const perTaskCap = Number.isSafeInteger(dataset.manifest.maxRequestsPerTask) ? dataset.manifest.maxRequestsPerTask : null;
      const budgetExhausted = perTaskCap !== null && Number.isFinite(behavior.usage?.requests) && behavior.usage.requests > perTaskCap;
      if (budgetExhausted) {
        stopEvents.push({
          type: 'AC-S4_BUDGET_STOP',
          group,
          taskId: task.taskId,
          requests: Number.isFinite(behavior.usage?.requests) ? behavior.usage.requests : null,
          studyRequestsUsed: ledgerUsedRequests() ?? executedRequests,
          counterBasis: ledgerUsedRequests() !== null ? 'budget_ledger' : 'task_reported',
          cap: perTaskCap,
          studyCap: studyRequestCap,
          action: 'row graded budget_exhausted; partial results reported as-is',
        });
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
  // A study fully stopped before its first model call has zero adjudication
  // rows — the paired view needs at least one row, so it is simply absent and
  // the explicit denominators/notExecuted lists carry the whole truth.
  const pairedReport = adjudications.length > 0
    ? buildPairedReport({ studyId, adjudications, exclusions, taskTypeById })
    : null;

  return {
    schemaVersion: PRR_REAL_RUNNER_SCHEMA,
    studyId,
    executed: true,
    freezeGate: { status: freeze.status, protocolDigestVerified: true, runningCommitSha },
    dataset: { datasetId: dataset.manifest.datasetId, fixtureHash: dataset.fixtureHash },
    denominators: {
      enrolledRows: dataset.tasks.tasks.length * 2,
      executedAdjudications: adjudications.length,
      notExecutedTasks: notExecutedTasks.length,
      excludedUnauthorized: exclusions.length,
      requestCounterBasis: ledgerUsedRequests() !== null ? 'budget_ledger' : (executedRequests > 0 ? 'task_reported' : 'UNKNOWN'),
    },
    adjudications,
    notExecutedTasks,
    exclusions,
    stopEvents,
    pairedReport,
    note: 'Full denominators retained: failures, not-executed, INCONCLUSIVE and NOT_APPLICABLE rows are listed, never dropped. This file is evidence of EXECUTION, not of value — the verdict is GO/STOP/UNPROVEN per the frozen FZ-09/10 criteria, decided by the Owner.',
  };
}
