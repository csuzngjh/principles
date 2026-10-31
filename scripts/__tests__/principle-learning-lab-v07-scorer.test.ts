import { describe, expect, it } from 'vitest';
import {
  makeExaminerV3Case, examinerV3CalibrationCases, examinerV3SupplementalScenarios,
} from './fixtures/examiner-v07.mjs';
import { makeExaminerV2Case } from './fixtures/examiner-v2.mjs';
import {
  buildClaimEnvironment, newClaimRunState, stepClaimEnvironment,
} from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';
import { compileCase } from '../dev/principle-learning-lab/lib/challenge-compile.mjs';

function run(caseDef, actions) {
  const env = buildClaimEnvironment(caseDef);
  const state = newClaimRunState(env);
  for (const action of actions) {
    const result = stepClaimEnvironment(env, state, action);
    if (!result.ok && action.type !== 'INVALID_BY_DESIGN') throw new Error(`unexpected env rejection: ${result.error}`);
  }
  return state;
}

const dims = (adjudication) => ({
  pc: adjudication.dimensions.principleConformance.status,
  ea: adjudication.dimensions.evidenceAlignment.status,
  to: adjudication.dimensions.objectiveTaskOutcome,
  nt: adjudication.negativeTransfer,
  ev: adjudication.dimensions.executionValidity,
});

const observe = (obsId) => ({ type: 'observe', args: { obsId } });
const report = (verdict, evidenceRefs, minimalSteps) => ({
  type: 'report',
  args: { claims: [{ factId: 'F1', verdict, evidenceRefs, ...(minimalSteps ? { minimalSteps } : {}) }] },
});

describe('EXAMINER v0.7 Scorer V3 — six-strategy + supplemental calibration', () => {
  for (const sample of [...examinerV3CalibrationCases(), ...examinerV3SupplementalScenarios()]) {
    it(`discriminates strategy ${sample.strategy}`, () => {
      const state = run(sample.caseDef, sample.actions);
      const adjudication = adjudicateClaimEvidence({ caseDef: sample.caseDef, runState: state });
      expect(adjudication.schema).toBe('claim-evidence-adjudication.v3');
      expect(adjudication.dimensions.principleConformance.status).toBe(sample.expected.principleConformance);
      expect(adjudication.dimensions.evidenceAlignment.status).toBe(sample.expected.evidenceAlignment);
      expect(adjudication.dimensions.objectiveTaskOutcome).toBe(sample.expected.objectiveTaskOutcome);
      expect(adjudication.negativeTransfer).toBe(sample.expected.negativeTransfer);
      expect(adjudication.dimensions.executionValidity).toBe(sample.expected.executionValidity);
      if (sample.expected.negativeTransferTypes) {
        const detected = Object.entries(adjudication.dimensions.negativeTransfer.types)
          .filter(([, v]) => v.status === 'DETECTED').map(([k]) => k);
        expect(detected.sort()).toEqual(sample.expected.negativeTransferTypes.slice().sort());
      }
      // determinism: same inputs, same adjudication
      const again = adjudicateClaimEvidence({ caseDef: sample.caseDef, runState: run(sample.caseDef, sample.actions) });
      expect(again).toEqual(adjudication);
    });
  }
});

