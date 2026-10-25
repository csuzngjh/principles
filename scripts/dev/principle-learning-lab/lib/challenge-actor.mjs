// SPEC-PD-EXAMINER-001 v0.3 — Phase 1B ActorTraceV1 + controlled Actor Loop
// for challenge studies (offline stub mode only).
//
// Route per SPEC §2.1: existing runRealActorOpportunity() is welded to the
// PLE-PILOT-01 oracle (imports newRunState/step/outcome from oracle.mjs), so
// this is an INDEPENDENT Challenge Loop that reuses the verified disciplines
// instead of performing coupling surgery on the frozen G2 actor:
//   - fixed JSON action protocol + structural validation before any effect;
//   - bounded loop with maxSteps / maxInvalidActions (actor.mjs caps pattern);
//   - narrative text carried verbatim but NEVER used as evidence (oracle.mjs
//     discipline);
//   - actor self-report is never an observation (evaluator.mjs discipline).
//
// The actor VIEW strips judge-side fields (implies maps) — the trace contains
// only what an actor could legitimately see. Gold lives in judge-only files;
// the gold-informed stub is explicitly labeled as a pipeline-wiring fixture,
// never as an arm measurement.

import { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } from './claim-evidence-env.mjs';

export const ACTOR_TRACE_SCHEMA = 'actor-trace.v1';
export const ACTOR_RUN_STATUS_VALUES = ['COMPLETED', 'FAILED', 'NO_RESPONSE', 'INTERRUPTED', 'UNKNOWN'];

export const DEFAULT_CHALLENGE_ACTOR_CAPS = {
  maxSteps: 40,
  maxInvalidActions: 2,
};

/** Thrown by stub actors to simulate a hard process crash mid-run: the
 *  runner must NOT write any attempt result, leaving PREPARED-without-RESULT
 *  (RESULT_UNKNOWN on recovery). */
export class SimulatedCrashError extends Error {
  constructor(atStep) {
    super(`simulated crash at step ${atStep} (process died before result persistence)`);
    this.name = 'SimulatedCrashError';
    this.atStep = atStep;
  }
}

function actorView(caseVisible, runState) {
  return {
    caseVisible,
    constraints: caseVisible.constraints,
    executedObservations: runState.executedObservations.map((r) => ({
      obsId: r.obsId,
      status: r.status,
      source: r.source,
      output: r.output,
      costUnits: r.costUnits,
      timeUnits: r.timeUnits,
      // implies deliberately stripped — judge-side information
    })),
    budgetUsed: runState.budgetUsed,
    timeUsed: runState.timeUsed,
    deadlineBreached: runState.deadlineBreached,
    signOffReceived: runState.signOffReceived,
    taskCompleted: runState.taskCompleted,
    step: runState.step,
  };
}

/**
 * Drive one case with a stub actor. Deterministic: same env + same actor
 * behavior → same trace. Every action, observation, budget refusal, invalid
 * action and the termination reason are recorded with a strict sequence.
 */
export function runControlledActorLoop({ env, runState, caseVisible, actor, linkage, caps = DEFAULT_CHALLENGE_ACTOR_CAPS }) {
  if (!actor || typeof actor.nextAction !== 'function') throw new Error('runControlledActorLoop: actor.nextAction required');
  const trace = {
    schema: ACTOR_TRACE_SCHEMA,
    actorKind: actor.kind || 'unknown-stub',
    linkage,
    records: [],
    finalReport: null,
    usage: null,
    termination: null,
    narrativePolicy: 'actions may carry a narrative field; it is carried verbatim and NEVER used as observation evidence or score input',
  };
  let seq = 0;
  const rec = (entry) => { entry.seq = seq++; trace.records.push(entry); };

  let invalidActions = 0;
  let done = false;
  while (!done) {
    if (runState.step >= caps.maxSteps) {
      rec({ kind: 'termination', reason: 'step_cap', detail: `reached maxSteps=${caps.maxSteps} without a report` });
      trace.termination = { reason: 'step_cap', actorRunStatus: 'NO_RESPONSE' };
      break;
    }
    const action = actor.nextAction(actorView(caseVisible, runState));
    if (action && typeof action.narrative === 'string') rec({ kind: 'narrative_carried', text: action.narrative });
    rec({ kind: 'action', action: { type: action && action.type, args: action && action.args } });
    const result = stepClaimEnvironment(env, runState, action);
    if (!result.ok) {
      invalidActions += 1;
      rec({ kind: 'invalid_action', error: result.error });
      if (invalidActions >= caps.maxInvalidActions) {
        rec({ kind: 'termination', reason: 'invalid_action_cap', detail: `${invalidActions} invalid actions` });
        trace.termination = { reason: 'invalid_action_cap', actorRunStatus: 'FAILED' };
        done = true;
      }
      continue;
    }
    if (result.record && result.record.status === 'refused_budget') {
      rec({ kind: 'budget_event', event: 'observation_refused_budget', obsId: result.record.obsId, output: result.record.output });
      continue;
    }
    if (action.type === 'report') {
      trace.finalReport = runState.report;
      rec({ kind: 'termination', reason: 'report_submitted', detail: 'actor submitted final claims' });
      trace.termination = { reason: 'report_submitted', actorRunStatus: 'COMPLETED' };
      done = true;
      continue;
    }
    if (action.type === 'deploy') {
      rec({ kind: 'consequence', event: 'deploy', authorizationViolated: runState.authorizationViolated, taskCompleted: runState.taskCompleted });
      continue;
    }
    rec({ kind: 'observation', obsId: result.record.obsId, source: result.record.source, status: result.record.status, output: result.record.output });
  }

  trace.usage = {
    steps: runState.step,
    invalidActions,
    observationsExecuted: runState.executedObservations.filter((r) => r.status === 'ok').length,
    budgetRefusals: runState.refusedCount,
    budgetUsed: runState.budgetUsed,
    timeUnits: runState.timeUsed,
  };
  return { trace, runState };
}

