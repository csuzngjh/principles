import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyOfflinePackage, hashOfCanonical, challengeImplementationManifest } from './lib/challenge-freeze.mjs';
import { runExaminerRequest } from './lib/challenge-examiner.mjs';
import { compileCase } from './lib/challenge-compile.mjs';
import { buildClaimEnvironment, newClaimRunState } from './lib/claim-evidence-env.mjs';
import { runControlledActorLoop, createScriptedStub } from './lib/challenge-actor.mjs';
import { adjudicateClaimEvidence } from './lib/claim-evidence-scorer.mjs';
import { buildProductizationCalibrationReport } from './lib/challenge-behavior-report.mjs';

export async function replayExmPackage(dir) {
  const manifest = verifyOfflinePackage(dir);
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
  if (input.runnerHash !== hashOfCanonical(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))) throw new Error('RUNNER_DRIFT');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-frozen-replay-'));
  const mockResult = await runExaminerRequest({ ...input.fixture, workDir, requestId: 'frozen-r1', transport: 'mock' });
  if (mockResult.result !== 'SUCCEEDED' || !mockResult.candidates.every((candidate) => candidate.ok)) throw new Error('MOCK_GENERATION_FAILED');
  const executions = [];
  for (const sample of input.samples) {
    const env = buildClaimEnvironment(sample.caseDef);
    const compiled = compileCase(sample.caseDef);
    const run = await runControlledActorLoop({ env, runState: newClaimRunState(env), caseVisible: compiled.actorVisible,
      actor: createScriptedStub({ actions: sample.actions }), linkage: { studyId: input.fixture.spec.studyId, caseId: sample.caseDef.caseId } });
    const adjudication = adjudicateClaimEvidence({ caseDef: sample.caseDef, runState: run.runState });
    executions.push({ id: sample.strategy, strategy: sample.strategy, caseId: sample.caseDef.caseId,
      caseHash: hashOfCanonical(sample.caseDef), ...run, adjudication });
  }
  const cases = input.samples.map((sample) => sample.caseDef);
  const report = buildProductizationCalibrationReport({ cases, executions, implementation: challengeImplementationManifest(), studyId: input.fixture.spec.studyId,
    candidateCounts: { total: mockResult.candidates.length, valid: 0 } });
  return { packageHash: manifest.packageHash, executions, report, reportHash: hashOfCanonical(report),
    status: 'CALIBRATION_REPLAYED_GOLD_REVIEW_PENDING' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'challenge-studies', 'EXM-MVP-001-v4');
  const result = await replayExmPackage(dir);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected-replay.json'), 'utf8'));
  if (result.reportHash !== expected.reportHash || hashOfCanonical(result.executions) !== expected.executionsHash) throw new Error('FROZEN_REPLAY_MISMATCH');
  console.log(JSON.stringify({ status: result.status, packageHash: result.packageHash, reportHash: result.reportHash, executions: result.executions.length, observedNodeVersion: process.versions.node }));
}
