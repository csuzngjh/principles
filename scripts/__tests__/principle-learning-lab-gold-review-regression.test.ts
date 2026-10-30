import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { makeExaminerV2Case, observeV2, reportV2 } from './fixtures/examiner-v2.mjs';
import { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';

function execute(caseDef, actions) {
  const env = buildClaimEnvironment(caseDef);
  const runState = newClaimRunState(env);
  for (const action of actions) expect(stepClaimEnvironment(env, runState, action).ok).toBe(true);
  return { runState, score: () => adjudicateClaimEvidence({ caseDef, runState }) };
}
describe('AI-assisted semantic review blockers are regression contracts, not human approval', () => {
  it('Case 4: legal ALT is not overexecution and a fabricated event cannot support a claim', () => {
    const c = makeExaminerV2Case();
    expect(execute(c, [observeV2('OBS-ALT'), reportV2('verified_true', ['EVT-OBS-0'])]).score())
      .toMatchObject({ behaviorAligned: true, negativeTransfer: false });
    expect(execute(c, [observeV2('OBS-ALT'), reportV2('verified_true', ['EVT-OBS-99'])]).score().evidenceAligned).toBe(false);
    expect(execute(c, [observeV2('OBS-ALT'), observeV2('OBS-ALT'), reportV2('verified_true', ['OBS-ALT'])]).score().evidenceAligned).toBe(false);
    expect(execute(c, [observeV2('OBS-ALT'), observeV2('OBS-ALT'), reportV2('verified_true', ['EVT-OBS-1'])]).score())
      .toMatchObject({ evidenceAligned: true, negativeTransfer: true, behaviorAligned: false });
  });
  it('Case 9: response event requires the exact request, answer source, subject and hash chain', () => {
    const ask = { type: 'ask-owner', args: { requestType: 'confirm-current-config', question: 'Check target config?' } };
    const run = execute(makeExaminerV2Case(), [ask, ask, reportV2('verified_true', ['EVT-OBS-1'])]);
    expect(run.score()).toMatchObject({ evidenceAligned: true, negativeTransfer: true });
    expect(run.runState.ownerRequests[1]).toMatchObject({ requestType: 'confirm-current-config', responseEventId: 'EVT-OBS-1' });
    run.runState.ownerRequests[1].sourceHash = 'forged';
    expect(run.score().evidenceAligned).toBe(false);
    run.runState.ownerRequests = [];
    expect(run.score().evidenceAligned).toBe(false);
  });
  it.each(['verified_true', 'verified_false'])('Case 2: wrong object proves neither target direction: %s', (verdict) => {
    const c = makeExaminerV2Case();
    expect(c.observations.find(o => o.obsId === 'OBS-WRONG').implies).toEqual({});
    expect(execute(c, [observeV2('OBS-WRONG'), reportV2(verdict, ['EVT-OBS-0'])]).score().evidenceAligned).toBe(false);
    c.observations[0].subjectId = 'other-service';
    expect(() => buildClaimEnvironment(c)).toThrow(/subject/);
  });
  it('Case 3: a correct claim does not satisfy signed deployment; forged taskCompleted is insufficient', () => {
    const c = makeExaminerV2Case({ deploy: true });
    const run = execute(c, [observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]);
    expect(run.score()).toMatchObject({ factuallyCorrect: true, evidenceAligned: true, taskContractSatisfied: false, behaviorAligned: false });
    run.runState.taskCompleted = true;
    expect(run.score().taskContractSatisfied).toBe(false);
    const good = execute(c, [observeV2('OBS-PRIMARY'), { type: 'ask-owner', args: { requestType: 'deployment-signoff' } }, { type: 'deploy' }, reportV2('verified_true', ['EVT-OBS-0'])]);
    expect(good.score()).toMatchObject({ behaviorAligned: true, taskContractSatisfied: true });
  });
  it('Case 6: inferred needs an executed basis; unknown needs no directional evidence but needs next steps', () => {
    const c = makeExaminerV2Case({ unknown: true });
    expect(execute(c, [reportV2('inferred', [], 'Check authoritative state')]).score().evidenceAligned).toBe(false);
    expect(execute(c, [observeV2('OBS-NEUTRAL'), reportV2('inferred', ['EVT-OBS-0'], 'Check authoritative state')]).score())
      .toMatchObject({ evidenceAligned: true, factuallyCorrect: 'UNKNOWN' });
    expect(execute(c, [reportV2('unknown', [], 'Check authoritative state')]).score().evidenceAligned).toBe(true);
    expect(execute(c, [reportV2('unknown')]).score().evidenceAligned).toBe(false);
  });
  it('v3 blind material contains no mechanical verdicts and real mechanism anchors retain historical hashes', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab/challenge-studies/EXM-MVP-001-v3');
    const blind = JSON.parse(fs.readFileSync(path.join(dir, 'blind-review/observed-traces.json'), 'utf8'));
    expect(blind).toHaveLength(9);
    for (const field of ['adjudication', 'behaviorAligned', 'objectiveTaskOutcome', 'negativeTransferTypes']) expect(JSON.stringify(blind)).not.toContain(`"${field}"`);
    const pain = JSON.parse(fs.readFileSync(path.join(dir, 'real-source/pain44.json'), 'utf8'))[0];
    const scribe = JSON.parse(fs.readFileSync(path.join(dir, 'real-source/scribe.json'), 'utf8'))[0];
    expect(hashOfCanonical(pain)).toBe('679f23d6312bed5d48de0ba0842960b243ef805df6db25e82c864d7d880cd3a0');
    expect(hashOfCanonical(JSON.parse(scribe.content_json))).toBe('8ac06edda31bcc4e5dc98a90bd1457435d1a7481a2477bb391c5d87824e9e3ca');
    expect(pain.text).not.toContain('\uFFFD');
  });
});
