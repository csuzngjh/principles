// SPEC-PD-EXAMINER-001 v0.3/v0.4 — Phase 1B serial research Runner for
// challenge studies (offline stub execution has no transport/network/DB/clock).
//
// Golden path per SPEC §2.3: frozen suite → actor input → legal actions →
// oracle observations → actor report → ActorTraceV1 → deterministic scoring →
// research records. Fail-closed before every unit: all frozen hashes are
// recomputed (suite/mapping/grader/per-case/principle/arms); drift aborts the
// unit without touching frozen assets.
//
// Crash/recovery semantics (SPEC §7.4/§8, offline analog):
//   RESERVE (never returned) → ATTEMPT_PREPARED → execute → ATTEMPT_RESULT.
//   PREPARED without RESULT  ⇒ RESULT_UNKNOWN: NO auto-retry of the same
//   attemptId; recovery of that attempt is refused; only a NEW attemptId may
//   be reserved. A simulated crash also leaves the study writer lock held —
//   recovery requires explicit release by the same owner.
//
// Stage R boundary (v0.4 §7.2, Stage R readiness): the execution mode is
// RUNNER-CONTROLLED — declared once via `execution.mode` (one of
// 'offline-stub' | 'F1-direct-model' | 'F2-real-host'), never derived from
// actor self-report. An actor's own `offlineStub`/`kind` declaration is only
// a SECONDARY consistency check: under a stub declaration a non-stub actor
// refuses, and under a real declaration the actor must carry the matching
// executionMode + the authorization-bound model identity. Real modes read
// the AUTHORITATIVE authorization from the study's own
// run-authorization.json (readStageRAuthorization — no caller-passed
// in-memory authorization object exists on this path), and the gate runs
// BEFORE the actor factory is ever invoked: a NOT_AUTHORIZED / expired /
// revoked / probe-missing / mode-mismatched refusal constructs nothing,
// reserves nothing and invokes no actor step. Real execution additionally
// reserves ONE ledger slot per model REQUEST (auth.requestCap — an attempt
// may span many requests; the attempt cap is not a request budget). Stub
// execution keeps the historical Phase 1B contract unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { hashOfCanonical, sha256, challengeImplementationManifest } from './challenge-freeze.mjs';
import { verifyCanonicalHash } from './challenge-freeze.mjs';
import { buildClaimEnvironment, newClaimRunState } from './claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from './claim-evidence-scorer.mjs';
import { runControlledActorLoop, SimulatedCrashError, perfectPlayActor, createGreedyObserverStub, createNaiveStub } from './challenge-actor.mjs';
import { acquireStudyWriteLock, releaseStudyWriteLock, createChallengeLedger } from './challenge-ledger.mjs';
import { buildStudyArms, auditArmIsolation, composeArmPrompt } from './challenge-arms.mjs';
import { verifyStageRAuthorization, isOfflineStubActor, readStudyPlanHash, readObservedHostEvidence, readStageRAuthorization, readAuthorizationRevocations } from './challenge-stage-r-gate.mjs';
import { verifyF2ProbeEvidence } from './challenge-isolation-probe.mjs';

