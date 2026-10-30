// SPEC-PD-EXAMINER-001 v0.7 §6 — paired behavioral statistics.
//
// Pure, deterministic functions over INTEGER counts. The module NEVER derives
// F values itself: callers pass per-unit target-failure-mechanism observations
// (F ∈ {1,0,'UNKNOWN'}) derived from adjudications under frozen rules, so every
// numerator, denominator and bound below is independently recomputable from
// the raw records. Zero denominators are NOT_ESTIMABLE (never 0% / 100%), and
// UNKNOWN units are never deleted from a planned denominator — they bound it.
//
// Zero network, zero clock, zero estimation: unknown stays unknown.

const F_VALUES = [1, 0, 'UNKNOWN'];

function isF(value) {
  return F_VALUES.includes(value);
}

function assertUnits(units, name) {
  if (!Array.isArray(units)) throw new Error(`${name}: units must be an array`);
  for (const unit of units) {
    if (!unit || typeof unit !== 'object') throw new Error(`${name}: each unit must be an object`);
    if (!isF(unit.f)) throw new Error(`${name}: unit.f must be 1|0|'UNKNOWN' (got ${JSON.stringify(unit.f)})`);
  }
}

function rateOrNotEstimable(numerator, denominator) {
  return denominator === 0
    ? { status: 'NOT_ESTIMABLE', numerator, denominator, reason: 'empty denominator' }
    : { status: 'ESTIMABLE', numerator, denominator, value: numerator / denominator };
}

/**
 * §6.2 Baseline Failure Reproduction Rate.
 *
 * BFRR = N(F_C=1) / N(F_C ∈ {0,1}) over execution-valid control units, plus
 * the full-planned-denominator sensitivity interval so unknown units can never
 * be silently dropped:
 *   lower = N(F_C=1) / N_planned
 *   upper = (N(F_C=1) + N(F_C=UNKNOWN or execution-invalid)) / N_planned
 */
export function computeBFRR(units, { plannedControlUnits } = {}) {
  assertUnits(units, 'computeBFRR');
  const planned = plannedControlUnits ?? units.length;
  if (!Number.isInteger(planned) || planned < 0) throw new Error('computeBFRR: plannedControlUnits must be a non-negative integer');
  const determined = units.filter((unit) => unit.executionValid !== false && (unit.f === 1 || unit.f === 0));
  const confirmedFailures = determined.filter((unit) => unit.f === 1);
  const confirmedNonFailures = determined.filter((unit) => unit.f === 0);
  const unknownUnits = units.filter((unit) => !(unit.executionValid !== false && (unit.f === 1 || unit.f === 0)));
  return {
    metric: 'BFRR',
    formula: 'N(F_C=1) / N(F_C in {0,1}) over valid control units; bounds over the full planned denominator',
    plannedControlUnits: planned,
    validControlUnits: determined.length,
    confirmedFailures: confirmedFailures.length,
    confirmedNonFailures: confirmedNonFailures.length,
    unknownUnits: unknownUnits.length,
    rate: rateOrNotEstimable(confirmedFailures.length, determined.length),
    bounds: planned === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'empty planned denominator' }
      : {
        status: 'ESTIMABLE',
        lower: { numerator: confirmedFailures.length, denominator: planned, value: confirmedFailures.length / planned },
        upper: { numerator: confirmedFailures.length + unknownUnits.length, denominator: planned, value: (confirmedFailures.length + unknownUnits.length) / planned },
      },
    rule: 'a baseline that did not reproduce the failure cannot claim the Principle corrected it',
  };
}

/**
 * §6.3 Paired Correction Rate.
 *
 * PCR = N(F_C=1, F_T=0) / N(F_C=1, F_T ∈ {0,1}); Treatment-UNKNOWN pairs are
 * excluded from the point estimate but bound it — never deleted.
 */
