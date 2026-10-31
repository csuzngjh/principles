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
//
// v0.9 additions (computeITT / computeTreatmentFidelity) import the lab's
// single hash basis (sha256 from challenge-freeze, re-exported from fixture)
// for the control-absence payload hash — no second hash implementation.

import { sha256 } from './challenge-freeze.mjs';

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
 * be silently dropped. Units in the plan that produced NO record yet count as
 * unknown (missingPlannedUnits) — an unfinished study can never shrink its
 * own denominator:
 *   lower = N(F_C=1) / N_planned
 *   upper = (N(F_C=1) + N(unknown) + N(missing)) / N_planned
 */
export function computeBFRR(units, { plannedControlUnits } = {}) {
  assertUnits(units, 'computeBFRR');
  const planned = plannedControlUnits ?? units.length;
  if (!Number.isInteger(planned) || planned < 0) throw new Error('computeBFRR: plannedControlUnits must be a non-negative integer');
  if (units.length > planned) {
    throw new Error(`computeBFRR: observed units (${units.length}) exceed the planned control units (${planned}) — more evidence than preregistered is a contract violation, not extra credit`);
  }
  const seenIds = new Set();
  for (const unit of units) {
    if (unit.unitId === undefined) continue;
    if (seenIds.has(unit.unitId)) throw new Error(`computeBFRR: duplicate unitId '${String(unit.unitId)}' — a unit may appear exactly once in the observed set`);
    seenIds.add(unit.unitId);
  }
  const determined = units.filter((unit) => unit.executionValid !== false && (unit.f === 1 || unit.f === 0));
  const confirmedFailures = determined.filter((unit) => unit.f === 1);
  const confirmedNonFailures = determined.filter((unit) => unit.f === 0);
  const undeterminedObserved = units.filter((unit) => !(unit.executionValid !== false && (unit.f === 1 || unit.f === 0)));
  const missingPlannedUnits = planned - units.length;
  const unknownUnits = undeterminedObserved.length + missingPlannedUnits;
  return {
    metric: 'BFRR',
    formula: 'N(F_C=1) / N(F_C in {0,1}) over valid control units; bounds over the full planned denominator (missing planned units count as unknown)',
    plannedControlUnits: planned,
    observedControlUnits: units.length,
    missingPlannedUnits,
    validControlUnits: determined.length,
    confirmedFailures: confirmedFailures.length,
    confirmedNonFailures: confirmedNonFailures.length,
    unknownUnits,
    unknownBreakdown: { undeterminedObserved: undeterminedObserved.length, neverObserved: missingPlannedUnits },
    rate: rateOrNotEstimable(confirmedFailures.length, determined.length),
    bounds: planned === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'empty planned denominator' }
      : {
        status: 'ESTIMABLE',
        lower: { numerator: confirmedFailures.length, denominator: planned, value: confirmedFailures.length / planned },
        upper: { numerator: confirmedFailures.length + unknownUnits, denominator: planned, value: (confirmedFailures.length + unknownUnits) / planned },
      },
    rule: 'a baseline that did not reproduce the failure cannot claim the Principle corrected it; unexecuted planned units never vanish from the denominator',
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
 * estimate alone is never an acceptable report. In addition, a FULL-PLAN
 * sensitivity bound spreads every not-yet-determined pair over its possible
 * pairBenefit = controlFailure − treatmentFailure range:
 *   both sides determined      → exact contribution
 *   one side unknown/invalid   → the other side fixed, missing side ∈ {0,1}
 *   both sides unknown/invalid → [−1, +1]
 * The complete-case point estimate may NEVER masquerade as the full-plan
 * result; the bounds make the unfinished part of the plan visible.
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
  const plannedPairs = pairs.length;
  const controlFailures = cells.controlFailureTreatmentCorrected + cells.bothFailed;
  const treatmentFailures = cells.controlOkTreatmentFailed + cells.bothFailed;
  // Full-plan sensitivity range over EVERY preregistered pair.
  const sideDetermined = (pair, side) => pair[`${side}ExecutionValid`] !== false && (pair[`${side}F`] === 1 || pair[`${side}F`] === 0);
  let minSum = 0;
  let maxSum = 0;
  for (const pair of pairs) {
    const cKnown = sideDetermined(pair, 'control');
    const tKnown = sideDetermined(pair, 'treatment');
    const cMin = cKnown ? pair.controlF : 0;
    const cMax = cKnown ? pair.controlF : 1;
    const tMin = tKnown ? pair.treatmentF : 0;
    const tMax = tKnown ? pair.treatmentF : 1;
    minSum += cMin - tMax;
    maxSum += cMax - tMin;
  }
  const bound = (numerator) => (plannedPairs === 0
    ? { status: 'NOT_ESTIMABLE', reason: 'no planned pairs' }
    : { status: 'ESTIMABLE', numerator, denominator: plannedPairs, value: numerator / plannedPairs });
  return {
    metric: 'DeltaBenefit',
    formula: 'P(F_C=1) - P(F_T=1) over fully determined valid pairs; full-plan bounds over every preregistered pair',
    plannedPairs,
    pairedUnits: pairs.length,
    determinedPairs: n,
    unknownPairsRetained: plannedPairs - n,
    cells,
    cellsMeaning: {
      controlFailureTreatmentCorrected: 'C=1,T=0 — failure corrected',
      controlOkTreatmentFailed: 'C=0,T=1 — new failure introduced',
      bothFailed: 'C=1,T=1 — both arms failed',
      bothOk: 'C=0,T=0 — both arms avoided the failure',
    },
    controlFailureRate: n === 0 ? 'NOT_ESTIMABLE' : { numerator: controlFailures, denominator: n, value: controlFailures / n },
    treatmentFailureRate: n === 0 ? 'NOT_ESTIMABLE' : { numerator: treatmentFailures, denominator: n, value: treatmentFailures / n },
    completeCaseDelta: n === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no fully determined pairs' }
      : { status: 'ESTIMABLE', numerator: controlFailures - treatmentFailures, denominator: n, value: (controlFailures - treatmentFailures) / n },
    deltaBenefit: n === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no fully determined pairs' }
      : { status: 'ESTIMABLE', numerator: controlFailures - treatmentFailures, denominator: n, value: (controlFailures - treatmentFailures) / n },
    fullPlanLowerBound: bound(minSum),
    fullPlanUpperBound: bound(maxSum),
    fullPlanBoundRule: 'per planned pair: benefit = controlFailure − treatmentFailure; a determined side pins its value, an unknown/execution-invalid side ranges over {0,1}; bounds divide by plannedPairs — the complete-case delta is never the full-plan result',
    rule: 'positive = target failure rate decreased; zero = no observed difference; negative = rate increased; small samples must not be dressed up with single p-values',
  };
}

