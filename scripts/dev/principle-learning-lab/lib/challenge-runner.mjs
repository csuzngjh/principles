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
// Stage R boundary (v0.4 §7.2, Stage R readiness): an actor that does NOT
// declare itself an offline stub must pass verifyStageRAuthorization BEFORE
// the runner reserves any budget for its unit — a NOT_AUTHORIZED / expired /
// revoked / probe-missing refusal consumes nothing, invokes no actor step and
// leaves no attempt record. Stub execution keeps the historical Phase 1B
// contract unchanged (no gate involved).

import fs from 'node:fs';
import path from 'node:path';
import { hashOfCanonical, sha256 } from './challenge-freeze.mjs';
import { verifyCanonicalHash } from './challenge-freeze.mjs';
import { buildClaimEnvironment, newClaimRunState } from './claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from './claim-evidence-scorer.mjs';
import { runControlledActorLoop, SimulatedCrashError, perfectPlayActor, createGreedyObserverStub, createNaiveStub } from './challenge-actor.mjs';
import { acquireStudyWriteLock, releaseStudyWriteLock, createChallengeLedger } from './challenge-ledger.mjs';
import { buildStudyArms, auditArmIsolation, composeArmPrompt } from './challenge-arms.mjs';
import { verifyStageRAuthorization, isOfflineStubActor, readStudyPlanHash, readObservedHostEvidence } from './challenge-stage-r-gate.mjs';

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

/**
 * Serial study run. One writer (lock), one unit at a time, append-only
 * records. Each unit: verify frozen → classify recovery state → reserve →
 * prepare → execute loop → score → persist attempt atomically → settle.
 */
