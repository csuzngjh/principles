// SPEC-PD-EXAMINER-001 v0.4 — behavior report generator test suite
// (SPEC §8 REPORT_READY, §9.1–§9.5 denominators/anomaly table/six dimensions,
// §10 behavior-report.json+.md, §12.4/Phase 2b DoD "报告可从轨迹重算").
//
// Covers the Owner-approved supplement (2026-10-26) mandatory checks 1–8 plus
// determinism, §9.5 fixed-example accounting, lock refusal and REPORT_READY
// event binding. All fixtures are SYNTHETIC studies copied from the frozen
// CEB-001 template into a temp dir — no external-worktree real data decides
// any test outcome (the PR #2165 vacuous-test lesson), and the pristine
// in-repo study must stay untouched (runtime write refusal asserted).
//
// Every dynamically composed path goes through inside(), which resolves the
// target and refuses anything escaping its study root (path-traversal guard).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBehaviorReport,
  renderBehaviorReportJson,
  renderBehaviorReportMarkdown,
  writeBehaviorReport,
  verifyBehaviorReport,
  FrozenStudyWriteRefusedError,
  ReportRevisionRequiredError,
  REPORT_STATUS_READY,
  REPORT_STATUS_INCONCLUSIVE,
} from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';
import { createChallengeLedger } from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';
import { sha256 } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'behavior-report-tests');
const NOW = '2026-10-26T12:00:00Z';

/** Resolve `segments` under `root` and refuse any result escaping the root. */
function inside(root: string, ...segments: string[]): string {
  const abs = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`path escapes study root: ${abs}`);
  return abs;
}

const readJson = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(inside(dir, rel), 'utf8'));