// ---------------------------------------------------------------------------
// Deterministic stub actors (offline wiring fixtures — never arm measurements)
// ---------------------------------------------------------------------------

/** Plays a fixed script; fails with SimulatedCrashError at `crashAt` if set. */
export function createScriptedStub({ kind = 'stub-scripted', actions = [], crashAt = null }) {
  let i = 0;
  return {
    kind,
    nextAction(view) {
      if (crashAt !== null && view.step >= crashAt) throw new SimulatedCrashError(view.step);
      if (i >= actions.length) return { type: 'report', args: { claims: [] } }; // defensive; env rejects empty
      return actions[i++];
    },
  };
}

/** Deterministic perfect-play script computed from caseDef (judge-only gold).
 *  PIPELINE WIRING FIXTURE ONLY — proves plumbing, never behavior. The
 *  executable actor is perfectPlayActor(); owner-answer evidence refs are
 *  resolved against real OBS-OWNER-<step> ids during execution. */
export function perfectPlayScript(caseDef) {
  const actions = [];
  const report = [];
  const constraints = caseDef.constraints || {};
  const budget = Number.isFinite(constraints.budgetUnits) ? constraints.budgetUnits : 99;
  const deadline = Number.isFinite(constraints.deadlineUnits) ? constraints.deadlineUnits : 99;
  let budgetUsed = 0;
  let timeUsed = 0;
  const executedIds = new Set(caseDef.preSeededObservations || []);

  const tryObserve = (obs) => {
    if (executedIds.has(obs.obsId)) return { obsId: obs.obsId, already: true };
    if (budgetUsed + obs.costUnits > budget) return null;
    if (timeUsed + obs.timeUnits > deadline) return null;
    actions.push({ type: 'observe', args: { obsId: obs.obsId } });
    budgetUsed += obs.costUnits;
    timeUsed += obs.timeUnits;
    executedIds.add(obs.obsId);
    return { obsId: obs.obsId };
  };
  const tryAskOwner = (requestType, cost = 2, time = 1) => {
    if (budgetUsed + cost > budget || timeUsed + time > deadline) return null;
    actions.push({ type: 'ask-owner', args: { requestType } });
    budgetUsed += cost;
    timeUsed += time;
    return { obsId: 'owner' };
  };

  if (caseDef.extraActions && caseDef.extraActions.deploy) {
    tryAskOwner('deployment-signoff');
  }

  for (const required of caseDef.gold.requiredClaims) {
    const wanted = required.acceptableVerdicts.find((v) => v === 'verified_true' || v === 'verified_false');
    if (wanted) {
      const target = wanted === 'verified_true' ? 'true' : 'false';
      const candidates = [];
      for (const obs of caseDef.observations || []) {
        if (obs.implies && obs.implies[required.factId] === target) candidates.push({ obs, cost: obs.costUnits, via: 'observe' });
      }
      for (const [requestType, answer] of Object.entries(caseDef.ownerAnswers || {})) {
        if (answer.implies && answer.implies[required.factId] === target) candidates.push({ obs: { obsId: `owner:${requestType}`, requestType, costUnits: 2, timeUnits: 1 }, cost: 2, via: 'ask-owner' });
      }
      candidates.sort((a, b) => a.cost - b.cost || String(a.obs.obsId).localeCompare(String(b.obs.obsId)));
      for (const cand of candidates) {
        const done = cand.via === 'observe' ? tryObserve(cand.obs) : tryAskOwner(cand.obs.requestType);
        if (done) {
          const evidenceRef = cand.via === 'observe' ? cand.obs.obsId : `OBS-OWNER-PENDING`; // resolved below
          report.push({ factId: required.factId, verdict: wanted, evidenceRef });
          break;
        }
      }
    }
  }

  if (caseDef.extraActions && caseDef.extraActions.deploy) actions.push({ type: 'deploy' });

  // Resolve owner-evidence refs: the loop assigns OBS-OWNER-<step>; predict deterministically.
  let ownerSeq = 0;
  for (const r of report) {
    if (r.evidenceRef === 'OBS-OWNER-PENDING') r.evidenceRef = `OBS-OWNER-RESOLVED-${++ownerSeq}`;
  }

  for (const required of caseDef.gold.requiredClaims) {
    if (report.some((r) => r.factId === required.factId)) continue;
    report.push({ factId: required.factId, verdict: 'inferred', minimalSteps: 'stub-minimal-step: 执行该事实的对应观察后可升级为 verified' });
  }

  actions.push({ type: 'report', args: { claims: report } });
  return actions;
}

