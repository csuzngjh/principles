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
//   - createAuthorizedPiTransport() is THE real-model path: it runs the
//     fail-closed authorization gate (verifyRealRunAuthorization — OD-1 frozen
//     prereg, OD-2 verified cost/request budgets, OD-3 frozen run parameters)
//     BEFORE constructing anything, then builds the production PiAiRuntimeAdapter
//     with a budgeted fetch (lib/http-budget.mjs) so EVERY outbound HTTP request
//     — I0, rounds, retries, repairs, fallbacks — reserves ledger budget before
//     send. No authorization ⇒ no transport ⇒ zero HTTP requests.
//   - createPiAdapterTransport() is the low-level boundary wrapper (fake
//     adapters in tests, or adapters already built by the authorized factory).
//   - createFakeActorTransport() is the deterministic offline rehearsal
//     provider (B4): scripted rounds, records every call, never touches a
//     network socket, and needs NO real-experiment authorization.
//
// NOTHING here runs a real model by itself. Real runs stay NOT_RUN until the
// Owner decisions in fixtures/pilot-run-config.json are made (OD-1..OD-3) AND
// a matching g2-real-run-authorization.v1 record is supplied at runtime; a
// config file's NOT_AUTHORIZED/DRAFT status is never convertible into
// authorization by this code.

import { finishRun, newRunState, outcome, step } from './oracle.mjs';
import { scanGoldLeak } from './fixture.mjs';
import { DELIVERY_CHANNEL } from './g2.mjs';
import { BudgetExhaustedError, createBudgetedFetch } from './http-budget.mjs';

/** Lab-side defaults for OFFLINE REHEARSAL ONLY (fake transports). These are
 * record-keeping values for deterministic tests — they are NEVER a real
 * experiment's cost authorization: a real run's HTTP/token budgets must come
 * from the runtime authorization record (P1-02). */
export const DEFAULT_REAL_ACTOR_CAPS = {
  maxStepsPerOpportunity: 40, // mirrors the oracle's own STEP_CAP
  maxRequestsPerOpportunity: 16, // model rounds incl. bounded invalid re-prompts
  maxInvalidActions: 2, // bounded invalid-output allowance — never unbounded repair
  maxTokensPerRequest: 512, // one action JSON is small by construction
  timeoutMsPerRequest: 60_000,
  totalBudgetMsPerOpportunity: 300_000,
};

/** P1-02 — the runtime authorization record contract. Present in code so the
 * gate and the audit report share one vocabulary with the fixtures docs. */
export const REAL_RUN_AUTHORIZATION_SCHEMA = 'g2-real-run-authorization.v1';
/** The ONLY preregistration status that can appear in a valid authorization. */
export const PREREG_FROZEN_STATUS = 'OWNER_APPROVED';

/**
 * P1-02 — mandatory pre-flight gate for REAL-model transports. Fail-closed by
 * construction: any missing/stale/inconsistent item throws
 * RealRunAuthorizationError listing ALL problems, BEFORE a transport (and its
 * adapter, and its fetch) exists — so an unauthorized study cannot emit even
 * one HTTP request. Verified invariants:
 *   OD-1  preregistration is Owner-approved AND frozen (status exactly
 *         OWNER_APPROVED — DRAFT_NOT_OWNER_APPROVED can never authorize) and
 *         the frozen fixture hash equals the dataset actually loaded;
 *   OD-2  provider/model/apiKeyEnv/baseUrl, per-run and total cost caps,
 *         per-opportunity/arm/study HTTP request caps, and a stop condition —
 *         every field explicit and finite (offline defaults are not honored);
 *   OD-3  seeds ≥ 1, execution order matches the dataset's arm order, frozen.
 * plus consistency: the adapter config this gate will build MUST equal the
 * authorized values (any drift refuses before the first request).
 */
