// PRI-966 G2 — the REAL actor wiring (SPEC-PD-PL-001 v0.3 §4.2, task Phase B).
//
// Extends the G2 model-stub abstraction (lib/g2.mjs) from a one-shot scripted
// plan into an INTERACTIVE real actor: each round the actor receives exactly
// what the experiment allows (world manual + task text + same-channel
// delivered payload + observations so far), answers with ONE action, the
// existing mechanical oracle executes it (lib/oracle.mjs step()), and the
// next round reacts to the new observation until terminal or a cap fires.
//
// Model calls go through a single transport seam:
//   - createPiAdapterTransport() wraps the PRODUCTION PiAiRuntimeAdapter
//     (same startRun/fetchOutput boundary production runners use, with the
//     lab's registered outputSchemaRef) — no second model-call framework;
//   - createFakeActorTransport() is the deterministic offline rehearsal
//     provider (B4): scripted rounds, records every call, never touches a
//     network socket.
//
// NOTHING here runs a real model by itself. Real runs stay NOT_RUN until the
// Owner decisions in fixtures/pilot-run-config.json are made (OD-1..OD-2).

import { finishRun, newRunState, outcome, step } from './oracle.mjs';
import { scanGoldLeak } from './fixture.mjs';
import { DELIVERY_CHANNEL } from './g2.mjs';

/** Lab-side defaults for offline rehearsal. Real-run values are
 * OWNER_DECISION_REQUIRED (fixtures/pilot-run-config.json budgets). */
export const DEFAULT_REAL_ACTOR_CAPS = {
  maxStepsPerOpportunity: 40, // mirrors the oracle's own STEP_CAP
  maxRequestsPerOpportunity: 16, // model rounds incl. bounded invalid re-prompts
  maxInvalidActions: 2, // bounded invalid-output allowance — never unbounded repair
  maxTokensPerRequest: 512, // one action JSON is small by construction
  timeoutMsPerRequest: 60_000,
  totalBudgetMsPerOpportunity: 300_000,
};

/**
 * Structural validation of one actor round output against the action space
 * (mirrors learning-lab-actor-action-v1; the production adapter validated the
 * same shape on the wire — this re-check keeps fake-transport rehearsals and
 * any adapter-free future caller equally honest, rc-2/rc-3).
 */
export function validateActorAction(action, knownActionNames) {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return { ok: false, reason: 'action must be a JSON object' };
  }
  if (typeof action.type !== 'string' || !knownActionNames.includes(action.type)) {
    return { ok: false, reason: `unknown action type '${String(action.type)}'` };
  }
  if (action.args !== undefined) {
    if (typeof action.args !== 'object' || action.args === null || Array.isArray(action.args)) {
      return { ok: false, reason: 'args must be an object when present' };
    }
    for (const v of Object.values(action.args)) {
      if (typeof v !== 'string') return { ok: false, reason: 'args values must be strings' };
    }
  }
  if (action.narrative !== undefined && typeof action.narrative !== 'string') {
    return { ok: false, reason: 'narrative must be a string when present' };
  }
  if (Object.keys(action).some((k) => !['type', 'args', 'narrative'].includes(k))) {
    return { ok: false, reason: 'action carries fields other than type/args/narrative' };
  }
  return { ok: true };
}

/**
 * Compose ONE round's messages. The single composition path for real actor
 * sessions: the delivered payload rides the research-same-channel-v1 position
 * (after the task text — same as g2.composeActorPrompt), the manual is the
 * actor-visible action truth, and the transcript carries only the actor's OWN
 * past actions and the oracle's observations (never gold).
 */
export function composeRoundMessages({ manualText, taskText, delivery, actionHistory, stepsLeft, invalidNote }) {
  if (delivery.channel !== DELIVERY_CHANNEL) {
    throw new Error(`composeRoundMessages: refusing non-${DELIVERY_CHANNEL} delivery`);
  }
  const systemPrompt = [
    'You are an agent executing a task inside a controlled research environment.',
    'Each turn you choose exactly ONE action from the manual below; the environment executes it and shows you the result.',
    'Manual (actions and their time costs):',
    manualText,
    'Answer with a single JSON object: {"type": "<action>", "args": {...optional...}, "narrative": "<optional short note>"} and nothing else.',
    "'proceed' applies the change and ends the task; 'decline' abandons it.",
  ].join('\n');
  const lines = [
    taskText,
    '',
    '--- applied context ---',
    delivery.payloadText,
    '',
    '--- transcript so far ---',
  ];
  if (actionHistory.length === 0) lines.push('(no actions taken yet — this is your first turn)');
  actionHistory.forEach((entry, i) => {
    lines.push(`turn ${i + 1}: action ${JSON.stringify(entry.action)} -> ${entry.observation}`);
  });
  lines.push('', `(time-budget notice: ${stepsLeft} action turn(s) remain before the run is cut off)`);
  if (invalidNote) {
    lines.push('', `(your previous answer was invalid: ${invalidNote} — answer again with ONE valid action JSON)`);
  }
  return { systemPrompt, userPrompt: lines.join('\n') };
}

