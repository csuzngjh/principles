// SPEC-PD-EXAMINER-001 v0.4 — challenge study behavior report generator
// (SPEC §8 REPORT_READY lifecycle, §9 denominators/anomaly table/six report
// dimensions, §10 behavior-report.json + behavior-report.md, §12.4 / Phase 2b
// DoD "报告可从原始轨迹重算").
//
// Discipline (Owner-approved supplement 2026-10-26):
//   - The ONLY truth sources are the study's append-only ledgers
//     (budget-ledger.jsonl / events.jsonl / adjudications.jsonl), the frozen
//     plan artifacts (preregistration.json, suite-manifest.json, hashes.json,
//     run-authorization.json) and the per-attempt files under runs/. This
//     module is a DERIVED read model — it never writes run state and never
//     redefines scorer semantics: adjudication fields
//     (behaviorAligned/forbiddenBehaviorOccurred/objectiveTaskOutcome/
//     negativeTransfer/overCheck) are copied VERBATIM from
//     claim-evidence-scorer output embedded in each attempt.
//   - assignedDenominator comes from the PREREGISTERED plan (prereg arms ×
//     frozen suite cases × planned repetitions). run-authorization.json only
//     defines the authorized SUBSET and never shrinks the denominator.
//   - Two-layer model: plan units are (caseId, armId, repetitionId);
//     execution records are full (caseId, armId, repetitionId, attemptId).
//     Nothing is deleted — an UNKNOWN followed by a recovered new attemptId
//     keeps BOTH records; the primary analysis follows the ledger's own
//     classifyUnit last-settlement authority, and any unit whose multiple
//     SUCCEEDED attempts diverge is marked AMBIGUOUS and excluded from the
//     paired main analysis (kept in the sensitivity block).
//   - Normal UNKNOWN / FAILED_KNOWN settlements are NOT integrity errors.
//     Critical integrity findings (missing key inputs, unparseable ledger,
//     frozen-binding drift, duplicate settlement, ledger↔file conflict,
//     real-mode execution without valid authorization) force
//     REPORT_INCONCLUSIVE and suppress the REPORT_READY event.
//   - Write mode refuses the in-repo frozen challenge-studies/ area at
//     RUNTIME (resolved-path check, not calling discipline), takes the
//     study single-writer lock, writes behavior-report.json and .md
//     atomically (tmp+rename) and only THEN — and only when READY — appends
//     exactly one REPORT_READY event binding the report sha256. A committed
//     REPORT_READY report is never overwritten in place: identical
//     recomputation is an idempotent no-op, anything else requires a new
//     revision (ReportRevisionRequiredError).
//   - verify mode is STRICTLY read-only: no lock, no writes, no events.
//     Without an injected --now it reuses the existing report's generatedAt
//     so an unmodified study verifies deterministically.
//
// Relationship to lib/stage-r-f1-report.mjs (PR #2165, operational F1 run
// recomputation, schema stage-r-f1-report.v1): complementary derived views
// over the same append-only truth; this module owns the SPEC §10 study
// artifact (challenge-behavior-report.v1, six §9.4 dimensions).
//
// Zero network, zero credentials, zero environment-clock reads: time enters
// only through the injected `now` parameter (same convention as the Stage R
// gate).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical, challengeImplementationManifest } from './challenge-freeze.mjs';
import { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } from './claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from './claim-evidence-scorer.mjs';

import { sha256, verifyCanonicalHash } from './challenge-freeze.mjs';
import { verifyFrozenStudy, isCapacityFailureDetail } from './challenge-runner.mjs';
import { createChallengeLedger, acquireStudyWriteLock, releaseStudyWriteLock } from './challenge-ledger.mjs';

export const BEHAVIOR_REPORT_SCHEMA = 'challenge-behavior-report.v1';

// v0.5 is additive: historical v1 reports continue to copy their recorded
// judgments. New offline evidence must instead replay actions under a pinned
// implementation before any saved judgment is counted.
export { challengeImplementationManifest };

export function replayChallengeExecution({ caseDef, execution, implementation, studyId = 'EXM-MVP-001' }) {
  if (hashOfCanonical(implementation) !== hashOfCanonical(challengeImplementationManifest())) {
    throw new Error('IMPLEMENTATION_DRIFT');
  }
  if (caseDef.schema !== 'claim-evidence-judge-only.v2') throw new Error('v2 case required');
  if (!execution || !execution.trace || !Array.isArray(execution.trace.records)
      || execution.trace.records.length === 0) throw new Error('TRAJECTORY_EVIDENCE_INSUFFICIENT');
  if (execution.caseHash !== hashOfCanonical(caseDef)) throw new Error('GOLD_OR_INPUT_DRIFT');
  if (execution.trace.schema !== 'actor-trace.v1' || execution.trace.actorKind !== 'stub-scripted'
      || hashOfCanonical(execution.trace.linkage) !== hashOfCanonical({ studyId, caseId: caseDef.caseId })) {
    throw new Error('CALIBRATION_LINKAGE_INVALID');
  }
  const env = buildClaimEnvironment(caseDef);
  const state = newClaimRunState(env);
  let actions = 0;
  let lastResult = null;
  let invalidActions = 0;
  const expectedObservations = [];
  const expectedEvents = [];
  for (const [seq, record] of execution.trace.records.entries()) {
    if (!record || record.seq !== seq) throw new Error('TRACE_SEQUENCE_INVALID');
    if (!['action', 'observation', 'invalid_action', 'narrative_carried', 'budget_event', 'consequence', 'termination', 'behavior_event'].includes(record.kind)) throw new Error('UNKNOWN_TRACE_RECORD');
    if (record.kind === 'action') {
      if (state.done) throw new Error('ACTION_AFTER_TERMINATION');
      actions++;
      lastResult = stepClaimEnvironment(env, state, record.action);
      if (!lastResult.ok) invalidActions++;
      if (!lastResult.ok) expectedEvents.push({ kind: 'invalid_action', error: lastResult.error });
      else if (lastResult.record?.status === 'refused_budget') expectedEvents.push({ kind: 'budget_event', event: 'observation_refused_budget', obsId: lastResult.record.obsId, output: lastResult.record.output });
      else if (record.action.type === 'report') expectedEvents.push({ kind: 'termination', reason: 'report_submitted', detail: 'actor submitted final claims' });
      else if (record.action.type === 'deploy') expectedEvents.push({ kind: 'consequence', event: 'deploy', authorizationViolated: state.authorizationViolated, taskCompleted: state.taskCompleted });
      else if (['refuse', 'block-path'].includes(record.action.type)) expectedEvents.push({ kind: 'behavior_event', event: record.action.type, args: record.action.args });
      else expectedEvents.push({ kind: 'observation', obsId: lastResult.record.obsId, source: lastResult.record.source, status: lastResult.record.status, output: lastResult.record.output,
        eventId: lastResult.record.eventId, ...(lastResult.record.requestId ? { requestId: lastResult.record.requestId, requestHash: lastResult.record.requestHash } : {}) });
      if (lastResult.ok && lastResult.record && lastResult.record.status === 'ok') {
        expectedObservations.push(Object.fromEntries(['obsId', 'source', 'status', 'output']
          .map((key) => [key, lastResult.record[key]])));
      }
    } else if (record.kind === 'observation') {
      if (!lastResult || !lastResult.record || ['obsId', 'source', 'status', 'output']
        .some((key) => record[key] !== lastResult.record[key])) throw new Error('OBSERVATION_REPLAY_MISMATCH');
    } else if (record.kind === 'invalid_action') {
      if (!lastResult || lastResult.ok || record.error !== lastResult.error) throw new Error('INVALID_ACTION_REPLAY_MISMATCH');
    } else if (record.kind === 'consequence') {
      if (record.event !== 'deploy' || record.authorizationViolated !== state.authorizationViolated
          || record.taskCompleted !== state.taskCompleted) throw new Error('CONSEQUENCE_REPLAY_MISMATCH');
    } else if (record.kind === 'budget_event') {
      if (!lastResult?.record || lastResult.record.status !== 'refused_budget'
          || record.obsId !== lastResult.record.obsId || record.output !== lastResult.output) throw new Error('BUDGET_REPLAY_MISMATCH');
    }
  }
  if (actions === 0) throw new Error('TRAJECTORY_EVIDENCE_INSUFFICIENT');
  const actualEvents = execution.trace.records.filter((record) => !['action', 'narrative_carried'].includes(record.kind))
    .map(({ seq: _seq, ...event }) => event);
  if (hashOfCanonical(actualEvents) !== hashOfCanonical(expectedEvents)) throw new Error('TRACE_EVENTS_REPLAY_MISMATCH');
  if (!state.report || hashOfCanonical(execution.trace.termination) !== hashOfCanonical({ reason: 'report_submitted', actorRunStatus: 'COMPLETED' })) {
    throw new Error('EXECUTION_INCOMPLETE');
  }
  const usage = { steps: state.step, invalidActions,
    observationsExecuted: state.executedObservations.filter((r) => r.status === 'ok').length,
    budgetRefusals: state.refusedCount, budgetUsed: state.budgetUsed, timeUnits: state.timeUsed };
  if (hashOfCanonical(usage) !== hashOfCanonical(execution.trace.usage)) throw new Error('USAGE_REPLAY_MISMATCH');
  const observed = execution.trace.records.filter((r) => r.kind === 'observation')
    .map((r) => Object.fromEntries(['obsId', 'source', 'status', 'output'].map((key) => [key, r[key]])));
  if (hashOfCanonical(observed) !== hashOfCanonical(expectedObservations)) throw new Error('OBSERVATION_REPLAY_MISMATCH');
  if (hashOfCanonical(execution.trace.finalReport) !== hashOfCanonical(state.report)) throw new Error('REPORT_REPLAY_MISMATCH');
  if (hashOfCanonical(state) !== hashOfCanonical(execution.runState)) throw new Error('STATE_REPLAY_MISMATCH');
  const adjudication = adjudicateClaimEvidence({ caseDef, runState: state });
  if (hashOfCanonical(adjudication) !== hashOfCanonical(execution.adjudication)) throw new Error('SCORE_REPLAY_MISMATCH');
  return adjudication;
}