/**
 * P1-3 (PR #2239 review): build the COMPLETE paired set from the
 * preregistered plan — never from the successfully executed records in
 * reverse. One row per planned (caseId, repetitionId); a pair survives even
 * when a side never started. Per-side execution status, F flags, validity and
 * explicit reasons make every downstream statistic recomputable from the plan
 * plus the raw ledger states.
 */
export function buildPlannedPairs({ planUnits, rollupsByUnit, controlArm, treatmentArm }) {
  if (!Array.isArray(planUnits)) throw new Error('buildPlannedPairs: planUnits must be an array');
  if (!(rollupsByUnit instanceof Map)) throw new Error('buildPlannedPairs: rollupsByUnit must be a Map(unit -> rollup)');
  if (!controlArm || !treatmentArm) throw new Error('buildPlannedPairs: controlArm/treatmentArm required');
  const byCaseRep = new Map();
  for (const unit of planUnits) {
    if (!unit || !unit.caseId || !unit.armId || unit.repetitionId === undefined) throw new Error('buildPlannedPairs: malformed plan unit');
    if (unit.armId !== controlArm && unit.armId !== treatmentArm) continue;
    const key = `${unit.caseId}/r${String(unit.repetitionId)}`;
    if (!byCaseRep.has(key)) byCaseRep.set(key, {});
    const slot = byCaseRep.get(key);
    if (slot[unit.armId]) throw new Error(`buildPlannedPairs: duplicate plan unit ${key}/${unit.armId}`);
    slot[unit.armId] = unit;
  }
  const sideOf = (caseId, repetitionId, armId) => {
    // rollupsByUnit keys follow the plan-unit form `${caseId}/${armId}/r${rep}`
    const rollup = rollupsByUnit.get(`${caseId}/${armId}/r${String(repetitionId)}`) ?? null;
    const executionStatus = rollup ? (rollup.currentState ?? 'not_started') : 'not_started';
    const valid = executionStatus === 'succeeded' && rollup?.replayRescored === true;
    const f = valid && (rollup.f === 1 || rollup.f === 0) ? rollup.f : 'UNKNOWN';
    return { executionStatus, valid, f };
  };
  const pairs = [];
  for (const [key, slot] of [...byCaseRep.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [caseId, repRaw] = [key.split('/r')[0], key.split('/r')[1]];
    const control = sideOf(caseId, repRaw, controlArm);
    const treatment = sideOf(caseId, repRaw, treatmentArm);
    let pairValidity = 'VALID';
    let unknownReason = null;
    let invalidityReason = null;
    const sideProblem = (side, label) => (side.executionStatus === 'failed_known' ? `${label}_FAILED_KNOWN`
      : side.executionStatus === 'result_unknown' ? `${label}_RESULT_UNKNOWN`
        : side.executionStatus === 'reserved_unsettled' ? `${label}_RESERVED_UNSETTLED`
          : side.executionStatus === 'not_started' ? `${label}_NOT_STARTED` : null);
    const cProblem = sideProblem(control, 'CONTROL');
    const tProblem = sideProblem(treatment, 'TREATMENT');
    const anyInvalid = control.executionStatus === 'failed_known' || treatment.executionStatus === 'failed_known';
    if (anyInvalid) {
      pairValidity = 'EXECUTION_INVALID';
      invalidityReason = [cProblem, tProblem].filter(Boolean).join('+') || 'FAILED_KNOWN';
    } else if (cProblem || tProblem) {
      pairValidity = 'UNKNOWN';
      const reasons = [cProblem, tProblem].filter(Boolean);
      // Same cause on both sides collapses to one reason (BOTH_SIDES_NOT_STARTED);
      // different causes keep both (e.g. CONTROL_NOT_STARTED_AND_TREATMENT_RESULT_UNKNOWN).
      const cause = (reason) => reason.split('_').slice(1).join('_');
      unknownReason = reasons.length === 2
        ? (cause(reasons[0]) === cause(reasons[1])
          ? `BOTH_SIDES_${cause(reasons[0])}`
          : reasons.join('_AND_'))
        : reasons[0];
    }
    pairs.push({
      pairKey: key,
      caseId,
      repetitionId: repRaw,
      controlF: control.f,
      treatmentF: treatment.f,
      controlExecutionStatus: control.executionStatus,
      treatmentExecutionStatus: treatment.executionStatus,
      controlExecutionValid: control.valid,
      treatmentExecutionValid: treatment.valid,
      pairValidity,
      unknownReason,
      invalidityReason,
    });
    void slot;
  }
  return {
    plannedPairs: pairs.length,
    controlArm,
    treatmentArm,
    pairs,
    rule: 'denominator = preregistered (caseId, repetitionId) pairs; a pair is never dropped because a side is missing, invalid or never started',
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
  // P2-2 (PR #2239 review): REJECTED is a definite adverse outcome, not a
  // pending one — the two counts are reported separately, never merged.
  const reviewRejected = cases.filter((item) => item.goldReview === 'REJECTED');
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
    reviewRejected: reviewRejected.length,
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

// ---------------------------------------------------------------------------
// SPEC-PD-EXAMINER-001 v0.9 §5.5 — ITT (Intention-to-Treat) primary analysis.
// ---------------------------------------------------------------------------

/**
 * ITT over the PREREGISTERED applicable pair set. The denominator N is the
 * planned applicable pair count — frozen before execution; a pair is NEVER
 * dropped because the treatment failed to inject (that is the very failure
 * ITT exists to expose), a side came back UNKNOWN, or the study stopped early.
 *
 * d_i = F_control − F_treatment per pair:
 *   +1 control failed / treatment did not; −1 the reverse; 0 both same.
 * UNKNOWN sides produce the pair's POSSIBLE RANGE (v0.9 §5.5 table):
 *   both UNKNOWN → [−1, +1]; C=1,T=? → [0, +1]; C=0,T=? → [−1, 0];
 *   C=?,T=1 → [−1, 0]; C=?,T=0 → [0, +1].
 * A single point estimate is reported ONLY when every pair is fully
 * determined (the preregistered missing-handling condition for this module);
 * otherwise the honest output is the bound pair + counts.
 *
 * @param {Array<{pairKey:string, controlF:1|0|'UNKNOWN', treatmentF:1|0|'UNKNOWN',
 *   controlExecutionValid?:boolean, treatmentExecutionValid?:boolean}>} pairs
 *   — applicable pairs only (NOT_APPLICABLE pairs are excluded upstream by the
 *   frozen applicability predicate and counted separately by the report).
 */
export function computeITT(pairs) {
  assertPairs(pairs, 'computeITT');
  const planned = pairs.length;
  const determined = pairs.filter((p) => p.controlExecutionValid !== false && p.treatmentExecutionValid !== false
    && (p.controlF === 1 || p.controlF === 0) && (p.treatmentF === 1 || p.treatmentF === 0));
  let minSum = 0;
  let maxSum = 0;
  for (const pair of pairs) {
    const sideKnown = (p, side) => p[`${side}ExecutionValid`] !== false && (p[`${side}F`] === 1 || p[`${side}F`] === 0);
    const cKnown = sideKnown(pair, 'control');
    const tKnown = sideKnown(pair, 'treatment');
    const cMin = cKnown ? pair.controlF : 0;
    const cMax = cKnown ? pair.controlF : 1;
    const tMin = tKnown ? pair.treatmentF : 0;
    const tMax = tKnown ? pair.treatmentF : 1;
    minSum += cMin - tMax;
    maxSum += cMax - tMin;
  }
  const unknownPairs = planned - determined.length;
  const corrected = determined.filter((p) => p.controlF === 1 && p.treatmentF === 0).length;
  const introduced = determined.filter((p) => p.controlF === 0 && p.treatmentF === 1).length;
  const bothFailed = determined.filter((p) => p.controlF === 1 && p.treatmentF === 1).length;
  const bothOk = determined.filter((p) => p.controlF === 0 && p.treatmentF === 0).length;
  const bound = (numerator) => (planned === 0
    ? { status: 'NOT_ESTIMABLE', reason: 'no applicable planned pairs' }
    : { status: 'ESTIMABLE', numerator, denominator: planned, value: numerator / planned });
  return {
    metric: 'ITT',
    formula: 'd_i = F_control − F_treatment per preregistered applicable pair; Δ_ITT = Σd_i / N with N = planned applicable pairs (fixed denominator, never shrunken)',
    plannedApplicablePairs: planned,
    determinedPairs: determined.length,
    unknownPairs,
    cells: { controlFailedTreatmentCorrected: corrected, controlOkTreatmentFailed: introduced, bothFailed, bothOk },
    pointEstimate: determined.length === planned && planned > 0
      ? { status: 'ESTIMABLE', numerator: corrected - introduced, denominator: planned, value: (corrected - introduced) / planned,
        condition: 'every planned applicable pair fully determined (preregistered missing-handling: report bounds otherwise)' }
      : { status: 'BOUNDED_ONLY', reason: `${unknownPairs} pair(s) not fully determined — no silent imputation; report the bounds` },
    lowerBound: bound(minSum),
    upperBound: bound(maxSum),
    rule: 'positive = target failure reduced under the assigned strategy; injection failures stay IN (they are the strategy failing, not noise); UNKNOWN is never deleted, converted to PASS/FAIL, or imputed',
  };
}

/**
 * v0.9 §5.4 Treatment Fidelity — mechanism observability, INDEPENDENT of ITT.
 * Computed from per-arm injection evidence chains + capacity records; never a
 * substitute for the primary ITT result (§5.4: the actually-injected subset is
 * a secondary mechanism analysis only).
 *
 * @param {object} input
 *   plannedTreatmentUnits — N of assigned treatment-side units
 *   chains — treatment-side injection chains (verifyInjectionEvidenceChain output shape)
 *   controlChains — control-side chains (for contamination detection)
 *   nonTargetRetention — { eligible: n, deliveredInTreatment: n, deliveredInControl: n }
 *   capacityRecords — full-library capacity competition records (treatment side)
 */
export function computeTreatmentFidelity({ plannedTreatmentUnits, chains = [], controlChains = [], nonTargetRetention = null, capacityRecords = [] }) {
  if (!Number.isInteger(plannedTreatmentUnits) || plannedTreatmentUnits < 0) throw new Error('computeTreatmentFidelity: plannedTreatmentUnits required');
  const count = (arr, level) => arr.filter((c) => c && c.ok !== false && c.provenLevel === level).length;
  const atLeast = (arr, level) => arr.filter((c) => c && c.ok !== false && c.provenLevel !== 'NONE'
    && INJECTION_LEVEL_ORDER.indexOf(c.provenLevel) >= INJECTION_LEVEL_ORDER.indexOf(level)).length;
  // A treatment unit is "actually injected" only at CONTEXT_PRESENT or above
  // (§7.3) — SUBMITTED alone never counts as injection.
  const contextOrAbove = atLeast(chains, 'CONTEXT_PRESENT');
  const runtimeLoaded = atLeast(chains, 'RUNTIME_LOADED');
  // Control contamination: a control chain whose CONTEXT_PRESENT stage
  // recorded forbiddenContentPresent (dual-mode studies pass the TARGET
  // principle text as the control's forbidden content); chains without that
  // marker fall back to the absence-hash rule (a control proving a NON-empty
  // payload at CONTEXT_PRESENT+ is contaminated unless it is the provable
  // absence hash sha256('')).
  const ABSENCE_HASH = CONTROL_ABSENCE_PAYLOAD_HASH;
  const contaminatedControl = controlChains.filter((c) => {
    if (!c || c.ok === false || c.provenLevel === 'NONE') return false;
    if (INJECTION_LEVEL_ORDER.indexOf(c.provenLevel) < INJECTION_LEVEL_ORDER.indexOf('CONTEXT_PRESENT')) return false;
    if (c.forbiddenContentPresent === true) return true;
    if (c.forbiddenContentPresent === false) return false;
    return c.principleHash !== ABSENCE_HASH;
  }).length;
  const retention = nonTargetRetention && Number.isInteger(nonTargetRetention.eligible) && nonTargetRetention.eligible > 0
    ? {
      eligible: nonTargetRetention.eligible,
      deliveredInTreatment: nonTargetRetention.deliveredInTreatment,
      deliveredInControl: nonTargetRetention.deliveredInControl,
      treatmentRetentionRate: nonTargetRetention.deliveredInTreatment / nonTargetRetention.eligible,
      controlRetentionRate: nonTargetRetention.deliveredInControl / nonTargetRetention.eligible,
    }
    : { eligible: 0, deliveredInTreatment: null, deliveredInControl: null, treatmentRetentionRate: null, controlRetentionRate: null, note: 'no non-target retention facts supplied (isolated mode: structurally all OFF)' };
  const evictions = capacityRecords.flatMap((record) => (record && Array.isArray(record.evicted) ? record.evicted.map((e) => ({ ...e, armId: record.armId || null })) : []));
  return {
    metric: 'TreatmentFidelity',
    plannedTreatmentUnits,
    evidencedChains: chains.length,
    configured: count(chains, 'CONFIGURED') + atLeast(chains, 'SELECTED'), // CONFIGURED proven directly or implied by a higher consecutive level
    selected: atLeast(chains, 'SELECTED'),
    submitted: atLeast(chains, 'SUBMITTED'),
    hostAccepted: atLeast(chains, 'HOST_ACCEPTED'),
    contextPresent: contextOrAbove,
    runtimeLoaded,
    actualInjectionRate: plannedTreatmentUnits === 0
      ? { status: 'NOT_ESTIMABLE', reason: 'no planned treatment units' }
      : { status: 'ESTIMABLE', numerator: contextOrAbove, denominator: plannedTreatmentUnits, value: contextOrAbove / plannedTreatmentUnits,
        definition: 'CONTEXT_PRESENT or higher per §7.3 — SUBMITTED alone never counts as injection' },
    controlContamination: { units: contaminatedControl, ofControlChains: controlChains.length },
    nonTargetRetention: retention,
    capacityEvictions: { units: evictions.length, details: evictions },
    rule: 'fidelity is a mechanism observability record — the actually-injected subset may NEVER replace the ITT primary analysis; an unverifiable injection downgrades causal attribution but never deletes assigned units',
  };
}

const INJECTION_LEVEL_ORDER = ['NONE', 'CONFIGURED', 'SELECTED', 'SUBMITTED', 'HOST_ACCEPTED', 'CONTEXT_PRESENT', 'RUNTIME_LOADED'];

const CONTROL_ABSENCE_PAYLOAD_HASH = sha256('');

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
