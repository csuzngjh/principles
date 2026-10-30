import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { examinerV2CalibrationCases } from './fixtures/examiner-v2.mjs';
import { makeExaminerProductizationFixture } from './fixtures/examiner-productization-fixture.mjs';
import { runExaminerRequest } from '../dev/principle-learning-lab/lib/challenge-examiner.mjs';
import { compileCase } from '../dev/principle-learning-lab/lib/challenge-compile.mjs';
import { buildClaimEnvironment, newClaimRunState } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { runControlledActorLoop, createScriptedStub } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';
import { hashOfCanonical } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { challengeImplementationManifest, replayChallengeExecution, buildProductizationCalibrationReport } from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';

describe('EXM-MVP-001 offline integration — no formal Gold approval', () => {
  it('Mock candidates → compile → six strategies → pinned action replay → independent negative-transfer report', async () => {
    const samples = examinerV2CalibrationCases().map((sample, i) => ({ ...sample,
      caseDef: { ...sample.caseDef, caseId: `EXM-MVP-001-${i + 1}` } }));
    const cases = samples.map((sample) => sample.caseDef);
    const fixture = makeExaminerProductizationFixture(cases);
    fixture.spec.perRequestCandidateCap = 6;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-mvp-001-'));
    const result = await runExaminerRequest({ ...fixture, workDir: path.join(dir, 'generation'), requestId: 'r1' });
    expect(result.result).toBe('SUCCEEDED');
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates.every((candidate) => candidate.ok)).toBe(true);
    expect(result.candidates.some((candidate) => candidate.eligibleForFormalSet)).toBe(false);
    const implementation = challengeImplementationManifest();
    const executions = [];
    for (const sample of samples) {
      const compiled = compileCase(sample.caseDef);
      expect(JSON.stringify(compiled.actorVisible)).not.toMatch(/goldTruth|supportRules|acceptableVerdicts/);
      const env = buildClaimEnvironment(sample.caseDef);
      const run = await runControlledActorLoop({ env, runState: newClaimRunState(env),
        caseVisible: compiled.actorVisible, actor: createScriptedStub({ actions: sample.actions }),
        linkage: { studyId: 'EXM-MVP-001', caseId: sample.caseDef.caseId } });
      const adjudication = adjudicateClaimEvidence({ caseDef: sample.caseDef, runState: run.runState });
      expect(adjudication).toMatchObject(sample.expected);
      executions.push({ id: sample.strategy, strategy: sample.strategy, caseId: sample.caseDef.caseId,
        caseHash: hashOfCanonical(sample.caseDef), ...run, adjudication });
    }
    const input = { cases, executions, implementation, candidateCounts: { total: 6, valid: 0 } };
    const report = buildProductizationCalibrationReport(input);
    expect(report.negativeTransfer).toEqual({ numerator: 1, denominator: 6 });
    expect(report.realExaminerValidCases).toBe(0);
    expect(report.goldReview).toBe('GOLD_REVIEW_PENDING');
    expect(buildProductizationCalibrationReport(input)).toEqual(report);
    expect(buildProductizationCalibrationReport({ ...input, candidateCounts: { total: null, valid: 0 } }).validCandidateRate)
      .toMatchObject({ status: 'NOT_ESTIMABLE' });
    const replay = (execution, pinned = implementation, caseDef = cases[0]) => replayChallengeExecution({ caseDef, execution, implementation: pinned });
    const first = executions[0];
    expect(() => replay({ ...first, adjudication: { ...first.adjudication, behaviorAligned: false } })).toThrow('SCORE_REPLAY_MISMATCH');
    expect(() => replay({ ...first, runState: { ...first.runState, taskCompleted: true } })).toThrow('STATE_REPLAY_MISMATCH');
    expect(() => replay(first, { ...implementation, node: 'wrong-version' })).toThrow('IMPLEMENTATION_DRIFT');
    expect(() => replay(first, implementation, { ...cases[0], taskText: 'changed' })).toThrow('GOLD_OR_INPUT_DRIFT');
    expect(() => replay({ ...first, trace: { ...first.trace, records: [] } })).toThrow('TRAJECTORY_EVIDENCE_INSUFFICIENT');
    const forged = structuredClone(first);
    forged.trace.records.find((record) => record.kind === 'observation').output = 'fabricated observation';
    expect(() => replay(forged)).toThrow('OBSERVATION_REPLAY_MISMATCH');
    fs.writeFileSync(path.join(dir, 'calibration-evidence.json'), JSON.stringify({
      studyId: 'EXM-MVP-001', status: 'OFFLINE_ONLY_NOT_AUTHORIZED', cases, implementation, executions,
      mockResult: result, report, reportHash: hashOfCanonical(report),
      networkModelRequests: 0, realHostExecutions: 0,
    }, null, 2));
    console.log(`EXM-MVP-001 evidence: ${path.join(dir, 'calibration-evidence.json')}`);
  });
});
