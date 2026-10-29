import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOfflinePackage } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { replayExmPackage } from '../dev/principle-learning-lab/run-exm-mvp-offline.mjs';
import { compileCase } from '../dev/principle-learning-lab/lib/challenge-compile.mjs';
import { replayChallengeExecution, challengeImplementationManifest } from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab/challenge-studies/EXM-MVP-001-v4');
describe('frozen EXM-MVP-001 is executable evidence, not a hash-only snapshot', () => {
  it('keeps every pending review form bound to the final Gold version', () => {
    const input = JSON.parse(fs.readFileSync(path.join(source, 'inputs.json'), 'utf8'));
    const summaries = ['gold-review.json', 'blind-review/review-form.json', 'blind-review/receipts.template.json'].map((file) => JSON.parse(fs.readFileSync(path.join(source, file), 'utf8')));
    for (const sample of input.samples) for (const summary of summaries) {
      const rows = summary.reviews || summary.caseDecisions || summary.goldReviews;
      expect(rows.find((row) => row.caseId === sample.caseDef.caseId).goldHash).toBe(compileCase(sample.caseDef).goldHash);
    }
  });
  it('reexecutes all nine strategies and reproduces the frozen report', async () => {
    const result = await replayExmPackage(source);
    const expected = JSON.parse(fs.readFileSync(path.join(source, 'expected-replay.json'), 'utf8'));
    expect(result.executions).toHaveLength(9);
    expect(result.executions.every((execution) => execution.trace.linkage.studyId === 'EXM-MVP-001-v4')).toBe(true);
    expect(result.reportHash).toBe(expected.reportHash);
    expect(result.report.negativeTransferMetrics.unnecessaryRefusal.numerator).toBe(1);
    expect(result.report.negativeTransferMetrics.alternativePathBlocking.numerator).toBe(1);
    expect(result.report.negativeTransferMetrics.repeatedConfirmation.numerator).toBe(1);
    expect(result.report.realExaminerValidCases).toBe(0);
  });
  it('rejects replay under the wrong study version', () => {
    const input = JSON.parse(fs.readFileSync(path.join(source, 'inputs.json'), 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(source, 'expected-replay.json'), 'utf8'));
    expect(() => replayChallengeExecution({ caseDef: input.samples[0].caseDef,
      execution: expected.executions[0], implementation: challengeImplementationManifest(), studyId: 'EXM-MVP-001-v3' })).toThrow('CALIBRATION_LINKAGE_INVALID');
  });
  for (const file of ['inputs.json', 'gold-review.json', 'expected-replay.json', 'package-manifest.json']) {
    it(`rejects ${file} drift without writing the frozen package`, () => {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-drift-'));
      fs.cpSync(source, copy, { recursive: true });
      const target = path.join(copy, file);
      const data = JSON.parse(fs.readFileSync(target, 'utf8'));
      data.unreviewedChange = true;
      fs.writeFileSync(target, JSON.stringify(data));
      expect(() => verifyOfflinePackage(copy)).toThrow('OFFLINE_PACKAGE_DRIFT');
      expect(() => verifyOfflinePackage(source)).not.toThrow();
    });
  }
});