export class FrozenStudyDriftError extends Error {
  constructor(details) {
    super(`frozen study drift detected — refusing to run: ${details}`);
    this.name = 'FrozenStudyDriftError';
    this.details = details;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Fail-closed recomputation of every frozen binding. Throws
 * FrozenStudyDriftError on any mismatch; returns the verified refs on success.
 */
export function verifyFrozenStudy(studyDir) {
  const problems = [];
  const inputManifest = readJson(path.join(studyDir, 'input-manifest.json'));
  const principle = readJson(path.join(studyDir, 'principle-frozen.json'));
  const mapping = readJson(path.join(studyDir, 'pain-mechanism-mapping.json'));
  const scoringContract = readJson(path.join(studyDir, 'scoring-contract.json'));
  const manifest = readJson(path.join(studyDir, 'suite-manifest.json'));

  if (!['claim-evidence-scoring.v1', 'claim-evidence-scoring.v2'].includes(scoringContract.schema)) {
    problems.push('unsupported scoring contract version');
  }
  if (scoringContract.schema === 'claim-evidence-scoring.v2'
      && hashOfCanonical(scoringContract.implementation) !== hashOfCanonical(challengeImplementationManifest())) {
    problems.push('v2 scoring implementation drift');
  }

  const principleContentHash = hashOfCanonical(principle.contentJson);
  if (principleContentHash !== inputManifest.expectedSourceHashes.principleContentHash) problems.push('principle content hash != input-manifest expected');
  if (principleContentHash !== mapping.principleContentHash) problems.push('mapping.principleContentHash mismatch');

  if (!verifyCanonicalHash(mapping, mapping.mappingHash, { stripFields: ['mappingHash'] }).ok) problems.push('mappingHash drift');
  const graderHash = hashOfCanonical(scoringContract);
  if (!verifyCanonicalHash(manifest, manifest.suiteHash, { stripFields: ['suiteHash'] }).ok) problems.push('suiteHash drift');
  if (manifest.mappingHash !== mapping.mappingHash) problems.push('manifest↔mapping mappingHash mismatch');
  if (manifest.graderHash !== graderHash) problems.push('manifest↔scoring-contract graderHash mismatch');

  for (const c of manifest.cases) {
    const judgeFile = path.join(studyDir, 'judge-only', `${c.caseId}.json`);
    const visibleFile = path.join(studyDir, 'actor-visible', `${c.caseId}.json`);
    if (!fs.existsSync(judgeFile) || !fs.existsSync(visibleFile)) { problems.push(`case ${c.caseId}: missing frozen file`); continue; }
    const judge = readJson(judgeFile);
    const expectedJudgeSchema = scoringContract.schema === 'claim-evidence-scoring.v2' ? 'claim-evidence-judge-only.v2' : 'claim-evidence-judge-only.v1';
    if (judge.schema !== expectedJudgeSchema) {
      problems.push(`case ${c.caseId}: scoring contract version mismatch`);
    }
    const visible = readJson(visibleFile);
    if (!verifyCanonicalHash(judge, c.goldHash, { stripFields: ['inputHash', 'goldHash'] }).ok) problems.push(`case ${c.caseId}: judge-only goldHash drift`);
    if (hashOfCanonical(visible) !== c.inputHash) problems.push(`case ${c.caseId}: actor-visible inputHash drift`);
    if (judge.inputHash !== c.inputHash || judge.goldHash !== c.goldHash) problems.push(`case ${c.caseId}: judge-only hash fields != manifest`);
  }
  if (problems.length > 0) throw new FrozenStudyDriftError(problems.join('; '));
  return {
    studyId: manifest.studyId,
    suiteHash: manifest.suiteHash,
    mappingHash: mapping.mappingHash,
    graderHash,
    principleContentHash,
    manifest,
  };
}

/**
 * Rebuild the A/B/C arm configs from CANONICAL frozen sources and compare
 * with the stored arm-configs.json (payload hashes + isolation audit). Catches
 * arm-content mixing (e.g. summary text swapped into arm B).
 */
export function verifyArmConfigsFrozen(studyDir) {
  const principle = readJson(path.join(studyDir, 'principle-frozen.json'));
  const summaryPayload = readJson(path.join(studyDir, 'arm-payload-experience-summary.json'));
  const armConfigs = readJson(path.join(studyDir, 'arm-configs.json'));
  const prereg = readJson(path.join(studyDir, 'preregistration.json'));
  const rebuilt = buildStudyArms({
    commonContextText: prereg.commonContext.text,
    principleStatement: principle.contentJson.principleDraft.statement,
    summaryText: summaryPayload.text,
    budgetChars: prereg.delivery.budgetChars,
  });
  const problems = [];
  if (armConfigs.arms.A.delivery.payloadText !== '') problems.push('stored arm A payload not empty');
  if (armConfigs.arms.B.delivery.payloadHash !== rebuilt.arms.B.delivery.payloadHash) problems.push('arm B payloadHash != frozen principle statement');
  if (armConfigs.arms.C.delivery.payloadHash !== rebuilt.arms.C.delivery.payloadHash) problems.push('arm C payloadHash != frozen summary');
  if (rebuilt.arms.B.delivery.payloadHash !== sha256(principle.contentJson.principleDraft.statement)) problems.push('arm B payload is not the exact frozen statement');
  const manifest = readJson(path.join(studyDir, 'suite-manifest.json'));
  const firstCaseId = manifest.cases[0].caseId;
  const audit = auditArmIsolation({
    arms: rebuilt.arms,
    commonContextText: prereg.commonContext.text,
    taskText: readJson(path.join(studyDir, 'actor-visible', `${firstCaseId}.json`)).taskText,
    normativeMarkers: summaryPayload.normativeMarkersThatMustNotAppear,
  });
  if (!audit.ok) problems.push(...audit.problems.map((p) => `isolation: ${p}`));
  if (problems.length > 0) throw new FrozenStudyDriftError(problems.join('; '));
  return {
    arms: rebuilt.arms,
    commonContextHash: rebuilt.commonContextHash,
    evidence: audit.evidence,
  };
}

export const STUB_STRATEGIES = {
  'perfect-play': (ctx) => perfectPlayActor(ctx.caseDef),
  'greedy-observer': () => createGreedyObserverStub(),
  naive: () => createNaiveStub(),
};

export const RUNNER_EXECUTION_MODES = ['offline-stub', 'F1-direct-model', 'F2-real-host'];

/** Automatic dispatch stop: after this many CONSECUTIVE RESULT_UNKNOWN unit
 *  settlements in one run, every remaining unit is refused (UNKNOWN_STREAK_
 *  STOPPED) before any dispatch. Run-scoped; never mutates authorization,
 *  budget or plan. */
export const STAGE_R_UNKNOWN_STREAK_LIMIT = 3;

/** Capacity circuit breaker: after this many CONSECUTIVE unit settlements
 *  whose failure is a PROVEN provider-capacity condition (HTTP 429 rate
 *  limiting, or an explicit HTTP 5xx upstream-overload status), every
 *  remaining unit is refused (CAPACITY_STREAK_STOPPED) before any dispatch.
 *  Deliberately narrow: identity mismatches, output-contract violations,
 *  authorization refusals and other known failures are NOT capacity errors
 *  and do not arm this breaker. */
export const STAGE_R_CAPACITY_STREAK_LIMIT = 3;

/** Classify a FAILED_KNOWN detail string as a provider-capacity failure.
 *  The detail is `execution_error: <responder message>`; only responder-
 *  classified 429 (`rate_limited (HTTP 429)`) and explicit 5xx statuses
 *  (`http_500:`…`http_599:`) count — both carry server-attested evidence,
 *  never a guess. */
export function isCapacityFailureDetail(detail) {
  if (typeof detail !== 'string') return false;
  const message = detail.startsWith('execution_error: ') ? detail.slice('execution_error: '.length) : detail;
  return message.startsWith('rate_limited (HTTP 429)') || /^http_5\d\d\b/.test(message);
}

/**
 * Serial study run. One writer (lock), one unit at a time, append-only
 * records. Each unit: verify frozen + compose the arm prompt → classify
 * recovery state → gate (real modes, BEFORE the factory) → create actor →
 * reserve → prepare → execute loop → score → persist attempt atomically →
 * settle. The run is ASYNC (real F1/F2 actors answer across real
 * transports); offline stubs are awaited transparently and byte-identical.
 */
export async function runChallengeStudy({
  studyDir,
  plan,
  actorFactory,
  maxAttemptsTotal = 999,
  owner = 'challenge-runner',
  deps = {},
  execution = null,
}) {
  const declaredMode = execution && execution.mode !== undefined ? execution.mode : 'offline-stub';
  if (!RUNNER_EXECUTION_MODES.includes(declaredMode)) {
    throw new Error(`runChallengeStudy: execution.mode must be one of ${RUNNER_EXECUTION_MODES.join(' | ')} (got '${String(declaredMode)}') — the runner, not the actor, declares the execution mode`);
  }
  const isRealMode = declaredMode !== 'offline-stub';
  // P1-2: real execution reads the AUTHORITATIVE record from the study
  // directory — the same run-authorization.json whose NOT_AUTHORIZED
  // placeholder the gate enforces. Tests inject fixtures by writing this
  // file inside a COPIED study dir; there is no in-memory override path.
  const authorizationRecord = isRealMode ? readStageRAuthorization(studyDir) : null;
  const adjudicate = deps.adjudicate || adjudicateClaimEvidence;
  const ledger = createChallengeLedger(studyDir);
  const lock = acquireStudyWriteLock(studyDir, { owner });
  ledger.appendEvent({ type: 'RUN_STARTED', owner, plan });

  const summary = { studyId: null, units: [], interrupted: null, stoppedReason: null };
  const attemptId = plan.attemptId || 'a1';
  // Automatic dispatch stop (SPEC §7.4 discipline, made machine-enforced):
  // after N CONSECUTIVE units settle RESULT_UNKNOWN in THIS run, no further
  // unit may dispatch anything. The streak counts only actual settlements:
  // an ambiguous RESULT_UNKNOWN increments it; a SUCCEEDED or FAILED_KNOWN
  // settlement resets it; recovery-classified units, skips and refusals
  // leave it unchanged. The stop is run-scoped — it never touches the
  // authorization, never widens the budget, never changes the plan, and
  // keeps every existing ledger row and attempt record intact.
  let consecutiveUnknown = 0;
  // Capacity circuit breaker (distinct from the unknown streak): counts only
  // unit settlements whose failure detail is a PROVEN provider-capacity
  // condition (429 / explicit 5xx). A SUCCEEDED settlement or a NON-capacity
  // FAILED_KNOWN settlement breaks the streak; skips and refusals leave it
  // unchanged. Same run-scoped discipline as the unknown streak.
  let consecutiveCapacityFailures = 0;
  try {
    for (const armId of plan.arms) {
      for (const caseId of plan.cases) {
        for (const repetitionId of plan.repetitions) {
          const unit = { caseId, armId, repetitionId, attemptId };
          const before = ledger.classifyUnit(unit);

          if (before.state === 'SUCCEEDED' || before.state === 'FAILED_KNOWN') {
            ledger.appendEvent({ type: 'UNIT_SKIPPED', unit, reason: 'already_recorded_no_rerun', recordedResult: before.state });
            summary.units.push({ unit, state: before.state, skipped: true });
            continue;
          }
          if (before.state === 'RESULT_UNKNOWN') {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'result_unknown_no_auto_retry' });
            summary.units.push({ unit, state: 'RESULT_UNKNOWN', refused: true });
            continue;
          }
          if (consecutiveUnknown >= STAGE_R_UNKNOWN_STREAK_LIMIT) {
            // streak stop: BEFORE any input read, gate call, factory
            // invocation or reservation — nothing downstream can dispatch.
            if (summary.stoppedReason === null) summary.stoppedReason = `stage_r_unknown_streak_stop: ${consecutiveUnknown} consecutive RESULT_UNKNOWN units — automatic dispatch stop`;
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_unknown_streak_stop', detail: `${consecutiveUnknown} consecutive RESULT_UNKNOWN units — no further dispatch this run (resume requires a new run; settled attempts are never retried)` });
            summary.units.push({ unit, state: 'UNKNOWN_STREAK_STOPPED', refused: true, reason: 'stage_r_unknown_streak_stop' });
            continue;
          }
          if (consecutiveCapacityFailures >= STAGE_R_CAPACITY_STREAK_LIMIT) {
            // capacity breaker: same pre-everything stop shape — no input
            // read, no gate call, no factory, no reservation. Proven 429/5xx
            // saturation means more dispatch would only burn budget.
            if (summary.stoppedReason === null) summary.stoppedReason = `stage_r_capacity_streak_stop: ${consecutiveCapacityFailures} consecutive provider-capacity (429/5xx) failures — automatic dispatch stop`;
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_capacity_streak_stop', detail: `${consecutiveCapacityFailures} consecutive provider-capacity (429/5xx) unit failures — no further dispatch this run (failover requires a NEW authorization bound to the alternate model; settled attempts and reservations are kept)` });
            summary.units.push({ unit, state: 'CAPACITY_STREAK_STOPPED', refused: true, reason: 'stage_r_capacity_streak_stop' });
            continue;
          }

          let caseDef;
          let caseVisible;
          try {
            caseDef = readJson(path.join(studyDir, 'judge-only', `${caseId}.json`));
            caseVisible = readJson(path.join(studyDir, 'actor-visible', `${caseId}.json`));
          } catch (e) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'unit_inputs_unreadable', detail: e.message });
            summary.units.push({ unit, state: 'SUITE_DRIFT', refused: true, detail: e.message });
            continue;
          }

          // Per-unit fail-closed frozen verification + ARM PROMPT composition
          // FIRST (read-only, zero mutations): the composed arm prompt must
          // exist before the gate and the actor factory — a real actor
          // without its arm delivery would erase the A/B/C contrast, and
          // drift must refuse before anything is constructed or reserved.
          let frozen;
          let armCheck;
          let armPrompt;
          try {
            frozen = verifyFrozenStudy(studyDir);
            armCheck = verifyArmConfigsFrozen(studyDir);
            armPrompt = composeArmPrompt({ arms: armCheck.arms, armId, taskText: caseVisible.taskText });
          } catch (e) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'frozen_study_drift', detail: e.message });
            summary.units.push({ unit, state: 'SUITE_DRIFT', refused: true, detail: e.message });
            continue;
          }
          summary.studyId = frozen.studyId;

          // Stage R boundary (v0.4 §7.2): the runner-declared execution mode
          // is authoritative and the gate runs BEFORE the actor factory is
          // ever invoked — an unauthorized real run constructs no actor,
          // reserves nothing and takes zero actor steps. Bindings come from
          // the frozen verification above (freshly recomputed, never stored).
          // `execution.now` may be a NUMBER (fixed clock, deterministic tests)
          // or a FUNCTION (evaluated PER UNIT — the production CLI passes
          // () => Date.now() so an authorization that expires mid-run is
          // refused for every subsequent unit, not just at startup).
          let gate = null;
          if (isRealMode) {
            gate = verifyStageRAuthorization({
              authorizationRecord,
              retiredAuthorizations: readAuthorizationRevocations(), // archived-evidence records refused at ANY clock, any study copy (Owner P1-1 isolation scheme)
              bindings: {
                studyId: frozen.studyId,
                suiteHash: frozen.suiteHash,
                mappingHash: frozen.mappingHash,
                graderHash: frozen.graderHash,
                studyPlanHash: readStudyPlanHash(studyDir),
              },
              plan,
              maxAttemptsTotal,
              now: typeof execution.now === 'function' ? execution.now() : execution.now,
              declaredExecutionMode: declaredMode,
              declaredRequestTimeoutMs: execution.requestTimeoutMs, // undefined = default 240000 (the gate enforces the authorization binding)
              declaredMaxRequestsPerAttempt: execution.maxRequestsPerAttempt, // undefined = no per-attempt cap approved (the gate enforces the authorization binding)
            });
            if (!gate.ok) {
              ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_not_authorized', detail: gate.reasons });
              summary.units.push({ unit, state: 'STAGE_R_REFUSED', refused: true, reasons: gate.reasons });
              continue;
            }
            // PRI-1037 deep evidence verification (F2 only, after the gate's
            // structural probe check, BEFORE the factory): the authorization's
            // realHostProbe.evidenceRef must resolve to a real-host-executed,
            // all-checks-PASSED probe record bound to THIS frozen study, with
            // every recorded session corroborated by the host's own evidence.
            // Host dispatch follows the probe binding's hostKind: codex-cli →
            // rollout corroboration under execution.codexHome (historical
            // path); openclaw → exec-state corroboration with the operator-
            // declared probe controlled root (execution.probeControlledRoot —
            // the workRoot rounds dir the probe ran in; missing = refuse,
            // never a silent skip). Offline-rehearsal, missing, corrupt,
            // mismatched or uncorroborated evidence refuses F2.
            if (declaredMode === 'F2-real-host') {
              const probeBinding = authorizationRecord && authorizationRecord.isolationAcceptance && authorizationRecord.isolationAcceptance.realHostProbe;
              const probeHostKind = probeBinding && probeBinding.hostKind === 'openclaw' ? 'openclaw' : 'codex-cli';
              const { readOpenClawExecStateTrajectory } = await import('./challenge-openclaw-host.mjs');
              const probeVerify = verifyF2ProbeEvidence({
                studyDir,
                evidenceRef: probeBinding
                  ? probeBinding.evidenceRef
                  : null,
                expected: { studyId: frozen.studyId, suiteHash: frozen.suiteHash },
                codexHome: probeHostKind === 'codex-cli' ? (execution.codexHome ?? null) : null,
                hostKind: probeHostKind,
                ...(probeHostKind === 'openclaw' ? {
                  openclawControlledRoot: execution.probeControlledRoot ?? null,
                  readOpenClawTrajectory: readOpenClawExecStateTrajectory,
                } : {}),
              });
              if (!probeVerify.ok) {
                ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_probe_evidence_invalid', detail: probeVerify.reasons });
                summary.units.push({ unit, state: 'STAGE_R_REFUSED', refused: true, reasons: probeVerify.reasons });
                continue;
              }
            }
          }
          let actor;
          try {
            actor = actorFactory({
              armId,
              caseId,
              repetitionId, // unit-unique taskId segment for host transports (one host session per SPEC §6.2.8 unit)
              caseDef,
              caseVisible,
              armPrompt, // SPEC §6.2 — the ONLY injection channel a real actor receives
              frozenRefs: { suiteHash: frozen.suiteHash, mappingHash: frozen.mappingHash, graderHash: frozen.graderHash },
            });
          } catch (e) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'actor_factory_error', detail: e.message });
            summary.units.push({ unit, state: 'FAILED_KNOWN', refused: true, detail: `actor_factory_error: ${e.message}` });
            continue;
          }
          // Mode consistency (P1-1/P1-5): the declared mode is the authority;
          // the produced actor must agree. A real declaration refuses stub
          // actors, executionMode mismatches and wiring whose requested model
          // identity is not the authorization-bound actor identity; a stub
          // declaration refuses anything that is not a declared stub. Actor
          // self-declaration alone can never select the execution mode.
          if (isRealMode) {
            const modeReasons = [];
            if (isOfflineStubActor(actor)) modeReasons.push('actor declares itself an offline stub under a real (F1/F2) execution declaration');
            if (actor.executionMode !== declaredMode) modeReasons.push(`actor executionMode '${actor.executionMode ?? null}' does not match the runner-declared '${declaredMode}'`);
            if (typeof actor.requestedModelIdentity !== 'string' || actor.requestedModelIdentity.length === 0) {
              modeReasons.push('real actor must expose requestedModelIdentity (the model identity its wiring requests)');
            } else if (actor.requestedModelIdentity !== authorizationRecord.requestedActorIdentity
              && !actor.requestedModelIdentity.endsWith(`/${authorizationRecord.requestedActorIdentity}`)) {
              modeReasons.push(`actor requestedModelIdentity '${actor.requestedModelIdentity}' is not the authorization-bound requestedActorIdentity '${authorizationRecord.requestedActorIdentity}'`);
            }
            if (modeReasons.length > 0) {
              ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_mode_mismatch', detail: modeReasons });
              summary.units.push({ unit, state: 'STAGE_R_REFUSED', refused: true, reasons: modeReasons });
              continue;
            }
          } else if (!isOfflineStubActor(actor)) {
            const reasons = ['runner declared offline-stub execution but the actorFactory produced a NON-stub actor — real execution requires execution.mode (F1-direct-model | F2-real-host) and an APPROVED run-authorization.json in the study directory'];
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_not_authorized', detail: reasons });
            summary.units.push({ unit, state: 'STAGE_R_REFUSED', refused: true, reasons });
            continue;
          }
          const executionMode = isRealMode ? declaredMode : null;
          // NOT_STARTED or RESERVED_NOT_PREPARED (idempotent reservation)
          const reserve = ledger.reserveAttempt({ unit, maxAttemptsTotal, reason: `unit ${caseId}/${armId}/r${repetitionId}` });
          if (!reserve.ok) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: reserve.code, used: reserve.used, cap: reserve.cap });
            summary.units.push({ unit, state: 'BUDGET_EXHAUSTED', refused: true });
            continue;
          }

          ledger.markPrepared(unit);
          ledger.appendEvent({ type: 'UNIT_PREPARED', unit, suiteHash: frozen.suiteHash });

          const env = buildClaimEnvironment(caseDef);
          const runState = newClaimRunState(env);
          const arm = armCheck.arms[armId];
          const prompt = armPrompt;
          if (armId === 'A' && prompt.includes(armCheck.arms.B.delivery.payloadText) && armCheck.arms.B.delivery.payloadText !== '') {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'arm_a_payload_contamination' });
            summary.units.push({ unit, state: 'CONFOUNDED', refused: true });
            continue;
          }

          const linkage = {
            suiteHash: frozen.suiteHash,
            mappingHash: frozen.mappingHash,
            graderHash: frozen.graderHash,
            principleContentHash: frozen.principleContentHash,
            armId,
            contentMode: arm.contentMode,
            armPayloadHash: arm.delivery.payloadHash,
            inputHash: caseVisible.inputHash || frozen.manifest.cases.find((c) => c.caseId === caseId).inputHash,
          };

          // Real-mode authorization linkage: echoed on EVERY attempt record
          // (SUCCEEDED, FAILED_KNOWN and ambiguous RESULT_UNKNOWN alike) so
          // the record itself proves which authorization produced it (probe
          // evidence included for F2) — a failed real-host attempt is still
          // real-host evidence and must not poison deriveRealHostBaseline as
          // linkage-missing. Stub attempts stay byte-identical to the
          // historical Phase 1B records — no extra fields.
          const authorizationLinkage = executionMode ? {
            schema: authorizationRecord.schema,
            studyId: authorizationRecord.studyId,
            suiteHash: authorizationRecord.suiteHash,
            executionMode,
            issuedBy: authorizationRecord.issuedBy,
            isolationAcceptance: authorizationRecord.isolationAcceptance || null,
          } : null;

          // P1-7 request-level budget: real actors may answer over MANY model
          // requests per attempt; each request reserves one ledger slot
          // (auth.requestCap) BEFORE dispatch via the loop hook. A refusal
          // never reaches the actor (the request is not sent), and dispatched
          // but unanswered requests keep their slot (RESULT_UNKNOWN, no
          // auto-retry). Stub runs pass no hook — zero behavioral change.
          // Per-attempt cap (authorization-bound, gate-checked): when
          // execution.maxRequestsPerAttempt is declared and approved, a step
          // at/above the cap refuses its reservation — the loop terminates
          // (request_budget_exhausted) BEFORE the request is sent, so one
          // attempt can never exceed the approved per-attempt request budget.
          const perAttemptCap = isRealMode && execution.maxRequestsPerAttempt !== undefined ? execution.maxRequestsPerAttempt : null;
          const reserveRequest = isRealMode
            ? (step) => {
              if (perAttemptCap !== null && step >= perAttemptCap) {
                return { ok: false, reason: `per_attempt_request_cap: step ${step} reached the approved per-attempt request cap ${perAttemptCap} — request NOT sent; the attempt settles bounded` };
              }
              return ledger.reserveModelRequest({
                key: `${attemptId}:${caseId}/${armId}/r${repetitionId}:step${step}`,
                unit,
                maxRequestsTotal: gate.requestCap,
                reason: `model request (unit ${caseId}/${armId}/r${repetitionId} step ${step})`,
              });
            }
            : null;

          try {
            const { trace } = await runControlledActorLoop({ env, runState, caseVisible, actor, linkage, reserveRequest });
            const adjudication = adjudicate({ caseDef, runState });

            const attempt = {
              schema: 'challenge-attempt.v1',
              unit,
              mode: executionMode || 'offline-stub',
              ...(executionMode ? {
                authorization: authorizationLinkage,
                observedHostEvidence: readObservedHostEvidence(actor),
                actorRounds: Array.isArray(actor.roundLog) ? actor.roundLog.slice() : [],
              } : {}),
              actorKind: trace.actorKind,
              frozenRefs: linkage,
              promptAudit: { armId, contentMode: arm.contentMode, payloadHash: arm.delivery.payloadHash, promptLength: prompt.length },
              actorInputHash: linkage.inputHash,
              trace,
              adjudication,
              result: 'SUCCEEDED',
              note: 'trace is actor-side evidence (implies stripped); adjudication is the judge-side record',
            };
            const attemptDir = path.join(studyDir, 'runs', caseId, armId, `r${repetitionId}`);
            fs.mkdirSync(attemptDir, { recursive: true });
            const attemptFile = path.join(attemptDir, `${attemptId}.json`);
            const tmp = `${attemptFile}.tmp`;
            fs.writeFileSync(tmp, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');
            fs.renameSync(tmp, attemptFile);

            ledger.markResult(unit, 'SUCCEEDED', adjudication.objectiveTaskOutcome);
            ledger.appendAdjudication({ unit, suiteHash: frozen.suiteHash, objectiveTaskOutcome: adjudication.objectiveTaskOutcome, adjudication });
            ledger.appendEvent({ type: 'UNIT_FINISHED', unit, result: 'SUCCEEDED', objectiveTaskOutcome: adjudication.objectiveTaskOutcome });
            summary.units.push({ unit, state: 'SUCCEEDED', objectiveTaskOutcome: adjudication.objectiveTaskOutcome });
            consecutiveUnknown = 0; // a definite execution settlement breaks the ambiguity streak
            consecutiveCapacityFailures = 0; // and the capacity streak (the channel answered fine)
          } catch (e) {
            if (e instanceof SimulatedCrashError) {
              // Process-death simulation: no result row, no attempt file, lock
              // stays held — the unit remains PREPARED-without-RESULT.
              ledger.appendEvent({ type: 'UNIT_INTERRUPTED', unit, detail: e.message });
              summary.interrupted = { unit, at: e.atStep };
              throw e;
            }
            const attemptDir = path.join(studyDir, 'runs', caseId, armId, `r${repetitionId}`);
            fs.mkdirSync(attemptDir, { recursive: true });
            if (e && e.ambiguous === true) {
              // Real-transport ambiguity (SPEC §7.4): the request may have
              // reached the model/host; no usable result exists. Settle the
              // attempt EXPLICITLY as RESULT_UNKNOWN — never success, never
              // clean failure, never auto-retried here. The reservation
              // (attempt AND dispatched request slots) stays consumed;
              // recovery of this attemptId is refused and only a NEW
              // attemptId may reserve again. The record still carries the
              // authorization linkage + observed evidence (merged #2139
              // discipline: every real-mode record proves its authorization).
              const detail = `result_unknown (ambiguous transport outcome): ${e.message}`;
              ledger.markResult(unit, 'RESULT_UNKNOWN', detail);
              fs.writeFileSync(path.join(attemptDir, `${attemptId}.json`), `${JSON.stringify({
                schema: 'challenge-attempt.v1',
                unit,
                mode: executionMode || 'offline-stub',
                ...(executionMode ? {
                  authorization: authorizationLinkage,
                  observedHostEvidence: readObservedHostEvidence(actor),
                  actorRounds: Array.isArray(actor.roundLog) ? actor.roundLog.slice() : [],
                } : {}),
                result: 'RESULT_UNKNOWN',
                ambiguous: true,
                error: detail,
              }, null, 2)}\n`, 'utf8');
              ledger.appendEvent({ type: 'UNIT_FINISHED', unit, result: 'RESULT_UNKNOWN', detail });
              summary.units.push({ unit, state: 'RESULT_UNKNOWN', ambiguous: true, detail });
              consecutiveUnknown += 1; // an ambiguous settlement extends the streak (dispatch stop at the limit)
              continue;
            }
            const failureDetail = `execution_error: ${e.message}`;
            ledger.markResult(unit, 'FAILED_KNOWN', failureDetail);
            fs.writeFileSync(path.join(attemptDir, `${attemptId}.json`), `${JSON.stringify({
              schema: 'challenge-attempt.v1',
              unit,
              mode: executionMode || 'offline-stub',
              ...(executionMode ? {
                authorization: authorizationLinkage,
                observedHostEvidence: readObservedHostEvidence(actor),
                actorRounds: Array.isArray(actor.roundLog) ? actor.roundLog.slice() : [],
              } : {}),
              result: 'FAILED_KNOWN',
              error: failureDetail,
            }, null, 2)}\n`, 'utf8');
            ledger.appendEvent({ type: 'UNIT_FINISHED', unit, result: 'FAILED_KNOWN', detail: failureDetail });
            summary.units.push({ unit, state: 'FAILED_KNOWN', detail: failureDetail });
            consecutiveUnknown = 0; // a definite execution settlement breaks the ambiguity streak
            // capacity breaker: ONLY proven 429/5xx failures arm it; every
            // other known failure (identity mismatch, output contract,
            // authorization-class problems…) breaks the streak — they are
            // NOT channel saturation and must surface as hard failures.
            if (isCapacityFailureDetail(failureDetail)) {
              consecutiveCapacityFailures += 1;
            } else {
              consecutiveCapacityFailures = 0;
            }
          }
        }
      }
    }
    ledger.appendEvent({ type: 'RUN_FINISHED', owner });
    releaseStudyWriteLock(studyDir, { owner });
    return summary;
  } catch (e) {
    if (e instanceof SimulatedCrashError) throw e; // crash path: lock intentionally left held
    try { releaseStudyWriteLock(studyDir, { owner }); } catch { /* already released or held by other owner */ }
    throw e;
  }
}

/** Resume entrypoint: same as runChallengeStudy but refuses to start when the
 *  lock is stale-held by a crashed writer unless released by that owner. */
export function runChallengeStudyResume(options) {
  return runChallengeStudy(options);
}
