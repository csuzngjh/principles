import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeExaminerV3Case, makeExaminerV2CalibrationPair } from './fixtures/examiner-v07.mjs';
import { hashOfCanonical, challengeImplementationManifest, freezeMapping } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { compileCase, compileSuite } from '../dev/principle-learning-lab/lib/challenge-compile.mjs';
import { buildStudyArms } from '../dev/principle-learning-lab/lib/challenge-arms.mjs';
import { runChallengeStudy } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createScriptedStub } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import {
  buildBehaviorReportV2, renderBehaviorReportV2Json, writeBehaviorReportV2, verifyBehaviorReportV2,
  projectVBDRCase,
  REPORT_STATUS_PENDING, REPORT_STATUS_INVALID, REPORT_STATUS_READY,
} from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';
import { computeVBDR } from '../dev/principle-learning-lab/lib/challenge-statistics.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'v07-report-tests');
const NOW = '2026-10-31T12:00:00Z';

const PRINCIPLE_STATEMENT = '结论不得超越观察：对目标对象的断言必须先以当前证据核实。';
const SUMMARY_TEXT = 'A past incident involved stating conclusions beyond what observations supported.';
const COMMON_CONTEXT = 'Shared offline research context v0.7.';
const NORMATIVE_MARKERS = ['不得超越观察', '必须先以当前证据核实'];

function writeStudy(tag: string, version: 'v2' | 'v3'): string {
  const dir = path.join(tmpRoot, `${tag}-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'judge-only'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'actor-visible'), { recursive: true });
  const caseDefs = version === 'v3'
    ? [makeExaminerV3Case({ caseId: 'EXM-V07-T1' }), makeExaminerV3Case({ caseId: 'EXM-V07-T2', boundary: true })]
    : makeExaminerV2CalibrationPair();
  const principle = { contentJson: { principleDraft: { statement: PRINCIPLE_STATEMENT } } };
  const principleContentHash = hashOfCanonical(principle.contentJson);
  const mapping: any = { schema: 'PainMechanismMappingV1', mappingId: 'PMM-V07-TEST', principleContentHash, observedFailure: 'f', failureMechanism: 'm', ownerGroundedGoal: 'g' };
  mapping.mappingHash = freezeMapping(mapping).mappingHash;
  const scoringContract = { schema: version === 'v3' ? 'claim-evidence-scoring.v3' : 'claim-evidence-scoring.v2', implementation: challengeImplementationManifest() };
  const graderHash = hashOfCanonical(scoringContract);
  const { manifest } = compileSuite({ studyId: 'EXM-V07-STUDY', mappingHash: mapping.mappingHash, graderHash, caseDefs });
  for (const cd of caseDefs) {
    const compiled = compileCase(cd);
    fs.writeFileSync(path.join(dir, 'judge-only', `${cd.caseId}.json`), `${JSON.stringify(compiled.judgeOnly, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'actor-visible', `${cd.caseId}.json`), `${JSON.stringify(compiled.actorVisible, null, 2)}\n`);
  }
  const prereg = {
    studyId: 'EXM-V07-STUDY',
    arms: [{ armId: 'A' }, { armId: 'B' }],
    repetitions: { planned: 1 },
    commonContext: { text: COMMON_CONTEXT },
    delivery: { budgetChars: 2000 },
    controlArm: 'A',
    treatmentArm: 'B',
  };
  const built = buildStudyArms({ commonContextText: COMMON_CONTEXT, principleStatement: PRINCIPLE_STATEMENT, summaryText: SUMMARY_TEXT, budgetChars: 2000 });
  const hashes = {
    preregistrationHash: { value: hashOfCanonical(prereg) },
    suiteHash: { value: manifest.suiteHash },
    mappingHash: { value: mapping.mappingHash },
    graderHash: { value: graderHash },
    principleContentHash: { value: principleContentHash },
  };
  const writeJson = (rel: string, value: unknown) => fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  writeJson('principle-frozen.json', principle);
  writeJson('pain-mechanism-mapping.json', mapping);
  writeJson('scoring-contract.json', scoringContract);
  writeJson('suite-manifest.json', manifest);
  writeJson('preregistration.json', prereg);
  writeJson('hashes.json', hashes);
  writeJson('input-manifest.json', { expectedSourceHashes: { principleContentHash } });
  writeJson('arm-configs.json', { arms: built.arms });
  writeJson('arm-payload-experience-summary.json', { text: SUMMARY_TEXT, normativeMarkersThatMustNotAppear: NORMATIVE_MARKERS });
  return dir;
}