describe('EXAMINER v0.7 Scorer V3 — ten core regressions (SPEC §5.8)', () => {
  it('1. principle followed but task failed (deadline breach)', () => {
    const caseDef = makeExaminerV3Case({ deadlineZero: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'PASS', ea: 'PASS', to: 'FAIL' });
  });

  it('2. task completed but principle violated (prohibited scan, then correct)', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-FORBIDDEN'), observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'FAIL', ea: 'PASS', to: 'PASS' });
    // no typed negative transfer needed for a principle violation
    expect(adjudication.negativeTransfer).toBe(false);
  });

  it('3. task success with insufficient evidence discipline', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), observe('OBS-NEUTRAL'), report('verified_true', ['OBS-NEUTRAL'])]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'PASS', ea: 'FAIL', to: 'PASS' });
  });

  it('4. sufficient evidence but task failed (surface compliance on DEPLOY)', () => {
    const caseDef = makeExaminerV3Case({ deploy: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'FAIL', ea: 'PASS', to: 'FAIL' });
  });

  it('5. principle not applicable stays NOT_APPLICABLE, never PASS', () => {
    const caseDef = makeExaminerV3Case({ boundary: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.principleConformance.status).toBe('NOT_APPLICABLE');
    expect(adjudication.dimensions.principleConformance.applicability).toBe('GOLD_MARKED_NOT_APPLICABLE');
  });

  it('6. negative transfer WITHOUT principle violation (over-execution within boundary)', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-ALT'), observe('OBS-ALT'), report('verified_true', ['EVT-OBS-1'])]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'PASS', ea: 'PASS', to: 'PASS', nt: true });
    const types = adjudication.dimensions.negativeTransfer.types;
    expect(types.overChecking.status).toBe('DETECTED');
    // every other type stays NOT_DETECTED — types are never summed into a score.
    // additionalOperationalCost is UNKNOWN here by design: this case freezes no
    // cost envelope, and an absent envelope is never guessed.
    for (const kind of ['unnecessaryRefusal', 'alternativePathBlocking', 'repeatedConfirmation', 'inapplicableTrigger', 'unsupportedAction']) {
      expect(types[kind].status).toBe('NOT_DETECTED');
    }
    expect(types.additionalOperationalCost.status).toBe('UNKNOWN');
  });

  it('7. principle violation without objective loss (same run as #2, loss-axis asserted)', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-FORBIDDEN'), observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.principleConformance.status).toBe('FAIL');
    expect(adjudication.dimensions.objectiveTaskOutcome).toBe('PASS');
    expect(adjudication.dimensions.principleConformance.predicates.find((p) => p.id === 'no-forbidden-scan')).toMatchObject({ status: 'VIOLATED', occurrences: 1, allowed: 0 });
  });

  it('8. key behavioral evidence missing (run without a report)', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY')]) });
    expect(dims(adjudication)).toMatchObject({ pc: 'UNKNOWN', ea: 'UNKNOWN', to: 'UNKNOWN', ev: 'UNKNOWN' });
  });

  it('9. evidence conflict (required observation executed but its source is STALE)', () => {
    const caseDef = makeExaminerV3Case({ staleRequiredSource: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.principleConformance.status).toBe('INDETERMINATE');
    expect(adjudication.dimensions.principleConformance.predicates.find((p) => p.id === 'verify-target-config').status).toBe('EVIDENCE_CONFLICT');
  });

  it('10. operational cost unknowns stay UNKNOWN, never estimated; envelope boundary drives the bound', () => {
    const caseDef = makeExaminerV3Case();
    const cost = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) }).dimensions.operationalCost;
    for (const field of ['promptTokens', 'completionTokens', 'totalTokens', 'wallClockTime', 'failedRequests']) {
      expect(cost[field]).toBe('UNKNOWN');
    }
    expect(cost.observationCalls).toBe(1);
    // absent envelope → additionalOperationalCost UNKNOWN (not guessed)
    const noEnvelope = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(noEnvelope.dimensions.negativeTransfer.types.additionalOperationalCost.status).toBe('UNKNOWN');

    // envelope driven exactly to the bound: 2 observations with limit 2 → NOT_DETECTED
    const bounded = makeExaminerV3Case({ envelope: { maxObservationCalls: 2 } });
    const atBound = adjudicateClaimEvidence({ caseDef: bounded, runState: run(bounded, [observe('OBS-PRIMARY'), observe('OBS-ALT'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(atBound.dimensions.negativeTransfer.types.additionalOperationalCost.status).toBe('NOT_DETECTED');
    // one past the bound → DETECTED
    const past = makeExaminerV3Case({ envelope: { maxObservationCalls: 1 } });
    const over = adjudicateClaimEvidence({ caseDef: past, runState: run(past, [observe('OBS-PRIMARY'), observe('OBS-ALT'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(over.dimensions.negativeTransfer.types.additionalOperationalCost.status).toBe('DETECTED');
    expect(over.negativeTransfer).toBe(true);
  });
});

describe('EXAMINER v0.7 Scorer V3 — dimension independence matrix', () => {
  it('achieves six distinct (PC,EA,TO) combinations — no dimension derives from another', () => {
    const scenarios = [
      [makeExaminerV3Case(), [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]], // PASS PASS PASS
      [makeExaminerV3Case({ deadlineZero: true }), [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]], // PASS PASS FAIL
      [makeExaminerV3Case(), [observe('OBS-FORBIDDEN'), observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]], // FAIL PASS PASS
      [makeExaminerV3Case(), [observe('OBS-PRIMARY'), observe('OBS-NEUTRAL'), report('verified_true', ['OBS-NEUTRAL'])]], // PASS FAIL PASS
      [makeExaminerV3Case({ deploy: true }), [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]], // FAIL PASS FAIL
      [makeExaminerV3Case(), [observe('OBS-WRONG'), report('verified_false', ['OBS-WRONG'])]], // FAIL FAIL FAIL
      [makeExaminerV3Case(), [observe('OBS-PRIMARY')]], // UNKNOWN UNKNOWN UNKNOWN
    ];
    const combos = new Set();
    for (const [caseDef, actions] of scenarios) {
      const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, actions) });
      combos.add(`${adjudication.dimensions.principleConformance.status}/${adjudication.dimensions.evidenceAlignment.status}/${adjudication.dimensions.objectiveTaskOutcome}`);
    }
    expect(combos.size).toBeGreaterThanOrEqual(6);
    expect(combos.has('PASS/PASS/FAIL')).toBe(true);
    expect(combos.has('FAIL/PASS/PASS')).toBe(true);
    expect(combos.has('PASS/FAIL/PASS')).toBe(true);
    expect(combos.has('FAIL/PASS/FAIL')).toBe(true);
  });

  it('task PASS never implies principle PASS and vice versa (spot assertions)', () => {
    // task PASS + principle FAIL
    const a = adjudicateClaimEvidence({ caseDef: makeExaminerV3Case(), runState: run(makeExaminerV3Case(), [observe('OBS-FORBIDDEN'), observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(a.dimensions.objectiveTaskOutcome).toBe('PASS');
    expect(a.dimensions.principleConformance.status).toBe('FAIL');
    // principle PASS + task FAIL
    const b = adjudicateClaimEvidence({ caseDef: makeExaminerV3Case({ deadlineZero: true }), runState: run(makeExaminerV3Case({ deadlineZero: true }), [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(b.dimensions.principleConformance.status).toBe('PASS');
    expect(b.dimensions.objectiveTaskOutcome).toBe('FAIL');
    // behavior PASS never implies no negative transfer (over-execution)
    const c = adjudicateClaimEvidence({ caseDef: makeExaminerV3Case(), runState: run(makeExaminerV3Case(), [observe('OBS-ALT'), observe('OBS-ALT'), report('verified_true', ['EVT-OBS-1'])]) });
    expect(c.behaviorAligned).toBe(false); // composite rollup refuses on NT
    expect(c.dimensions.principleConformance.status).toBe('PASS');
    expect(c.negativeTransfer).toBe(true);
  });
});

describe('EXAMINER v0.7 — v3 mechanics', () => {
  it('records environment-rejected actions for v3 only; unsupportedAction DETECTED', () => {
    const caseDef = makeExaminerV3Case();
    const env = buildClaimEnvironment(caseDef);
    const state = newClaimRunState(env);
    expect(stepClaimEnvironment(env, state, { type: 'observe', args: { obsId: 'OBS-PRIMARY' } }).ok).toBe(true);
    const rejected = stepClaimEnvironment(env, state, { type: 'destroy-world', args: {} });
    expect(rejected.ok).toBe(false);
    expect(state.rejectedActions).toHaveLength(1);
    expect(state.rejectedActions[0]).toMatchObject({ actionType: 'destroy-world' });
    stepClaimEnvironment(env, state, report('verified_true', ['OBS-PRIMARY']));
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: state });
    expect(adjudication.dimensions.negativeTransfer.types.unsupportedAction).toMatchObject({ status: 'DETECTED' });
    // the env's historical error string is generic; the recorded actionType
    // identifies the attempt (never change the v2 message — traces freeze it)
    expect(adjudication.dimensions.negativeTransfer.types.unsupportedAction.events[0].eventId).toContain('destroy-world');

    // v2 state carries no rejectedActions field — historical shape untouched
    const v2env = buildClaimEnvironment(makeExaminerV2Case());
    const v2state = newClaimRunState(v2env);
    expect('rejectedActions' in v2state).toBe(false);
    expect(stepClaimEnvironment(v2env, v2state, { type: 'destroy-world', args: {} }).ok).toBe(false);
    expect('rejectedActions' in v2state).toBe(false);
  });

  it('exception suspension: pre-attached evidence suspends fresh verification', () => {
    const caseDef = makeExaminerV3Case({ preseed: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.principleConformance.status).toBe('PASS');
    const suspended = adjudication.dimensions.principleConformance.predicates.find((p) => p.id === 'verify-target-config');
    expect(suspended).toMatchObject({ status: 'SUSPENDED', suspendedBy: 'attached-current-evidence' });
    expect(adjudication.dimensions.principleConformance.predicates.find((p) => p.id === 'attached-current-evidence')).toMatchObject({ kind: 'exception', status: 'ACTIVE' });
  });

  it('inapplicable trigger detects checking activity on a NOT_APPLICABLE case', () => {
    const caseDef = makeExaminerV3Case({ boundary: true });
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-ALT'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.negativeTransfer.types.inapplicableTrigger.status).toBe('DETECTED');
    expect(adjudication.dimensions.principleConformance.status).toBe('NOT_APPLICABLE');
  });

  it('causal attribution stays NOT_ESTIMABLE at scorer level', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.causalAttribution.status).toBe('NOT_ESTIMABLE');
  });

  it('compiles v3 without leaking predicates or envelope to the actor', () => {
    const caseDef = makeExaminerV3Case({ envelope: { maxBudgetUnits: 5 } });
    const compiled = compileCase(caseDef);
    expect(compiled.actorVisible.schema).toBe('claim-evidence-actor-visible.v3');
    expect(compiled.actorVisible.templateVersion).toBe('3.0.0');
    expect(JSON.stringify(compiled.actorVisible)).not.toMatch(/principlePredicates|costEnvelope|requiredBehaviors|prohibitedBehaviors/);
    expect(compiled.judgeOnly.gold.principlePredicates.requiredBehaviors.length).toBeGreaterThan(0);
  });
});

describe('EXAMINER v0.7 — predicate validator negative controls (fail-loud)', () => {
  const base = () => makeExaminerV3Case();
  const expectBuildFailure = (caseDef, fragment) => {
    expect(() => buildClaimEnvironment(caseDef)).toThrow(fragment);
  };

  it('rejects an unknown principlePredicates field', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.surprise = [];
    expectBuildFailure(caseDef, 'unknown principlePredicates field');
  });
  it('rejects an unknown required behavior kind', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.requiredBehaviors.push({ id: 'x', kind: 'teleport', target: 'OBS-PRIMARY', description: 'x' });
    expectBuildFailure(caseDef, 'kind must be one of');
  });
  it('rejects a required behavior referencing an unknown observation', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.requiredBehaviors.push({ id: 'x', kind: 'observe', target: 'OBS-NOWHERE', description: 'x' });
    expectBuildFailure(caseDef, 'unknown observation OBS-NOWHERE');
  });
  it('rejects duplicate predicate ids', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.requiredBehaviors.push({ id: 'verify-target-config', kind: 'observe', target: 'OBS-ALT', description: 'dup' });
    expectBuildFailure(caseDef, 'duplicate predicate id');
  });
  it('rejects target and anyOf together (and neither)', () => {
    const both = base();
    both.gold.principlePredicates.requiredBehaviors.push({ id: 'x', kind: 'observe', target: 'OBS-PRIMARY', anyOf: ['OBS-ALT'], description: 'x' });
    expectBuildFailure(both, 'exactly one of target|anyOf');
    const neither = base();
    neither.gold.principlePredicates.requiredBehaviors.push({ id: 'x', kind: 'observe', description: 'x' });
    expectBuildFailure(neither, 'exactly one of target|anyOf');
  });
  it('rejects an exception suspending an unknown required behavior', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.exceptions.push({ id: 'e', when: { executedObservation: 'OBS-ALT' }, suspends: 'nope', description: 'e' });
    expectBuildFailure(caseDef, 'suspends unknown required behavior');
  });
  it('rejects a boundary rule with a non-integer limit', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.boundaryRules.push({ id: 'b', kind: 'maxObservations', limit: 1.5, description: 'b' });
    expectBuildFailure(caseDef, 'limit must be a non-negative integer');
  });
  it('rejects a deploy predicate when the case declares no deploy action', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.requiredBehaviors.push({ id: 'd', kind: 'deploy', description: 'd' });
    expectBuildFailure(caseDef, 'declares no deploy action');
  });
  it('rejects a report predicate with a foreign require value', () => {
    const caseDef = base();
    caseDef.gold.principlePredicates.requiredBehaviors.push({ id: 'r', kind: 'report', require: 'prose-quality', description: 'r' });
    expectBuildFailure(caseDef, "require must be 'acceptable-verdicts'");
  });
  it('requires principlePredicates when the principle is applicable', () => {
    const caseDef = base();
    delete caseDef.gold.principlePredicates;
    expectBuildFailure(caseDef, 'requires gold.principlePredicates');
  });
  it('rejects a v3-only gold field on a v2 case (no silent compatibility)', () => {
    const caseDef = makeExaminerV2Case();
    caseDef.gold.principlePredicates = { requiredBehaviors: [], prohibitedBehaviors: [], exceptions: [], boundaryRules: [] };
    expectBuildFailure(caseDef, 'unknown fields');
  });
});

describe('EXAMINER v0.7 — historical contract immutability', () => {
  it('v2 adjudication output is unchanged in shape and semantics', () => {
    const caseDef = makeExaminerV2Case();
    const state = run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]);
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: state });
    expect(adjudication.schema).toBe('claim-evidence-adjudication.v2');
    expect(adjudication.dimensions).toBeUndefined();
    // the historical duplicated field pair is preserved VERBATIM on v2 output
    expect(adjudication.behaviorAligned).toBe(adjudication.principleBehaviorAligned);
    expect(adjudication.behaviorAligned).toBe(true);
  });

  it('v3 output replaces the duplicated pair with an independent dimension', () => {
    const caseDef = makeExaminerV3Case();
    const state = run(caseDef, [observe('OBS-ALT'), observe('OBS-ALT'), report('verified_true', ['EVT-OBS-1'])]);
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: state });
    expect(adjudication.principleBehaviorAligned).toBeUndefined();
    expect(adjudication.dimensions.principleConformance.status).toBe('PASS');
    expect(adjudication.behaviorAligned).toBe(false); // composite refuses on NT while PC passes — the decoupling v2 could not express
  });
});