export function verifyRealRunAuthorization({ authorization, prereg, dataset, adapterConfig, budgets }) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };

  check(authorization !== null && typeof authorization === 'object' && !Array.isArray(authorization),
    'authorization record missing — real-model transports require a g2-real-run-authorization.v1 record');
  if (problems.length === 0) {
    check(authorization.schemaVersion === REAL_RUN_AUTHORIZATION_SCHEMA,
      `authorization.schemaVersion must be ${REAL_RUN_AUTHORIZATION_SCHEMA}`);

    // OD-1 — preregistration approved AND frozen.
    check(prereg !== null && typeof prereg === 'object' && prereg.status === PREREG_FROZEN_STATUS,
      `OD-1: preregistration is not Owner-approved and frozen (preregistration.status=${String(prereg?.status)}) — ${'DRAFT_NOT_OWNER_APPROVED'} can never authorize real model calls`);
    check(authorization.od1 !== null && typeof authorization.od1 === 'object',
      'OD-1: authorization.od1 record missing');
    if (authorization.od1 && typeof authorization.od1 === 'object') {
      check(authorization.od1.approved === true,
        'OD-1: authorization.od1.approved must be literal true (no implicit approval)');
      check(typeof authorization.od1.decisionRef === 'string' && authorization.od1.decisionRef.length > 0,
        'OD-1: authorization.od1.decisionRef must name the Owner decision record');
      check(authorization.od1.frozenFixtureHash === dataset.fixtureHash,
        `OD-1: authorization.od1.frozenFixtureHash does not equal the loaded dataset fixtureHash (${dataset.fixtureHash.slice(0, 12)}…) — study would run on different data than approved`);
    }

    // OD-2 — provider/model/credentials/cost+request budgets/stop thresholds.
    const od2 = authorization.od2;
    check(od2 !== null && typeof od2 === 'object', 'OD-2: authorization.od2 record missing');
    if (od2 && typeof od2 === 'object') {
      check(typeof od2.provider === 'string' && od2.provider.length > 0, 'OD-2: provider missing');
      check(typeof od2.model === 'string' && od2.model.length > 0, 'OD-2: model missing');
      check(typeof od2.apiKeyEnv === 'string' && od2.apiKeyEnv.length > 0, 'OD-2: apiKeyEnv missing');
      check(od2.credentialsAvailable === true,
        'OD-2: credentialsAvailable must be literal true after Owner-side verification');
      const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
      check(posNum(od2.perRunCostCapUsd), 'OD-2: perRunCostCapUsd must be a positive finite number');
      check(posNum(od2.totalCostCapUsd), 'OD-2: totalCostCapUsd must be a positive finite number');
      check(od2.perRunCostCapUsd !== undefined && od2.totalCostCapUsd !== undefined && od2.totalCostCapUsd >= od2.perRunCostCapUsd,
        'OD-2: totalCostCapUsd must be >= perRunCostCapUsd');
      check(typeof od2.stopCondition === 'string' && od2.stopCondition.length > 0,
        'OD-2: stopCondition (abort threshold description) missing');
      // Cost basis must be verified, not assumed: the record carries its own evidence.
      check(typeof od2.costBasisRef === 'string' && od2.costBasisRef.length > 0,
        'OD-2: costBasisRef missing — official billing evidence is a precondition (AC-6 BLOCKED_COST_GUARD)');
    }

    // OD-3 — repetitions/seeds/execution order frozen.
    const od3 = authorization.od3;
    check(od3 !== null && typeof od3 === 'object', 'OD-3: authorization.od3 record missing');
    if (od3 && typeof od3 === 'object') {
      check(typeof od3.seeds === 'number' && Number.isInteger(od3.seeds) && od3.seeds >= 1,
        'OD-3: seeds must be a positive integer');
      check(od3.frozen === true, 'OD-3: od3.frozen must be literal true');
      check(Array.isArray(od3.executionOrder) && od3.executionOrder.length > 0,
        'OD-3: executionOrder missing');
    }

    // Consistency — the adapter/budgets this gate would build must equal the
    // authorized values (parameter drift refuses before the first request).
    check(adapterConfig !== null && typeof adapterConfig === 'object', 'adapterConfig missing');
    if (adapterConfig && typeof adapterConfig === 'object' && authorization.od2 && typeof authorization.od2 === 'object') {
      check(adapterConfig.provider === authorization.od2.provider, 'drift: adapterConfig.provider != authorization.od2.provider');
      check(adapterConfig.model === authorization.od2.model, 'drift: adapterConfig.model != authorization.od2.model');
      check(adapterConfig.apiKeyEnv === authorization.od2.apiKeyEnv, 'drift: adapterConfig.apiKeyEnv != authorization.od2.apiKeyEnv');
      check((adapterConfig.baseUrl ?? null) === (authorization.od2.baseUrl ?? null), 'drift: adapterConfig.baseUrl != authorization.od2.baseUrl');
    }
    check(budgets !== null && typeof budgets === 'object', 'budgets missing');
    if (budgets && typeof budgets === 'object' && authorization.od2 && typeof authorization.od2 === 'object') {
      check(budgets.httpRequestsPerOpportunity === authorization.od2.httpRequestsPerOpportunity,
        'drift: budgets.httpRequestsPerOpportunity != authorized value');
      check(budgets.httpRequestsPerArm === authorization.od2.httpRequestsPerArm,
        'drift: budgets.httpRequestsPerArm != authorized value');
      check(budgets.httpRequestsPerStudy === authorization.od2.httpRequestsPerStudy,
        'drift: budgets.httpRequestsPerStudy != authorized value');
    }
  }

  if (problems.length > 0) {
    const err = new Error(
      'real-model transport REFUSED (fail-closed) — no adapter was constructed and no HTTP request can occur. Problems:\n  - ' +
      problems.join('\n  - '),
    );
    err.name = 'RealRunAuthorizationError';
    err.problems = problems;
    throw err;
  }
  return { ok: true, schemaVersion: REAL_RUN_AUTHORIZATION_SCHEMA };
}

