import { describe, expect, it } from 'vitest';
import {
  computeBFRR, computePCR, computeFIR, computePairedEffect, computeVBDR,
  computeFactorialEffect, causalAttributionStatus,
} from '../dev/principle-learning-lab/lib/challenge-statistics.mjs';

const pair = (controlF, treatmentF, extra = {}) => ({
  unitId: `u${controlF}${treatmentF}${Math.random()}`, controlF, treatmentF, ...extra,
});

describe('EXAMINER v0.7 §6.2 BFRR', () => {
  it('computes rate and planned-denominator bounds from raw units (independently recomputable)', () => {
    // 10 planned control units: 4 confirmed failures, 4 confirmed non-failures, 2 unknown
    const units = [
      ...Array.from({ length: 4 }, () => ({ f: 1, executionValid: true })),
      ...Array.from({ length: 4 }, () => ({ f: 0, executionValid: true })),
      ...Array.from({ length: 2 }, () => ({ f: 'UNKNOWN', executionValid: true })),
    ];
    const result = computeBFRR(units, { plannedControlUnits: 10 });
    expect(result.validControlUnits).toBe(8);
    expect(result.confirmedFailures).toBe(4);
    expect(result.confirmedNonFailures).toBe(4);
    expect(result.unknownUnits).toBe(2);
    // independent recomputation: 4/8
    expect(result.rate).toMatchObject({ status: 'ESTIMABLE', numerator: 4, denominator: 8, value: 0.5 });
    // bounds over the FULL planned denominator: 4/10 and 6/10
    expect(result.bounds.lower).toMatchObject({ numerator: 4, denominator: 10, value: 0.4 });
    expect(result.bounds.upper).toMatchObject({ numerator: 6, denominator: 10, value: 0.6 });
  });

  it('execution-invalid units count as unknown, never as non-failures', () => {
    const units = [{ f: 0, executionValid: false }, { f: 1, executionValid: true }];
    const result = computeBFRR(units);
    expect(result.validControlUnits).toBe(1);
    expect(result.unknownUnits).toBe(1);
    expect(result.confirmedNonFailures).toBe(0);
  });

  it('empty denominator is NOT_ESTIMABLE, never 0%', () => {
    const result = computeBFRR([{ f: 'UNKNOWN' }]);
    expect(result.rate.status).toBe('NOT_ESTIMABLE');
    expect(computeBFRR([]).rate.status).toBe('NOT_ESTIMABLE');
    expect(computeBFRR([]).bounds.status).toBe('NOT_ESTIMABLE');
  });

  it('planned denominator cannot be shrunk by authorizing fewer units', () => {
    // 12 planned, only 6 units observed — the bounds still divide by 12
    const units = Array.from({ length: 6 }, () => ({ f: 1, executionValid: true }));
    const result = computeBFRR(units, { plannedControlUnits: 12 });
    expect(result.bounds.lower).toMatchObject({ numerator: 6, denominator: 12 });
  });
});