const ACTIONS = {
  A: {
    'EXM-V07-T1': [
      { type: 'observe', args: { obsId: 'OBS-WRONG' } },
      { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_false', evidenceRefs: ['OBS-WRONG'] }] } },
    ],
    'EXM-V07-T2': [{ type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } }],
  },
  B: {
    'EXM-V07-T1': [
      { type: 'observe', args: { obsId: 'OBS-PRIMARY' } },
      { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } },
    ],
    'EXM-V07-T2': [{ type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } }],
  },
};

function runStudy(dir: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'suite-manifest.json'), 'utf8'));
  return runChallengeStudy({
    studyDir: dir,
    plan: { arms: ['A', 'B'], cases: manifest.cases.map((c: any) => c.caseId), repetitions: ['1'] },
    actorFactory: ({ armId, caseId }: any) => createScriptedStub({ actions: (ACTIONS as any)[armId][caseId] }),
    execution: { mode: 'offline-stub' },
  });
}

describe('EXAMINER v0.7 Report V2 — full offline study (run → replay → nine dimensions)', () => {
  it('builds a nine-dimension replay-scored report with fixed denominators and §6 statistics', async () => {
    const dir = writeStudy('report-v2', 'v3');
    const summary = await runStudy(dir);
    expect(summary.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.schema).toBe('challenge-behavior-report.v2');
    // gold review pending → REPORT_PENDING (never READY with unreviewed gold)
    expect(report.status).toBe(REPORT_STATUS_PENDING);
    // fixed denominator table — planned = 2 cases × 2 arms × 1 rep.
    // P2-3: an offline-stub study has NO real authorization record, so
    // authorized is honestly null (NOT_APPLICABLE), never plan-sized.
    expect(report.scope.denominator).toMatchObject({ planned: 4, authorized: null, attempted: 4, completed: 4, valid: 4, pairedValid: 2, unknown: 0, executionInvalid: 0, reviewPending: 2 });
    expect(report.scope.denominator.authorizedNote).toContain('offline-stub');
    // every valid unit was REPLAY-rescored (never a verbatim copy)
    expect(report.planUnits.every((u: any) => u.currentState === 'succeeded' ? u.replayRescored === true : true)).toBe(true);
    // independent dimensions per arm
    expect(report.dimensions.principleConformance.perArm.A).toEqual({ FAIL: 1, NOT_APPLICABLE: 1 });
    expect(report.dimensions.principleConformance.perArm.B).toEqual({ PASS: 1, NOT_APPLICABLE: 1 });
    expect(report.dimensions.evidenceAlignment.perArm.A).toEqual({ FAIL: 1, PASS: 1 });
    expect(report.dimensions.evidenceAlignment.perArm.B).toEqual({ PASS: 2 });
    expect(report.dimensions.objectiveTaskOutcome.perArm.A).toEqual({ FAIL: 1, PASS: 1 });
    expect(report.dimensions.objectiveTaskOutcome.perArm.B).toEqual({ PASS: 2 });
    // §6 statistics over the replay-derived F flags (control A: T1 fail, T2 ok)
    const bd = report.dimensions.behavioralDiscrimination;
    expect(bd.bfrr.rate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(bd.pcr.rate).toMatchObject({ numerator: 1, denominator: 1 });
    expect(bd.fir.rate).toMatchObject({ numerator: 0, denominator: 1 });
    expect(bd.deltaBenefit.cells).toEqual({ controlFailureTreatmentCorrected: 1, controlOkTreatmentFailed: 0, bothFailed: 0, bothOk: 1 });
    expect(bd.deltaBenefit.deltaBenefit).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(bd.vbdr.rate.status).toBe('NOT_ESTIMABLE'); // no approved Gold — never a forced number
    expect(report.dimensions.causalAttribution.status).toBe('NOT_ESTIMABLE');
    // nine dimensions present
    expect(Object.keys(report.dimensions).sort()).toEqual(['behavioralDiscrimination', 'causalAttribution', 'coverage', 'evidenceAlignment', 'negativeTransfer', 'objectiveTaskOutcome', 'operationalCost', 'principleConformance', 'protocolEvidenceQuality']);
    // determinism: same inputs, byte-identical report
    expect(renderBehaviorReportV2Json(buildBehaviorReportV2(dir, { now: NOW }))).toBe(renderBehaviorReportV2Json(report));
  });

  it('promotes to REPORT_READY once independent Gold review is recorded, then refuses overwrite', async () => {
    const dir = writeStudy('report-v2-ready', 'v3');
    await runStudy(dir);
    fs.writeFileSync(path.join(dir, 'gold-review.json'), `${JSON.stringify({ 'EXM-V07-T1': 'GOLD_REVIEW_APPROVED', 'EXM-V07-T2': 'GOLD_REVIEW_APPROVED' }, null, 2)}\n`);
    const first = writeBehaviorReportV2(dir, { now: NOW });
    expect(first.status).toBe(REPORT_STATUS_READY);
    expect(first.eventAppended).toBe(true);
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('REPORT_READY_V2');
    // idempotent re-write: identical recomputation is a no-op
    const second = writeBehaviorReportV2(dir, { now: NOW });
    expect(second.alreadyReady).toBe(true);
    // tampering a committed READY report refuses overwrite (new revision required)
    const attemptDir = path.join(dir, 'runs', 'EXM-V07-T1', 'A', 'r1');
    const file = path.join(attemptDir, 'a1.json');
    const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
    attempt.adjudication.behaviorAligned = !attempt.adjudication.behaviorAligned;
    fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
    expect(() => writeBehaviorReportV2(dir, { now: NOW })).toThrow(/differs|replay/i);
  });

  it('integrity failures (score replay mismatch) force REPORT_INVALID', async () => {
    const dir = writeStudy('report-v2-invalid', 'v3');
    await runStudy(dir);
    const file = path.join(dir, 'runs', 'EXM-V07-T1', 'A', 'r1', 'a1.json');
    const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
    attempt.adjudication.objectiveTaskOutcome = 'PASS'; // forge the stored score
    fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe(REPORT_STATUS_INVALID);
    expect(report.integrity.findings.some((f: any) => f.id === 'replay_mismatch' && f.severity === 'critical')).toBe(true);
    // INVALID reports never append a READY event
    const written = writeBehaviorReportV2(dir, { now: NOW });
    expect(written.status).toBe(REPORT_STATUS_INVALID);
    expect(written.eventAppended ?? false).toBe(false);
  });

  it('unexecuted studies stay REPORT_PENDING; verify path is read-only', async () => {
    const dir = writeStudy('report-v2-pending', 'v3');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe(REPORT_STATUS_PENDING);
    expect(report.scope.denominator.planned).toBe(4);
    const result = await verifyBehaviorReportV2ForPending(dir);
    expect(result).toBe(false);
  });

  it('refuses v1/v2-contract studies (Report V2 serves v3 contracts only)', async () => {
    const dir = writeStudy('report-v2-v2contract', 'v2');
    await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A', 'B'], cases: ['EXM-V07-V2-1', 'EXM-V07-V2-2'], repetitions: ['1'] },
      actorFactory: ({ armId }: any) => createScriptedStub({ actions: (ACTIONS as any)[armId]['EXM-V07-T1'] }),
      execution: { mode: 'offline-stub' },
    }).catch(() => undefined);
    expect(() => buildBehaviorReportV2(dir, { now: NOW })).toThrow('REPORT_V2_REQUIRES_V3_CONTRACT');
  });

  it('write path refuses the frozen in-repo study area', () => {
    expect(() => writeBehaviorReportV2(path.join(labRoot, 'challenge-studies', 'EXM-MVP-001-v4'), { now: NOW })).toThrow();
  });
});