/**
 * Deterministic offline transport (B4). `rounds` is either a queue of response
 * objects ({payload: …}, Errors, or (request) => response functions — consumed
 * in order) or a single persistent (request) => response function (a scripted
 * "model" that answers every call from the prompt). Every call and response is
 * recorded verbatim for leak/isolation/caps tests. Never touches a network
 * socket.
 */
export function createFakeActorTransport({ rounds = [] } = {}) {
  const calls = [];
  const queue = Array.isArray(rounds) ? [...rounds] : null;
  const persistent = typeof rounds === 'function' ? rounds : null;
  return {
    kind: 'fake',
    async complete(request) {
      const next = persistent ?? queue.shift();
      if (next === undefined) throw new Error('fake actor transport: script exhausted (no more rounds)');
      if (next instanceof Error) {
        calls.push({
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          taskId: request.taskId ?? null,
          outputSchemaRef: request.outputSchemaRef ?? null,
          maxTokens: request.maxTokens,
          response: null,
          error: next.message,
        });
        throw next;
      }
      const response = typeof next === 'function' ? next(request) : next;
      calls.push({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        taskId: request.taskId ?? null,
        outputSchemaRef: request.outputSchemaRef ?? null,
        maxTokens: request.maxTokens,
        response,
      });
      return response;
    },
    calls() {
      return calls.slice();
    },
  };
}

/**
 * Production-path transport: wraps a PiAiRuntimeAdapter instance (or any
 * object with the same startRun/fetchOutput boundary) using the lab's
 * registered schema ref — the same structured-output machinery (tool-call /
 * json_schema rewrite / bounded repair) every production runner gets.
 *
 * `outputSchemaRef` per call: actor rounds pass the action ref; I0 reflection
 * may pass undefined to use the adapter's free-form JSON path (validated
 * lab-side). `roundSeq` keeps task ids unique inside one process.
 */
export function createPiAdapterTransport({ adapter }) {
  if (!adapter || typeof adapter.startRun !== 'function' || typeof adapter.fetchOutput !== 'function') {
    throw new Error('createPiAdapterTransport: adapter must expose startRun/fetchOutput (PDRuntimeAdapter boundary)');
  }
  let roundSeq = 0;
  return {
    kind: 'pi-adapter',
    async complete(request) {
      roundSeq += 1;
      const handle = await adapter.startRun({
        agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
        taskRef: { taskId: request.taskId ?? `lab-actor-round-${roundSeq}` },
        inputPayload: request.userPrompt,
        contextItems: [],
        outputSchemaRef: request.outputSchemaRef,
        timeoutMs: request.timeoutMs,
        // PRI-966 G2: per-request hard cap (StartRunInput.maxTokens) — the
        // actor round (512) / I0 reflection (1024) budget reaches the model
        // request instead of being dropped here.
        maxTokens: request.maxTokens,
        systemPrompt: request.systemPrompt,
      });
      const output = await adapter.fetchOutput(handle.runId);
      if (!output) {
        const err = new Error('pi-adapter transport: fetchOutput returned null (no structured output)');
        err.code = 'no_response';
        throw err;
      }
      return { payload: output.payload, runId: handle.runId };
    },
  };
}

function actorRunStatusOf(failure) {
  if (!failure) return 'COMPLETED';
  if (failure.kind === 'no_response') return 'NO_RESPONSE';
  if (failure.kind === 'invalid_protocol' || failure.kind === 'budget_capped') return 'INTERRUPTED';
  return 'FAILED';
}

/**
 * The interactive loop for ONE opportunity. Guarantees (task §四.B1/B4):
 *   - request cap / step cap / per-request timeout / total budget — checked
 *     BEFORE each model call, fail-loud, never bypassed;
 *   - invalid actions never reach the oracle and never trigger unbounded
 *     repair: bounded re-prompt (maxInvalidActions) then the run fails;
 *   - judge-only canaries are scanned on EVERY composed round prompt; a hit
 *     aborts the run as an INVALID_PROTOCOL signal (g2 exit condition), not
 *     silently;
 *   - after terminal no further model call happens (loop exits; usage proof).
 */