describe('EXAMINER v0.7 §6.3 PCR / §6.4 FIR', () => {
  it('covers all four complete paired combinations and recomputes exactly', () => {
    const pairs = [
      pair(1, 0), pair(1, 0), // corrected
      pair(0, 1), // introduced
      pair(1, 1), // both failed
      pair(0, 0), pair(0, 0), pair(0, 0), // both ok
    ];
    const pcr = computePCR(pairs);
    const fir = computeFIR(pairs);
    expect(pcr).toMatchObject({ baselineFailurePairs: 3, correctedPairs: 2, uncorrectedPairs: 1, treatmentUnknownPairs: 0 });
    expect(pcr.rate).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(fir).toMatchObject({ baselineNonFailurePairs: 4, introducedPairs: 1 });
    expect(fir.rate).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
  });

  it('Treatment UNKNOWN is excluded from the point estimate but bounds it — never deleted', () => {
    const pairs = [
      pair(1, 0), pair(1, 0), // corrected
      pair(1, 'UNKNOWN'), pair(1, 'UNKNOWN'), // treatment unknown
    ];
    const pcr = computePCR(pairs);
    expect(pcr.rate).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
    expect(pcr.treatmentUnknownPairs).toBe(2);
    // lower stays honest at 2/4; upper 4/4
    expect(pcr.bounds.lower).toMatchObject({ numerator: 2, denominator: 4, value: 0.5 });
    expect(pcr.bounds.upper).toMatchObject({ numerator: 4, denominator: 4, value: 1 });
  });

  it('execution-invalid treatment arms count as treatment unknown', () => {
    const pairs = [pair(1, 0), pair(1, 0, { treatmentExecutionValid: false })];
    const pcr = computePCR(pairs);
    expect(pcr.treatmentUnknownPairs).toBe(1);
    expect(pcr.rate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('Control UNKNOWN pairs are excluded from PCR/FIR denominators but retained and reported', () => {
    const pairs = [pair('UNKNOWN', 0), pair(1, 0)];
    const pcr = computePCR(pairs);
    expect(pcr.baselineFailurePairs).toBe(1);
    expect(pcr.pairedUnitsSeeDelta).toBeUndefined(); // shape guard: no hidden derived fields
  });

  it('FIR bounds mirror PCR discipline', () => {
    const pairs = [pair(0, 1), pair(0, 'UNKNOWN')];
    const fir = computeFIR(pairs);
    expect(fir.rate).toMatchObject({ numerator: 1, denominator: 1 });
    expect(fir.treatmentUnknownPairs).toBe(1);
    expect(fir.bounds.lower).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(fir.bounds.upper).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
  });

  it('zero denominators are NOT_ESTIMABLE', () => {
    expect(computePCR([]).rate.status).toBe('NOT_ESTIMABLE');
    expect(computePCR([pair(0, 1)]).rate.status).toBe('NOT_ESTIMABLE'); // no baseline failures
    expect(computePCR([pair(1, 'UNKNOWN')]).rate.status).toBe('NOT_ESTIMABLE');
    expect(computeFIR([]).rate.status).toBe('NOT_ESTIMABLE');
  });
});

describe('EXAMINER v0.7 §6.5 overall paired effect', () => {
  it('reports the complete four-cell table plus Δ, not an improvement rate alone', () => {
    const pairs = [pair(1, 0), pair(1, 0), pair(0, 1), pair(1, 1), pair(0, 0)];
    const effect = computePairedEffect(pairs);
    expect(effect.cells).toEqual({ controlFailureTreatmentCorrected: 2, controlOkTreatmentFailed: 1, bothFailed: 1, bothOk: 1 });
    expect(effect.controlFailureRate).toMatchObject({ numerator: 3, denominator: 5, value: 0.6 });
    expect(effect.treatmentFailureRate).toMatchObject({ numerator: 2, denominator: 5, value: 0.4 });
    expect(effect.deltaBenefit).toMatchObject({ numerator: 1, denominator: 5, value: 0.2 });
  });

  it('both-arm UNKNOWN pairs stay out of the point estimate but remain counted', () => {
    const pairs = [pair(1, 0), pair('UNKNOWN', 'UNKNOWN'), pair(1, 'UNKNOWN'), pair('UNKNOWN', 0)];
    const effect = computePairedEffect(pairs);
    expect(effect.determinedPairs).toBe(1);
    expect(effect.unknownPairsRetained).toBe(3);
    expect(effect.deltaBenefit).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
  });

  it('zero determined pairs → NOT_ESTIMABLE (no single p-value theatrics)', () => {
    const effect = computePairedEffect([pair('UNKNOWN', 0)]);
    expect(effect.deltaBenefit.status).toBe('NOT_ESTIMABLE');
    expect(effect.controlFailureRate).toBe('NOT_ESTIMABLE');
  });
});

describe('EXAMINER v0.7 §6.6 VBDR', () => {
  const approvedCase = (over = {}) => ({
    caseId: 'c', goldReview: 'APPROVED', pairedValid: true, executionInvalid: false,
    repetitionStable: true, differenceObserved: true, relatedToTargetMechanism: true, adjudicatedNotNoise: true, ...over,
  });

  it('counts every required field and computes the rate over Gold-approved valid pairs', () => {
    const cases = [
      approvedCase({ caseId: 'a' }),
      approvedCase({ caseId: 'b', differenceObserved: false }),
      { caseId: 'c', goldReview: 'PENDING' },
      { caseId: 'd', executionInvalid: true, goldReview: 'APPROVED' },
      { caseId: 'e', goldReview: 'APPROVED', pairedValid: true, repetitionStable: false, differenceObserved: true, relatedToTargetMechanism: true, adjudicatedNotNoise: true },
    ];
    const result = computeVBDR(cases);
    expect(result).toMatchObject({ plannedCases: 5, goldReviewApproved: 4, validPairedCases: 3, discriminativeCases: 1, executionInvalid: 1, reviewPending: 1, repetitionInstability: 1 });
    expect(result.rate).toMatchObject({ status: 'ESTIMABLE', numerator: 1, denominator: 3, value: 1 / 3 });
  });

  it('empty valid denominator is NOT_ESTIMABLE, never 0%', () => {
    const result = computeVBDR([{ caseId: 'a', goldReview: 'PENDING' }]);
    expect(result.rate.status).toBe('NOT_ESTIMABLE');
    expect(computeVBDR([]).rate.status).toBe('NOT_ESTIMABLE');
  });

  it('unresolved adjudication evidence is INDETERMINATE, never a forced 0%', () => {
    const cases = [
      approvedCase({ caseId: 'a', differenceObserved: false }),
      approvedCase({ caseId: 'b', adjudicatedNotNoise: null, differenceObserved: true }),
    ];
    const result = computeVBDR(cases);
    expect(result.rate.status).toBe('INDETERMINATE');
    expect(result.rate.denominator).toBe(2);
  });

  it('false positive / false negative are separate counters', () => {
    const cases = [
      approvedCase({ caseId: 'fp', differenceObserved: true, adjudicatedNotNoise: false }),
      approvedCase({ caseId: 'fn', differenceObserved: false, adjudicatedNotNoise: true }),
    ];
    const result = computeVBDR(cases);
    expect(result.falsePositive).toBe(1);
    expect(result.falseNegative).toBe(1);
    expect(result.discriminativeCases).toBe(0);
  });
});

describe('EXAMINER v0.7 §4.4 factorial computation contract', () => {
  it('computes main effects and interaction from integer counts', () => {
    const result = computeFactorialEffect({
      P0R0: { failures: 8, units: 10 }, P1R0: { failures: 2, units: 10 },
      P0R1: { failures: 9, units: 10 }, P1R1: { failures: 3, units: 10 },
    });
    expect(result.principleMainEffectWithoutRuleCode.value).toBeCloseTo(0.6, 12);
    expect(result.principleMainEffectWithRuleCode.value).toBeCloseTo(0.6, 12);
    expect(result.interaction.value).toBeCloseTo(0, 12);
  });

  it('a real interaction surfaces as a nonzero I and forbids independent-effect claims', () => {
    const result = computeFactorialEffect({
      P0R0: { failures: 8, units: 10 }, P1R0: { failures: 4, units: 10 },
      P0R1: { failures: 8, units: 10 }, P1R1: { failures: 8, units: 10 },
    });
    expect(result.principleMainEffectWithoutRuleCode.value).toBeCloseTo(0.4, 12);
    expect(result.principleMainEffectWithRuleCode.value).toBeCloseTo(0, 12);
    expect(result.interaction.value).toBeCloseTo(-0.4, 12);
  });

  it('empty arm → NOT_ESTIMABLE effects (fail loud on malformed input)', () => {
    const result = computeFactorialEffect({ P0R0: { failures: 0, units: 0 }, P1R0: { failures: 0, units: 5 }, P0R1: { failures: 1, units: 5 }, P1R1: { failures: 0, units: 5 } });
    expect(result.principleMainEffectWithoutRuleCode).toBe('NOT_ESTIMABLE');
    expect(result.interaction).toBe('NOT_ESTIMABLE');
    expect(() => computeFactorialEffect({ P0R0: { failures: 6, units: 5 }, P1R0: { failures: 0, units: 5 }, P0R1: { failures: 0, units: 5 }, P1R1: { failures: 0, units: 5 } })).toThrow('failures <= units');
  });
});

describe('EXAMINER v0.7 §5.9 causal attribution contract', () => {
  it('NOT_ESTIMABLE without verified isolation', () => {
    expect(causalAttributionStatus({ isolationVerified: false, randomizationDeclared: true, repetitionsMet: true, preregisteredDirection: 'improve', observedDirection: 'improve' }).status).toBe('NOT_ESTIMABLE');
  });
  it('DESCRIPTIVE_ONLY when randomization or preregistered repetitions are missing', () => {
    expect(causalAttributionStatus({ isolationVerified: true, randomizationDeclared: false, repetitionsMet: true, preregisteredDirection: 'improve', observedDirection: 'improve' }).status).toBe('DESCRIPTIVE_ONLY');
    expect(causalAttributionStatus({ isolationVerified: true, randomizationDeclared: true, repetitionsMet: false, preregisteredDirection: 'improve', observedDirection: 'improve' }).status).toBe('DESCRIPTIVE_ONLY');
  });
  it('INDETERMINATE when a direction is missing', () => {
    expect(causalAttributionStatus({ isolationVerified: true, randomizationDeclared: true, repetitionsMet: true, preregisteredDirection: null, observedDirection: 'improve' }).status).toBe('INDETERMINATE');
  });
  it('SUPPORTED_WITHIN_SCOPE only when everything holds and directions agree', () => {
    expect(causalAttributionStatus({ isolationVerified: true, randomizationDeclared: true, repetitionsMet: true, preregisteredDirection: 'improve', observedDirection: 'improve' }).status).toBe('SUPPORTED_WITHIN_SCOPE');
  });
  it('CONTRADICTED when the observed direction opposes the preregistered one', () => {
    expect(causalAttributionStatus({ isolationVerified: true, randomizationDeclared: true, repetitionsMet: true, preregisteredDirection: 'improve', observedDirection: 'worsen' }).status).toBe('CONTRADICTED');
  });
});

describe('EXAMINER v0.7 statistics — fail-loud inputs', () => {
  it('rejects malformed F values and non-arrays', () => {
    expect(() => computeBFRR([{ f: 2 }])).toThrow('unit.f');
    expect(() => computePCR([{ controlF: 1, treatmentF: 'maybe' }])).toThrow('controlF/treatmentF');
    expect(() => computeVBDR([{ caseId: 'x', goldReview: 'MAYBE' }])).toThrow('goldReview');
    expect(() => computeBFRR(null)).toThrow('array');
  });
});

// ---------------------------------------------------------------------------
// P1-3 repair round (PR #2239 review): full planned denominators, retained
// unknowns, and a full-plan sensitivity bound for the paired effect
// ---------------------------------------------------------------------------
describe('P1-3 — BFRR keeps the FULL planned denominator', () => {
  it('RED: 12 planned, 6 observed (all failures), 6 never observed — bounds must be 6/12..12/12', () => {
    const units = Array.from({ length: 6 }, (_, i) => ({ unitId: `c${i}`, f: 1, executionValid: true }));
    const result = computeBFRR(units, { plannedControlUnits: 12 });
    expect(result.missingPlannedUnits).toBe(6);
    expect(result.unknownUnits).toBe(6); // never-observed units count as unknown, never vanish
    expect(result.bounds.lower).toMatchObject({ numerator: 6, denominator: 12, value: 0.5 });
    expect(result.bounds.upper).toMatchObject({ numerator: 12, denominator: 12, value: 1 });
  });

  it('RED: observed units beyond the plan are a contract violation (throw)', () => {
    const units = Array.from({ length: 7 }, (_, i) => ({ unitId: `c${i}`, f: 0, executionValid: true }));
    expect(() => computeBFRR(units, { plannedControlUnits: 6 })).toThrow(/exceed|planned/i);
  });

  it('RED: duplicate unitIds inside the observed set are rejected', () => {
    const units = [{ unitId: 'c1', f: 1, executionValid: true }, { unitId: 'c1', f: 0, executionValid: true }];
    expect(() => computeBFRR(units, { plannedControlUnits: 4 })).toThrow(/duplicate/i);
  });

  it('observed-only study (units.length === planned) keeps the previous semantics', () => {
    const units = [
      ...Array.from({ length: 4 }, (_, i) => ({ unitId: `a${i}`, f: 1, executionValid: true })),
      ...Array.from({ length: 4 }, (_, i) => ({ unitId: `b${i}`, f: 0, executionValid: true })),
    ];
    const result = computeBFRR(units, { plannedControlUnits: 8 });
    expect(result.missingPlannedUnits).toBe(0);
    expect(result.rate).toMatchObject({ numerator: 4, denominator: 8, value: 0.5 });
    expect(result.bounds.upper).toMatchObject({ numerator: 4, denominator: 8 });
  });
});

describe('P1-3 — paired effect gains a full-plan sensitivity bound', () => {
  it('RED: one-sided unknown contributes its possible range; two-sided unknown contributes [-1,+1]', () => {
    // planned=3: (1,0) determined +1; (1,UNKNOWN) in [0,1]; (UNKNOWN,UNKNOWN) in [-1,+1]
    const pairs = [
      pair(1, 0),
      pair(1, 'UNKNOWN'),
      pair('UNKNOWN', 'UNKNOWN'),
    ];
    const effect = computePairedEffect(pairs);
    expect(effect.plannedPairs).toBe(3);
    expect(effect.determinedPairs).toBe(1);
    expect(effect.completeCaseDelta).toMatchObject({ status: 'ESTIMABLE', numerator: 1, denominator: 1, value: 1 });
    // min: +1 + (1-1=0) + (-1) = 0 → 0/3 ; max: +1 + (1-0=1) + (+1) = 3 → 3/3
    expect(effect.fullPlanLowerBound).toMatchObject({ numerator: 0, denominator: 3, value: 0 });
    expect(effect.fullPlanUpperBound).toMatchObject({ numerator: 3, denominator: 3, value: 1 });
  });

  it('RED: execution-invalid sides participate in the sensitivity range like unknowns', () => {
    // (1,0) + (0, f=0 but treatmentExecutionValid=false → range [0-0,0-1]=[-1..0]) → min 0, max 1 over 2
    const pairs = [pair(1, 0), pair(0, 0, { treatmentExecutionValid: false })];
    const effect = computePairedEffect(pairs);
    expect(effect.fullPlanLowerBound).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
    expect(effect.fullPlanUpperBound).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it('all-determined pairs keep the point estimate as the exact bound', () => {
    const pairs = [pair(1, 0), pair(0, 0)];
    const effect = computePairedEffect(pairs);
    expect(effect.fullPlanLowerBound).toMatchObject({ value: 0.5 });
    expect(effect.fullPlanUpperBound).toMatchObject({ value: 0.5 });
    expect(effect.completeCaseDelta.value).toBeCloseTo(0.5, 12);
  });

  it('zero planned pairs stay NOT_ESTIMABLE', () => {
    const effect = computePairedEffect([]);
    expect(effect.completeCaseDelta.status).toBe('NOT_ESTIMABLE');
    expect(effect.fullPlanLowerBound.status).toBe('NOT_ESTIMABLE');
    expect(effect.fullPlanUpperBound.status).toBe('NOT_ESTIMABLE');
  });
});

describe('P1-3 — planned pair construction from the preregistered plan', () => {
  it('RED: buildPlannedPairs derives one row per planned (caseId, repetitionId) with per-side status', async () => {
    const { buildPlannedPairs } = await import('../dev/principle-learning-lab/lib/challenge-statistics.mjs');
    const planUnits = [
      { caseId: 'T1', armId: 'A', repetitionId: '1' },
      { caseId: 'T1', armId: 'B', repetitionId: '1' },
      { caseId: 'T1', armId: 'A', repetitionId: '2' },
      { caseId: 'T1', armId: 'B', repetitionId: '2' }, // never started on either side
      { caseId: 'T2', armId: 'A', repetitionId: '1' },
      { caseId: 'T2', armId: 'B', repetitionId: '1' },
    ];
    const rollups = new Map([
      ['T1/A/r1', { f: 1, currentState: 'succeeded', replayRescored: true }],
      ['T1/B/r1', { f: 0, currentState: 'succeeded', replayRescored: true }],
      ['T1/A/r2', { f: 'UNKNOWN', currentState: 'not_started', replayRescored: false }],
      ['T1/B/r2', { f: 'UNKNOWN', currentState: 'not_started', replayRescored: false }],
      ['T2/A/r1', { f: 'UNKNOWN', currentState: 'failed_known', replayRescored: false }],
      ['T2/B/r1', { f: 0, currentState: 'succeeded', replayRescored: true }],
    ]);
    const pairs = buildPlannedPairs({ planUnits, rollupsByUnit: rollups, controlArm: 'A', treatmentArm: 'B' });
    expect(pairs.plannedPairs).toBe(3);
    const t1r1 = pairs.pairs.find((p: any) => p.pairKey === 'T1/r1');
    expect(t1r1).toMatchObject({ controlF: 1, treatmentF: 0, pairValidity: 'VALID', controlExecutionStatus: 'succeeded', treatmentExecutionStatus: 'succeeded' });
    const t1r2 = pairs.pairs.find((p: any) => p.pairKey === 'T1/r2');
    expect(t1r2).toMatchObject({ pairValidity: 'UNKNOWN', unknownReason: 'BOTH_SIDES_NOT_STARTED' });
    const t2r1 = pairs.pairs.find((p: any) => p.pairKey === 'T2/r1');
    expect(t2r1).toMatchObject({ pairValidity: 'EXECUTION_INVALID', invalidityReason: 'CONTROL_FAILED_KNOWN' });
  });
});
