// PRI-966 G2 — real-arm execution engine (SPEC-PD-PL-001 v0.3 §4.2).
//
// Mirrors lib/runner.mjs's G1 flow (learn → freeze → interactive oracle run →
// adjudicate) with the REAL actor in place of a simulated strategy:
//
//   I0 reflection: ONE transport call reads the arm's frozen history and
//                  states the operating policy it will follow → freezeCandidate
//                  (bytes + hash, sourceStage 'i0-reflection'). Never
//                  hand-polished; no candidate (E0 none-arm) is a transparent
//                  sentinel, not fabricated content.
//   Same-channel delivery: the frozen bytes reach the actor ONLY through
//                  deliverPayload() (research-same-channel-v1), position and
//                  budget identical for every arm — C-A can never be confounded
//                  by delivery mechanics.
//   Per opportunity: runRealActorOpportunity() (lib/actor.mjs) drives the
//                  oracle one action per model round under hard caps; the
//                  outcome goes to the SAME three-layer adjudicator.
//
// Cross-arm isolation: every arm runs on its OWN transport instance supplied
// by transportForArm — no module state, no shared cache. A judge-only leak
// aborts the whole study (pilot-run-config exitConditions), remaining arms
// are not started.
//
// This module never opens a socket itself: the transport decides (fake =
// offline rehearsal, pi-adapter = production adapter behind Owner decisions).

import { allOpportunities, goldFor, renderHistoryText } from './fixture.mjs';
import { ACTION_COSTS } from './oracle.mjs';
import { adjudicate } from './evaluator.mjs';
import { freezeCandidate } from './sidecar.mjs';
import { deliverPayload } from './g2.mjs';
import { DEFAULT_REAL_ACTOR_CAPS, runRealActorOpportunity } from './actor.mjs';
import { auditTokenUsage, createHttpBudgetLedger } from './http-budget.mjs';



export const REAL_ACTOR_STRATEGY_ID = 'REAL_ACTOR_I0';
export { auditTokenUsage };
const KNOWN_ACTION_NAMES = Object.keys(ACTION_COSTS);
const REFLECTION_MAX_TOKENS = 1024;
const NONE_ARM_SENTINEL = '[none-arm: no I0 candidate generated — delivered content is empty by design]';

/** One I0 reflection call: history in, {policyText} out (free-form JSON path,
 * validated lab-side). Returns {policyText} or throws a labeled failure. */
async function runI0Reflection({ transport, historyText, armId, caps }) {
  const systemPrompt = [
    'You are an agent being onboarded with a learning history before future tasks.',
    'Read the history and state the operating policy you will actually follow in future tasks because of it.',
    'Answer with a single JSON object: {"policyText": "<one paragraph, <= 2000 chars>"} and nothing else.',
  ].join('\n');
  let round;
  try {
    round = await transport.complete({
      systemPrompt,
      userPrompt: historyText,
      outputSchemaRef: undefined,
      maxTokens: REFLECTION_MAX_TOKENS,
      timeoutMs: caps.timeoutMsPerRequest,
      taskId: `${armId}#i0-reflection`,
    });
  } catch (err) {
    const failure = new Error(`I0 reflection transport failure: ${err?.message ?? String(err)}`);
    failure.kind = err?.code === 'no_response' ? 'no_response' : 'transport_error';
    throw failure;
  }
  const payload = round?.payload;
  if (typeof payload !== 'object' || payload === null || typeof payload.policyText !== 'string' || payload.policyText.length === 0) {
    const failure = new Error('I0 reflection output invalid: expected {policyText: non-empty string}');
    failure.kind = 'invalid_output';
    throw failure;
  }
  return payload.policyText;
}

/**
 * Run one real-actor arm. Returns { arm, adjudications, actorInputs, usage, fatal }.
 * `fatal` is set only for judge-leak INVALID_PROTOCOL — the caller stops the study.
 */