export function runChallengeStudy({
  studyDir,
  plan,
  actorFactory,
  maxAttemptsTotal = 999,
  owner = 'challenge-runner',
  deps = {},
  execution = null,
}) {
  const adjudicate = deps.adjudicate || adjudicateClaimEvidence;
  const ledger = createChallengeLedger(studyDir);
  const lock = acquireStudyWriteLock(studyDir, { owner });
  ledger.appendEvent({ type: 'RUN_STARTED', owner, plan });

  const summary = { studyId: null, units: [], interrupted: null };
  const attemptId = plan.attemptId || 'a1';
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

          // Stage R boundary (v0.4 §7.2): create and classify the actor
          // BEFORE any budget mutation. A non-stub actor is refused with ZERO
          // side effects (no reservation, no PREPARED, no actor step) unless
          // a Stage R authorization bound to the freshly recomputed frozen
          // study passes the gate.
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
          let actor;
          try {
            actor = actorFactory({ armId, caseId, caseDef, caseVisible });
          } catch (e) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'actor_factory_error', detail: e.message });
            summary.units.push({ unit, state: 'FAILED_KNOWN', refused: true, detail: `actor_factory_error: ${e.message}` });
            continue;
          }
          let executionMode = null; // null = offline stub (Phase 1B contract, no gate)
          if (!isOfflineStubActor(actor)) {
            let gate;
            if (!execution || !execution.authorizationRecord) {
              gate = { ok: false, reasons: ['stage R execution config missing — a real (non-stub) actor requires execution.authorizationRecord (challenge-stage-authorization.v1, status APPROVED); run-authorization.json stays NOT_AUTHORIZED until the Owner issues one'] };
            } else {
              let frozenBindings = null;
              try {
                const frozenForGate = verifyFrozenStudy(studyDir);
                frozenBindings = {
                  studyId: frozenForGate.studyId,
                  suiteHash: frozenForGate.suiteHash,
                  mappingHash: frozenForGate.mappingHash,
                  graderHash: frozenForGate.graderHash,
                  studyPlanHash: readStudyPlanHash(studyDir),
                };
              } catch (e) {
                gate = { ok: false, reasons: [`frozen_study_drift: ${e.message}`] };
              }
              if (frozenBindings) {
                gate = verifyStageRAuthorization({ authorizationRecord: execution.authorizationRecord, bindings: frozenBindings, plan, maxAttemptsTotal, now: execution.now });
              }
            }
            if (!gate.ok) {
              ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'stage_r_not_authorized', detail: gate.reasons });
              summary.units.push({ unit, state: 'STAGE_R_REFUSED', refused: true, reasons: gate.reasons });
              continue;
            }
            executionMode = gate.executionMode;
          }
          // NOT_STARTED or RESERVED_NOT_PREPARED (idempotent reservation)
          const reserve = ledger.reserveAttempt({ unit, maxAttemptsTotal, reason: `unit ${caseId}/${armId}/r${repetitionId}` });
          if (!reserve.ok) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: reserve.code, used: reserve.used, cap: reserve.cap });
            summary.units.push({ unit, state: 'BUDGET_EXHAUSTED', refused: true });
            continue;
          }

          // Per-unit fail-closed frozen verification (drift mid-study aborts this unit)
          let frozen;
          let armCheck;
          try {
            frozen = verifyFrozenStudy(studyDir);
            armCheck = verifyArmConfigsFrozen(studyDir);
          } catch (e) {
            ledger.appendEvent({ type: 'UNIT_REFUSED', unit, reason: 'frozen_study_drift', detail: e.message });
            summary.units.push({ unit, state: 'SUITE_DRIFT', refused: true, detail: e.message });
            continue;
          }

          ledger.markPrepared(unit);
          ledger.appendEvent({ type: 'UNIT_PREPARED', unit, suiteHash: frozen.suiteHash });

          const env = buildClaimEnvironment(caseDef);
          const runState = newClaimRunState(env);
          const arm = armCheck.arms[armId];
          const prompt = composeArmPrompt({ arms: armCheck.arms, armId, taskText: caseVisible.taskText });
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
          summary.studyId = frozen.studyId;

          try {
            const { trace } = runControlledActorLoop({ env, runState, caseVisible, actor, linkage });
            const adjudication = adjudicate({ caseDef, runState });

            // Real-mode authorization linkage: echoed on the attempt so the
            // record itself proves which authorization produced it (probe
            // evidence included for F2). Stub attempts stay byte-identical to
            // the historical Phase 1B records — no extra fields.
            const authorizationLinkage = executionMode ? {
              schema: execution.authorizationRecord.schema,
              studyId: execution.authorizationRecord.studyId,
              suiteHash: execution.authorizationRecord.suiteHash,
              executionMode,
              issuedBy: execution.authorizationRecord.issuedBy,
              isolationAcceptance: execution.authorizationRecord.isolationAcceptance || null,
            } : null;
            const attempt = {
              schema: 'challenge-attempt.v1',
              unit,
              mode: executionMode || 'offline-stub',
              ...(executionMode ? { authorization: authorizationLinkage, observedHostEvidence: readObservedHostEvidence(actor) } : {}),
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
          } catch (e) {
            if (e instanceof SimulatedCrashError) {
              // Process-death simulation: no result row, no attempt file, lock
              // stays held — the unit remains PREPARED-without-RESULT.
              ledger.appendEvent({ type: 'UNIT_INTERRUPTED', unit, detail: e.message });
              summary.interrupted = { unit, at: e.atStep };
              throw e;
            }
            const failureDetail = `execution_error: ${e.message}`;
            ledger.markResult(unit, 'FAILED_KNOWN', failureDetail);
            const attemptDir = path.join(studyDir, 'runs', caseId, armId, `r${repetitionId}`);
            fs.mkdirSync(attemptDir, { recursive: true });
            fs.writeFileSync(path.join(attemptDir, `${attemptId}.json`), `${JSON.stringify({ schema: 'challenge-attempt.v1', unit, mode: executionMode || 'offline-stub', result: 'FAILED_KNOWN', error: failureDetail }, null, 2)}\n`, 'utf8');
            ledger.appendEvent({ type: 'UNIT_FINISHED', unit, result: 'FAILED_KNOWN', detail: failureDetail });
            summary.units.push({ unit, state: 'FAILED_KNOWN', detail: failureDetail });
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
