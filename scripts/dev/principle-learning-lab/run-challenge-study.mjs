#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 — challenge study CLI (offline stub AND Stage R
// F1 real-model execution entry).
//
// Intended for study directory COPIES (e.g. under .tmp/) — running against
// the pristine frozen study would append run records to its append-only
// ledgers, which is legal but permanent; tests and demos use copies.
//
//   # Phase 1B offline stub (default, unchanged):
//   node run-challenge-study.mjs --study-dir <copy> [--strategy perfect-play] \
//        [--arms A,B,C] [--max-attempts 40] [--owner demo]
//
//   # Stage R F1 real-model execution (requires an Owner-issued APPROVED
//   # run-authorization.json INSIDE the study copy — the authoritative file;
//   # every model request is reserved against auth.requestCap BEFORE dispatch;
//   # validity is judged with the ACTUAL system clock, PER UNIT — no caller-
//   # supplied clock is honored for real execution):
//   node run-challenge-study.mjs --study-dir <copy> \
//        --execution-mode F1-direct-model
//
//   # Plan verification ONLY (computes the plan, verifies the frozen suite
//   # and the authorization gate, prints the budget accounting — ZERO runner
//   # invocation, ZERO actor construction, ZERO network). --now is a clearly
//   # labeled SIMULATED clock for this mode only:
//   node run-challenge-study.mjs --study-dir <copy> \
//        --execution-mode F1-direct-model --now 2026-10-27T00:00:00Z --dry-run
//
// F2-real-host is deliberately NOT exposed here: it needs a configured real
// host environment and stays behind its own execution round (PRI-1037 must
// pass first). The gate, not this CLI, remains the authorization authority.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrozenStudy, verifyArmConfigsFrozen, runChallengeStudy, STUB_STRATEGIES, RUNNER_EXECUTION_MODES } from './lib/challenge-runner.mjs';
import { readStageRAuthorization, verifyStageRAuthorization, readStudyPlanHash, MAX_REQUESTS_PER_ATTEMPT_CEILING } from './lib/challenge-stage-r-gate.mjs';
import { createRealModelActor, createAmdActorResponder } from './lib/challenge-actor-transport.mjs';
import { INTERN_S2_BASE_URL, resolveInternS2ApiKey, BIGMODEL_CODING_BASE_URL, BIGMODEL_CODING_MODEL_ID, resolveBigmodelCodingApiKey } from './lib/challenge-amd-transport.mjs';
import { createChallengeLedger } from './lib/challenge-ledger.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const studyDir = arg('--study-dir');
if (!studyDir) {
  console.error('run-challenge-study: --study-dir <path> required (use a COPY of the study, not the pristine frozen directory)');
  process.exit(1);
}
const executionMode = arg('--execution-mode', 'offline-stub');
if (!RUNNER_EXECUTION_MODES.includes(executionMode)) {
  console.error(`run-challenge-study: --execution-mode must be one of ${RUNNER_EXECUTION_MODES.join(' | ')} (got '${executionMode}')`);
  process.exit(1);
}
if (executionMode === 'F2-real-host') {
  console.error('run-challenge-study: F2-real-host is not available through this CLI — it requires a configured real host environment and a PASSED PRI-1037 isolation probe (own execution round). Stage R F1 only.');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const arms = (arg('--arms', 'A,B,C') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Optional case subset — same contract as --arms: the value list (and its
// ORDER) defines the run plan; the gate still enforces plan ⊆ authorization.
const casesArg = arg('--cases');
const casesFilter = casesArg !== undefined ? (casesArg || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const maxAttemptsTotal = Number(arg('--max-attempts', '40'));
const owner = arg('--owner', 'challenge-runner-cli');

// Request-timeout discipline (security): `--request-timeout-ms` is NOT a free
// knob. The value is declared to the Stage R gate, which enforces the
// authorization binding — an authorization that binds requestTimeoutMs must
// see the exact same value, and an authorization WITHOUT the field only ever
// approves the 240000ms default. Invalid values refuse before anything runs.
let requestTimeoutMs; // undefined = default 240000
{
  const t = arg('--request-timeout-ms');
  if (t !== undefined) {
    requestTimeoutMs = Number(t);
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 60_000 || requestTimeoutMs > 600_000) {
      console.error(`run-challenge-study: --request-timeout-ms '${t}' must be an integer within [60000, 600000] (socket-inactivity semantics — see AMD_TRANSPORT_TIMEOUTS)`);
      process.exit(1);
    }
  }
}

// Per-attempt request-cap discipline (security, same pattern as the timeout):
// `--max-requests-per-attempt` is NOT a free knob. An authorization that binds
// maxRequestsPerAttempt must see the exact same declared value; an authorization
// WITHOUT the field approves NO per-attempt cap (the actor-loop step ceiling
// stays the only bound). Invalid values refuse before anything runs.
let maxRequestsPerAttempt; // undefined = no per-attempt cap
{
  const c = arg('--max-requests-per-attempt');
  if (c !== undefined) {
    maxRequestsPerAttempt = Number(c);
    if (!Number.isSafeInteger(maxRequestsPerAttempt) || maxRequestsPerAttempt < 1 || maxRequestsPerAttempt > MAX_REQUESTS_PER_ATTEMPT_CEILING) {
      console.error(`run-challenge-study: --max-requests-per-attempt '${c}' must be an integer within [1, ${MAX_REQUESTS_PER_ATTEMPT_CEILING}] (${MAX_REQUESTS_PER_ATTEMPT_CEILING} = the actor-loop step ceiling)`);
      process.exit(1);
    }
  }
}

// Clock discipline (security): the authorization clock is NOT caller-chosen
// for REAL execution. `--now` is a SIMULATED clock for --dry-run only (clearly
// labeled); a real F1 run always judges validity with the ACTUAL system clock,
// evaluated PER UNIT by the runner (() => Date.now()) — an expired or not-yet-
// valid authorization can never be smuggled through with a past/future --now,
// and an authorization expiring mid-run refuses every subsequent unit.
let now = null; // simulated clock (dry-run only)
if (executionMode !== 'offline-stub') {
  const nowArg = arg('--now');
  if (nowArg !== undefined) {
    now = Date.parse(nowArg);
    if (!Number.isFinite(now)) {
      console.error(`run-challenge-study: --now '${nowArg}' is not a parseable timestamp`);
      process.exit(1);
    }
    if (!dryRun) {
      console.error('run-challenge-study: --now is only honored for --dry-run (SIMULATED clock); a real run uses the actual system clock — refusing the ambiguous combination');
      process.exit(1);
    }
  } else if (dryRun) {
    console.error('run-challenge-study: --dry-run needs a clock to judge with — pass --now <ISO-8601 with timezone> (SIMULATED); a real run needs no clock argument (it uses the actual system clock)');
    process.exit(1);
  }
}

// Stub strategy is only meaningful for the offline path.
const strategy = arg('--strategy', 'perfect-play');
if (executionMode === 'offline-stub' && !STUB_STRATEGIES[strategy]) {
  console.error(`run-challenge-study: unknown strategy '${strategy}' (available: ${Object.keys(STUB_STRATEGIES).join(', ')})`);
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), studyDir);

/** Shared plan verification: frozen suite + arm configs + (real modes) the
 *  Stage R authorization gate. READ-ONLY — no ledger writes, no actor, no
 *  network. Returns the verified plan descriptor or exits non-stop. */
function verifyPlan(frozen, armCheck) {
  const manifestCaseIds = frozen.manifest.cases.map((c) => c.caseId);
  let cases = manifestCaseIds;
  if (casesFilter !== null) {
    const unknown = casesFilter.filter((c) => !manifestCaseIds.includes(c));
    if (unknown.length > 0) {
      console.error(`run-challenge-study: --cases contains non-frozen case(s): ${unknown.join(', ')} (frozen: ${manifestCaseIds.join(', ')})`);
      process.exit(1);
    }
    cases = casesFilter; // caller order is the loop order (e.g. deepest-context unit first)
  }
  const repsArg = arg('--repetitions');
  const repetitions = repsArg ? repsArg.split(',').map((s) => s.trim()).filter(Boolean).map(Number) : [1];
  // Same argument-validation discipline as --max-requests-per-attempt: NaN,
  // decimals, zero/negative counts, and an empty list (',' / ',,') refuse
  // before anything runs — the offline-stub path has no gate containment to
  // catch them, and would otherwise fabricate units like `rNaN`.
  if (repetitions.length === 0 || repetitions.some((r) => !Number.isSafeInteger(r) || r < 1)) {
    console.error(`run-challenge-study: --repetitions '${repsArg}' must be a comma-separated list of integers >= 1 (e.g. 1,2)`);
    process.exit(1);
  }
  const plan = { arms, cases, repetitions };
  const units = arms.length * cases.length * repetitions.length;
  if (executionMode === 'offline-stub') {
    return { plan, units, gate: null, auth: null };
  }
  const auth = readStageRAuthorization(resolved);
  const gate = verifyStageRAuthorization({
    authorizationRecord: auth,
    bindings: {
      studyId: frozen.studyId,
      suiteHash: frozen.suiteHash,
      mappingHash: frozen.mappingHash,
      graderHash: frozen.graderHash,
      studyPlanHash: readStudyPlanHash(resolved),
    },
    plan,
    maxAttemptsTotal,
    // Clock semantics: dry-run judges with the SIMULATED --now (labeled as
    // such in the output); a real run's pre-flight judges with the ACTUAL
    // system clock — the runner then re-verifies PER UNIT with () => Date.now(),
    // so the pre-flight value is never the last word either way.
    now: dryRun ? now : Date.now(),
    declaredExecutionMode: executionMode,
    declaredRequestTimeoutMs: requestTimeoutMs, // undefined = default 240000; the gate enforces the authorization binding
    declaredMaxRequestsPerAttempt: maxRequestsPerAttempt, // undefined = no per-attempt cap; the gate enforces the authorization binding
  });
  return { plan, units, gate, auth };
}

function printPlan(frozen, verified) {
  const { plan, units, gate, auth } = verified;
  console.log(`run-challenge-study: plan — study=${frozen.studyId} units=${units} (${plan.arms.join('/')} × ${plan.cases.length} cases × ${plan.repetitions.length} repetition(s))`);
  if (executionMode === 'offline-stub') {
    console.log('run-challenge-study: mode=offline-stub (deterministic stub, no transport, no network)');
    return;
  }
  const ledger = createChallengeLedger(resolved); // read-only accounting
  const usedAttempts = ledger.budgetEntries().filter((e) => e.type === 'RESERVE').length;
  const usedRequests = ledger.budgetEntries().filter((e) => e.type === 'REQUEST_RESERVE').length;
  const worstCaseRequests = units * 40; // hard cap per unit: maxSteps=40 (invalid actions consume steps too)
  console.log(`run-challenge-study: mode=${executionMode} authorizedModel=${auth.requestedActorIdentity} issuedBy=${auth.issuedBy}`);
  console.log(`run-challenge-study: budget — attemptCap=${auth.attemptCap} (used ${usedAttempts}) | requestCap=${gate.requestCap} (used ${usedRequests})`);
  console.log(`run-challenge-study: worst-case requests for THIS plan = ${worstCaseRequests} (units × maxSteps=40); the gate refuses plans whose runner flag exceeds auth.attemptCap`);
  if (!gate.ok) {
    console.error('run-challenge-study: STAGE R GATE REFUSED — no execution, no network, no ledger writes. Reasons:');
    for (const r of gate.reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
}

(async () => {
try {
  const frozen = verifyFrozenStudy(resolved);
  const armCheck = verifyArmConfigsFrozen(resolved);
  console.log(`run-challenge-study: frozen OK — study=${frozen.studyId} suiteHash=${frozen.suiteHash.slice(0, 12)}… arms=A/B/C audited`);

  const verified = verifyPlan(frozen, armCheck);
  printPlan(frozen, verified);

  // Transport selection is AUTHORIZATION-BOUND: the approved record's
  // requestedActorIdentity picks the responder wiring — a run can never reach
  // a provider its authorization does not name (and a failover authorization
  // names the alternate model explicitly, per the owner runbook).
  let responderFactory = null;
  if (executionMode !== 'offline-stub') {
    const identity = verified.auth && typeof verified.auth.requestedActorIdentity === 'string' ? verified.auth.requestedActorIdentity : null;
    if (identity === 'GLM-5.3-Flash') {
      responderFactory = () => createAmdActorResponder({ requestTimeoutMs: requestTimeoutMs !== undefined ? requestTimeoutMs : 240_000 });
      console.log('run-challenge-study: transport = AMD radeon tokenfactory (GLM-5.3-Flash)');
    } else if (identity === 'Atria-Dawn') {
      // Shuxi intern-ai-discovery, Stage G round10-verified wiring: standard
      // content layout, NO reasoning_effort (unverified parameter — never sent).
      responderFactory = () => createAmdActorResponder({
        requestTimeoutMs: requestTimeoutMs !== undefined ? requestTimeoutMs : 240_000,
        baseUrl: INTERN_S2_BASE_URL,
        modelId: 'Atria-Dawn',
        apiKeyProvider: resolveInternS2ApiKey,
        reasoningEffort: null,
      });
      console.log('run-challenge-study: transport = Shuxi intern-ai-discovery (Atria-Dawn, no reasoning_effort)');
    } else if (identity === 'deepseek-v4.1-flash-1017') {
      // Shuxi intern-ai-discovery, Stage G round7-verified wiring (12/12 valid
      // candidates): standard content layout, NO reasoning_effort.
      responderFactory = () => createAmdActorResponder({
        requestTimeoutMs: requestTimeoutMs !== undefined ? requestTimeoutMs : 240_000,
        baseUrl: INTERN_S2_BASE_URL,
        modelId: 'deepseek-v4.1-flash-1017',
        apiKeyProvider: resolveInternS2ApiKey,
        reasoningEffort: null,
      });
      console.log('run-challenge-study: transport = Shuxi intern-ai-discovery (deepseek-v4.1-flash-1017, no reasoning_effort)');
    } else if (identity === 'glm-5.3-flash') {
      // Zhipu bigmodel Coding Plan (PAID, Owner-provided credential) — the
      // API's own /v4/models entry, OpenAI Chat protocol. reasoning_effort is
      // UNVERIFIED on this endpoint → never sent (provider discipline).
      responderFactory = () => createAmdActorResponder({
        requestTimeoutMs: requestTimeoutMs !== undefined ? requestTimeoutMs : 240_000,
        baseUrl: BIGMODEL_CODING_BASE_URL,
        modelId: BIGMODEL_CODING_MODEL_ID,
        apiKeyProvider: resolveBigmodelCodingApiKey,
        reasoningEffort: null,
      });
      console.log('run-challenge-study: transport = Zhipu bigmodel coding (glm-5.3-flash, no reasoning_effort)');
    } else {
      console.error(`run-challenge-study: no F1 transport wiring is registered for requestedActorIdentity '${String(identity)}' — refusing (fail-closed; never guess a provider)`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log('run-challenge-study: DRY-RUN OK — plan and authorization verified; nothing was executed, no request was sent, no ledger row was written');
    console.log(`run-challenge-study: NOTE — this verdict used the ${now !== null ? `SIMULATED clock (--now ${new Date(now).toISOString()})` : 'actual system clock'}; a real run re-verifies PER UNIT with the actual system clock`);
    return;
  }

  const actorFactory = executionMode === 'offline-stub'
    ? (ctx) => STUB_STRATEGIES[strategy](ctx)
    : (ctx) => createRealModelActor({ ctx, responder: responderFactory() });

  const summary = await runChallengeStudy({
    studyDir: resolved,
    plan: verified.plan,
    actorFactory,
    maxAttemptsTotal,
    owner,
    ...(executionMode === 'offline-stub' ? {} : { execution: { mode: executionMode, now: () => Date.now(), requestTimeoutMs, maxRequestsPerAttempt } }),
  });

  const counts = {};
  for (const u of summary.units) counts[u.state] = (counts[u.state] || 0) + 1;
  const outcomes = {};
  for (const u of summary.units) if (u.objectiveTaskOutcome) outcomes[u.objectiveTaskOutcome] = (outcomes[u.objectiveTaskOutcome] || 0) + 1;
  console.log(`run-challenge-study: DONE — units=${summary.units.length} states=${JSON.stringify(counts)} objectiveOutcomes=${JSON.stringify(outcomes)}`);
  const ledger = createChallengeLedger(resolved);
  const budget = ledger.budgetEntries();
  console.log(`  budget RESERVE rows: ${budget.filter((e) => e.type === 'RESERVE').length} (never returned on crash) | REQUEST_RESERVE: ${budget.filter((e) => e.type === 'REQUEST_RESERVE').length} | REQUEST_REFUSED: ${budget.filter((e) => e.type === 'REQUEST_REFUSED').length}`);
  if (executionMode !== 'offline-stub') {
    console.log(`  model-request budget remaining: ${Math.max(0, verified.gate.requestCap - budget.filter((e) => e.type === 'REQUEST_RESERVE').length)} / ${verified.gate.requestCap}`);
  }
} catch (e) {
  console.error(`run-challenge-study: FAIL — ${e.message}`);
  process.exit(1);
}
})();