export async function runRealArm({ dataset, historyId, transport, caps = DEFAULT_REAL_ACTOR_CAPS, studyId, armLedger = null, budgets = null }) {
  const armId = `${historyId}:${REAL_ACTOR_STRATEGY_ID}`;
  // P1-01: every opportunity runs inside its OWN child scope of the arm
  // ledger; the arm scope itself hangs off the study ledger. cap null =
  // record-only (offline rehearsal); a positive cap is fail-closed at the
  // HTTP boundary. Levels never reset or overwrite each other.
  const opportunityLedgers = [];
  const makeOppLedger = (opportunityId) => {
    if (!armLedger) return null;
    const child = createHttpBudgetLedger({
      scope: `${armId}#${opportunityId}`,
      cap: budgets?.httpRequestsPerOpportunity ?? null,
      parent: armLedger,
    });
    opportunityLedgers.push(child);
    return child;
  };
  const history = dataset.histories[historyId];
  const manualText = dataset.worldManual.manualText.join('\n');

  // 1. I0 reflection → frozen candidate (never hand-polished).
  let policyText = NONE_ARM_SENTINEL;
  let reflection = { requests: 0, failure: null };
  if (historyId !== 'E0') {
    try {
      policyText = await runI0Reflection({ transport, historyText: renderHistoryText(history), armId, caps });
      reflection.requests = 1;
    } catch (err) {
      reflection.failure = { kind: err?.kind ?? 'transport_error', reason: err?.message ?? String(err) };
      policyText = NONE_ARM_SENTINEL;
    }
  }
  const frozenCandidate = freezeCandidate({
    policyText,
    sourceStage: 'i0-reflection',
    deliveredRepresentation: historyId === 'E0' ? 'none' : 'real_i0_policy_text',
  });

  // 2. Same-channel delivery. deliverPayload throws loudly when the frozen
  // bytes exceed the channel budget — truncation belongs to study design, not
  // to delivery, so an over-budget candidate is an honest arm failure.
  let delivery;
  try {
    delivery = deliverPayload({
      armId,
      content: historyId === 'E0' ? null : (reflection.failure ? null : policyText),
    });
  } catch (err) {
    delivery = null;
    reflection.failure = { kind: 'delivery_budget', reason: err?.message ?? String(err) };
  }

  // 3. Every opportunity through the interactive real actor + oracle.
  const adjudications = [];
  const actorInputs = [];
  const opportunityUsage = [];
  let fatal = null;
  for (const opp of allOpportunities(dataset)) {
    const taskText = opp.taskInstructions.join('\n');
    const goldRecord = goldFor(dataset, opp.probeId, opp.opportunityId);
    let effectiveDelivery = delivery;
    if (!effectiveDelivery) {
      // Delivery failed at budget gate: still run the actor with an explicit
      // empty-channel receipt so the opportunity is scored, never skipped.
      effectiveDelivery = deliverPayload({ armId, content: null });
    }
    const opportunityLedger = makeOppLedger(opp.opportunityId);
    // P1-01: route the transport-bound fetch's reserves through THIS
    // opportunity scope so per-opportunity caps are enforced at the same
    // outbound boundary (the transport holds the arm ledger's fetch).
    if (armLedger && opportunityLedger) armLedger.setActiveChild(opportunityLedger);
    let result;
    try {
      result = await runRealActorOpportunity({
        transport,
        environment: opp.environment,
        knownActionNames: KNOWN_ACTION_NAMES,
        manualText,
        taskText,
        delivery: effectiveDelivery,
        goldRecord,
        opportunityId: opp.opportunityId,
        caps,
        httpLedger: opportunityLedger,
      });
    } finally {
      if (armLedger) armLedger.clearActiveChild();
    }
    opportunityUsage.push({
      opportunityId: opp.opportunityId,
      ...result.usage,
      actorRunStatus: result.actorRunStatus,
      failure: result.failure,
      budget: opportunityLedger ? opportunityLedger.snapshot() : null,
    });
    actorInputs.push({
      historyId,
      probeId: opp.probeId,
      opportunityId: opp.opportunityId,
      leakageGroupId: dataset.probes[opp.probeId].leakageGroupId,
      historySynthetic: history.synthetic === true,
      visibleText: result.firstRoundPrompt ?? '(no round prompt composed — run failed before the first model call)',
    });
    adjudications.push(
      adjudicate({
        studyId,
        armId,
        probeId: opp.probeId,
        opportunityId: opp.opportunityId,
        goldRecord,
        outcome: result.outcome,
        actorRunStatus: result.actorRunStatus,
      }),
    );
    if (result.failure?.kind === 'invalid_protocol') {
      const row = adjudications[adjudications.length - 1];
      row.dataQualityFlag = 'INVALID_PROTOCOL';
      row.dataQualityReasons.push(result.failure.reason);
      fatal = { armId, opportunityId: opp.opportunityId, reason: result.failure.reason };
      break; // exitConditions: judge leak stops the study — do not proceed
    }
    if (reflection.failure) {
      // The candidate generation failed but the actor still ran: record the
      // generation failure on every row's data quality (visible, not silent).
      const row = adjudications[adjudications.length - 1];
      row.dataQualityReasons.push(`i0-reflection: ${reflection.failure.kind} — ${reflection.failure.reason}`);
    }
  }

  const arm = {
    armId,
    historyId,
    strategyId: REAL_ACTOR_STRATEGY_ID,
    strategyKind: 'real-actor-i0',
    actorKind: 'real',
    allocationUnit: 'episode',
    informationCutoff: dataset.episode.informationCutoff,
    initialMemoryManifest: {
      schemaVersion: 'memory-manifest.v0.1',
      entries: [],
      note: 'lab real-actor arm — no external memory files; OD-authorized runs fingerprint real profiles via buildMemoryManifest before first run',
    },
    frozenCandidate,
    delivery,
    reflection,
    usage: {
      caps,
      budgets,
      reflectionRequests: reflection.requests,
      opportunities: opportunityUsage,
      // P1-01: arm-level HTTP budget snapshot (chain: opportunity → arm → study).
      budget: armLedger ? armLedger.snapshot() : null,
      // P1-03: per-request token audit (null usage rows stay explicit).
      tokenAudit: armLedger
        ? auditTokenUsage([...armLedger.requests(), ...opportunityLedgers.flatMap((l) => l.requests())])
        : null,
      // P1-01: retry/repair attribution (authorized Pi transports only — the
      // factory attaches telemetry counters to the ledger; null = not wired).
      retries: armLedger?.telemetry ? armLedger.telemetry.retries : null,
      repairs: armLedger?.telemetry ? armLedger.telemetry.repairs : null,
    },
  };

  return { arm, adjudications, actorInputs, usage: opportunityUsage, fatal };
}