export async function runRealActorOpportunity({
  transport,
  environment,
  knownActionNames,
  manualText,
  taskText,
  delivery,
  goldRecord,
  opportunityId = 'opp',
  caps = DEFAULT_REAL_ACTOR_CAPS,
}) {
  const state = newRunState(environment);
  const actionHistory = [];
  const narratives = [];
  const invalidEvents = [];
  const startedAt = Date.now();
  let requests = 0;
  let invalidActions = 0;
  let failure = null;
  let canaryLeak = null;
  let firstRoundPrompt = null;

  while (
    !state.terminal
    && state.steps < caps.maxStepsPerOpportunity
    && requests < caps.maxRequestsPerOpportunity
    && Date.now() - startedAt < caps.totalBudgetMsPerOpportunity
  ) {
    const invalidNote = invalidEvents.length > 0 ? invalidEvents[invalidEvents.length - 1].reason : null;
    const { systemPrompt, userPrompt } = composeRoundMessages({
      manualText,
      taskText,
      delivery,
      actionHistory,
      stepsLeft: caps.maxStepsPerOpportunity - state.steps,
      invalidNote,
    });
    // NT-01 discipline on the REAL composition path — every round, on the
    // CHANNEL text (system role + task + delivered payload + invalid note):
    // everything the actor receives WITHOUT having earned it through oracle
    // actions. The transcript section is deliberately EXCLUDED — gold canary
    // strings double as hidden-consumer ids, and consumer-graph/full-audit
    // observations legitimately reveal them to an actor that PAID for the
    // check (that discovery is the task, not a leak). A canary in the channel
    // (history/delivery/model-emitted text) is the actual NT-01 violation.
    const channelText = `${systemPrompt}\n${taskText}\n${delivery.payloadText}${invalidNote ? `\n${invalidNote}` : ''}`;
    const leaks = scanGoldLeak(channelText, goldRecord);
    if (leaks.length > 0) {
      canaryLeak = leaks[0].canary;
      failure = { kind: 'invalid_protocol', reason: `canary '${canaryLeak}' entered an actor round prompt (NT-01)` };
      break;
    }
    firstRoundPrompt ??= `${systemPrompt}\n${userPrompt}`;

    let round;
    try {
      round = await transport.complete({
        systemPrompt,
        userPrompt,
        outputSchemaRef: 'learning-lab-actor-action-v1',
        maxTokens: caps.maxTokensPerRequest,
        timeoutMs: caps.timeoutMsPerRequest,
        taskId: `${delivery.armId}#${opportunityId}#turn${requests + 1}`,
      });
      requests += 1;
    } catch (err) {
      requests += 1;
      failure = { kind: err?.code === 'no_response' ? 'no_response' : 'transport_error', reason: err?.message ?? String(err) };
      break;
    }

    const verdict = validateActorAction(round?.payload, knownActionNames);
    if (!verdict.ok) {
      invalidActions += 1;
      invalidEvents.push({ turn: requests, reason: verdict.reason });
      if (invalidActions >= caps.maxInvalidActions) {
        failure = { kind: 'invalid_output', reason: `invalid actor output x${invalidActions} (last: ${verdict.reason}) — bounded allowance exhausted` };
        break;
      }
      continue; // bounded re-prompt: the invalid action is NOT executed
    }

    const action = { type: round.payload.type, ...(round.payload.args !== undefined ? { args: round.payload.args } : {}) };
    if (round.payload.narrative) narratives.push(round.payload.narrative);
    const before = state.observations.length;
    step(environment, state, action);
    const fresh = state.observations.slice(before);
    actionHistory.push({
      action,
      observation: fresh.map((o) => o.text).join(' | ') || '(no observable output)',
    });
  }

  if (!state.terminal && !failure) {
    failure = { kind: 'budget_capped', reason: 'step/request/time cap reached before a terminal action' };
  }
  if (!state.terminal) {
    finishRun(environment, state, 'timeout');
  }

  return {
    state,
    outcome: outcome(state, narratives.join(' ')),
    usage: { requests, steps: state.steps, invalidActions, wallMs: Date.now() - startedAt },
    failure,
    canaryLeak,
    actorRunStatus: actorRunStatusOf(failure),
    firstRoundPrompt,
  };
}