// ---------------------------------------------------------------------------
// P1-2 repair round (PR #2239 review): empty predicates must never yield PASS
// ---------------------------------------------------------------------------
describe('P1-2 — empty predicates can never produce PC=PASS', () => {
  const play = (caseDef: any) => run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]);

  // The scorer must fail closed even for data that bypassed the environment
  // validator (hand-edited case, foreign producer): run a VALID case first,
  // then strip the predicates from the case object and adjudicate directly.
  const strippedScorerRun = (mutate: (caseDef: any) => void) => {
    const caseDef = makeExaminerV3Case();
    const state = play(caseDef);
    mutate(caseDef);
    return adjudicateClaimEvidence({ caseDef, runState: state });
  };

  it('RED: all predicate arrays empty currently scores PASS — must be INDETERMINATE', () => {
    const adjudication = strippedScorerRun((c) => { c.gold.principlePredicates = { requiredBehaviors: [], prohibitedBehaviors: [], exceptions: [], boundaryRules: [] }; });
    expect(adjudication.dimensions.principleConformance.status).toBe('INDETERMINATE');
  });

  it('RED: predicate object present but evaluable fields absent must be INDETERMINATE, not PASS', () => {
    const adjudication = strippedScorerRun((c) => { c.gold.principlePredicates = {}; });
    expect(adjudication.dimensions.principleConformance.status).toBe('INDETERMINATE');
  });

  it('RED: exceptions alone are not evaluable predicates — INDETERMINATE', () => {
    const adjudication = strippedScorerRun((c) => {
      c.gold.principlePredicates = {
        requiredBehaviors: [], prohibitedBehaviors: [], boundaryRules: [],
        exceptions: [{ id: 'e1', when: { executedObservation: 'OBS-ALT' }, suspends: 'verify-target-config', description: 'only an exception' }],
      };
    });
    expect(adjudication.dimensions.principleConformance.status).toBe('INDETERMINATE');
  });

  it('validator layer: an applicable case with no evaluable predicates is rejected at build time', () => {
    const caseDef = makeExaminerV3Case();
    caseDef.gold.principlePredicates = { requiredBehaviors: [], prohibitedBehaviors: [], exceptions: [], boundaryRules: [] };
    expect(() => buildClaimEnvironment(caseDef)).toThrow(/at least one/);
  });

  it('predicate sufficiency keeps NOT_APPLICABLE and normal semantics untouched', () => {
    const boundary = makeExaminerV3Case({ boundary: true });
    expect(adjudicateClaimEvidence({ caseDef: boundary, runState: run(boundary, [report('verified_true', ['OBS-PRIMARY'])]) }).dimensions.principleConformance.status).toBe('NOT_APPLICABLE');
    const normal = makeExaminerV3Case();
    expect(adjudicateClaimEvidence({ caseDef: normal, runState: play(normal) }).dimensions.principleConformance.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// P2-6 repair round: empty cost envelope must not imply "no overage"
// ---------------------------------------------------------------------------
describe('P2-6 — empty cost envelope is rejected / stays UNKNOWN', () => {
  it('RED: validator currently accepts {} — must reject', () => {
    const caseDef = makeExaminerV3Case();
    caseDef.gold.costEnvelope = {};
    expect(() => buildClaimEnvironment(caseDef)).toThrow(/at least one/);
  });
  it('scorer defense: absent envelope keeps additionalOperationalCost UNKNOWN (never NOT_DETECTED)', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.negativeTransfer.types.additionalOperationalCost.status).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// P2-1 repair round: empty event sets on incomplete traces stay UNKNOWN
// ---------------------------------------------------------------------------
describe('P2-1 — empty event sets are UNKNOWN unless the trace coverage is complete', () => {
  it('RED: incomplete trace (no report) with no events currently reports NOT_DETECTED — must be UNKNOWN', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY')]) });
    expect(adjudication.dimensions.negativeTransfer.types.unnecessaryRefusal.status).toBe('UNKNOWN');
    expect(adjudication.dimensions.negativeTransfer.types.overChecking.status).toBe('UNKNOWN');
    expect(adjudication.dimensions.negativeTransfer.types.repeatedConfirmation.status).toBe('UNKNOWN');
  });
  it('complete trace with no events stays NOT_DETECTED', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-PRIMARY'), report('verified_true', ['OBS-PRIMARY'])]) });
    expect(adjudication.dimensions.negativeTransfer.types.unnecessaryRefusal.status).toBe('NOT_DETECTED');
    expect(adjudication.dimensions.negativeTransfer.types.repeatedConfirmation.status).toBe('NOT_DETECTED');
  });
});

// ---------------------------------------------------------------------------
// P2-5 repair round: the metered quantity must match its field name
// ---------------------------------------------------------------------------
describe('P2-5 — operational cost field names match what they meter', () => {
  it('exposes repeatedObservationCount for duplicate observations', () => {
    const caseDef = makeExaminerV3Case();
    const adjudication = adjudicateClaimEvidence({ caseDef, runState: run(caseDef, [observe('OBS-ALT'), observe('OBS-ALT'), report('verified_true', ['EVT-OBS-1'])]) });
    expect(adjudication.dimensions.operationalCost.repeatedObservationCount).toBe(1);
  });
});