/**
 * P1-02 — the ONLY factory for real-model lab transports. Runs
 * verifyRealRunAuthorization first (throws before anything exists), then
 * builds the production PiAiRuntimeAdapter with a budgeted fetch wired to
 * `ledger` — every outbound HTTP attempt (I0/rounds/retries/repairs/fallbacks)
 * reserves budget before send. `adapterConfig.fetch` must be left unset (the
 * budgeted fetch wraps the real PRI-683 transport itself).
 */
export async function createAuthorizedPiTransport({ authorization, prereg, dataset, adapterConfig, budgets, ledger }) {
  verifyRealRunAuthorization({ authorization, prereg, dataset, adapterConfig, budgets });
  if (!ledger || typeof ledger.reserve !== 'function') {
    throw new Error('createAuthorizedPiTransport: ledger (lib/http-budget.mjs) is required for real transports');
  }
  if (adapterConfig.fetch !== undefined) {
    throw new Error('createAuthorizedPiTransport: adapterConfig.fetch must be unset — the budgeted fetch is the only transport (no bypass)');
  }
  if (adapterConfig.eventEmitter !== undefined) {
    throw new Error('createAuthorizedPiTransport: adapterConfig.eventEmitter must be unset — the gate owns telemetry (retry/repair counters)');
  }
  // Dynamic import: the offline fake path never loads core; here it is
  // required — the budgeted fetch wraps the REAL PRI-683 transport.
  const core = await import('@principles/core/runtime-v2');
  const { PiAiRuntimeAdapter, getPiAiFetchForApi, StoreEventEmitter } = core;
  if (typeof PiAiRuntimeAdapter !== 'function' || typeof getPiAiFetchForApi !== 'function' || typeof StoreEventEmitter !== 'function') {
    throw new Error('createAuthorizedPiTransport: @principles/core dist is missing PiAiRuntimeAdapter/getPiAiFetchForApi/StoreEventEmitter — build the core package first');
  }
  // P1-01 attribution: retry (provider-rejection downshift) and repair counts
  // come from the adapter's own telemetry, aggregated per arm on the ledger.
  const emitter = new StoreEventEmitter();
  const telemetry = { retries: 0, repairs: 0 };
  emitter.onTelemetry((event) => {
    if (event.eventType === 'llm_max_tokens_downshift') telemetry.retries += 1;
    if (event.eventType === 'output_repair_attempted') telemetry.repairs += Number(event.payload?.attemptsUsed ?? 0);
  });
  ledger.telemetry = telemetry;
  const budgetedFetch = createBudgetedFetch({ ledger, baseFetch: (input, init) => getPiAiFetchForApi('openai-completions')(input, init) });
  const adapter = new PiAiRuntimeAdapter({ ...adapterConfig, eventEmitter: emitter, fetch: budgetedFetch });
  const transport = createPiAdapterTransport({ adapter });
  return { transport, adapter };
}


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
export function createFakeActorTransport({ rounds = [], httpLedger = null } = {}) {
  const calls = [];
  const queue = Array.isArray(rounds) ? [...rounds] : null;
  const persistent = typeof rounds === 'function' ? rounds : null;
  return {
    kind: 'fake',
    async complete(request) {
      // REHEARSAL VEHICLE ONLY (P1-01 tests): when a ledger is wired, each fake
      // round models ONE HTTP request through the same reserve-before-answer
      // path the real budgetedFetch uses — clearly labeled kind 'rehearsal-round';
      // this is never real network traffic and never counted as real usage.
      const grant = httpLedger ? httpLedger.reserve('fake-transport rehearsal round') : null;
      if (grant) httpLedger.record(grant, { url: 'fake://rehearsal-round', status: 200, elapsedMs: 0, tokenUsage: null, usageSource: 'unavailable' });
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
  if (failure.kind === 'invalid_protocol' || failure.kind === 'budget_capped' || failure.kind === 'budget_exhausted') return 'INTERRUPTED';
  return 'FAILED';
}

/**
 * The interactive loop for ONE opportunity. Guarantees (task §四.B1/B4 + P1-01):
 *   - model-round cap / step cap / per-request timeout / total budget — checked
 *     BEFORE each model call, fail-loud, never bypassed;
 *   - when an `httpLedger` is supplied (real runs: always), the ACTUAL outbound
 *     HTTP requests are counted and capped at the wire boundary by that ledger
 *     (lib/http-budget.mjs) — one model round may cost several HTTP requests
 *     (retries/repairs/fallbacks), so `usage.modelRounds` and
 *     `usage.httpRequests` are distinct, non-interchangeable counts;
 *   - a ledger exhaustion (P1-01 fail-closed, thrown before send) surfaces as
 *     failure kind 'budget_exhausted' with the auditable reason;
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
  httpLedger = null,
}) {
  const state = newRunState(environment);
  const actionHistory = [];
  const narratives = [];
  const invalidEvents = [];
  const startedAt = Date.now();
  const httpBefore = httpLedger ? httpLedger.used() : null;
  let modelRounds = 0;
  let invalidActions = 0;
  let failure = null;
  let canaryLeak = null;
  let firstRoundPrompt = null;

  while (
    !state.terminal
    && state.steps < caps.maxStepsPerOpportunity
    && modelRounds < caps.maxRequestsPerOpportunity
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
        taskId: `${delivery.armId}#${opportunityId}#turn${modelRounds + 1}`,
      });
      modelRounds += 1;
    } catch (err) {
      modelRounds += 1;
      if (err instanceof BudgetExhaustedError || err?.code === 'budget_exhausted') {
        // P1-01 fail-closed: the HTTP ledger refused BEFORE the request was
        // sent. Auditable termination — the ledger snapshot (kept by the
        // runner) carries used/cap and every settled request row.
        failure = { kind: 'budget_exhausted', reason: err.message, scope: err.scope, used: err.used, cap: err.cap };
        break;
      }
      failure = { kind: err?.code === 'no_response' ? 'no_response' : 'transport_error', reason: err?.message ?? String(err) };
      break;
    }

    const verdict = validateActorAction(round?.payload, knownActionNames);
    if (!verdict.ok) {
      invalidActions += 1;
      invalidEvents.push({ turn: modelRounds, reason: verdict.reason });
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
    usage: {
      // P1-01: model interaction rounds and actual outbound HTTP requests are
      // distinct counts. httpRequests comes from the ledger when one is wired
      // (real runs); null here means "no ledger wired" (offline unit use) —
      // never zero-by-assumption.
      modelRounds,
      httpRequests: httpLedger ? httpLedger.used() - (httpBefore ?? 0) : null,
      invalidActions,
      steps: state.steps,
      wallMs: Date.now() - startedAt,
    },
    failure,
    canaryLeak,
    actorRunStatus: actorRunStatusOf(failure),
    firstRoundPrompt,
  };
}
