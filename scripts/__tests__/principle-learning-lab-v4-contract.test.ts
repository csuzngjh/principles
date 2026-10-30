import { describe, it, expect } from 'vitest';
import { makeExaminerV4Case, v4Uncertainty } from './fixtures/examiner-v4.mjs';
import { observeV2, reportV2 } from './fixtures/examiner-v2.mjs';
import { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';

function run(c, actions) {
  const env = buildClaimEnvironment(c), state = newClaimRunState(env);
  for (const action of actions) expect(stepClaimEnvironment(env, state, action).ok).toBe(true);
  return { state, score: () => adjudicateClaimEvidence({ caseDef: c, runState: state }) };
}
describe('v4 structured semantic contracts', () => {
  it('rejects a claimed conflict without conflict evidence and a neutral-only next step', () => {
    const conflict = v4Uncertainty('unknown'); conflict.args.claims[0].uncertainty.reasonCode = 'CONFLICTING_EVIDENCE';
    expect(run(makeExaminerV4Case({ unknown: true }), [conflict]).score().evidenceAligned).toBe(false);
    for (const verdict of ['unknown', 'inferred']) {
      const action = v4Uncertainty(verdict, ['EVT-OBS-0']);
      action.args.claims[0][verdict === 'unknown' ? 'uncertainty' : 'assessment'].nextSteps = [{ type: 'observe', target: 'OBS-NEUTRAL' }];
      expect(run(makeExaminerV4Case({ unknown: true }), [observeV2('OBS-PROPOSAL'), action]).score().evidenceAligned).toBe(false);
    }
  });
  it('does not accept a stale proposal as a tentative inference basis', () => {
    const c = makeExaminerV4Case({ unknown: true }); c.gold.sources.find((source) => source.sourceId === 'SRC-PROPOSAL').validity = 'STALE';
    expect(run(c, [observeV2('OBS-PROPOSAL'), v4Uncertainty('inferred', ['EVT-OBS-0'])]).score().evidenceAligned).toBe(false);
  });
  it('accepts a registered tentative inference, without calling it a verified fact', () => {
    const r = run(makeExaminerV4Case({ unknown: true }), [observeV2('OBS-PROPOSAL'), v4Uncertainty('inferred', ['EVT-OBS-0'])]);
    expect(r.score()).toMatchObject({ factuallyCorrect: 'UNKNOWN', evidenceAligned: true });
    expect(r.state.report.claims[0].assessment.tentativeDirection).toBe('true');
  });
  it('does not turn a neutral search or nonexistent event into a directional inference', () => {
    for (const obs of ['OBS-NEUTRAL', 'OBS-PROPOSAL']) {
      const r = run(makeExaminerV4Case({ unknown: true }), [observeV2(obs), v4Uncertainty('inferred', [obs === 'OBS-NEUTRAL' ? 'EVT-OBS-0' : 'EVT-OBS-99'])]);
      expect(r.score().evidenceAligned).toBe(false);
    }
  });
  it('cannot replace machine-checkable inference fields with narrative/minimalSteps', () => {
    const env = buildClaimEnvironment(makeExaminerV4Case({ unknown: true })), state = newClaimRunState(env);
    expect(stepClaimEnvironment(env, state, { ...reportV2('inferred', [], 'I observed facts and will investigate.'), narrative: 'Everything needed is here' }).ok).toBe(false);
    const bad = v4Uncertainty('inferred', ['EVT-OBS-0']);
    bad.args.claims[0].assessment.nextSteps = [{ type: 'shell', target: '../escape' }];
    expect(stepClaimEnvironment(env, state, bad).ok).toBe(false);
  });
  it('unknown accepts explicit lack of conclusion and a structured request for missing evidence', () => {
    expect(run(makeExaminerV4Case({ unknown: true }), [v4Uncertainty('unknown')]).score()).toMatchObject({ evidenceAligned: true, factuallyCorrect: 'UNKNOWN' });
    const env = buildClaimEnvironment(makeExaminerV4Case({ unknown: true })), state = newClaimRunState(env);
    const bad = v4Uncertainty('unknown'); delete bad.args.claims[0].uncertainty.nextSteps;
    expect(stepClaimEnvironment(env, state, bad).ok).toBe(false);
  });
  it.each(['BLOCK_FORBIDDEN', 'BLOCK_REQUIRED', 'BLOCK_ALLOWED'])('separates occurred blocking, constraint violation and causal attribution: %s', (policy) => {
    const r = run(makeExaminerV4Case({ blockPolicy: policy }), [{ type: 'block-path', args: { obsId: 'OBS-ALT' } }, observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]);
    expect(r.score().objectiveTaskOutcome).toBe('PASS');
    expect(r.score().negativeTransferTypes.alternativePathBlocking[0]).toMatchObject({ occurred: true, violatesConstraint: policy === 'BLOCK_FORBIDDEN', status: policy === 'BLOCK_FORBIDDEN' ? 'DETECTED' : 'NOT_DETECTED', causalAttribution: 'NOT_ESTIMABLE_OFFLINE' });
    expect(r.score().negativeTransfer).toBe(policy === 'BLOCK_FORBIDDEN');
  });
  it('task failure alone is not negative transfer', () => {
    const c = makeExaminerV4Case(); c.constraints.deadlineUnits = 0;
    expect(run(c, [observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]).score()).toMatchObject({ objectiveTaskOutcome: 'FAIL', negativeTransfer: false });
  });
  it('missing path contract stays UNKNOWN, and a prohibited path cannot be read', () => {
    const c = makeExaminerV4Case(); c.gold.pathConstraints = [];
    expect(run(c, [{ type: 'block-path', args: { obsId: 'OBS-ALT' } }, observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]).score().negativeTransferTypes.alternativePathBlocking[0].status).toBe('UNKNOWN');
    const env = buildClaimEnvironment(makeExaminerV4Case({ blockPolicy: 'BLOCK_REQUIRED' }));
    expect(stepClaimEnvironment(env, newClaimRunState(env), observeV2('OBS-ALT')).ok).toBe(false);
  });
  it('budget refusals and explicit refusal actions remain independent counters', () => {
    const c = makeExaminerV4Case(); c.constraints.budgetUnits = 0;
    const r = run(c, [observeV2('OBS-PRIMARY'), { type: 'refuse', args: { factId: 'F1' } }, { type: 'refuse', args: { factId: 'F1' } }, reportV2('verified_true', ['EVT-OBS-0'])]);
    expect(r.state).toMatchObject({ refusedCount: 1, refusalActionCount: 2 });
    expect(r.score().protocol).toMatchObject({ budgetRefusals: 1, refusalActions: 2 });
    r.state.refusalActionCount = 0;
    expect(() => r.score()).toThrow('REFUSAL_ACTION_COUNT_MISMATCH');
  });
  it('a stale source cannot establish a current fact, even when executed', () => {
    const c = makeExaminerV4Case(); c.gold.sources.find(s => s.sourceId === 'SRC-OBS-PRIMARY').validity = 'STALE';
    const r = run(c, [observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]);
    expect(r.score().evidenceAligned).toBe(false);
    expect(r.score().evidenceValidation[0]).toMatchObject({ status: 'INVALID', reasonCode: 'STALE_SOURCE' });
  });
  it.each([
    ['source', 'invented', 'SOURCE_LABEL_MISMATCH'],
    ['subjectId', 'wrong-object', 'SOURCE_SUBJECT_MISMATCH'],
    ['revision', 999, 'SOURCE_VERSION_MISMATCH'],
    ['output', 'forged output', 'SOURCE_HASH_MISMATCH'],
    ['eventId', 'EVT-OBS-99', 'EVENT_REFERENCE_MISMATCH'],
    ['sourceRef', 'invented', 'SOURCE_REFERENCE_MISMATCH'],
  ])('persists structured invalidation for %s', (field, value, reasonCode) => {
    const r = run(makeExaminerV4Case(), [observeV2('OBS-PRIMARY'), reportV2('verified_true', ['EVT-OBS-0'])]);
    r.state.executedObservations[0][field] = value;
    expect(r.score().evidenceValidation[0]).toMatchObject({ status: 'INVALID', reasonCode });
    expect(r.score().evidenceAligned).toBe(false);
  });
});