export function buildProductizationCalibrationReport({ cases, executions, implementation, candidateCounts, studyId = 'EXM-MVP-001' }) {
  if (hashOfCanonical(implementation) !== hashOfCanonical(challengeImplementationManifest())) throw new Error('IMPLEMENTATION_DRIFT');
  if (!Array.isArray(cases) || !Array.isArray(executions)) throw new Error('cases/executions required');
  const caseMap = new Map(cases.map((c) => [c.caseId, c]));
  if (caseMap.size !== cases.length) throw new Error('duplicate case ID');
  const ids = new Set();
  const rows = executions.map((execution) => {
    if (!execution || typeof execution.id !== 'string' || ids.has(execution.id)) throw new Error('duplicate/missing execution ID');
    ids.add(execution.id);
    const caseDef = caseMap.get(execution.caseId);
    if (!caseDef) throw new Error('unknown execution case');
    const score = replayChallengeExecution({ caseDef, execution, implementation, studyId });
    return { id: execution.id, caseId: caseDef.caseId, strategy: execution.strategy, score };
  });
  const denominator = rows.length;
  const negativeTransfer = rows.filter((r) => r.score.negativeTransfer === true).length;
  const knownCandidates = candidateCounts && Number.isSafeInteger(candidateCounts.total) && candidateCounts.total >= 0;
  if (candidateCounts && candidateCounts.total !== null && !knownCandidates) throw new Error('invalid candidate counts');
  if (knownCandidates && (!Number.isSafeInteger(candidateCounts.valid) || candidateCounts.valid < 0
      || candidateCounts.valid > candidateCounts.total)) throw new Error('invalid candidate counts');
  return {
    schema: 'challenge-productization-calibration-report.v1',
    status: 'OFFLINE_ONLY_NOT_AUTHORIZED',
    implementationHash: hashOfCanonical(implementation),
    rows,
    executionDenominator: denominator,
    negativeTransfer: { numerator: negativeTransfer, denominator },
    boundaryNegativeTransfer: {
      numerator: rows.filter((r) => caseMap.get(r.caseId).principleApplicable === false && r.score.negativeTransfer === true).length,
      denominator: rows.filter((r) => caseMap.get(r.caseId).principleApplicable === false).length,
    },
    negativeTransferMetrics: Object.fromEntries(['unnecessaryRefusal', 'alternativePathBlocking', 'repeatedConfirmation', 'inapplicableTrigger'].map((type) => [type, {
      numerator: rows.filter((row) => row.score.negativeTransferTypes[type].some((event) => event.status === 'DETECTED')).length,
      unknown: rows.filter((row) => row.score.negativeTransferTypes[type].some((event) => event.status === 'UNKNOWN')).length,
      denominator, deduplication: 'one execution per type; overlapping types never summed',
    }])),
    overChecking: { numerator: rows.filter((row) => row.score.overCheck.overCheckOccurred).length, denominator,
      unnecessaryCostUnits: rows.reduce((sum, row) => sum + row.score.overCheck.unnecessaryCostUnits, 0) },
    candidateCounts,
    validCandidateRate: knownCandidates && candidateCounts.total > 0
      ? { numerator: candidateCounts.valid, denominator: candidateCounts.total }
      : { status: 'NOT_ESTIMABLE', reason: 'empty_or_unknown_candidate_denominator' },
    goldReview: 'GOLD_REVIEW_PENDING',
    realExaminerValidCases: 0,
    validatedBehavioralDiscriminationRate: { status: 'NOT_RUN', reason: 'calibration_is_not_real_behavior_experiment' },
  };
}
export const REPORT_STATUS_READY = 'REPORT_READY';
export const REPORT_STATUS_INCONCLUSIVE = 'REPORT_INCONCLUSIVE';
export const REPORT_DIMENSIONS = [
  'protocolEvidenceQuality',
  'behavioralBenefit',
  'boundaryNegativeTransfer',
  'objectiveTaskOutcome',
  'cost',
  'coverage',
];

const FROZEN_STUDIES_AREA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'challenge-studies');
const REPORT_JSON = 'behavior-report.json';
const REPORT_MD = 'behavior-report.md';
const FREEZE_REFERENCE_FIELDS = [
  'suiteHash',
  'mappingHash',
  'graderHash',
  'principleContentHash',
  'summaryPayloadHash',
  'commonContextHash',
];
const SEVERITY_ORDER = { critical: 0, major: 1, info: 2 };

export class FrozenStudyWriteRefusedError extends Error {
  constructor(target, frozenArea) {
    super(`refusing to write a behavior report into the frozen study area: ${target} (frozen area: ${frozenArea}) — run the generator against a study COPY`);
    this.name = 'FrozenStudyWriteRefusedError';
    this.target = target;
    this.frozenArea = frozenArea;
  }
}

export class ReportRevisionRequiredError extends Error {
  constructor(detail) {
    super(`a REPORT_READY report is already committed and the recomputation differs — overwrite refused, create a new study revision instead: ${detail}`);
    this.name = 'ReportRevisionRequiredError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// local read helpers (mirror challenge-ledger readLines semantics: a torn
// final line is reported as malformedTail and dropped, never interpreted)
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return { entries: [], malformedTail: false, missing: true };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw === '' ? [] : raw.split('\n');
  let malformedTail = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  else if (lines.length > 0) malformedTail = true;
  const entries = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformedTail = true;
    }
  }
  return { entries, malformedTail, missing: false };
}

const unitKey = (u) => `${u.caseId}/${u.armId}/r${String(u.repetitionId)}/${String(u.attemptId)}`;
const planUnitKey = (caseId, armId, repetitionId) => `${caseId}/${armId}/r${String(repetitionId)}`;

function normalizeNow(now) {
  if (now === undefined || now === null) return null;
  const ms = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) throw new Error(`buildBehaviorReport: invalid now: ${String(now)} (ISO-8601 required)`);
  return new Date(ms).toISOString();
}

function collectAttemptFiles(studyDir) {
  const runsDir = path.join(studyDir, 'runs');
  const files = [];
  if (!fs.existsSync(runsDir)) return files;
  for (const caseId of fs.readdirSync(runsDir).sort()) {
    const caseDir = path.join(runsDir, caseId);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    for (const armId of fs.readdirSync(caseDir).sort()) {
      const armDir = path.join(caseDir, armId);
      if (!fs.statSync(armDir).isDirectory()) continue;
      for (const repDir of fs.readdirSync(armDir).sort()) {
        const repPath = path.join(armDir, repDir);
        if (!fs.statSync(repPath).isDirectory()) continue;
        for (const f of fs.readdirSync(repPath).sort()) {
          if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
          files.push({ rel: path.join('runs', caseId, armId, repDir, f), abs: path.join(repPath, f) });
        }
      }
    }
  }
  return files;
}

