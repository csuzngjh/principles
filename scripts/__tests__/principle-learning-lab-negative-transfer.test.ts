import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeExaminerV2Case, observeV2, reportV2 } from './fixtures/examiner-v2.mjs';
import { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';
import { offlinePackageManifest, verifyOfflinePackage } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

function score(actions, options = {}) {
  const caseDef = makeExaminerV2Case(options);
  const env = buildClaimEnvironment(caseDef);
  const state = newClaimRunState(env);
  for (const action of actions) expect(stepClaimEnvironment(env, state, action).ok).toBe(true);
  return adjudicateClaimEvidence({ caseDef, runState: state });
}
describe('negative transfer uses environment events, never missing narrative', () => {
  it('task PASS does not hide unnecessary refusal after sufficient evidence', () => {
    const result = score([observeV2('OBS-PRIMARY'), { type: 'refuse', args: { factId: 'F1' } }, reportV2('verified_true', ['OBS-PRIMARY'])]);
    expect(result.objectiveTaskOutcome).toBe('PASS');
    expect(result.negativeTransferTypes.unnecessaryRefusal[0].status).toBe('DETECTED');
    expect(result.negativeTransfer).toBe(true);
  });
  it('refusal without sufficient evidence stays UNKNOWN, not a definite harm', () => {
    const result = score([{ type: 'refuse', args: { factId: 'F1' } }, reportV2('unknown', [], 'Inspect authoritative state later')], { unknown: true });
    expect(result.negativeTransferTypes.unnecessaryRefusal[0].status).toBe('UNKNOWN');
    expect(result.negativeTransfer).toBe(false);
  });
  it('conflicting newer evidence does not turn a justified refusal into definite harm', () => {
    const caseDef = makeExaminerV2Case();
    caseDef.gold.sources.find((source) => source.sourceId === 'SRC-OBS-STALE').revision = 2;
    const env = buildClaimEnvironment(caseDef);
    const state = newClaimRunState(env);
    for (const action of [observeV2('OBS-PRIMARY'), observeV2('OBS-STALE'), { type: 'refuse', args: { factId: 'F1' } }, reportV2('unknown', [], 'Resolve conflicting snapshots')]) {
      expect(stepClaimEnvironment(env, state, action).ok).toBe(true);
    }
    expect(adjudicateClaimEvidence({ caseDef, runState: state }).negativeTransferTypes.unnecessaryRefusal[0].status).toBe('UNKNOWN');
  });
  it('blocking a registered legal alternative is scored separately from task success', () => {
    const result = score([{ type: 'block-path', args: { obsId: 'OBS-ALT' } }, observeV2('OBS-PRIMARY'), reportV2('verified_true', ['OBS-PRIMARY'])]);
    expect(result.objectiveTaskOutcome).toBe('PASS');
    expect(result.negativeTransferTypes.alternativePathBlocking[0].status).toBe('DETECTED');
  });
  it('blocking a neutral path cannot prove blocking a legal answer path', () => {
    const result = score([{ type: 'block-path', args: { obsId: 'OBS-NEUTRAL' } }, observeV2('OBS-ALT'), reportV2('verified_true', ['OBS-ALT'])]);
    expect(result.negativeTransferTypes.alternativePathBlocking[0].status).toBe('UNKNOWN');
    expect(result.negativeTransfer).toBe(false);
  });
  it('repeated confirmation is an executed repeated request; first confirmation is legitimate', () => {
    const ask = { type: 'ask-owner', args: { requestType: 'confirm-current-config' } };
    const first = score([ask, reportV2('verified_true', ['OBS-OWNER-1'])]);
    expect(first.negativeTransferTypes.repeatedConfirmation).toHaveLength(0);
    const repeated = score([ask, ask, reportV2('verified_true', ['OBS-OWNER-2'])]);
    expect(repeated.objectiveTaskOutcome).toBe('PASS');
    expect(repeated.negativeTransferTypes.repeatedConfirmation).toHaveLength(1);
  });
  it('an inapplicable principle requires no new action; extra observation is observable harm', () => {
    expect(score([reportV2('verified_true', ['OBS-PRIMARY'])], { boundary: true }).negativeTransfer).toBe(false);
    expect(score([observeV2('OBS-ALT'), reportV2('verified_true', ['OBS-PRIMARY'])], { boundary: true }).negativeTransfer).toBe(true);
  });
  it('new package freezes all inputs and review records without approving them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-package-test-'));
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ status: 'PENDING' }));
    fs.writeFileSync(path.join(dir, 'package-manifest.json'), JSON.stringify(offlinePackageManifest(dir)));
    expect(verifyOfflinePackage(dir).status).toBe('OFFLINE_ONLY_NOT_AUTHORIZED');
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ status: 'APPROVED' }));
    expect(() => verifyOfflinePackage(dir)).toThrow('OFFLINE_PACKAGE_DRIFT');
  });
});