let copyCounter = 0;
function copyStudy(tag: string): string {
  const dir = inside(tmpRoot, `${tag}-${++copyCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}

const manifest = readJson(realStudyDir, 'suite-manifest.json');
const realHashes = readJson(realStudyDir, 'hashes.json');
const CASE_IDS: string[] = manifest.cases.map((c: any) => c.caseId);

function approvedAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'challenge-stage-authorization.v1',
    stage: 'R',
    status: 'APPROVED',
    studyId: 'CEB-001',
    suiteHash: realHashes.suiteHash.value,
    mappingHash: realHashes.mappingHash.value,
    graderHash: realHashes.graderHash.value,
    studyPlanHash: realHashes.preregistrationHash.value,
    requestedActorIdentity: 'glm-5.3-flash',
    executionMode: 'F1-direct-model',
    arms: ['A', 'B', 'C'],
    cases: CASE_IDS,
    repetitions: ['1'],
    attemptCap: 48,
    requestCap: 1440,
    issuedBy: 'test fixture',
    validFrom: '2026-10-26T00:00:00Z',
    validUntil: '2026-10-28T00:00:00Z',
    revoked: false,
    halted: false,
    ...over,
  };
}

function writeAttempt(dir: string, unit: any, fields: Record<string, unknown> = {}) {
  const file = inside(dir, 'runs', unit.caseId, unit.armId, `r${unit.repetitionId}`, `${unit.attemptId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: any = {
    schema: 'challenge-attempt.v1',
    unit,
    mode: fields.mode ?? 'offline-stub',
    result: fields.result ?? 'SUCCEEDED',
    ...fields,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function adjudication(over: Record<string, unknown> = {}) {
  return {
    schema: 'claim-evidence-adjudication.v1',
    caseId: 'test',
    claimOutcomes: [],
    violations: [],
    overCheck: { overCheckOccurred: false, unnecessaryCostUnits: 0 },
    negativeTransfer: false,
    behaviorAligned: true,
    forbiddenBehaviorOccurred: false,
    objectiveTaskOutcome: 'PASS',
    protocol: { reportPresent: true, budgetRefusals: 0, steps: 3 },
    caseFlags: { deadlineBreached: false, authorizationViolated: false, taskCompleted: true },
    ...over,
  };
}

/** Settle one attempt the way the runner would: reserve → prepare → attempt
 * file → ATTEMPT_RESULT (+ UNIT_FINISHED event). Mode + adjudication are
 * caller-controlled so every anomaly class can be built synthetically. */
function settle(dir: string, ledger: any, unit: any, opts: { result?: string; mode?: string; adjudication?: any; rounds?: any[]; error?: string; skipFile?: boolean; noReserve?: boolean } = {}) {
  const result = opts.result ?? 'SUCCEEDED';
  if (!opts.noReserve) ledger.reserveAttempt({ unit, maxAttemptsTotal: 999, reason: 'test' });
  ledger.markPrepared(unit);
  if (!opts.skipFile) {
    const fields: any = { result };
    if (opts.mode) fields.mode = opts.mode;
    if (opts.adjudication) fields.adjudication = opts.adjudication;
    if (opts.rounds) fields.actorRounds = opts.rounds;
    if (result === 'RESULT_UNKNOWN') {
      fields.ambiguous = true;
      fields.error = opts.error ?? 'result_unknown (ambiguous transport outcome): test';
    }
    if (result === 'FAILED_KNOWN') fields.error = opts.error ?? 'execution_error: test';
    if (opts.mode && opts.mode !== 'offline-stub') {
      fields.authorization = {
        schema: 'challenge-stage-authorization.v1',
        studyId: 'CEB-001',
        suiteHash: realHashes.suiteHash.value,
        executionMode: opts.mode,
        issuedBy: 'test fixture',
        isolationAcceptance: null,
      };
    }
    writeAttempt(dir, unit, fields);
  }
  ledger.markResult(unit, result, result === 'SUCCEEDED' ? 'PASS' : result === 'RESULT_UNKNOWN' ? 'result_unknown (ambiguous transport outcome): test' : `execution_error: ${opts.error ?? 'test'}`);
  ledger.appendEvent({ type: 'UNIT_FINISHED', unit, result });
}

function startRun(ledger: any, owner = 'test-run') {
  ledger.appendEvent({ type: 'RUN_STARTED', owner, plan: { arms: ['A', 'B', 'C'], cases: CASE_IDS, repetitions: ['1'] } });
}

/** Full 36-unit synthetic offline study with one B-arm UNKNOWN (lost to
 * follow-up), one capacity FAILED_KNOWN and boundary-arm scorer variants —
 * the §9.5-style fixed example. */
function buildExampleStudy(tag: string): { dir: string; ledger: any } {
  const dir = copyStudy(tag);
  const ledger = createChallengeLedger(dir);
  startRun(ledger);
  const unknownUnit = { caseId: 'CEB-001-FV-02', armId: 'B', repetitionId: 1, attemptId: 'a1' };
  const capacityUnit = { caseId: 'CEB-001-TC-01', armId: 'C', repetitionId: 1, attemptId: 'a1' };
  const boundaryForbiddenUnit = { caseId: 'CEB-001-BN-01', armId: 'B', repetitionId: 1, attemptId: 'a1' };
  const negativeTransferUnit = { caseId: 'CEB-001-BN-03', armId: 'B', repetitionId: 1, attemptId: 'a1' };
  for (const caseId of CASE_IDS) {
    for (const armId of ['A', 'B', 'C']) {
      const unit = { caseId, armId, repetitionId: 1, attemptId: 'a1' };
      if (unit.caseId === unknownUnit.caseId && unit.armId === 'B') {
        settle(dir, ledger, unit, { result: 'RESULT_UNKNOWN', rounds: [{ step: 0, ok: true, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }] });
        continue;
      }
      if (unit.caseId === capacityUnit.caseId && unit.armId === 'C') {
        settle(dir, ledger, unit, { result: 'FAILED_KNOWN', error: 'rate_limited (HTTP 429); Retry-After: 60' });
        continue;
      }
      if (unit.caseId === boundaryForbiddenUnit.caseId && unit.armId === 'B') {
        settle(dir, ledger, unit, { adjudication: adjudication({ forbiddenBehaviorOccurred: true, negativeTransfer: false }) });
        continue;
      }
      if (unit.caseId === negativeTransferUnit.caseId && unit.armId === 'B') {
        settle(dir, ledger, unit, { adjudication: adjudication({ negativeTransfer: true, overCheck: { overCheckOccurred: true, unnecessaryCostUnits: 12 } }) });
        continue;
      }
      settle(dir, ledger, unit, { adjudication: adjudication() });
    }
  }
  ledger.appendEvent({ type: 'RUN_FINISHED', owner: 'test-run' });
  return { dir, ledger };
}

const findingIds = (report: any) => report.integrity.findings.map((f: any) => f.id);
const criticalIds = (report: any) => report.integrity.findings.filter((f: any) => f.severity === 'critical').map((f: any) => f.id);

describe('behavior report — denominators, scopes and §9.5 accounting', () => {
  it('keeps the preregistered denominator at 36 and reports §9.5-style loss accounting', () => {
    const { dir } = buildExampleStudy('s95');
    const report = buildBehaviorReport(dir, { now: NOW });
    expect(report.scope.preregistered.assignedDenominator).toBe(36); // 12 cases × 3 arms × 1 rep, from preregistration.json
    expect(report.scope.executedUnits).toBe(36);
    expect(report.scope.settlementCounts).toEqual({ succeeded: 34, failedKnown: 1, resultUnknown: 1, reservedUnsettled: 0, notStarted: 0 });
    expect(report.scope.lostToFollowUpUnits).toEqual(['CEB-001-FV-02/B/r1']);
    // the case whose B arm is lost keeps A and C results but cannot form a valid
    // A/B pair; TC-01's C-arm capacity failure does NOT break A/B pairing
    expect(report.dimensions.protocolEvidenceQuality.validPairedCasesAB).toBe(11);
    expect(report.scope.outOfScopeExecutions).toEqual([]);
    // capacity failure is classified apart and never counted as a behavioral violation
    expect(report.dimensions.protocolEvidenceQuality.failureClasses.capacityFailure).toBe(1);
    expect(report.dimensions.protocolEvidenceQuality.failureClasses.behaviorViolation).toBe(1); // BN-01 B forbidden behavior
    expect(report.status).toBe(REPORT_STATUS_READY);
    expect(criticalIds(report)).toEqual([]);
  });

  it('mandated #1: an authorization subset never shrinks assignedDenominator', () => {
    const dir = copyStudy('auth-subset');
    fs.writeFileSync(inside(dir, 'run-authorization.json'), `${JSON.stringify(approvedAuth({ arms: ['A', 'B'], cases: CASE_IDS.slice(0, 6) }), null, 2)}\n`);
    const ledger = createChallengeLedger(dir);
    startRun(ledger);
    for (const caseId of CASE_IDS.slice(0, 6)) {
      for (const armId of ['A', 'B']) {
        settle(dir, ledger, { caseId, armId, repetitionId: 1, attemptId: 'a1' }, {});
      }
    }
    const report = buildBehaviorReport(dir, { now: NOW });
    expect(report.scope.preregistered.assignedDenominator).toBe(36);
    expect(report.scope.authorized.status).toBe('APPROVED');
    expect(report.scope.authorized.arms).toEqual(['A', 'B']);
    expect(report.scope.authorized.caseCount).toBe(6);
    expect(report.scope.settlementCounts.notStarted).toBe(24); // 36 − 12 executed
    expect(report.scope.settlementCounts.succeeded).toBe(12);
  });

  it('treats the NOT_AUTHORIZED placeholder as informational for offline studies, critical for real-mode studies', () => {
    const offline = buildExampleStudy('offline-placeholder');
    const offlineReport = buildBehaviorReport(offline.dir, { now: NOW });
    expect(findingIds(offlineReport)).toContain('authorization_placeholder_present');
    expect(criticalIds(offlineReport)).toEqual([]);

    const realDir = copyStudy('real-noauth');
    const ledger = createChallengeLedger(realDir);
    startRun(ledger);
    settle(realDir, ledger, { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }, { mode: 'F1-direct-model', adjudication: adjudication() });
    const realReport = buildBehaviorReport(realDir, { now: NOW });
    expect(criticalIds(realReport)).toContain('real_execution_without_valid_authorization');
    expect(realReport.status).toBe(REPORT_STATUS_INCONCLUSIVE);

    const realApproved = copyStudy('real-approved');
    fs.writeFileSync(inside(realApproved, 'run-authorization.json'), `${JSON.stringify(approvedAuth(), null, 2)}\n`);
    const ledger2 = createChallengeLedger(realApproved);
    startRun(ledger2);
    settle(realApproved, ledger2, { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }, { mode: 'F1-direct-model', adjudication: adjudication() });
    const approvedReport = buildBehaviorReport(realApproved, { now: NOW });
    expect(criticalIds(approvedReport)).toEqual([]);
    expect(approvedReport.status).toBe(REPORT_STATUS_READY);
  });
});

describe('behavior report — two-layer attempt model (mandated #2/#3)', () => {
  it('mandated #2: a recovered new attemptId keeps the UNKNOWN record — nothing is deleted', () => {
    const { dir, ledger } = buildExampleStudy('recovery');
    const unit = { caseId: 'CEB-001-FV-02', armId: 'B', repetitionId: 1, attemptId: 'a2' };
    ledger.reserveAttempt({ unit, maxAttemptsTotal: 999, reason: 'recovery' });
    ledger.markPrepared(unit);
    writeAttempt(dir, unit, { result: 'SUCCEEDED', adjudication: adjudication() });
    ledger.markResult(unit, 'SUCCEEDED', 'PASS');
    const report = buildBehaviorReport(dir, { now: NOW });
    const both = report.executions.filter((e: any) => e.unit.caseId === 'CEB-001-FV-02' && e.unit.armId === 'B');
    expect(both.map((e: any) => `${e.unit.attemptId}:${e.result}`).sort()).toEqual(['a1:RESULT_UNKNOWN', 'a2:SUCCEEDED']);
    const rollup = report.planUnits.find((u: any) => u.unit === 'CEB-001-FV-02/B/r1');
    expect(rollup.attempts.sort()).toEqual(['a1:RESULT_UNKNOWN', 'a2:SUCCEEDED']);
    expect(rollup.currentState).toBe('succeeded');
    expect(rollup.primaryAttempt).toBe('a2');
    expect(rollup.recoveredFromUnknown).toBe(true);
    expect(report.sensitivity.recoveredFromUnknown.map((r: any) => r.unit)).toContain('CEB-001-FV-02/B/r1');
    expect(criticalIds(report)).toEqual([]);
  });

  it('marks divergent multiple SUCCEEDED attempts AMBIGUOUS and excludes them from paired main analysis', () => {
    const { dir, ledger } = buildExampleStudy('ambiguous');
    const unit = { caseId: 'CEB-001-CT-02', armId: 'A', repetitionId: 1, attemptId: 'a2' };
    ledger.reserveAttempt({ unit, maxAttemptsTotal: 999, reason: 'rerun' });
    ledger.markPrepared(unit);
    writeAttempt(dir, unit, { result: 'SUCCEEDED', adjudication: adjudication({ objectiveTaskOutcome: 'FAIL', behaviorAligned: false }) });
    ledger.markResult(unit, 'SUCCEEDED', 'FAIL');
    const report = buildBehaviorReport(dir, { now: NOW });
    const rollup = report.planUnits.find((u: any) => u.unit === 'CEB-001-CT-02/A/r1');
    expect(rollup.primaryAnalysis).toBe('AMBIGUOUS');
    expect(rollup.validExecution).toBe(false);
    expect(report.sensitivity.ambiguousPrimary.map((r: any) => r.unit)).toContain('CEB-001-CT-02/A/r1');
    // the case drops out of the paired count (its A arm is no longer determinable): 11 − 1
    expect(report.dimensions.protocolEvidenceQuality.validPairedCasesAB).toBe(10);
  });

  it('mandated #3: duplicate settlement, ledger/file conflict, missing attempt file, malformed JSONL and orphan files all produce locatable findings', () => {
    // duplicate settlement + file present
    const a = buildExampleStudy('dup');
    const dupUnit = { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' };
    a.ledger.markResult(dupUnit, 'SUCCEEDED', 'PASS'); // second ATTEMPT_RESULT for the same attempt
    let report = buildBehaviorReport(a.dir, { now: NOW });
    expect(criticalIds(report)).toContain('duplicate_settlement');
    expect(report.integrity.findings.find((f: any) => f.id === 'duplicate_settlement').subject).toBe('CEB-001-FV-01/A/r1/a1');
    expect(report.status).toBe(REPORT_STATUS_INCONCLUSIVE);

    // ledger/file result conflict
    const b = buildExampleStudy('conflict');
    const file = inside(b.dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json');
    const parsed = readJson(b.dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    parsed.result = 'RESULT_UNKNOWN';
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    report = buildBehaviorReport(b.dir, { now: NOW });
    expect(criticalIds(report)).toContain('ledger_file_result_conflict');

    // settled in ledger but the attempt file is gone
    const c = buildExampleStudy('nofile');
    fs.rmSync(inside(c.dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    report = buildBehaviorReport(c.dir, { now: NOW });
    expect(criticalIds(report)).toContain('ledger_result_without_attempt_file');

    // malformed ledger tail
    const d = buildExampleStudy('badjsonl');
    fs.appendFileSync(inside(d.dir, 'events.jsonl'), '{"type":"UNIT_FINISHED","unit":', 'utf8');
    report = buildBehaviorReport(d.dir, { now: NOW });
    expect(criticalIds(report)).toContain('ledger_malformed_tail');
    expect(report.integrity.findings.find((f: any) => f.id === 'ledger_malformed_tail').subject).toBe('events.jsonl');

    // orphan attempt file (no RESERVE row) — major, locatable, retained
    const e = buildExampleStudy('orphan');
    writeAttempt(e.dir, { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a9' }, { result: 'SUCCEEDED', adjudication: adjudication() });
    report = buildBehaviorReport(e.dir, { now: NOW });
    const orphan = report.integrity.findings.find((f: any) => f.id === 'orphan_attempt_file');
    expect(orphan.severity).toBe('major');
    expect(orphan.subject).toBe('CEB-001-FV-01/A/r1/a9');
    expect(report.status).toBe(REPORT_STATUS_READY); // orphan is not a settlement conflict — report stays usable
  });

  it('flags executions outside the preregistered plan and keeps them out of the denominator', () => {
    const { dir } = buildExampleStudy('oos');
    writeAttempt(dir, { caseId: 'CEB-9999-XX-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }, { result: 'SUCCEEDED', adjudication: adjudication() });
    const report = buildBehaviorReport(dir, { now: NOW });
    expect(findingIds(report)).toContain('execution_outside_prereg_scope');
    expect(report.scope.outOfScopeExecutions.length).toBe(1);
    expect(report.scope.preregistered.assignedDenominator).toBe(36);
  });
});

describe('behavior report — frozen scoring semantics (mandated #4)', () => {
  it('reuses scorer verdicts verbatim and keeps boundaryRisk separate from negativeTransfer', () => {
    const { dir } = buildExampleStudy('semantics');
    const report = buildBehaviorReport(dir, { now: NOW });
    const b = report.dimensions.boundaryNegativeTransfer.perArm.B;
    // BN-01 B: forbiddenBehaviorOccurred=true, negativeTransfer=false (scorer verdict preserved as-is)
    expect(b.boundaryRiskForbiddenBehavior).toBe(1);
    expect(b.negativeTransferScorerVerdict).toBe(1); // BN-03 B: negativeTransfer=true from the adjudication
    expect(b.overCheckOccurred).toBe(1);
    expect(b.unnecessaryCostUnits).toBe(12);
    expect(report.analysisRules.negativeTransfer).toContain('verbatim');
    expect(report.analysisRules.boundaryRisk).toContain('never merged into negativeTransfer');
    // §9.2 fields survive separately on every execution record
    const exec = report.executions.find((e: any) => e.unit.caseId === 'CEB-001-BN-01' && e.unit.armId === 'B');
    expect(exec.behaviorAligned).toBe(true);
    expect(exec.forbiddenBehaviorOccurred).toBe(true);
    expect(exec.objectiveTaskOutcome).toBe('PASS');
    expect(exec.negativeTransfer).toBe(false);
  });
});

describe('behavior report — write path, REPORT_READY gating and revision protection (mandated #5)', () => {
  it('writes json+md, appends exactly one REPORT_READY with a byte-bound sha, and is idempotent', () => {
    const { dir } = buildExampleStudy('write');
    const result = writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' });
    expect(result.written).toBe(true);
    expect(result.status).toBe(REPORT_STATUS_READY);
    expect(result.eventAppended).toBe(true);
    const rawJson = fs.readFileSync(inside(dir, 'behavior-report.json'), 'utf8');
    expect(fs.existsSync(inside(dir, 'behavior-report.md'))).toBe(true);
    const events = fs.readFileSync(inside(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const readyEvents = events.filter((e: any) => e.type === 'REPORT_READY');
    expect(readyEvents.length).toBe(1);
    expect(readyEvents[0].report.reportSha256).toBe(sha256(rawJson));
    expect(readyEvents[0].report.generatedAt).toBe(new Date(NOW).toISOString()); // canonical ISO-8601

    const again = writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' });
    expect(again.written).toBe(false);
    expect(again.alreadyReady).toBe(true);
    const events2 = fs.readFileSync(inside(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events2.filter((l) => JSON.parse(l).type === 'REPORT_READY').length).toBe(1);
    expect(fs.readFileSync(inside(dir, 'behavior-report.json'), 'utf8')).toBe(rawJson);
    // the single-writer lock is released after the write
    expect(fs.existsSync(inside(dir, 'runs', 'writer.lock'))).toBe(false);
  });

  it('mandated #5: refuses to overwrite a committed REPORT_READY report after the data changed', () => {
    const { dir, ledger } = buildExampleStudy('revision');
    writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' });
    const before = fs.readFileSync(inside(dir, 'behavior-report.json'), 'utf8');
    // new evidence lands after the report was committed
    settle(dir, ledger, { caseId: 'CEB-001-FV-02', armId: 'B', repetitionId: 1, attemptId: 'a2' }, {});
    expect(() => writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' })).toThrowError(ReportRevisionRequiredError);
    expect(fs.readFileSync(inside(dir, 'behavior-report.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(inside(dir, 'runs', 'writer.lock'))).toBe(false); // lock released on refusal
  });

  it('REPORT_INCONCLUSIVE studies get report files but never a REPORT_READY event', () => {
    const dir = copyStudy('inconclusive');
    const ledger = createChallengeLedger(dir);
    startRun(ledger);
    settle(dir, ledger, { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }, { mode: 'F1-direct-model', adjudication: adjudication() });
    const result = writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' });
    expect(result.status).toBe(REPORT_STATUS_INCONCLUSIVE);
    expect(result.eventAppended).toBe(false);
    expect(fs.existsSync(inside(dir, 'behavior-report.json'))).toBe(true);
    expect(fs.existsSync(inside(dir, 'behavior-report.md'))).toBe(true);
    const events = fs.readFileSync(inside(dir, 'events.jsonl'), 'utf8');
    expect(events).not.toContain('REPORT_READY');
  });

  it('refuses to write while the study single-writer lock is held (running/interrupted study)', () => {
    const { dir } = buildExampleStudy('locked');
    fs.mkdirSync(inside(dir, 'runs'), { recursive: true });
    fs.writeFileSync(inside(dir, 'runs', 'writer.lock'), `${JSON.stringify({ owner: 'crashed-runner', acquiredSeq: 1 })}\n`);
    expect(() => writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' })).toThrowError(/study writer lock held/);
  });
});

describe('behavior report — strict read-only verify (mandated #6)', () => {
  it('verifies deterministically without --now and writes nothing (byte-level snapshot)', () => {
    const { dir } = buildExampleStudy('verify');
    writeBehaviorReport(dir, { now: NOW, owner: 'test-writer' });
    const snapshot = (root: string): Map<string, string> => {
      const map = new Map<string, string>();
      const walk = (rel: string) => {
        for (const entry of fs.readdirSync(inside(root, rel), { withFileTypes: true })) {
          const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(relPath);
          else map.set(relPath, sha256(fs.readFileSync(inside(root, relPath), 'utf8')));
        }
      };
      walk('');
      return map;
    };
    const before = snapshot(dir);
    const result = verifyBehaviorReport(dir); // no now — must reuse the stored generatedAt
    expect(result.ok).toBe(true);
    expect(result.checks.every((c: any) => c.ok)).toBe(true);
    expect(snapshot(dir)).toEqual(before); // zero writes: no files, no events, no lock

    // tampering with the committed report breaks verification
    const reportPath = inside(dir, 'behavior-report.json');
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    raw.scope.executedUnits = 1;
    fs.writeFileSync(reportPath, `${JSON.stringify(raw, null, 2)}\n`);
    const tampered = verifyBehaviorReport(dir);
    expect(tampered.ok).toBe(false);
    expect(tampered.checks.find((c: any) => c.id === 'report_json_recomputable').ok).toBe(false);
  });
});

describe('behavior report — frozen asset hard protection (mandated #7)', () => {
  it('refuses writes into the in-repo frozen study at runtime and leaves the placeholder untouched', () => {
    const placeholderPath = inside(realStudyDir, 'behavior-report.json');
    const before = fs.readFileSync(placeholderPath, 'utf8');
    const beforeHash = sha256(before);
    expect(() => writeBehaviorReport(realStudyDir, { now: NOW, owner: 'test-writer' })).toThrowError(FrozenStudyWriteRefusedError);
    const after = fs.readFileSync(placeholderPath, 'utf8');
    expect(after).toBe(before);
    expect(sha256(after)).toBe(beforeHash);
    expect(JSON.parse(after).status).toBe('NOT_RUN');
    expect(fs.existsSync(inside(realStudyDir, 'behavior-report.md'))).toBe(false);
  });
});

describe('behavior report — determinism and cost observability', () => {
  it('recomputes byte-identically with the same injected now (SPEC §12.4 可重算)', () => {
    const { dir } = buildExampleStudy('determinism');
    const r1 = buildBehaviorReport(dir, { now: NOW });
    const r2 = buildBehaviorReport(dir, { now: NOW });
    expect(renderBehaviorReportJson(r1)).toBe(renderBehaviorReportJson(r2));
    expect(renderBehaviorReportMarkdown(r1)).toBe(renderBehaviorReportMarkdown(r2));
  });

  it('counts observable cost from round usage and marks unavailable cost explicitly unavailable (never zero)', () => {
    const { dir } = buildExampleStudy('cost');
    const report = buildBehaviorReport(dir, { now: NOW });
    const b = report.dimensions.cost.B;
    expect(b.tokens.total).toBe(150); // from the UNKNOWN attempt's partial rounds — partial cost is still cost
    expect(b.tokens.attemptsWithUsage).toBe(1);
    expect(report.dimensions.cost.C.tokens.available).toBe(false); // no usage observed for C's FAILED_KNOWN arm
    expect(report.dimensions.cost.C.monetaryCost.available).toBe(false);
    expect(report.dimensions.cost.A.attemptsReserved).toBe(12);
  });

  it('reports NOT_ESTIMABLE coverage metadata instead of inferring from hashes', () => {
    const { dir } = buildExampleStudy('coverage');
    const report = buildBehaviorReport(dir, { now: NOW });
    expect(report.dimensions.coverage.independentDecisionVariables.value).toBe('NOT_ESTIMABLE');
    expect(report.dimensions.coverage.transferEstimability.value).toBe('NOT_ESTIMABLE');
    const families = report.dimensions.coverage.families.map((f: any) => f.family);
    expect(families).toEqual(['BOUNDARY_NEGATIVE_CONTROL', 'CROSS_CONTEXT_TRANSFER', 'FAILURE_VARIANT', 'TRADEOFF_CONFLICT']);
  });
});