function classifyKnownFailure(error) {
  if (typeof error !== 'string' || error === '') return 'unclassified';
  const message = error.startsWith('execution_error: ') ? error.slice('execution_error: '.length) : error;
  if (isCapacityFailureDetail(message)) return 'capacity_failure';
  if (message.startsWith('model_identity_')) return 'identity_failure';
  return 'protocol_contract_failure';
}

function sumUsage(rounds) {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let observed = 0;
  for (const r of Array.isArray(rounds) ? rounds : []) {
    const u = r && r.usage;
    if (!u || typeof u !== 'object') continue;
    observed += 1;
    prompt += Number(u.prompt_tokens) || 0;
    completion += Number(u.completion_tokens) || 0;
    total += Number(u.total_tokens) || 0;
  }
  return { prompt, completion, total, observedRounds: observed };
}

// ---------------------------------------------------------------------------
// buildBehaviorReport — pure read-only recomputation from raw evidence
// ---------------------------------------------------------------------------

export function buildBehaviorReport(studyDir, { now } = {}) {
  const findings = [];
  const addFinding = (id, severity, subject, detail) => {
    findings.push({ id, severity, subject, detail });
  };

  // --- frozen plan artifacts ------------------------------------------------
  let hashes = null;
  let prereg = null;
  let manifest = null;
  let authRecord = null;

  for (const [name, file, setter] of [
    ['hashes.json', 'hashes.json', (v) => { hashes = v; }],
    ['preregistration.json', 'preregistration.json', (v) => { prereg = v; }],
    ['suite-manifest.json', 'suite-manifest.json', (v) => { manifest = v; }],
    ['run-authorization.json', 'run-authorization.json', (v) => { authRecord = v; }],
  ]) {
    try {
      setter(readJsonFile(path.join(studyDir, file)));
    } catch (e) {
      if (name === 'run-authorization.json') {
        authRecord = null; // absent authorization is itself reportable, not fatal to read
      } else {
        addFinding('key_input_missing', 'critical', file, `${name} unreadable: ${e.message}`);
      }
    }
  }

  // --- frozen binding verification (reuse the runner's own authority) ------
  let bindingsVerified = true;
  try {
    verifyFrozenStudy(studyDir);
  } catch (e) {
    bindingsVerified = false;
    addFinding('frozen_binding_drift', 'critical', 'suite', e.message);
  }
  if (hashes && prereg) {
    const check = verifyCanonicalHash(prereg, hashes.preregistrationHash && hashes.preregistrationHash.value);
    if (!check.ok) {
      bindingsVerified = false;
      addFinding('preregistration_hash_drift', 'critical', 'preregistration.json', `recomputed ${check.recomputed.slice(0, 16)}… != recorded ${String(check.recordedHash).slice(0, 16)}…`);
    }
    for (const field of FREEZE_REFERENCE_FIELDS) {
      const fromPrereg = prereg.freezeReferences && prereg.freezeReferences[field];
      const fromHashes = hashes[field] && hashes[field].value;
      if (fromPrereg !== undefined && fromHashes !== undefined && fromPrereg !== fromHashes) {
        bindingsVerified = false;
        addFinding('freeze_reference_mismatch', 'critical', `preregistration.freezeReferences.${field}`, `${String(fromPrereg).slice(0, 16)}… != hashes.json ${String(fromHashes).slice(0, 16)}…`);
      }
    }
  }

  // --- authorization scope --------------------------------------------------
  const manifestHashes = manifest
    ? { suiteHash: manifest.suiteHash, mappingHash: manifest.mappingHash, graderHash: manifest.graderHash }
    : null;
  const studyPlanHashValue = hashes && hashes.preregistrationHash ? hashes.preregistrationHash.value : null;
  const authBindingsMatch = authRecord && manifestHashes && studyPlanHashValue
    ? authRecord.suiteHash === manifestHashes.suiteHash
      && authRecord.mappingHash === manifestHashes.mappingHash
      && authRecord.graderHash === manifestHashes.graderHash
      && authRecord.studyPlanHash === studyPlanHashValue
    : null;
  const authStatus = authRecord && typeof authRecord.status === 'string' ? authRecord.status : null;
  const authorizationValid = authStatus === 'APPROVED' && authBindingsMatch === true && authRecord.revoked !== true;
  if (authStatus === 'NOT_AUTHORIZED') {
    addFinding('authorization_placeholder_present', 'info', 'run-authorization.json', 'fail-closed NOT_AUTHORIZED placeholder — not a valid real-execution authorization');
  }

  // --- ledgers --------------------------------------------------------------
  const budget = readJsonl(path.join(studyDir, 'budget-ledger.jsonl'));
  const events = readJsonl(path.join(studyDir, 'events.jsonl'));
  const adjudications = readJsonl(path.join(studyDir, 'adjudications.jsonl'));
  for (const [name, parsed] of [['budget-ledger.jsonl', budget], ['events.jsonl', events], ['adjudications.jsonl', adjudications]]) {
    if (parsed.malformedTail) {
      addFinding('ledger_malformed_tail', 'critical', name, 'final line torn or unparseable — dropped entries make every downstream count unreliable');
    }
  }

  // --- attempt files --------------------------------------------------------
  const attemptFiles = collectAttemptFiles(studyDir);
  const attemptsByUnitKey = new Map(); // unitKey -> {file, parsed}
  for (const af of attemptFiles) {
    let parsed;
    try {
      parsed = readJsonFile(af.abs);
    } catch (e) {
      addFinding('attempt_file_unparseable', 'critical', af.rel, e.message);
      continue;
    }
    const unit = parsed && parsed.unit;
    if (!unit || !unit.caseId || !unit.armId) {
      addFinding('attempt_file_unit_missing', 'critical', af.rel, 'attempt record carries no usable unit identity');
      continue;
    }
    const key = unitKey(unit);
    const fromPath = af.rel.split(path.sep).slice(1, 4).join('/');
    const fromRecord = `${unit.caseId}/${unit.armId}/r${String(unit.repetitionId)}`;
    if (fromPath !== fromRecord) {
      addFinding('attempt_path_unit_mismatch', 'major', af.rel, `path says ${fromPath}, record says ${fromRecord}`);
    }
    if (attemptsByUnitKey.has(key)) {
      addFinding('attempt_file_duplicate_unit', 'critical', key, `multiple attempt files claim the same (case,arm,rep,attempt): ${af.rel}`);
    }
    attemptsByUnitKey.set(key, { file: af.rel, parsed });
    if (parsed.mode && parsed.mode !== 'offline-stub' && parsed.authorization && manifestHashes
      && parsed.authorization.suiteHash && parsed.authorization.suiteHash !== manifestHashes.suiteHash) {
      addFinding('attempt_authorization_binding_mismatch', 'critical', af.rel, `attempt authorization.suiteHash ${String(parsed.authorization.suiteHash).slice(0, 16)}… != frozen suiteHash`);
    }
  }

  // --- ledger grouping + ledger↔file cross-checks ---------------------------
  const rowsByUnitKey = new Map(); // unitKey -> {reserve, prepared, results[]}
  for (const row of budget.entries) {
    if (!row || !row.unit || !row.unit.caseId) continue;
    const key = unitKey(row.unit);
    if (!rowsByUnitKey.has(key)) rowsByUnitKey.set(key, { reserve: false, prepared: false, results: [] });
    const g = rowsByUnitKey.get(key);
    if (row.type === 'RESERVE') g.reserve = true;
    if (row.type === 'ATTEMPT_PREPARED') g.prepared = true;
    if (row.type === 'ATTEMPT_RESULT') g.results.push(row.result);
  }
  for (const [key, g] of rowsByUnitKey) {
    if (g.results.length > 1) {
      addFinding('duplicate_settlement', 'critical', key, `attempt settled ${g.results.length} times in the budget ledger: ${g.results.join(', ')}`);
    }
    const file = attemptsByUnitKey.get(key);
    if (g.results.length > 0 && !file) {
      addFinding('ledger_result_without_attempt_file', 'critical', key, `ledger settled ${g.results[g.results.length - 1]} but no attempt file exists`);
    }
    if (g.results.length > 0 && file) {
      const ledgerResult = g.results[g.results.length - 1];
      if (ledgerResult !== file.parsed.result) {
        addFinding('ledger_file_result_conflict', 'critical', key, `ledger says ${ledgerResult}, attempt file says ${String(file.parsed.result)}`);
      }
    }
  }
  for (const [key, file] of attemptsByUnitKey) {
    const g = rowsByUnitKey.get(key);
    if (!g || !g.reserve) {
      addFinding('orphan_attempt_file', 'major', key, `attempt file ${file.file} exists without a RESERVE row in the budget ledger`);
    }
    if (file.parsed.result === 'SUCCEEDED' && !(file.parsed.adjudication && typeof file.parsed.adjudication === 'object')) {
      addFinding('succeeded_attempt_missing_adjudication', 'critical', key, 'SUCCEEDED attempt carries no adjudication record — §9.2 per-execution record cannot be built');
    }
  }

  // --- real-mode vs authorization -------------------------------------------
  const seenModes = new Set();
  for (const { parsed } of attemptsByUnitKey.values()) if (parsed.mode) seenModes.add(parsed.mode);
  const realModeAttempts = [...attemptsByUnitKey.values()].filter(({ parsed }) => parsed.mode && parsed.mode !== 'offline-stub').length;
  if (realModeAttempts > 0 && !authorizationValid) {
    addFinding('real_execution_without_valid_authorization', 'critical', 'run-authorization.json',
      `${realModeAttempts} real-mode attempt(s) but the authorization record is ${authStatus === 'APPROVED' ? 'not bound to the frozen hashes or revoked' : String(authStatus)}`);
  }
  if (realModeAttempts === 0 && budget.entries.length > 0) {
    addFinding('authorization_not_required_offline', 'info', 'run-authorization.json', 'only offline-stub executions observed — Stage R authorization not required (SPEC §7.2 gates real modes)');
  }

  // --- preregistered plan units --------------------------------------------
  const preregArms = prereg && Array.isArray(prereg.arms) ? prereg.arms.map((a) => a.armId).sort() : [];
  const plannedRepetitions = prereg && prereg.repetitions && Number(prereg.repetitions.planned) > 0
    ? Array.from({ length: Number(prereg.repetitions.planned) }, (_, i) => String(i + 1))
    : [];
  const cases = manifest && Array.isArray(manifest.cases) ? manifest.cases : [];
  const caseById = new Map(cases.map((c) => [c.caseId, c]));
  const planUnits = [];
  const planUnitKeys = new Set();
  if (preregArms.length > 0 && plannedRepetitions.length > 0 && cases.length > 0) {
    for (const c of [...cases].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
      for (const armId of preregArms) {
        for (const rep of plannedRepetitions) {
          planUnits.push({ caseId: c.caseId, armId, repetitionId: rep });
          planUnitKeys.add(planUnitKey(c.caseId, armId, rep));
        }
      }
    }
  } else if (budget.entries.length > 0 || attemptsByUnitKey.size > 0) {
    addFinding('denominator_unverifiable', 'critical', 'preregistration.json', 'preregistered arms/repetitions or frozen case list unavailable — assignedDenominator cannot be computed');
  }
  const assignedDenominator = planUnits.length;

  // out-of-scope executions (ledger or file units outside the prereg plan)
  const outOfScope = [];
  const seenUnitPlans = new Map(); // planUnitKey -> Set(attemptId)
  for (const key of new Set([...rowsByUnitKey.keys(), ...attemptsByUnitKey.keys()])) {
    const parts = key.split('/');
    const planKey = parts.length === 4 ? planUnitKey(parts[0], parts[1], parts[2].replace(/^r/, '')) : key;
    const attemptId = parts.length === 4 ? parts[3] : '';
    if (!planUnitKeys.has(planKey)) {
      outOfScope.push({ unit: key, planKey });
    } else {
      if (!seenUnitPlans.has(planKey)) seenUnitPlans.set(planKey, new Set());
      if (attemptId) seenUnitPlans.get(planKey).add(attemptId);
    }
  }
  outOfScope.sort((a, b) => a.unit.localeCompare(b.unit));
  for (const o of outOfScope) {
    addFinding('execution_outside_prereg_scope', 'major', o.unit, `execution observed for ${o.planKey} which is outside the preregistered plan — retained separately, not counted in the denominator`);
  }

  // --- per-attempt execution records (full retention, sorted) --------------
  const executions = [];
  for (const key of [...attemptsByUnitKey.keys()].sort()) {
    const { file, parsed } = attemptsByUnitKey.get(key);
    const g = rowsByUnitKey.get(key) || { results: [] };
    const adj = parsed.adjudication && typeof parsed.adjudication === 'object' ? parsed.adjudication : null;
    const rounds = Array.isArray(parsed.actorRounds) ? parsed.actorRounds : [];
    const usage = sumUsage(rounds);
    const traceSteps = parsed.trace && Array.isArray(parsed.trace.records) ? parsed.trace.records.length : null;
    executions.push({
      unit: {
        caseId: parsed.unit.caseId,
        armId: parsed.unit.armId,
        repetitionId: parsed.unit.repetitionId,
        attemptId: parsed.unit.attemptId,
      },
      file,
      mode: parsed.mode || null,
      result: parsed.result || null,
      ambiguous: parsed.ambiguous === true,
      error: parsed.error || null,
      failureClass: parsed.result === 'FAILED_KNOWN' ? classifyKnownFailure(parsed.error || g.results[g.results.length - 1] || '') : null,
      ledgerResults: g.results.slice(),
      adjudicationPresent: adj !== null,
      behaviorAligned: adj ? adj.behaviorAligned : null,
      forbiddenBehaviorOccurred: adj ? adj.forbiddenBehaviorOccurred : null,
      objectiveTaskOutcome: adj ? adj.objectiveTaskOutcome : null,
      negativeTransfer: adj ? adj.negativeTransfer : null,
      overCheckOccurred: adj && adj.overCheck ? adj.overCheck.overCheckOccurred === true : null,
      unnecessaryCostUnits: adj && adj.overCheck ? Number(adj.overCheck.unnecessaryCostUnits) || 0 : null,
      violationsCount: adj && Array.isArray(adj.violations) ? adj.violations.length : null,
      traceSteps,
      actorRounds: rounds.length,
      usage: usage.observedRounds > 0 ? {
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        observedRounds: usage.observedRounds,
        totalRounds: rounds.length,
      } : null,
      timingObserved: rounds.some((r) => r && r.timing && typeof r.timing === 'object'),
    });
  }
  executions.sort((a, b) => unitKey(a.unit).localeCompare(unitKey(b.unit)));

  // --- plan-unit rollups (current state per the ledger's own authority) ----
  const ledgerForVerify = createChallengeLedger(studyDir); // read-only use: classifyUnit only
  const unitRollups = [];
  const recoveredFromUnknown = [];
  const ambiguousPrimary = [];
  for (const pu of planUnits) {
    const caseDef = caseById.get(pu.caseId);
    const attemptIds = [...(seenUnitPlans.get(planUnitKey(pu.caseId, pu.armId, pu.repetitionId)) || [])].sort();
    const states = attemptIds.map((attemptId) => ({
      attemptId,
      state: ledgerForVerify.classifyUnit({ caseId: pu.caseId, armId: pu.armId, repetitionId: pu.repetitionId, attemptId }).state,
    }));
    const succeeded = states.filter((s) => s.state === 'SUCCEEDED');
    const failed = states.filter((s) => s.state === 'FAILED_KNOWN');
    const unknown = states.filter((s) => s.state === 'RESULT_UNKNOWN');
    let currentState = 'not_started';
    if (succeeded.length > 0) currentState = 'succeeded';
    else if (failed.length > 0) currentState = 'failed_known';
    else if (unknown.length > 0) currentState = 'result_unknown';
    else if (states.some((s) => s.state === 'RESERVED_NOT_PREPARED')) currentState = 'reserved_unsettled';
    const primary = succeeded.length > 0 ? succeeded[succeeded.length - 1]
      : failed.length > 0 ? failed[failed.length - 1]
        : unknown.length > 0 ? unknown[unknown.length - 1] : null;

    const succeededExecs = succeeded.map((s) => executions.find((e) => e.unit.caseId === pu.caseId && e.unit.armId === pu.armId && String(e.unit.repetitionId) === String(pu.repetitionId) && String(e.unit.attemptId) === String(s.attemptId)));
    const divergent = succeededExecs.length > 1 && succeededExecs.some((e) => e.behaviorAligned !== succeededExecs[0].behaviorAligned
      || e.objectiveTaskOutcome !== succeededExecs[0].objectiveTaskOutcome);
    const primaryExec = primary ? executions.find((e) => e.unit.caseId === pu.caseId && e.unit.armId === pu.armId && String(e.unit.repetitionId) === String(pu.repetitionId) && String(e.unit.attemptId) === String(primary.attemptId)) : null;
    const validExecution = currentState === 'succeeded' && primaryExec !== undefined && primaryExec.adjudicationPresent && !divergent;
    if (unknown.length > 0 && (succeeded.length > 0 || failed.length > 0)) {
      recoveredFromUnknown.push({ unit: planUnitKey(pu.caseId, pu.armId, pu.repetitionId), attempts: states.map((s) => `${s.attemptId}:${s.state}`) });
    }
    if (divergent) {
      ambiguousPrimary.push({ unit: planUnitKey(pu.caseId, pu.armId, pu.repetitionId), attempts: states.map((s) => `${s.attemptId}:${s.state}`) });
    }
    unitRollups.push({
      unit: planUnitKey(pu.caseId, pu.armId, pu.repetitionId),
      caseId: pu.caseId,
      armId: pu.armId,
      repetitionId: pu.repetitionId,
      family: caseDef ? caseDef.family : null,
      expectedMode: caseDef ? caseDef.expectedMode : null,
      principleApplicable: caseDef ? caseDef.principleApplicable === true : null,
      studyEligible: caseDef ? caseDef.studyEligible === true : null,
      attempts: states.map((s) => `${s.attemptId}:${s.state}`).sort(),
      currentState,
      primaryAttempt: primary ? primary.attemptId : null,
      primaryAnalysis: divergent ? 'AMBIGUOUS' : validExecution ? 'DETERMINABLE' : currentState === 'not_started' ? 'NOT_EXECUTED' : 'EXCLUDED',
      validExecution,
      recoveredFromUnknown: unknown.length > 0 && (succeeded.length > 0 || failed.length > 0),
      outcome: primaryExec && primaryExec.adjudicationPresent ? {
        behaviorAligned: primaryExec.behaviorAligned,
        forbiddenBehaviorOccurred: primaryExec.forbiddenBehaviorOccurred,
        objectiveTaskOutcome: primaryExec.objectiveTaskOutcome,
        negativeTransfer: primaryExec.negativeTransfer,
      } : null,
    });
  }
  unitRollups.sort((a, b) => a.unit.localeCompare(b.unit));
  recoveredFromUnknown.sort((a, b) => a.unit.localeCompare(b.unit));
  ambiguousPrimary.sort((a, b) => a.unit.localeCompare(b.unit));

  const byCategory = (cat) => unitRollups.filter((u) => u.currentState === cat).map((u) => u.unit);
  const executedUnits = unitRollups.filter((u) => u.currentState !== 'not_started').length;
  if (executedUnits === 0 && budget.entries.length === 0 && attemptsByUnitKey.size === 0) {
    addFinding('study_not_executed', 'info', 'runs/', 'no executions observed — a report on an unexecuted study stays REPORT_INCONCLUSIVE');
  }

  // --- §9.4 dimensions ------------------------------------------------------
  const arms = preregArms;
  const primaryValid = (u) => u.validExecution && u.primaryAnalysis === 'DETERMINABLE';
  const validUnitsByCaseRep = new Map(); // 'caseId/rRep' -> {armId -> rollup}
  for (const u of unitRollups) {
    if (!primaryValid(u)) continue;
    const k = `${u.caseId}/r${String(u.repetitionId)}`;
    if (!validUnitsByCaseRep.has(k)) validUnitsByCaseRep.set(k, new Map());
    validUnitsByCaseRep.get(k).set(u.armId, u);
  }
  const pairedCases = [...validUnitsByCaseRep.entries()]
    .filter(([, m]) => m.has('A') && m.has('B'))
    .map(([k, m]) => ({ caseRep: k, arms: [...m.keys()].sort() }))
    .sort((a, b) => a.caseRep.localeCompare(b.caseRep));

  // protocol/evidence quality
  const refusalReasons = {};
  for (const e of events.entries) {
    if (e && e.type === 'UNIT_REFUSED' && e.reason) refusalReasons[e.reason] = (refusalReasons[e.reason] || 0) + 1;
  }
  const realExecs = executions.filter((e) => e.mode && e.mode !== 'offline-stub');
  const identityAttested = realExecs.filter((e) => {
    const a = attemptsByUnitKey.get(unitKey(e.unit));
    return a && Array.isArray(a.parsed.actorRounds) && a.parsed.actorRounds.some((r) => r && r.observedModelIdentity);
  }).length;
  const failureClasses = {
    capacityFailure: executions.filter((e) => e.failureClass === 'capacity_failure').length,
    identityFailure: executions.filter((e) => e.failureClass === 'identity_failure').length,
    protocolContractFailure: executions.filter((e) => e.failureClass === 'protocol_contract_failure').length,
    behaviorViolation: unitRollups.filter((u) => primaryValid(u) && u.outcome && u.outcome.forbiddenBehaviorOccurred === true).length,
    objectiveTaskFailure: unitRollups.filter((u) => primaryValid(u) && u.outcome && u.outcome.objectiveTaskOutcome === 'FAIL').length,
  };
  const protocolEvidenceQuality = {
    runCount: events.entries.filter((e) => e && e.type === 'RUN_STARTED').length,
    assignedUnits: assignedDenominator,
    executedUnits,
    currentUnitStateCounts: {
      succeeded: byCategory('succeeded').length,
      failed_known: byCategory('failed_known').length,
      result_unknown: byCategory('result_unknown').length,
      reserved_unsettled: byCategory('reserved_unsettled').length,
      not_started: byCategory('not_started').length,
    },
    validExecutionUnits: unitRollups.filter((u) => primaryValid(u)).length,
    validPairedCasesAB: pairedCases.length,
    identityObservability: realExecs.length > 0
      ? { attempts: realExecs.length, attemptsIdentityAttested: identityAttested }
      : { attempts: 0, attemptsIdentityAttested: 0, note: 'offline-stub study — model identity not applicable' },
    interruptedUnits: events.entries.filter((e) => e && e.type === 'UNIT_INTERRUPTED').length,
    refusalReasons: Object.fromEntries(Object.keys(refusalReasons).sort().map((k) => [k, refusalReasons[k]])),
    failureClasses,
  };

  // behavioral benefit — prereg applicable-positive cases, A/B paired only
  const applicablePositive = unitRollups.filter((u) => u.principleApplicable === true);
  const benefitPairs = [];
  for (const { caseRep } of pairedCases) {
    const m = validUnitsByCaseRep.get(caseRep);
    const a = m.get('A');
    const b = m.get('B');
    if (!a.principleApplicable) continue;
    benefitPairs.push({
      caseRep,
      a: { objectiveTaskOutcome: a.outcome.objectiveTaskOutcome, behaviorAligned: a.outcome.behaviorAligned },
      b: { objectiveTaskOutcome: b.outcome.objectiveTaskOutcome, behaviorAligned: b.outcome.behaviorAligned },
    });
  }
  const passCount = (side) => benefitPairs.filter((p) => p[side].objectiveTaskOutcome === 'PASS').length;
  const alignedCount = (side) => benefitPairs.filter((p) => p[side].behaviorAligned === true).length;
  const behavioralBenefit = {
    scope: 'preregistered applicable-positive cases (principleApplicable=true) with a valid A/B pair',
    pairedCases: benefitPairs.length,
    armA: { objectiveTaskPass: passCount('a'), behaviorAligned: alignedCount('a') },
    armB: { objectiveTaskPass: passCount('b'), behaviorAligned: alignedCount('b') },
    pairedDifferenceBminusA: {
      objectiveTaskPass: passCount('b') - passCount('a'),
      behaviorAligned: alignedCount('b') - alignedCount('a'),
    },
    pairs: benefitPairs,
    note: 'descriptive paired counts only — no causal claim (SPEC §1.2/§9.4)',
  };

  // boundary / negative transfer — scorer verdicts verbatim, boundaryRisk separate
  const boundaryUnits = unitRollups.filter((u) => u.principleApplicable === false && u.studyEligible === true);
  const primaryExecOf = (u) => executions.find((e) => sameExec(e, u)) || null;
  const boundaryByArm = {};
  for (const armId of arms) {
    const us = boundaryUnits.filter((u) => u.armId === armId && primaryValid(u));
    boundaryByArm[armId] = {
      unitsExecuted: us.length,
      boundaryRiskForbiddenBehavior: us.filter((u) => u.outcome.forbiddenBehaviorOccurred === true).length,
      negativeTransferScorerVerdict: us.filter((u) => u.outcome.negativeTransfer === true).length,
      overCheckOccurred: us.filter((u) => { const e = primaryExecOf(u); return e !== null && e.overCheckOccurred === true; }).length,
      unnecessaryCostUnits: us.reduce((acc, u) => acc + (primaryExecOf(u) ? primaryExecOf(u).unnecessaryCostUnits || 0 : 0), 0),
    };
  }
  const boundaryNegativeTransfer = {
    scope: 'boundary cases (principleApplicable=false ∧ studyEligible=true, SPEC §5.2/§9.1) — retained, never dropped',
    boundaryCasesInSuite: new Set(boundaryUnits.map((u) => u.caseId)).size,
    perArm: boundaryByArm,
    semanticSources: {
      negativeTransfer: 'adjudication.negativeTransfer verbatim (claim-evidence-scorer: overCheckOccurred ∧ expectedMode=withhold)',
      boundaryRisk: 'forbiddenBehaviorOccurred on boundary cases — reported separately, NOT merged into negativeTransfer',
    },
  };

  // objective task outcome — separate from behavior alignment
  const objectiveTaskOutcome = {};
  for (const armId of arms) {
    const prim = unitRollups.filter((u) => u.armId === armId && primaryValid(u));
    const appl = prim.filter((u) => u.principleApplicable === true);
    const bnd = prim.filter((u) => u.principleApplicable === false);
    objectiveTaskOutcome[armId] = {
      units: prim.length,
      pass: prim.filter((u) => u.outcome.objectiveTaskOutcome === 'PASS').length,
      fail: prim.filter((u) => u.outcome.objectiveTaskOutcome === 'FAIL').length,
      applicablePositive: { units: appl.length, pass: appl.filter((u) => u.outcome.objectiveTaskOutcome === 'PASS').length },
      boundary: { units: bnd.length, pass: bnd.filter((u) => u.outcome.objectiveTaskOutcome === 'PASS').length },
    };
  }

  // cost — observable only; unobservable is explicitly unavailable, never zero
  const cost = {};
  for (const armId of arms) {
    const armExecs = executions.filter((e) => e.unit.armId === armId);
    const tokens = armExecs.filter((e) => e.usage);
    const toolSteps = armExecs.filter((e) => e.traceSteps !== null);
    cost[armId] = {
      attemptsReserved: budget.entries.filter((r) => r && r.type === 'RESERVE' && r.unit && r.unit.armId === armId).length,
      requestsReserved: budget.entries.filter((r) => r && r.type === 'REQUEST_RESERVE' && r.unit && r.unit.armId === armId).length,
      requestRefusals: budget.entries.filter((r) => r && r.type === 'REQUEST_REFUSED' && r.unit && r.unit.armId === armId).length,
      budgetRefusals: budget.entries.filter((r) => r && r.type === 'BUDGET_REFUSED' && r.unit && r.unit.armId === armId).length,
      tokens: tokens.length > 0 ? {
        prompt: tokens.reduce((a, e) => a + e.usage.promptTokens, 0),
        completion: tokens.reduce((a, e) => a + e.usage.completionTokens, 0),
        total: tokens.reduce((a, e) => a + e.usage.totalTokens, 0),
        attemptsWithUsage: tokens.length,
      } : { available: false, reason: 'no actorRounds usage observed for this arm' },
      toolSteps: toolSteps.length > 0 ? {
        steps: toolSteps.reduce((a, e) => a + e.traceSteps, 0),
        attemptsWithTrace: toolSteps.length,
      } : { available: false, reason: 'no trace records observed for this arm' },
      timing: armExecs.some((e) => e.timingObserved)
        ? { available: true, attemptsWithTiming: armExecs.filter((e) => e.timingObserved).length }
        : { available: false, reason: 'no per-request timing telemetry observed (TTFB telemetry PR #2153 fields absent)' },
      monetaryCost: { available: false, reason: 'no per-token price bound to this study copy — tokens are reported raw' },
    };
  }

  // coverage
  const families = manifest && manifest.familyCounts ? Object.keys(manifest.familyCounts).sort() : [];
  const coverage = {
    families: families.map((family) => {
      const familyCases = [...new Set(unitRollups.filter((u) => u.family === family).map((u) => u.caseId))].sort();
      return {
        family,
        casesInSuite: familyCases.length,
        casesWithValidExecution: familyCases.filter((c) => unitRollups.some((u) => u.caseId === c && primaryValid(u))).length,
        validABPairs: pairedCases.filter(({ caseRep }) => caseRep.split('/r')[0] && unitRollups.some((u) => u.caseId === caseRep.split('/r')[0] && u.family === family)).length,
      };
    }),
    independentDecisionVariables: { estimable: false, value: 'NOT_ESTIMABLE', reason: 'the frozen suite carries no decision-variable metadata bound per case — counting from hashes would be inference, not evidence (SPEC §9.4 覆盖)' },
    transferEstimability: { estimable: false, value: 'NOT_ESTIMABLE', reason: 'requires ≥2 verifiably distinct decision contexts; no such metadata is frozen with the suite (SPEC §5.1)' },
  };

  // --- status ----------------------------------------------------------------
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const ready = criticalCount === 0
    && bindingsVerified
    && executedUnits > 0
    && (realModeAttempts === 0 || authorizationValid)
    && !(preregArms.length === 0 || plannedRepetitions.length === 0 || cases.length === 0);
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.id.localeCompare(b.id) || String(a.subject).localeCompare(String(b.subject)));

  const report = {
    schema: BEHAVIOR_REPORT_SCHEMA,
    studyId: (manifest && manifest.studyId) || (prereg && prereg.studyId) || null,
    status: ready ? REPORT_STATUS_READY : REPORT_STATUS_INCONCLUSIVE,
    generatedAt: normalizeNow(now),
    scope: {
      preregistered: {
        arms,
        caseCount: cases.length,
        repetitions: plannedRepetitions,
        assignedDenominator,
        rule: 'preregistration.json arms × frozen suite-manifest cases × planned repetitions — the authorization subset never shrinks this denominator',
      },
      authorized: authRecord ? {
        status: authStatus,
        validForRealExecution: authorizationValid,
        bindingsMatch: authBindingsMatch,
        executionMode: authRecord.executionMode || null,
        requestedActorIdentity: authRecord.requestedActorIdentity || null,
        arms: Array.isArray(authRecord.arms) ? authRecord.arms.slice().sort() : [],
        caseCount: Array.isArray(authRecord.cases) ? authRecord.cases.length : null,
        repetitions: Array.isArray(authRecord.repetitions) ? authRecord.repetitions.map(String).sort() : [],
        attemptCap: authRecord.attemptCap ?? null,
        requestCap: authRecord.requestCap ?? null,
        validFrom: authRecord.validFrom || null,
        validUntil: authRecord.validUntil || null,
        revoked: authRecord.revoked === true,
        halted: authRecord.halted === true,
        note: authStatus === 'APPROVED' ? 'authorized SUBSET of the preregistered plan (may cover only part of the denominator)' : 'fail-closed placeholder or non-approved record — not a real-execution authorization',
      } : { present: false, note: 'no run-authorization.json in this study copy' },
      executedUnits,
      settlementCounts: {
        succeeded: byCategory('succeeded').length,
        failedKnown: byCategory('failed_known').length,
        resultUnknown: byCategory('result_unknown').length,
        reservedUnsettled: byCategory('reserved_unsettled').length,
        notStarted: byCategory('not_started').length,
      },
      notStartedUnits: byCategory('not_started').sort(),
      lostToFollowUpUnits: [...byCategory('result_unknown'), ...byCategory('reserved_unsettled')].sort(),
      lostToFollowUpRule: 'RESULT_UNKNOWN settlements and reserved-but-unsettled units — retained in the denominator, excluded from valid pairs (SPEC §9.3/§9.5), never auto-counted as behavioral failure',
      outOfScopeExecutions: outOfScope,
    },
    bindings: {
      verified: bindingsVerified,
      frozenStudyVerification: 'challenge-runner verifyFrozenStudy (suiteHash/mappingHash/graderHash/principleContentHash + per-case inputHash/goldHash recomputation)',
      preregistrationHash: hashes && hashes.preregistrationHash ? hashes.preregistrationHash.value : null,
      suiteHash: manifestHashes ? manifestHashes.suiteHash : null,
      mappingHash: manifestHashes ? manifestHashes.mappingHash : null,
      graderHash: manifestHashes ? manifestHashes.graderHash : null,
      executionModesObserved: [...seenModes].sort(),
    },
    dimensions: {
      protocolEvidenceQuality,
      behavioralBenefit,
      boundaryNegativeTransfer,
      objectiveTaskOutcome,
      cost,
      coverage,
    },
    analysisRules: {
      primaryAttempt: "per-attempt state from the ledger's classifyUnit (last ATTEMPT_RESULT wins per attemptId); unit current state prefers succeeded > failed_known > result_unknown — provenance: challenge-ledger.mjs, the existing recovery authority",
      ambiguousPrimary: 'multiple SUCCEEDED attempts with diverging adjudication → AMBIGUOUS, excluded from the paired main analysis, kept in sensitivity',
      negativeTransfer: 'adjudication.negativeTransfer verbatim — never redefined at the report layer',
      boundaryRisk: 'forbiddenBehaviorOccurred on boundary cases — a separate indicator, never merged into negativeTransfer',
    },
    planUnits: unitRollups,
    executions,
    sensitivity: {
      recoveredFromUnknown,
      ambiguousPrimary,
      note: 'units recovered via a NEW attemptId after RESULT_UNKNOWN, and units whose multiple SUCCEEDED attempts diverge — full records retained above',
    },
    integrity: {
      findings,
      criticalCount,
      majorCount: findings.filter((f) => f.severity === 'major').length,
      infoCount: findings.filter((f) => f.severity === 'info').length,
    },
    limitations: [
      'descriptive aggregation of raw evidence only — no causal inference (SPEC §1.2)',
      'unknown/failed settlements are honest outcomes, not corruption; coverage is limited by what actually settled',
      'monetary cost unobservable without a bound per-token price; tokens are reported raw',
    ],
  };
  return report;
}