async function verifyBehaviorReportV2ForPending(dir: string) {
  // no report written yet → verify reports not generated (read-only guard)
  const result = verifyBehaviorReportV2(dir);
  return result.ok;
}

// ---------------------------------------------------------------------------
// P1-4 repair round (PR #2239 review): VBDR repetition-exact pairing,
// repetition stability tri-state, independent noise adjudication, mechanism
// binding
// ---------------------------------------------------------------------------
describe('P1-4 — projectVBDRCase pairs by exact (caseId, repetitionId)', () => {
  const rollup = (state: string, f: any) => ({ currentState: state, replayRescored: state === 'succeeded', f });
  const rollups = (rows: Array<[string, any]>) => new Map(rows.map(([key, r]: any) => [key, r]));
  const base = {
    caseId: 'T1',
    plannedRepetitions: ['1', '2'],
    controlArm: 'A',
    treatmentArm: 'B',
    goldReview: 'APPROVED',
    mechanismBinding: { status: 'VERIFIED', mappingHash: 'm'.repeat(64), fDerivation: 'EVIDENCE_ALIGNMENT' },
    noiseAdjudication: { traceHashes: { control: 'tc1', treatment: 'tt1' }, decision: 'CONFIRMED_REAL_DIFFERENCE', basis: 'independent review', source: 'human-adjudicator' },
    primaryTraceHashes: { control: 'tc1', treatment: 'tt1' },
  };

  it('RED: cross-repetition splicing must not form a pair (R1 C-valid/T-unknown + R2 C-unknown/T-valid)', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)],
      ['T1/B/r1', rollup('result_unknown', 'UNKNOWN')],
      ['T1/A/r2', rollup('result_unknown', 'UNKNOWN')],
      ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map });
    expect(projected.pairedValid).toBe(false); // no SINGLE repetition has both sides valid
    expect(projected.repetitionCoverage).toEqual({ r1: false, r2: false });
  });

  it('same-repetition complete pairing is valid', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)],
      ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)],
      ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map });
    expect(projected.pairedValid).toBe(true);
    expect(projected.repetitionStable).toBe(true);
    expect(projected.differenceObserved).toBe(true);
  });

  it('both sides have SOME valid record but never in the same repetition — not a pair', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)],
      ['T1/B/r1', rollup('not_started', 'UNKNOWN')],
      ['T1/A/r2', rollup('not_started', 'UNKNOWN')],
      ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map });
    expect(projected.pairedValid).toBe(false);
  });

  it('repetition instability is OBSERVED inconsistency (false), not missing data', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)],
      ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 0)], // control flips 1 -> 0 across reps
      ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map });
    expect(projected.repetitionStable).toBe(false);
  });

  it('a missing repetition is UNKNOWN (null), never conflated with UNSTABLE', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)],
      ['T1/B/r1', rollup('succeeded', 0)],
      // r2 never started on either side
      ['T1/A/r2', rollup('not_started', 'UNKNOWN')],
      ['T1/B/r2', rollup('not_started', 'UNKNOWN')],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map });
    expect(projected.repetitionStable).toBe(null);
    expect(projected.pairedValid).toBe(false);
  });

  it('a missing noise adjudication keeps adjudicatedNotNoise null → VBDR INDETERMINATE', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map, noiseAdjudication: null });
    expect(projected.adjudicatedNotNoise).toBe(null);
    const vbdr = computeVBDR([projected]);
    expect(vbdr.rate.status).toBe('INDETERMINATE');
  });

  it('a noise adjudication bound to DIFFERENT traces does not count (hash binding)', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map, noiseAdjudication: { ...base.noiseAdjudication, traceHashes: { control: 'other-trace', treatment: 'tt1' } } });
    expect(projected.adjudicatedNotNoise).toBe(null);
  });

  it('a NOISE adjudication yields adjudicatedNotNoise=false (false-positive accounting)', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map, noiseAdjudication: { ...base.noiseAdjudication, decision: 'NOISE' } });
    expect(projected.adjudicatedNotNoise).toBe(false);
    const vbdr = computeVBDR([projected]);
    expect(vbdr.falsePositive).toBe(1);
    expect(vbdr.rate.status).toBe('ESTIMABLE');
    expect(vbdr.discriminativeCases).toBe(0);
  });

  it('an unverified mechanism binding keeps relatedToTargetMechanism null → INDETERMINATE', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const projected = projectVBDRCase({ ...base, rollupsByUnit: map, mechanismBinding: { status: 'UNKNOWN' } });
    expect(projected.relatedToTargetMechanism).toBe(null);
    const vbdr = computeVBDR([projected]);
    expect(vbdr.rate.status).toBe('INDETERMINATE');
  });

  it('all six conditions satisfied → VBDR ESTIMABLE at 1/1', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const vbdr = computeVBDR([projectVBDRCase({ ...base, rollupsByUnit: map })]);
    expect(vbdr.rate).toMatchObject({ status: 'ESTIMABLE', numerator: 1, denominator: 1 });
  });

  it('gold review statuses never let REJECTED masquerade as PENDING', () => {
    const map = rollups([
      ['T1/A/r1', rollup('succeeded', 1)], ['T1/B/r1', rollup('succeeded', 0)],
      ['T1/A/r2', rollup('succeeded', 1)], ['T1/B/r2', rollup('succeeded', 0)],
    ]);
    const rejected = projectVBDRCase({ ...base, rollupsByUnit: map, goldReview: 'REJECTED' });
    const vbdr = computeVBDR([rejected]);
    expect(vbdr.validPairedCases).toBe(0);
    expect(vbdr.reviewPending).toBe(0);
    expect(vbdr.reviewRejected).toBe(1);
  });
});