/** Scripted wrapper so perfectPlayScript can be replayed step by step. */
export function perfectPlayActor(caseDef) {
  const script = perfectPlayScript(caseDef);
  let i = 0;
  // Owner evidence refs are assigned by the environment as OBS-OWNER-<step>;
  // rewrite the predicted placeholders with the real ids while executing.
  const ownerIds = [];
  return {
    kind: 'stub-perfect-play(gold-informed-pipeline-fixture)',
    nextAction(view) {
      const action = script[i++];
      if (!action) return { type: 'report', args: { claims: [] } };
      if (action.type === 'ask-owner') {
        const step = view.step + 1; // the env assigns step before executing
        const obsId = `OBS-OWNER-${step}`;
        ownerIds.push(obsId);
        return action;
      }
      if (action.type === 'report') {
        const claims = action.args.claims.map((c) => {
          if (typeof c.evidenceRef === 'string' && c.evidenceRef.startsWith('OBS-OWNER-RESOLVED-')) {
            const idx = Number(c.evidenceRef.split('-').pop()) - 1;
            return { ...c, evidenceRef: ownerIds[idx] || c.evidenceRef };
          }
          return c;
        });
        return { type: 'report', args: { claims } };
      }
      return action;
    },
  };
}

/** Observes everything affordable in listed order, then reports every fact as
 *  inferred with minimal steps — never fabricates a verdict direction. Shows
 *  abstention detection on required-verifiable claims. */
export function createGreedyObserverStub() {
  return {
    kind: 'stub-greedy-observer',
    nextAction(view) {
      const { caseVisible, executedObservations, budgetUsed, timeUsed } = view;
      const { budgetUnits, deadlineUnits } = caseVisible.constraints;
      const doneIds = new Set(executedObservations.map((r) => r.obsId));
      for (const obs of caseVisible.availableObservations) {
        if (doneIds.has(obs.obsId)) continue;
        if (budgetUsed + obs.costUnits <= budgetUnits && timeUsed + obs.timeUnits <= deadlineUnits) {
          return { type: 'observe', args: { obsId: obs.obsId } };
        }
      }
      return {
        type: 'report',
        args: {
          claims: caseVisible.facts.map((f) => ({ factId: f.factId, verdict: 'inferred', minimalSteps: 'stub-greedy: 未断言方向，需语义判读' })),
        },
      };
    },
  };
}

/** Runs exactly one observation (the first listed), then asserts verified_true
 *  citing it for every fact — the classic surface-compliance failure shape. */
export function createNaiveStub() {
  let observed = false;
  let firstObsId = null;
  return {
    kind: 'stub-naive-surface-compliance',
    nextAction(view) {
      if (!observed) {
        firstObsId = view.caseVisible.availableObservations[0].obsId;
        observed = true;
        return { type: 'observe', args: { obsId: firstObsId } };
      }
      return {
        type: 'report',
        args: { claims: view.caseVisible.facts.map((f) => ({ factId: f.factId, verdict: 'verified_true', evidenceRef: firstObsId })) },
      };
    },
  };
}

export { buildClaimEnvironment, newClaimRunState };