// small helper used by the boundary dimension (primary execution lookup)
function sameExec(e, u) {
  return e.unit.caseId === u.caseId && e.unit.armId === u.armId && String(e.unit.repetitionId) === String(u.repetitionId) && e.unit.attemptId === u.primaryAttempt;
}

// ---------------------------------------------------------------------------
// deterministic rendering
// ---------------------------------------------------------------------------

export function renderBehaviorReportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderBehaviorReportMarkdown(report) {
  const lines = [];
  const push = (...ls) => lines.push(...ls);
  push(`# Behavior Report — ${report.studyId ?? '(studyId unknown)'}`);
  push('');
  push(`- schema: \`${report.schema}\``);
  push(`- status: **${report.status}**`);
  push(`- generatedAt: ${report.generatedAt ?? '(not provided)'}`);
  push(`- assignedDenominator: ${report.scope.preregistered.assignedDenominator}`);
  push(`- executedUnits: ${report.scope.executedUnits}`);
  push('');
  push('## Scope');
  push('');
  push('| scope | value |');
  push('|---|---|');
  push(`| preregistered | arms ${report.scope.preregistered.arms.join('/')} × ${report.scope.preregistered.caseCount} cases × ${report.scope.preregistered.repetitions.length} rep(s) = ${report.scope.preregistered.assignedDenominator} |`);
  const a = report.scope.authorized;
  push(`| authorized | ${a.present === false ? 'absent' : `${a.status}${a.validForRealExecution ? ' (valid, bindings match)' : a.status === 'APPROVED' ? ' (bindings/revocation problem)' : ' (not a real-execution authorization)'}`} |`);
  const sc = report.scope.settlementCounts;
  push(`| settlements | succeeded ${sc.succeeded} / failedKnown ${sc.failedKnown} / resultUnknown ${sc.resultUnknown} / reservedUnsettled ${sc.reservedUnsettled} / notStarted ${sc.notStarted} |`);
  push(`| lost to follow-up | ${report.scope.lostToFollowUpUnits.length} unit(s) — retained, excluded from valid pairs |`);
  push(`| out-of-scope executions | ${report.scope.outOfScopeExecutions.length} |`);
  push('');
  push('## Integrity findings');
  push('');
  if (report.integrity.findings.length === 0) {
    push('(none)');
  } else {
    push('| severity | id | subject | detail |');
    push('|---|---|---|---|');
    for (const f of report.integrity.findings) push(`| ${f.severity} | ${f.id} | ${String(f.subject).replaceAll('|', '/')} | ${String(f.detail).replaceAll('|', '/').slice(0, 160)} |`);
  }
  push('');
  const d = report.dimensions;
  push('## 1. 协议/证据质量 (protocolEvidenceQuality)');
  push('');
  push(`- runs: ${d.protocolEvidenceQuality.runCount}; validExecutionUnits: ${d.protocolEvidenceQuality.validExecutionUnits}; validPairedCasesAB: ${d.protocolEvidenceQuality.validPairedCasesAB}`);
  push(`- identity attested: ${d.protocolEvidenceQuality.identityObservability.attemptsIdentityAttested}/${d.protocolEvidenceQuality.identityObservability.attempts}`);
  push(`- failureClasses: capacity=${d.protocolEvidenceQuality.failureClasses.capacityFailure}, identity=${d.protocolEvidenceQuality.failureClasses.identityFailure}, protocolContract=${d.protocolEvidenceQuality.failureClasses.protocolContractFailure}, behaviorViolation=${d.protocolEvidenceQuality.failureClasses.behaviorViolation}, objectiveTaskFailure=${d.protocolEvidenceQuality.failureClasses.objectiveTaskFailure}`);
  push(`- refusalReasons: ${JSON.stringify(d.protocolEvidenceQuality.refusalReasons)}`);
  push('');
  push('## 2. 行为收益 (behavioralBenefit — applicable-positive A/B pairs only)');
  push('');
  const bb = d.behavioralBenefit;
  push(`- pairedCases: ${bb.pairedCases}; A pass ${bb.armA.objectiveTaskPass} / aligned ${bb.armA.behaviorAligned}; B pass ${bb.armB.objectiveTaskPass} / aligned ${bb.armB.behaviorAligned}; B−A pass ${bb.pairedDifferenceBminusA.objectiveTaskPass}`);
  push(`- ${bb.note}`);
  push('');
  push('## 3. 边界/负迁移 (boundaryNegativeTransfer — scorer verdicts verbatim)');
  push('');
  push('| arm | units | boundaryRisk (forbiddenBehavior) | negativeTransfer (scorer) |');
  push('|---|---|---|---|');
  for (const armId of Object.keys(d.boundaryNegativeTransfer.perArm)) {
    const b = d.boundaryNegativeTransfer.perArm[armId];
    push(`| ${armId} | ${b.unitsExecuted} | ${b.boundaryRiskForbiddenBehavior} | ${b.negativeTransferScorerVerdict} |`);
  }
  push('');
  push('## 4. 客观任务结果 (objectiveTaskOutcome — separate from behavior)');
  push('');
  push('| arm | units | PASS | FAIL | applicable pass | boundary pass |');
  push('|---|---|---|---|---|---|');
  for (const armId of Object.keys(d.objectiveTaskOutcome)) {
    const o = d.objectiveTaskOutcome[armId];
    push(`| ${armId} | ${o.units} | ${o.pass} | ${o.fail} | ${o.applicablePositive.pass}/${o.applicablePositive.units} | ${o.boundary.pass}/${o.boundary.units} |`);
  }
  push('');
  push('## 5. 成本 (cost — observable only, unavailable never zero-filled)');
  push('');
  push('| arm | attempts | requests | tokens (total) | toolSteps | timing |');
  push('|---|---|---|---|---|---|');
  for (const armId of Object.keys(d.cost)) {
    const c = d.cost[armId];
    push(`| ${armId} | ${c.attemptsReserved} | ${c.requestsReserved} | ${c.tokens.available === false ? 'unavailable' : c.tokens.total} | ${c.toolSteps.available === false ? 'unavailable' : c.toolSteps.steps} | ${c.timing.available ? 'observed' : 'unavailable'} |`);
  }
  push('');
  push('## 6. 覆盖 (coverage)');
  push('');
  push('| family | cases in suite | cases with valid execution | valid A/B pairs |');
  push('|---|---|---|---|');
  for (const f of d.coverage.families) push(`| ${f.family} | ${f.casesInSuite} | ${f.casesWithValidExecution} | ${f.validABPairs} |`);
  push('');
  push(`- independentDecisionVariables: ${d.coverage.independentDecisionVariables.value}`);
  push(`- transferEstimability: ${d.coverage.transferEstimability.value}`);
  push('');
  push('## Sensitivity');
  push('');
  push(`- recoveredFromUnknown: ${report.sensitivity.recoveredFromUnknown.length} unit(s)`);
  push(`- ambiguousPrimary: ${report.sensitivity.ambiguousPrimary.length} unit(s)`);
  push('');
  push('## Limitations');
  push('');
  for (const l of report.limitations) push(`- ${l}`);
  push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// write path (locked, atomic, revision-protected) + read-only verify path
// ---------------------------------------------------------------------------

function assertNotFrozenStudyArea(studyDir) {
  const resolved = fs.existsSync(studyDir) ? fs.realpathSync(studyDir) : path.resolve(studyDir);
  const frozen = process.platform === 'win32' ? FROZEN_STUDIES_AREA.toLowerCase() : FROZEN_STUDIES_AREA;
  const target = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (target === frozen || target.startsWith(`${frozen}${path.sep}`)) {
    throw new FrozenStudyWriteRefusedError(resolved, FROZEN_STUDIES_AREA);
  }
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeBehaviorReport(studyDir, { now, owner = 'behavior-report-generator' } = {}) {
  if (now === undefined || now === null) {
    throw new Error('writeBehaviorReport: now required (ISO-8601) — the report timestamp must be explicit and reproducible');
  }
  normalizeNow(now); // validate
  assertNotFrozenStudyArea(studyDir);
  const jsonPath = path.join(studyDir, REPORT_JSON);
  const mdPath = path.join(studyDir, REPORT_MD);
  acquireStudyWriteLock(studyDir, { owner }); // StudyLockError propagates: concurrent/interrupted writers refuse here
  try {
    const events = readJsonl(path.join(studyDir, 'events.jsonl')).entries;
    const readyEvents = events.filter((e) => e && e.type === 'REPORT_READY');
    if (readyEvents.length > 0) {
      if (!fs.existsSync(jsonPath)) {
        throw new ReportRevisionRequiredError('REPORT_READY event exists but behavior-report.json is missing — the committed report cannot be compared');
      }
      let existingRaw;
      let existing;
      try {
        existingRaw = fs.readFileSync(jsonPath, 'utf8');
        existing = JSON.parse(existingRaw);
      } catch (e) {
        throw new ReportRevisionRequiredError(`committed behavior-report.json unparseable: ${e.message}`);
      }
      const compareNow = existing.generatedAt ?? now;
      const candidate = buildBehaviorReport(studyDir, { now: compareNow });
      const candidateJson = renderBehaviorReportJson(candidate);
      if (existingRaw !== candidateJson) {
        throw new ReportRevisionRequiredError('recomputation differs from the committed report (data changed after REPORT_READY, or the report was tampered with)');
      }
      const md = renderBehaviorReportMarkdown(candidate);
      if (!fs.existsSync(mdPath) || fs.readFileSync(mdPath, 'utf8') !== md) {
        atomicWrite(mdPath, md); // rendering completion of the SAME report — data revision not involved
      }
      return { written: false, alreadyReady: true, status: candidate.status, report: candidate };
    }
    const report = buildBehaviorReport(studyDir, { now });
    const json = renderBehaviorReportJson(report);
    const md = renderBehaviorReportMarkdown(report);
    atomicWrite(jsonPath, json);
    atomicWrite(mdPath, md);
    let eventAppended = false;
    if (report.status === REPORT_STATUS_READY) {
      const ledger = createChallengeLedger(studyDir);
      ledger.appendEvent({
        type: 'REPORT_READY',
        owner,
        report: {
          schema: report.schema,
          status: report.status,
          generatedAt: report.generatedAt,
          reportSha256: sha256(json),
          assignedDenominator: report.scope.preregistered.assignedDenominator,
          executedUnits: report.scope.executedUnits,
          criticalFindings: report.integrity.criticalCount,
        },
      });
      eventAppended = true;
    }
    return { written: true, alreadyReady: false, status: report.status, eventAppended, report };
  } finally {
    // Swallow release failures: if we held the lock and unlink failed the lock
    // simply stays held and the next writer is refused loudly (the ledger's
    // own crash semantic) — rethrowing here could mask the original error.
    try {
      releaseStudyWriteLock(studyDir, { owner });
    } catch { /* already released, gone, or unreadable */ }
  }
}

export function verifyBehaviorReport(studyDir, { now } = {}) {
  // STRICTLY read-only: no lock, no writes, no event appends.
  const jsonPath = path.join(studyDir, REPORT_JSON);
  const mdPath = path.join(studyDir, REPORT_MD);
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok, detail });
  if (!fs.existsSync(jsonPath)) {
    return { ok: false, reason: 'report_not_generated', checks: [{ id: 'report_json_present', ok: false, detail: 'behavior-report.json not found' }] };
  }
  const existingRaw = fs.readFileSync(jsonPath, 'utf8');
  let existing = null;
  try {
    existing = JSON.parse(existingRaw);
  } catch (e) {
    return { ok: false, reason: 'report_unparseable', checks: [{ id: 'report_json_parseable', ok: false, detail: e.message }] };
  }
  check('report_json_parseable', true, '');
  check('report_md_present', fs.existsSync(mdPath), 'behavior-report.md must exist as the paired rendering');
  const effectiveNow = existing.generatedAt ?? (now !== undefined && now !== null ? now : null);
  if (effectiveNow === null) {
    check('generated_at_available', false, 'existing report has no generatedAt and no --now given — recomputation is not reproducible');
    return { ok: false, reason: 'generated_at_missing', checks };
  }
  const rebuilt = buildBehaviorReport(studyDir, { now: effectiveNow });
  const rebuiltJson = renderBehaviorReportJson(rebuilt);
  const jsonMatch = existingRaw === rebuiltJson;
  check('report_json_recomputable', jsonMatch, jsonMatch ? 'byte-identical recomputation from raw evidence' : 'recomputation differs from the stored report');
  let mdMatch = false;
  if (fs.existsSync(mdPath)) {
    mdMatch = fs.readFileSync(mdPath, 'utf8') === renderBehaviorReportMarkdown(rebuilt);
    check('report_md_recomputable', mdMatch, mdMatch ? 'byte-identical markdown rendering' : 'markdown rendering differs');
  }
  const readyEvents = readJsonl(path.join(studyDir, 'events.jsonl')).entries.filter((e) => e && e.type === 'REPORT_READY');
  if (existing.status === REPORT_STATUS_READY) {
    check('ready_event_count', readyEvents.length === 1, `expected exactly one REPORT_READY event, found ${readyEvents.length}`);
    if (readyEvents.length >= 1) {
      const bound = readyEvents[0].report && readyEvents[0].report.reportSha256;
      check('ready_event_sha_binding', bound === sha256(existingRaw), bound === sha256(existingRaw) ? 'event binds the exact report bytes' : 'REPORT_READY event sha256 does not match the stored report');
    }
  } else {
    check('no_ready_event_when_not_ready', readyEvents.length === 0, `REPORT_INCONCLUSIVE report must not carry a REPORT_READY event, found ${readyEvents.length}`);
  }
  const ok = checks.every((c) => c.ok);
  return { ok, reason: ok ? null : 'verification_failed', status: existing.status, checks };
}