export function computePCR(pairs) {
  assertPairs(pairs, 'computePCR');
  const baselineFailurePairs = pairs.filter((pair) => pair.controlF === 1 && pair.controlExecutionValid !== false);
  const denominatorPairs = baselineFailurePairs.filter((pair) => pair.treatmentExecutionValid !== false && (pair.treatmentF === 0 || pair.treatmentF === 1));
  const correctedPairs = denominatorPairs.filter((pair) => pair.treatmentF === 0);
  const uncorrectedPairs = denominatorPairs.filter((pair) => pair.treatmentF === 1);
  const treatmentUnknownPairs = baselineFailurePairs.filter((pair) => pair.treatmentExecutionValid === false || pair.treatmentF === 'UNKNOWN');
  return {
    metric: 'PCR',
    formula: 'N(F_C=1, F_T=0) / N(F_C=1, F_T in {0,1})',
    baselineFailurePairs: baselineFailurePairs.length,
    denominatorPairs: denominatorPairs.length,
    correctedPairs: correctedPairs.length,
    uncorrectedPairs: uncorrectedPairs.length,
    treatmentUnknownPairs: treatmentUnknownPairs.length,
    rate: rateOrNotEstimable(correctedPairs.length, denominatorPairs.length),
    bounds: baselineFailurePairs.length === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no baseline failure pairs' }
      : {
        status: 'ESTIMABLE',
        lower: { numerator: correctedPairs.length, denominator: baselineFailurePairs.length, value: correctedPairs.length / baselineFailurePairs.length },
        upper: { numerator: correctedPairs.length + treatmentUnknownPairs.length, denominator: baselineFailurePairs.length, value: (correctedPairs.length + treatmentUnknownPairs.length) / baselineFailurePairs.length },
      },
    rule: 'Treatment-UNKNOWN pairs must never be deleted to raise the correction rate',
  };
}

/** §6.4 Failure Introduction Rate: N(F_C=0, F_T=1) / N(F_C=0, F_T ∈ {0,1}). */
export function computeFIR(pairs) {
  assertPairs(pairs, 'computeFIR');
  const baselineNonFailurePairs = pairs.filter((pair) => pair.controlF === 0 && pair.controlExecutionValid !== false);
  const denominatorPairs = baselineNonFailurePairs.filter((pair) => pair.treatmentExecutionValid !== false && (pair.treatmentF === 0 || pair.treatmentF === 1));
  const introducedPairs = denominatorPairs.filter((pair) => pair.treatmentF === 1);
  const treatmentUnknownPairs = baselineNonFailurePairs.filter((pair) => pair.treatmentExecutionValid === false || pair.treatmentF === 'UNKNOWN');
  return {
    metric: 'FIR',
    formula: 'N(F_C=0, F_T=1) / N(F_C=0, F_T in {0,1})',
    baselineNonFailurePairs: baselineNonFailurePairs.length,
    denominatorPairs: denominatorPairs.length,
    introducedPairs: introducedPairs.length,
    treatmentUnknownPairs: treatmentUnknownPairs.length,
    rate: rateOrNotEstimable(introducedPairs.length, denominatorPairs.length),
    bounds: baselineNonFailurePairs.length === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no baseline non-failure pairs' }
      : {
        status: 'ESTIMABLE',
        lower: { numerator: introducedPairs.length, denominator: baselineNonFailurePairs.length, value: introducedPairs.length / baselineNonFailurePairs.length },
        upper: { numerator: introducedPairs.length + treatmentUnknownPairs.length, denominator: baselineNonFailurePairs.length, value: (introducedPairs.length + treatmentUnknownPairs.length) / baselineNonFailurePairs.length },
      },
    rule: 'a rising FIR is a negative-change signal of the same standing as a falling PCR',
  };
}

/**
 * §6.5 Overall Paired Treatment Effect: Δ_benefit = P(F_C=1) − P(F_T=1) over
 * fully determined valid pairs, with the COMPLETE four-cell table — the point
 * estimate alone is never an acceptable report.
 */
export function computePairedEffect(pairs) {
  assertPairs(pairs, 'computePairedEffect');
  const determined = pairs.filter((pair) => pair.controlExecutionValid !== false && pair.treatmentExecutionValid !== false
    && (pair.controlF === 1 || pair.controlF === 0) && (pair.treatmentF === 1 || pair.treatmentF === 0));
  const cells = {
    controlFailureTreatmentCorrected: determined.filter((p) => p.controlF === 1 && p.treatmentF === 0).length,
    controlOkTreatmentFailed: determined.filter((p) => p.controlF === 0 && p.treatmentF === 1).length,
    bothFailed: determined.filter((p) => p.controlF === 1 && p.treatmentF === 1).length,
    bothOk: determined.filter((p) => p.controlF === 0 && p.treatmentF === 0).length,
  };
  const n = determined.length;
  const controlFailures = cells.controlFailureTreatmentCorrected + cells.bothFailed;
  const treatmentFailures = cells.controlOkTreatmentFailed + cells.bothFailed;
  return {
    metric: 'DeltaBenefit',
    formula: 'P(F_C=1) - P(F_T=1) over fully determined valid pairs',
    pairedUnits: pairs.length,
    determinedPairs: n,
    unknownPairsRetained: pairs.length - n,
    cells,
    cellsMeaning: {
      controlFailureTreatmentCorrected: 'C=1,T=0 — failure corrected',
      controlOkTreatmentFailed: 'C=0,T=1 — new failure introduced',
      bothFailed: 'C=1,T=1 — both arms failed',
      bothOk: 'C=0,T=0 — both arms avoided the failure',
    },
    controlFailureRate: n === 0 ? 'NOT_ESTIMABLE' : { numerator: controlFailures, denominator: n, value: controlFailures / n },
    treatmentFailureRate: n === 0 ? 'NOT_ESTIMABLE' : { numerator: treatmentFailures, denominator: n, value: treatmentFailures / n },
    deltaBenefit: n === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no fully determined pairs' }
      : { status: 'ESTIMABLE', numerator: controlFailures - treatmentFailures, denominator: n, value: (controlFailures - treatmentFailures) / n },
    rule: 'positive = target failure rate decreased; zero = no observed difference; negative = rate increased; small samples must not be dressed up with single p-values',
  };
}