/**
 * Run every real-actor arm on its OWN transport (cross-arm isolation), in the
 * preregistered history order, under the study-level HTTP budget (P1-01).
 * Stops at the first judge-leak INVALID_PROTOCOL (remaining arms are not
 * started — exitConditions) and reports `stopped`. `budgets` = explicit HTTP
 * request caps {httpRequestsPerOpportunity, httpRequestsPerArm,
 * httpRequestsPerStudy}; null caps are record-only (offline rehearsal) and are
 * NEVER a real-experiment authorization (P1-02 gate covers that).
 */
export async function runRealStudy({ dataset, transportForArm, caps = DEFAULT_REAL_ACTOR_CAPS, studyId, historyIds = ['E0', 'EA', 'EB', 'EN'], budgets = null }) {
  const studyLedger = createHttpBudgetLedger({
    scope: `study:${studyId}`,
    cap: budgets?.httpRequestsPerStudy ?? null,
    costCapUsd: budgets?.totalCostCapUsd ?? null,
    reason: 'study-level cumulative HTTP/USD cost cap',
  });
  const arms = [];
  const adjudications = [];
  const actorInputs = [];
  let stopped = null;
  for (const historyId of historyIds) {
    const armLedger = createHttpBudgetLedger({
      scope: `${historyId}:${REAL_ACTOR_STRATEGY_ID}`,
      cap: budgets?.httpRequestsPerArm ?? null,
      costCapUsd: budgets?.perRunCostCapUsd ?? null,
      parent: studyLedger,
      reason: 'arm-level HTTP/USD cost cap',
    });
    const r = await runRealArm({ dataset, historyId, transport: transportForArm(historyId, armLedger), caps, studyId, armLedger, budgets });
    arms.push(r.arm);
    adjudications.push(...r.adjudications);
    actorInputs.push(...r.actorInputs);
    if (r.fatal) {
      stopped = { atArm: r.arm.armId, ...r.fatal };
      break;
    }
  }
  return { arms, adjudications, actorInputs, stopped, budget: studyLedger.snapshot() };
}