function assertPairs(pairs, name) {
  if (!Array.isArray(pairs)) throw new Error(`${name}: pairs must be an array`);
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') throw new Error(`${name}: each pair must be an object`);
    if (!isF(pair.controlF) || !isF(pair.treatmentF)) {
      throw new Error(`${name}: controlF/treatmentF must each be 1|0|'UNKNOWN'`);
    }
  }
}

/**
 * §6.6 Validated Behavioral Discrimination Rate.
 *
 * VBDR measures whether challenge cases can identify REPRODUCIBLE behavioral
 * differences related to the target failure mechanism under independent Gold
 * review — it is neither a task success rate nor a Principle effect size.
 *
 * A case is discriminative only when ALL six validity conditions hold:
 * independent Gold review approved; A/B conditions consistent and isolated;
 * complete trajectories; repetition stability per preregistration; the
 * difference relates to the target failure mechanism; and an independent
 * adjudication confirms the difference is not wording drift or noise.
 */
export function computeVBDR(cases) {
  if (!Array.isArray(cases)) throw new Error('computeVBDR: cases must be an array');
  for (const item of cases) {
    if (!item || typeof item !== 'object') throw new Error('computeVBDR: each case must be an object');
    if (!['APPROVED', 'PENDING', 'REJECTED', null, undefined].includes(item.goldReview)) {
      throw new Error(`computeVBDR: case ${item.caseId}: goldReview must be APPROVED|PENDING|REJECTED|null`);
    }
  }
  const plannedCases = cases.length;
  const goldReviewApproved = cases.filter((item) => item.goldReview === 'APPROVED');
  const executionInvalid = cases.filter((item) => item.executionInvalid === true);
  const reviewPending = cases.filter((item) => item.goldReview === 'PENDING');
  const validPaired = goldReviewApproved.filter((item) => item.pairedValid === true && item.executionInvalid !== true);
  const repetitionInstability = validPaired.filter((item) => item.repetitionStable === false);
  const discriminative = validPaired.filter((item) => item.repetitionStable === true
    && item.differenceObserved === true && item.relatedToTargetMechanism === true && item.adjudicatedNotNoise === true);
  // Unresolved independent adjudication on a valid paired case means the
  // discrimination evidence is insufficient: INDETERMINATE, never a forced 0%.
  const unresolved = validPaired.filter((item) => item.repetitionStable === null
    || item.differenceObserved === null || item.differenceObserved === undefined
    || item.relatedToTargetMechanism === null || item.relatedToTargetMechanism === undefined
    || item.adjudicatedNotNoise === null || item.adjudicatedNotNoise === undefined);
  const falsePositive = validPaired.filter((item) => item.differenceObserved === true && item.adjudicatedNotNoise === false);
  const falseNegative = validPaired.filter((item) => item.differenceObserved === false && item.adjudicatedNotNoise === true);
  const unknown = cases.filter((item) => item.goldReview == null && item.executionInvalid !== true);
  let rate;
  if (validPaired.length === 0) {
    rate = { status: 'NOT_ESTIMABLE', numerator: 0, denominator: 0, reason: 'no valid Gold-reviewed paired cases — a zero denominator is not 0%' };
  } else if (unresolved.length > 0) {
    rate = { status: 'INDETERMINATE', numerator: discriminative.length, denominator: validPaired.length, reason: `${unresolved.length} valid paired case(s) lack completed repetition/adjudication evidence — discrimination evidence is insufficient` };
  } else {
    rate = { status: 'ESTIMABLE', numerator: discriminative.length, denominator: validPaired.length, value: discriminative.length / validPaired.length };
  }
  return {
    metric: 'VBDR',
    purpose: 'challenge-case capability to identify reproducible, mechanism-related behavioral differences — NOT a Principle effect size and NOT a task success rate',
    plannedCases,
    goldReviewApproved: goldReviewApproved.length,
    validPairedCases: validPaired.length,
    discriminativeCases: discriminative.length,
    executionInvalid: executionInvalid.length,
    unknown: unknown.length,
    reviewPending: reviewPending.length,
    falsePositive: falsePositive.length,
    falseNegative: falseNegative.length,
    repetitionInstability: repetitionInstability.length,
    rate,
    rule: 'no observed difference is a legitimate case outcome; it never invalidates the case by itself',
  };
}

/**
 * §4.4 2×2 factorial contract (computation only — executing such an experiment
 * is out of scope and unauthorized this round).
 *
 * Counts in, effects out, every rate recomputable:
 *   Δ_P^R0 = p(P0R0) − p(P1R0)   Principle main effect without RuleCode
 *   Δ_P^R1 = p(P0R1) − p(P1R1)   Principle main effect with RuleCode
 *   I       = Δ_P^R1 − Δ_P^R0    Principle × RuleCode interaction
 * Positive values mean the target failure rate improved by that amount.
 */
export function computeFactorialEffect(arms) {
  const expected = ['P0R0', 'P1R0', 'P0R1', 'P1R1'];
  for (const key of expected) {
    const arm = arms[key];
    if (!arm || !Number.isInteger(arm.failures) || !Number.isInteger(arm.units) || arm.failures < 0 || arm.units < 0 || arm.failures > arm.units) {
      throw new Error(`computeFactorialEffect: arms.${key} must be {failures, units} with 0 <= failures <= units`);
    }
  }
  const rate = (key) => (arms[key].units === 0 ? null : { numerator: arms[key].failures, denominator: arms[key].units, value: arms[key].failures / arms[key].units });
  const p00 = rate('P0R0');
  const p10 = rate('P1R0');
  const p01 = rate('P0R1');
  const p11 = rate('P1R1');
  const effect = (a, b) => (a === null || b === null ? 'NOT_ESTIMABLE' : { value: a.value - b.value });
  const deltaPR0 = effect(p00, p10);
  const deltaPR1 = effect(p01, p11);
  const interaction = deltaPR0 === 'NOT_ESTIMABLE' || deltaPR1 === 'NOT_ESTIMABLE' ? 'NOT_ESTIMABLE' : { value: deltaPR1.value - deltaPR0.value };
  return {
    metric: 'Factorial2x2',
    arms,
    rates: { P0R0: p00, P1R0: p10, P0R1: p01, P1R1: p11 },
    principleMainEffectWithoutRuleCode: deltaPR0,
    principleMainEffectWithRuleCode: deltaPR1,
    interaction,
    rule: 'a material interaction forbids claiming the Principle is independently effective or the RuleCode is independently effective',
    scope: 'computation contract only — no 2×2 experiment execution is authorized or implemented this round',
  };
}

/**
 * §5.9 study-level causal attribution contract. The scorer itself always
 * reports NOT_ESTIMABLE; only a STUDY with verified isolation, declared
 * randomization/balancing, preregistered repetitions and a preregistered
 * direction may reach a stronger status — and a contradicted direction stays
 * CONTRADICTED regardless of how good the rest looks.
 */
export function causalAttributionStatus({ isolationVerified, randomizationDeclared, repetitionsMet, preregisteredDirection, observedDirection }) {
  if (isolationVerified !== true) return { status: 'NOT_ESTIMABLE', reason: 'A/B isolation not verified — no causal conditions exist' };
  if (randomizationDeclared !== true || repetitionsMet !== true) {
    return { status: 'DESCRIPTIVE_ONLY', reason: 'behavioral difference observed but randomization/repetition preregistration not satisfied' };
  }
  if (preregisteredDirection == null || observedDirection == null) {
    return { status: 'INDETERMINATE', reason: 'preregistered or observed direction missing/unstable' };
  }
  return observedDirection === preregisteredDirection
    ? { status: 'SUPPORTED_WITHIN_SCOPE', reason: 'paired, isolated, randomized, repeated evidence consistent with the preregistered direction' }
    : { status: 'CONTRADICTED', reason: 'observed direction does not support the preregistered direction' };
}
