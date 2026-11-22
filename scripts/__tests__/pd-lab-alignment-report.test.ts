// PRI-1255 / PD-Lab v0.3 T4: contract tests for the offline judge merge,
// Owner-alignment scoring and two-sided change-vs-baseline decision.
//
// Authority: docs/specs/CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md
// sections 5.2, 6.1-6.5 and 7 (SC-01..SC-19), plus the section 7 numeric
// properties. Every SC case is an independent test asserting pointEstimate,
// missingBounds, status and decision fields. Expectations are recomputed
// from the CONTRACT tables, not from the implementation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAlignmentReport, mergeJudgments } from '../dev/pd-lab/alignment-report.mjs';

// ---------------------------------------------------------------------------
// Fixture builders (test-side; assignment keys composed independently of the
// implementation to keep the join honest).
// ---------------------------------------------------------------------------

interface UnitSpec {
  caseId: string;
  scenarioId: string;
  opportunityId?: string;
  repetitionId?: string;
  caseVersion?: string;
}

function unit(spec: UnitSpec) {
  return {
    candidateConfigId: 'cfg-candidate',
    caseId: spec.caseId,
    caseVersion: spec.caseVersion ?? 'v1',
    opportunityId: spec.opportunityId ?? 'opp-1',
    repetitionId: spec.repetitionId ?? 'rep-1',
    referenceId: 'ref-1',
    scenarioId: spec.scenarioId,
    // Pre-registered evidence bindings (PR #2696 B1 remediation): judged
    // units need these to count as verified; negative tests null them out.
    candidateTrajectoryRef: `traj-cand-${spec.caseId}`,
    referenceTrajectoryRef: `traj-ref-${spec.caseId}`,
    expectationRef: `exp-${spec.caseId}`,
  };
}

function keyOf(assignment: ReturnType<typeof unit>) {
  return `${assignment.candidateConfigId}+${assignment.caseId}@${assignment.caseVersion}+${assignment.opportunityId}+${assignment.repetitionId}+${assignment.referenceId}`;
}

function finalComparison(assignment: ReturnType<typeof unit>, verdict: string, extra: Record<string, unknown> = {}) {
  return {
    assignmentKey: keyOf(assignment),
    candidateTrajectoryRef: null,
    referenceTrajectoryRef: null,
    expectationRef: null,
    judgeProtocolRef: 'jp-test@1',
    judgmentRefs: [`j-${keyOf(assignment)}`],
    arbitrationRef: null,
    verdict,
    reasonCode: verdict === 'UNKNOWN' ? 'TEST_UNKNOWN' : 'CONSISTENT_JUDGMENTS',
    evidenceRefs: [],
    resolvedBy: 'CONSISTENT_JUDGMENTS',
    ...extra,
  };
}

interface PlanOptions {
  design?: string;
  alpha?: number;
  scenarios?: Array<{ scenarioId: string; ownerId: string; weight: number }>;
  owners?: Array<{ ownerId: string; weight: number }>;
  requiredJudgments?: number;
  /** Preregistered judge slot ids (plan.judgeProtocol.judgeSlots, round 3). */
  judgeSlots?: string[];
  omitAnalysisPolicy?: boolean;
}

function makePlan(assignments: Array<ReturnType<typeof unit>>, options: PlanOptions = {}) {
  const design = options.design ?? 'HOST_VS_FIXED_REFERENCE';
  const judgeProtocol: Record<string, unknown> = { requiredJudgments: options.requiredJudgments ?? 1 };
  if (options.judgeSlots) {
    judgeProtocol.judgeSlots = options.judgeSlots.map((judgeSlotId) => ({ judgeSlotId }));
  }
  const plan: Record<string, unknown> = {
    schemaVersion: 'pd-lab-plan.v1',
    benchmarkId: 'bench-test',
    benchmarkVersion: '1',
    comparisonDesign: design,
    judgeProtocolRef: 'jp-test@1',
    judgeProtocol,
    owners: options.owners ?? [{ ownerId: 'O1', weight: 1 }],
    scenarios: options.scenarios ?? [{ scenarioId: 'SC1', ownerId: 'O1', weight: 1 }],
    assignments,
  };
  if (!options.omitAnalysisPolicy) {
    plan.analysisPolicy = { alpha: options.alpha ?? 0.05 };
  }
  return plan;
}

function sourceGroupsFor(assignments: Array<ReturnType<typeof unit>>, override?: Record<string, string>) {
  const groups: Record<string, string> = {};
  for (const assignment of assignments) {
    groups[assignment.caseId] = `sg-${assignment.caseId}`;
  }
  Object.assign(groups, override ?? {});
  // Complete per-group rationales (CONTRACT section 3): every published
  // source group carries its grouping rationale. B5 negative tests build
  // their own sourceGroups objects to exercise missing rationale evidence.
  const rationales: Record<string, string> = {};
  for (const groupId of new Set(Object.values(groups))) {
    rationales[groupId] = `same-session grouping rationale for ${groupId}`;
  }
  return { groups, rationales };
}

function reportFor(assignments: Array<ReturnType<typeof unit>>, comparisons: Array<ReturnType<typeof finalComparison>>, options: PlanOptions = {}, sourceGroupsOverride?: Record<string, string>) {
  return buildAlignmentReport({
    plan: makePlan(assignments, options),
    finalComparisons: comparisons,
    sourceGroups: sourceGroupsFor(assignments, sourceGroupsOverride),
  });
}

/** n single-unit source groups in one scenario; verdicts indexed by group. */
function nGroupFixture(n: number, verdictFor: (groupIndex: number) => string, alpha = 0.05) {
  const assignments: Array<ReturnType<typeof unit>> = [];
  for (let i = 1; i <= n; i += 1) {
    assignments.push(unit({ caseId: `case-${i}`, scenarioId: 'SC1' }));
  }
  const comparisons = assignments.map((assignment, index) => finalComparison(assignment, verdictFor(index + 1)));
  const report = reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE', alpha });
  return { assignments, comparisons, report };
}

const W = 'CANDIDATE_BETTER';
const L = 'REFERENCE_BETTER';
const T = 'TIE';
const U = 'UNKNOWN';

// ---------------------------------------------------------------------------
// CONTRACT section 7: SC-01 .. SC-19.
// ---------------------------------------------------------------------------

describe('CONTRACT section 7 synthetic cases', () => {
  it('SC-01: one scenario, two independent source groups (win, loss) scores 50 and is fully scoreable', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const report = reportFor([a1, a2], [finalComparison(a1, W), finalComparison(a2, L)]);
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    expect(report.missingBounds).toEqual({ lower: 50, upper: 50 });
    // Owner remediation ruling 2026-11-17 (PR #2696 B3): ESTIMABLE means only
    // "every planned unit has a computable point value"; formal ranking
    // eligibility (rankingEligible) is judged independently and stays false
    // at T4 because the qualification credentials do not exist offline.
    // Mapping record: pointEstimate/missingBounds/status/decision assertions
    // are unchanged; only the former `rankingEligible: true` expectation is
    // corrected to false. This is a semantic correction, not a weakened test.
    expect(report.rankingEligible).toBe(false);
    expect(report.decision).toBe(null); // HOST_VS_FIXED_REFERENCE: no 6.5 decision
    expect(report.counts.planned).toBe(2);
    expect(report.counts.sourceGroups).toBe(2);
  });

  it('SC-02: repetitions aggregate inside the opportunity (75), not by raw output count (66.7)', () => {
    const a1r1 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-1' });
    const a1r2 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-2' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const report = reportFor(
      [a1r1, a1r2, a2],
      [finalComparison(a1r1, W), finalComparison(a1r2, L), finalComparison(a2, W)],
    );
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(75);
    expect(report.counts.planned).toBe(3);
    expect(report.counts.opportunities).toBe(2);
    expect(report.counts.sourceGroups).toBe(2);
  });

  it('SC-03: two equally weighted scenarios (A groups 1 and 0.5, B group 0) score 37.5', () => {
    const scenarios = [
      { scenarioId: 'SC-A', ownerId: 'O1', weight: 0.5 },
      { scenarioId: 'SC-B', ownerId: 'O1', weight: 0.5 },
    ];
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC-A' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC-A' });
    const b1 = unit({ caseId: 'case-3', scenarioId: 'SC-B' });
    const report = reportFor(
      [a1, a2, b1],
      [finalComparison(a1, W), finalComparison(a2, T), finalComparison(b1, L)],
      { scenarios },
    );
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(37.5);
    expect(report.counts.scenarios).toBe(2);
  });

  it('SC-04: SC-03 with B UNKNOWN gives point null and bounds [37.5, 87.5], not ranking-eligible', () => {
    const scenarios = [
      { scenarioId: 'SC-A', ownerId: 'O1', weight: 0.5 },
      { scenarioId: 'SC-B', ownerId: 'O1', weight: 0.5 },
    ];
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC-A' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC-A' });
    const b1 = unit({ caseId: 'case-3', scenarioId: 'SC-B' });
    const report = reportFor(
      [a1, a2, b1],
      [finalComparison(a1, W), finalComparison(a2, T), finalComparison(b1, U, { resolvedBy: 'UNRESOLVED' })],
      { scenarios },
    );
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds.lower).toBeCloseTo(37.5, 10);
    expect(report.missingBounds.upper).toBeCloseTo(87.5, 10);
    expect(report.rankingEligible).toBe(false);
    expect(report.counts.unknown).toBe(1);
  });

  it('SC-05: ten derived winning cases in one group vs one losing case in another scores 50, not 90.9', () => {
    const assignments: Array<ReturnType<typeof unit>> = [];
    const comparisons: Array<ReturnType<typeof finalComparison>> = [];
    for (let i = 1; i <= 10; i += 1) {
      const a = unit({ caseId: `case-1-${i}`, scenarioId: 'SC1' });
      assignments.push(a);
      comparisons.push(finalComparison(a, W));
    }
    const loser = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    assignments.push(loser);
    comparisons.push(finalComparison(loser, L));
    const groups = { groups: {} as Record<string, string> };
    for (const assignment of assignments) {
      groups.groups[assignment.caseId] = assignment.caseId.startsWith('case-1-') ? 'sg-1' : 'sg-2';
    }
    const report = buildAlignmentReport({
      plan: makePlan(assignments),
      finalComparisons: comparisons,
      sourceGroups: groups,
    });
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    expect(report.counts.cases).toBe(11);
    expect(report.counts.sourceGroups).toBe(2);
  });

  it('SC-06: all planned units TIE scores 50 and never auto-promotes', () => {
    const { report } = nGroupFixture(3, () => T);
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.definiteWins).toBe(0);
    expect(report.decision.definiteLosses).toBe(0);
    expect(report.decision.undetermined).toBe(3);
    expect(report.decision.unknownsCouldChangeVerdict).toBe(false);
  });

  it('SC-07: plan of two units with only one persisted win keeps the denominator ([50, 100], point null)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-2' });
    const report = reportFor([a1, a2], [finalComparison(a1, W)], { design: 'CHANGE_VS_BASELINE' });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 50, upper: 100 });
    expect(report.counts.planned).toBe(2);
    expect(report.counts.resolved).toBe(1);
    expect(report.counts.unknown).toBe(1);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.plannedGroups).toBe(1);
    expect(report.decision.undetermined).toBe(1);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
  });

  it('SC-08: two final comparisons for the same assignment are INVALID, never "last one wins"', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const report = reportFor([a1], [finalComparison(a1, W), finalComparison(a1, W)]);
    expect(report.status).toBe('INVALID');
    expect(report.problems.some((p) => p.code === 'DUPLICATE_FINAL_COMPARISON')).toBe(true);
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toBe(null);
    expect(report.rankingEligible).toBe(false);
    expect(report.decision).toBe(null);
  });

  it('SC-09: A-better with A=candidate and swapped B-better with B=candidate both restore to a consistent candidate win (value 1)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [
      // Same frozen comparison input for both protocol-required judgments
      // (B1: records of one unit with different comparisonInputDigest values
      // do not belong to one frozen comparison without a verified mapping).
      { judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'A_BETTER', attempt: 1, judgeSlotId: 'slot-j1' },
      { judgmentId: 'j2', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'B_BETTER', attempt: 1, judgeSlotId: 'slot-j2' },
    ];
    // j1: display A is the candidate. j2 arrived after the display swap, so
    // for that record display B is the candidate (per-record mapping).
    const blindmap = {
      map: {
        j1: { A: 'candidate', B: 'reference' },
        j2: { A: 'reference', B: 'candidate' },
      },
    };
    const merged = mergeJudgments({ plan, judgments, blindmap });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons).toHaveLength(1);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.finalComparisons[0].resolvedBy).toBe('CONSISTENT_JUDGMENTS');
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
    });
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(100);
    // And the mirrored arrangement: B=candidate wins / A=candidate wins is
    // the same candidate win after restoration.
    const blindmapSwapped = {
      map: {
        j1: { A: 'reference', B: 'candidate' },
        j2: { A: 'candidate', B: 'reference' },
      },
    };
    const judgmentsSwapped = [
      { judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'B_BETTER', attempt: 1, judgeSlotId: 'slot-j1' },
      { judgmentId: 'j2', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'A_BETTER', attempt: 1, judgeSlotId: 'slot-j2' },
    ];
    const mergedSwapped = mergeJudgments({ plan, judgments: judgmentsSwapped, blindmap: blindmapSwapped });
    expect(mergedSwapped.problems).toEqual([]);
    expect(mergedSwapped.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
  });

  it('SC-10: conflicting judgments with swapped displays and no arbitration are UNKNOWN, never averaged to 0.5', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [
      { judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'A_BETTER', attempt: 1, judgeSlotId: 'slot-j1' }, // A=candidate -> candidate better
      { judgmentId: 'j2', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen-a', displayVerdict: 'B_BETTER', attempt: 1, judgeSlotId: 'slot-j2' }, // B=reference -> reference better
    ];
    const blindmap = {
      map: {
        j1: { A: 'candidate', B: 'reference' },
        j2: { A: 'candidate', B: 'reference' },
      },
    };
    const merged = mergeJudgments({ plan, judgments, blindmap });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('ARBITRATION_MISSING');
    expect(merged.finalComparisons[0].resolvedBy).toBe('UNRESOLVED');
    const report = buildAlignmentReport({
      plan: makePlan([a1], { requiredJudgments: 2, design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
    });
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
    expect(report.counts.unknown).toBe(1);
  });

  it('SC-11: empty scenario group or weights not summing to 1 is INVALID_PLAN without silent re-weighting', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const badWeights = reportFor(
      [a1],
      [finalComparison(a1, W)],
      {
        scenarios: [
          { scenarioId: 'SC1', ownerId: 'O1', weight: 0.6 },
          { scenarioId: 'SC2', ownerId: 'O1', weight: 0.6 },
        ],
      },
    );
    expect(badWeights.status).toBe('INVALID');
    expect(badWeights.problems.some((p) => p.code === 'SCENARIO_WEIGHT_SUM')).toBe(true);
    expect(badWeights.pointEstimate).toBe(null);

    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const emptyGroup = reportFor(
      [a1, a2],
      [finalComparison(a1, W), finalComparison(a2, L)],
      {
        scenarios: [
          { scenarioId: 'SC1', ownerId: 'O1', weight: 1 },
          { scenarioId: 'SC2', ownerId: 'O1', weight: 0 },
        ],
      },
    );
    expect(emptyGroup.status).toBe('INVALID');
    expect(emptyGroup.problems.some((p) => p.code === 'EMPTY_SCENARIO_GROUP')).toBe(true);
    expect(emptyGroup.pointEstimate).toBe(null);
    expect(emptyGroup.missingBounds).toBe(null);
  });

  it('SC-12: the same source group split across two main scenarios is INVALID_PLAN', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC-A' });
    const a2 = unit({ caseId: 'case-1', scenarioId: 'SC-B', opportunityId: 'opp-2' });
    const groups = { groups: { 'case-1': 'sg-shared' } };
    const report = buildAlignmentReport({
      plan: makePlan([a1, a2], {
        scenarios: [
          { scenarioId: 'SC-A', ownerId: 'O1', weight: 0.5 },
          { scenarioId: 'SC-B', ownerId: 'O1', weight: 0.5 },
        ],
      }),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, L)],
      sourceGroups: groups,
    });
    expect(report.status).toBe('INVALID');
    expect(report.problems.some((p) => p.code === 'SOURCE_GROUP_SPLIT_ACROSS_SCENARIOS')).toBe(true);
    expect(report.pointEstimate).toBe(null);
  });

  it('SC-13: 14 groups, 12 wins / 2 losses, two-sided alpha 0.05 -> IMPROVED with point 85.7', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 12 ? W : L));
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBeCloseTo(85.7143, 3);
    expect(report.missingBounds.lower).toBeCloseTo(85.7143, 3);
    expect(report.missingBounds.upper).toBeCloseTo(85.7143, 3);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.design).toBe('CHANGE_VS_BASELINE');
    expect(report.decision.alpha).toBe(0.05);
    expect(report.decision.alphaPerDirection).toBe(0.025);
    expect(report.decision.plannedGroups).toBe(14);
    expect(report.decision.definiteWins).toBe(12);
    expect(report.decision.definiteLosses).toBe(2);
    expect(report.decision.undetermined).toBe(0);
    expect(report.decision.threshold).toBe(12);
    expect(report.decision.outcome).toBe('IMPROVED');
    expect(report.decision.unknownsCouldChangeVerdict).toBe(null);
    expect(report.decision.guardrailBreaches).toEqual([]);
  });

  it('SC-14: 14 groups, 11 wins / 3 losses -> INCONCLUSIVE: two-sided k=12 rejects the old one-sided threshold 11', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 11 ? W : L));
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBeCloseTo(78.5714, 3);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.threshold).toBe(12);
    expect(report.decision.definiteWins).toBe(11);
    // The rejected single-sided legacy threshold is 11: with W = 11 < k = 12
    // the outcome must NOT be IMPROVED.
    expect(report.decision.definiteWins).toBeLessThan(report.decision.threshold);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.unknownsCouldChangeVerdict).toBe(false);
    expect(report.decision.definiteLosses).toBe(3);
    expect(report.decision.undetermined).toBe(0);
  });

  it('SC-15: 14 groups, 10 wins / 1 loss / 3 all-UNKNOWN -> INCONCLUSIVE, unknowns could change it, bounds [71.4, 92.9]', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 10 ? W : g === 11 ? L : U));
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds.lower).toBeCloseTo(71.4286, 3);
    expect(report.missingBounds.upper).toBeCloseTo(92.8571, 3);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.plannedGroups).toBe(14); // missing records never shrink the denominator
    expect(report.decision.definiteWins).toBe(10);
    expect(report.decision.definiteLosses).toBe(1);
    expect(report.decision.undetermined).toBe(3);
    expect(report.decision.threshold).toBe(12);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.unknownsCouldChangeVerdict).toBe(true);
    expect(report.counts.unknown).toBe(3);
  });

  it('SC-16: 14 groups, 8 wins / 2 losses / 4 ties, no unknowns -> INCONCLUSIVE, unknowns cannot change it, point 71.4', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 8 ? W : g <= 10 ? L : T));
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBeCloseTo(71.4286, 3);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.definiteWins).toBe(8);
    expect(report.decision.definiteLosses).toBe(2);
    expect(report.decision.undetermined).toBe(4);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.unknownsCouldChangeVerdict).toBe(false);
    expect(report.counts.unknown).toBe(0);
  });

  it('SC-17: 14 groups, 1 win / 12 losses / 1 tie -> REGRESSION with point 10.7', () => {
    const { report } = nGroupFixture(14, (g) => (g === 1 ? W : g <= 13 ? L : T));
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBeCloseTo(10.7143, 3);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.definiteWins).toBe(1);
    expect(report.decision.definiteLosses).toBe(12);
    expect(report.decision.undetermined).toBe(1);
    expect(report.decision.threshold).toBe(12);
    expect(report.decision.outcome).toBe('REGRESSION');
    expect(report.decision.unknownsCouldChangeVerdict).toBe(null);
  });

  it('SC-18: a group with one win and one UNKNOWN unit is [0.5, 1] and UNDETERMINED, not a definite win', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-2' });
    const groups = { groups: { 'case-1': 'sg-1' } };
    const report = buildAlignmentReport({
      plan: makePlan([a1, a2], { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: [finalComparison(a1, W)], // a2 missing -> UNKNOWN in the denominator
      sourceGroups: groups,
    });
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.groups).toHaveLength(1);
    const group = report.decision.groups[0];
    expect(group.sourceGroupId).toBe('sg-1');
    // CONTRACT 6.5 field names (round-3 rectification: implementation now
    // emits lower_g/upper_g exactly as the contract defines).
    expect(group.lower_g).toBe(0.5);
    expect(group.upper_g).toBe(1);
    expect(group.classification).toBe('UNDETERMINED');
    expect(group.containsUnknown).toBe(true);
    expect(group.plannedUnits).toBe(2);
    expect(report.decision.definiteWins).toBe(0);
  });

  it('SC-19: a dataset case missing from source-groups.json is INVALID_PLAN, never one-case-one-group', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const groups = { groups: { 'case-1': 'sg-1' } }; // case-2 not covered
    const report = buildAlignmentReport({
      plan: makePlan([a1, a2]),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, L)],
      sourceGroups: groups,
    });
    expect(report.status).toBe('INVALID');
    expect(report.problems.some((p) => p.code === 'SOURCE_GROUP_MAPPING_MISSING')).toBe(true);
    expect(report.pointEstimate).toBe(null);
    expect(report.counts.sourceGroups).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CONTRACT section 6.5 property list.
// ---------------------------------------------------------------------------

describe('CONTRACT 6.5 properties', () => {
  it('W and L never double-count: every group lands in exactly one bucket', () => {
    for (const verdictFor of [
      (g: number) => (g <= 12 ? W : L),
      (g: number) => (g <= 11 ? W : L),
      (g: number) => (g === 1 ? W : g <= 13 ? L : T),
      (g: number) => (g <= 8 ? W : g <= 10 ? L : g <= 14 ? T : U),
    ]) {
      const { report } = nGroupFixture(14, verdictFor);
      if (!report.decision) throw new Error('decision missing');
      const { definiteWins, definiteLosses, undetermined, plannedGroups } = report.decision;
      expect(definiteWins + definiteLosses + undetermined).toBe(plannedGroups);
    }
  });

  it('UNKNOWN is neutral: adding an UNKNOWN unit to an already-definite group does not change its classification', () => {
    // 2-of-3 wins: lower = 2/3 > 0.5 -> definite win even with an unknown.
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-2' });
    const a3 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-3' });
    const groups = { groups: { 'case-1': 'sg-1' } };
    const report = buildAlignmentReport({
      plan: makePlan([a1, a2, a3], { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, W)], // rep-3 missing
      sourceGroups: groups,
    });
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.groups[0].classification).toBe('DEFINITE_WIN');
    expect(report.decision.groups[0].containsUnknown).toBe(true);
    expect(report.decision.groups[0].lower_g).toBeCloseTo(2 / 3, 12);
    expect(report.decision.groups[0].upper_g).toBe(1);
    // Mirror: 2-of-3 losses stays a definite loss.
    const reportLoss = buildAlignmentReport({
      plan: makePlan([a1, a2, a3], { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: [finalComparison(a1, L), finalComparison(a2, L)],
      sourceGroups: groups,
    });
    if (!reportLoss.decision) throw new Error('decision missing');
    expect(reportLoss.decision.groups[0].classification).toBe('DEFINITE_LOSS');
    expect(reportLoss.decision.groups[0].upper_g).toBeCloseTo(1 / 3, 12);
  });

  it('TIE does not masquerade as UNKNOWN: a real tie group is a single point 0.5, undetermined, no unknowns', () => {
    const { report } = nGroupFixture(2, () => T);
    if (!report.decision) throw new Error('decision missing');
    const tieGroup = report.decision.groups[0];
    expect(tieGroup.lower_g).toBe(0.5);
    expect(tieGroup.upper_g).toBe(0.5);
    expect(tieGroup.classification).toBe('UNDETERMINED');
    expect(tieGroup.containsUnknown).toBe(false);
    expect(report.counts.unknown).toBe(0);
    expect(report.pointEstimate).toBe(50); // ties are known outcomes
  });

  it('missing units stay in the denominator: planned and plannedGroups never shrink', () => {
    const { assignments, report } = nGroupFixture(14, (g) => (g <= 10 ? W : g === 11 ? L : U));
    expect(report.counts.planned).toBe(assignments.length);
    expect(report.counts.unknown).toBe(3);
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.plannedGroups).toBe(14);
    // Drop two comparison records entirely (missing finals, not UNKNOWN
    // verdicts): the denominator is unchanged.
    const partial = buildAlignmentReport({
      plan: makePlan(assignments, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: [],
      sourceGroups: sourceGroupsFor(assignments),
    });
    if (!partial.decision) throw new Error('decision missing');
    expect(partial.counts.planned).toBe(14);
    expect(partial.decision.plannedGroups).toBe(14);
    expect(partial.decision.definiteWins).toBe(0);
    expect(partial.decision.undetermined).toBe(14);
  });

  it('source groups are equal weight regardless of unit count (10 units vs 1 unit)', () => {
    const big: Array<ReturnType<typeof unit>> = [];
    const bigComparisons: Array<ReturnType<typeof finalComparison>> = [];
    for (let i = 1; i <= 10; i += 1) {
      const a = unit({ caseId: `case-1`, scenarioId: 'SC1', opportunityId: `opp-${i}` });
      big.push(a);
      bigComparisons.push(finalComparison(a, W));
    }
    const small = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    big.push(small);
    bigComparisons.push(finalComparison(small, L));
    const groups = { groups: { 'case-1': 'sg-1', 'case-2': 'sg-2' } };
    const report = buildAlignmentReport({
      plan: makePlan(big, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: bigComparisons,
      sourceGroups: groups,
    });
    expect(report.pointEstimate).toBe(50); // not (10*1 + 0) / 11 = 90.9
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.plannedGroups).toBe(2);
    expect(report.decision.definiteWins).toBe(1);
    expect(report.decision.definiteLosses).toBe(1);
  });

  it('repeated runs of the same case do not add independent source groups', () => {
    const oneRep = [unit({ caseId: 'case-1', scenarioId: 'SC1' }), unit({ caseId: 'case-2', scenarioId: 'SC1' })];
    const threeReps: Array<ReturnType<typeof unit>> = [];
    const threeRepComparisons: Array<ReturnType<typeof finalComparison>> = [];
    for (const base of oneRep) {
      for (const rep of ['rep-1', 'rep-2', 'rep-3']) {
        const a = { ...base, repetitionId: rep };
        threeReps.push(a);
        threeRepComparisons.push(finalComparison(a, base.caseId === 'case-1' ? W : L));
      }
    }
    const reportOne = reportFor(oneRep, [finalComparison(oneRep[0], W), finalComparison(oneRep[1], L)], { design: 'CHANGE_VS_BASELINE' });
    const groups = { groups: { 'case-1': 'sg-1', 'case-2': 'sg-2' } };
    const reportThree = buildAlignmentReport({
      plan: makePlan(threeReps, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: threeRepComparisons,
      sourceGroups: groups,
    });
    expect(reportThree.counts.planned).toBe(6);
    expect(reportThree.counts.sourceGroups).toBe(2);
    expect(reportThree.pointEstimate).toBe(50);
    if (!reportThree.decision || !reportOne.decision) throw new Error('decision missing');
    expect(reportThree.decision.plannedGroups).toBe(reportOne.decision.plannedGroups);
    expect(reportThree.decision.definiteWins).toBe(reportOne.decision.definiteWins);
    expect(reportThree.decision.definiteLosses).toBe(reportOne.decision.definiteLosses);
  });

  it('missingBounds is recomputable from the per-group [lower_g, upper_g] and plan weights', () => {
    const scenarios = [
      { scenarioId: 'SC-A', ownerId: 'O1', weight: 0.5 },
      { scenarioId: 'SC-B', ownerId: 'O1', weight: 0.5 },
    ];
    const assignments = [
      unit({ caseId: 'case-1', scenarioId: 'SC-A' }),
      unit({ caseId: 'case-2', scenarioId: 'SC-A' }),
      unit({ caseId: 'case-3', scenarioId: 'SC-B' }),
    ];
    const report = reportFor(
      assignments,
      [finalComparison(assignments[0], W), finalComparison(assignments[1], U, { resolvedBy: 'UNRESOLVED' }), finalComparison(assignments[2], L)],
      { scenarios },
    );
    expect(report.status).toBe('BOUNDED_ONLY');
    // Independent recomputation: scenario = mean over its groups, then the
    // 0.5/0.5 scenario weights, times 100.
    const scenarioALower = (1 + 0) / 2;
    const scenarioAUpper = (1 + 1) / 2;
    const expectedLower = 100 * (0.5 * scenarioALower + 0.5 * 0);
    const expectedUpper = 100 * (0.5 * scenarioAUpper + 0.5 * 0);
    expect(report.missingBounds.lower).toBeCloseTo(expectedLower, 10);
    expect(report.missingBounds.upper).toBeCloseTo(expectedUpper, 10);
  });

  it('missingBounds matches decision.groups aggregation for the 6.5 fixtures too', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 10 ? W : g === 11 ? L : U));
    if (!report.decision) throw new Error('decision missing');
    const groupLowers = report.decision.groups.map((g) => g.lower_g);
    const groupUppers = report.decision.groups.map((g) => g.upper_g);
    const recomputedLower = (100 * groupLowers.reduce((s, v) => s + v, 0)) / groupLowers.length;
    const recomputedUpper = (100 * groupUppers.reduce((s, v) => s + v, 0)) / groupUppers.length;
    expect(report.missingBounds.lower).toBeCloseTo(recomputedLower, 10);
    expect(report.missingBounds.upper).toBeCloseTo(recomputedUpper, 10);
  });

  it('unknownsCouldChangeVerdict enumerates both directions and only appears when INCONCLUSIVE', () => {
    // Improvement direction only (SC-15 shape).
    const improve = nGroupFixture(14, (g) => (g <= 10 ? W : g === 11 ? L : U)).report;
    if (!improve.decision) throw new Error('decision missing');
    expect(improve.decision.outcome).toBe('INCONCLUSIVE');
    expect(improve.decision.unknownsCouldChangeVerdict).toBe(true);
    expect(improve.decision.groups.filter((g) => g.classification === 'UNDETERMINED' && g.containsUnknown && g.upper_g > 0.5).length).toBe(3);

    // Regression direction only: 1 win, 11 losses, 2 all-UNKNOWN groups.
    // k = 12: favorable wins give 1 + 2 = 3 < 12, favorable losses 11 + 2 = 13 >= 12.
    const regress = nGroupFixture(14, (g) => (g === 1 ? W : g <= 12 ? L : U)).report;
    if (!regress.decision) throw new Error('decision missing');
    expect(regress.decision.outcome).toBe('INCONCLUSIVE');
    expect(regress.decision.definiteLosses).toBe(11);
    expect(regress.decision.unknownsCouldChangeVerdict).toBe(true);

    // Neither direction (SC-16 shape).
    const neither = nGroupFixture(14, (g) => (g <= 8 ? W : g <= 10 ? L : T)).report;
    if (!neither.decision) throw new Error('decision missing');
    expect(neither.decision.unknownsCouldChangeVerdict).toBe(false);

    // Not emitted for decided outcomes (SC-13 / SC-17 shapes).
    expect(nGroupFixture(14, (g) => (g <= 12 ? W : L)).report.decision?.unknownsCouldChangeVerdict).toBe(null);
    expect(nGroupFixture(14, (g) => (g === 1 ? W : g <= 13 ? L : T)).report.decision?.unknownsCouldChangeVerdict).toBe(null);
  });

  it('unknownsCouldChangeVerdict agrees with brute-force enumeration of every UNKNOWN resolution', () => {
    // n = 6 (k = 6): 5 definite wins + 1 group whose single unit is UNKNOWN.
    // Resolving it to a win yields W = 6 >= 6 -> true.
    const caseA = Array.from({ length: 5 }, (_, i) => unit({ caseId: `case-w${i}`, scenarioId: 'SC1' }));
    const unknownUnit = unit({ caseId: 'case-u', scenarioId: 'SC1' });
    const assignments6 = [...caseA, unknownUnit];
    const groups6 = sourceGroupsFor(assignments6);
    const comparisons6 = caseA.map((a) => finalComparison(a, W));
    const report6 = buildAlignmentReport({
      plan: makePlan(assignments6, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: comparisons6,
      sourceGroups: groups6,
    });
    if (!report6.decision) throw new Error('decision missing');
    expect(report6.decision.threshold).toBe(6);
    expect(report6.decision.outcome).toBe('INCONCLUSIVE');

    // Brute force: every resolution of the unknown unit in {0, 0.5-free win/loss}.
    const resolutions: number[] = [];
    for (const value of [0, 1]) {
      const wins = 5 + (value === 1 ? 1 : 0);
      const losses = 0 + (value === 0 ? 1 : 0);
      resolutions.push(wins, losses);
    }
    const maxWins = Math.max(resolutions[0], resolutions[2]);
    const maxLosses = Math.max(resolutions[1], resolutions[3]);
    expect(maxWins >= 6 || maxLosses >= 6).toBe(true);
    expect(report6.decision.unknownsCouldChangeVerdict).toBe(true);

    // n = 7 (k = 7): 4 wins, 1 loss, 2 all-UNKNOWN groups. Max wins 6 < 7,
    // max losses 3 < 7 -> false.
    const assignments7 = [
      ...Array.from({ length: 4 }, (_, i) => unit({ caseId: `case-w${i}`, scenarioId: 'SC1' })),
      unit({ caseId: 'case-l', scenarioId: 'SC1' }),
      unit({ caseId: 'case-u1', scenarioId: 'SC1' }),
      unit({ caseId: 'case-u2', scenarioId: 'SC1' }),
    ];
    const report7 = buildAlignmentReport({
      plan: makePlan(assignments7, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: [
        ...Array.from({ length: 4 }, (_, i) => finalComparison(assignments7[i], W)),
        finalComparison(assignments7[4], L),
      ],
      sourceGroups: sourceGroupsFor(assignments7),
    });
    if (!report7.decision) throw new Error('decision missing');
    expect(report7.decision.threshold).toBe(7);
    expect(report7.decision.unknownsCouldChangeVerdict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Two-sided k(n, alpha) table (CONTRACT 6.5) including the n = 1..5 proof.
// ---------------------------------------------------------------------------

describe('two-sided threshold k(n, alpha)', () => {
  const table: Array<[number, number]> = [
    [6, 6], [7, 7], [8, 8], [9, 8], [10, 9], [11, 10], [12, 10],
    [13, 11], [14, 12], [15, 12], [16, 13], [20, 15], [30, 21], [50, 33], [100, 61],
  ];

  it.each(table)('n = %i yields k = %i at alpha = 0.05 (all-win plan reaches IMPROVED)', (n, expectedK) => {
    const { report } = nGroupFixture(n, () => W);
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.threshold).toBe(expectedK);
    expect(report.decision.plannedGroups).toBe(n);
    expect(report.decision.outcome).toBe('IMPROVED'); // W = n >= k
  });

  it.each([1, 2, 3, 4, 5])('n = %i has no k <= n at alpha = 0.05: even all wins stay INCONCLUSIVE', (n) => {
    const { report } = nGroupFixture(n, () => W);
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.threshold).toBe(null);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.definiteWins).toBe(n);
    expect(report.decision.unknownsCouldChangeVerdict).toBe(false); // no k exists, more evidence cannot help
  });

  it('the threshold formula really consumes the preregistered alpha, not a hardcoded 0.05', () => {
    // alpha = 0.02 (per-direction 0.01): n = 16 needs k = 14, not the table's 13,
    // and n = 6 has no achievable threshold at all (P(X>=6) = 0.015625 > 0.01).
    const strict16 = nGroupFixture(16, (g) => (g <= 13 ? W : L), 0.02).report;
    if (!strict16.decision) throw new Error('decision missing');
    expect(strict16.decision.alpha).toBe(0.02);
    expect(strict16.decision.alphaPerDirection).toBeCloseTo(0.01, 15);
    expect(strict16.decision.threshold).toBe(14);
    expect(strict16.decision.outcome).toBe('INCONCLUSIVE'); // 13 wins < 14

    const strict14 = nGroupFixture(14, (g) => (g <= 14 ? W : L), 0.02).report;
    if (!strict14.decision) throw new Error('decision missing');
    expect(strict14.decision.threshold).toBe(12); // unchanged where margins allow
    expect(strict14.decision.outcome).toBe('IMPROVED');

    const strict6 = nGroupFixture(6, () => W, 0.02).report;
    if (!strict6.decision) throw new Error('decision missing');
    expect(strict6.decision.threshold).toBe(null);
    expect(strict6.decision.outcome).toBe('INCONCLUSIVE');

    // alpha = 0.5 (per-direction 0.25): n = 6 drops to k = 5.
    const loose6 = nGroupFixture(6, (g) => (g <= 5 ? W : L), 0.5).report;
    if (!loose6.decision) throw new Error('decision missing');
    expect(loose6.decision.threshold).toBe(5);
    expect(loose6.decision.outcome).toBe('IMPROVED'); // 5 wins >= 5
  });

  it('IMPROVED and REGRESSION are mutually exclusive because k > n/2 (all tabulated n)', () => {
    for (const [n] of table) {
      // The worst case for mutual exclusion is W = L = n/2 with k as low as
      // the table allows; assert k > n/2 structurally for every n.
      const { report } = nGroupFixture(n, (g) => (g <= 6 ? W : L), 0.05);
      if (!report.decision) throw new Error('decision missing');
      if (report.decision.threshold !== null) {
        expect(report.decision.threshold).toBeGreaterThan(n / 2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CONTRACT section 7 numeric properties.
// ---------------------------------------------------------------------------

describe('CONTRACT section 7 numeric properties', () => {
  it('all valid scores lie in [0, 100]', () => {
    const fixtures = [
      nGroupFixture(14, (g) => (g <= 12 ? W : L)).report,
      nGroupFixture(14, (g) => (g === 1 ? W : g <= 13 ? L : T)).report,
      nGroupFixture(3, () => T).report,
      (() => {
        const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
        return reportFor([a1, unit({ caseId: 'case-2', scenarioId: 'SC1' })], [finalComparison(a1, W)]);
      })(),
    ];
    for (const report of fixtures) {
      if (report.pointEstimate !== null) {
        expect(report.pointEstimate).toBeGreaterThanOrEqual(0);
        expect(report.pointEstimate).toBeLessThanOrEqual(100);
      }
    }
  });

  it('swapping candidate/reference and inverting every judgment yields scores summing to 100', () => {
    const assignments = [
      unit({ caseId: 'case-1', scenarioId: 'SC1' }),
      unit({ caseId: 'case-2', scenarioId: 'SC1' }),
      unit({ caseId: 'case-3', scenarioId: 'SC1' }),
    ];
    const verdicts = [W, T, L];
    const invert: Record<string, string> = { CANDIDATE_BETTER: 'REFERENCE_BETTER', REFERENCE_BETTER: 'CANDIDATE_BETTER', TIE: 'TIE', UNKNOWN: 'UNKNOWN' };
    const forward = reportFor(assignments, assignments.map((a, i) => finalComparison(a, verdicts[i])));
    const backward = reportFor(assignments, assignments.map((a, i) => finalComparison(a, invert[verdicts[i]])));
    expect(forward.pointEstimate).toBeCloseTo(50, 10);
    expect(backward.pointEstimate).toBeCloseTo(50, 10);
    const asymmetric = reportFor(
      assignments,
      [finalComparison(assignments[0], W), finalComparison(assignments[1], W), finalComparison(assignments[2], T)],
    );
    const asymmetricSwapped = reportFor(
      assignments,
      [finalComparison(assignments[0], L), finalComparison(assignments[1], L), finalComparison(assignments[2], T)],
    );
    expect(asymmetric.pointEstimate! + asymmetricSwapped.pointEstimate!).toBeCloseTo(100, 10);
  });

  it('reordering the comparison records does not change the result', () => {
    const { comparisons, report } = nGroupFixture(14, (g) => (g <= 8 ? W : g <= 10 ? L : T));
    const reordered = [comparisons[5], comparisons[0], ...comparisons.slice(6), comparisons[1], comparisons[2], comparisons[3], comparisons[4]];
    const assignments = Array.from({ length: 14 }, (_, i) => unit({ caseId: `case-${i + 1}`, scenarioId: 'SC1' }));
    const reorderedReport = reportFor(assignments, reordered, { design: 'CHANGE_VS_BASELINE' });
    expect(reorderedReport.pointEstimate).toBeCloseTo(report.pointEstimate!, 12);
    expect(reorderedReport.status).toBe(report.status);
    expect(reorderedReport.counts).toEqual(report.counts);
    expect(reorderedReport.decision?.outcome).toBe(report.decision?.outcome);
    expect(reorderedReport.decision?.definiteWins).toBe(report.decision?.definiteWins);
  });

  it('recomputing from identical records is bit-identical, digests included', () => {
    const { assignments, comparisons } = nGroupFixture(14, (g) => (g <= 10 ? W : g === 11 ? L : U));
    const first = reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE' });
    const second = reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE' });
    expect(second).toEqual(first);
    expect(first.bindings.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.bindings.comparisonsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.bindings.analysisVersion).toBe('pd-lab-alignment-report.v1');
  });

  it('adding unknowns never narrows the missing bounds', () => {
    const scenarios = [
      { scenarioId: 'SC-A', ownerId: 'O1', weight: 0.5 },
      { scenarioId: 'SC-B', ownerId: 'O1', weight: 0.5 },
    ];
    const assignments = [
      unit({ caseId: 'case-1', scenarioId: 'SC-A' }),
      unit({ caseId: 'case-2', scenarioId: 'SC-A' }),
      unit({ caseId: 'case-3', scenarioId: 'SC-B' }),
      unit({ caseId: 'case-4', scenarioId: 'SC-B' }),
    ];
    const before = reportFor(
      assignments,
      [finalComparison(assignments[0], W), finalComparison(assignments[1], L), finalComparison(assignments[2], U, { resolvedBy: 'UNRESOLVED' }), finalComparison(assignments[3], T)],
      { scenarios },
    );
    const after = reportFor(
      assignments,
      [finalComparison(assignments[0], U, { resolvedBy: 'UNRESOLVED' }), finalComparison(assignments[1], L), finalComparison(assignments[2], U, { resolvedBy: 'UNRESOLVED' }), finalComparison(assignments[3], T)],
      { scenarios },
    );
    expect(after.missingBounds.lower).toBeLessThanOrEqual(before.missingBounds.lower);
    expect(after.missingBounds.upper).toBeGreaterThanOrEqual(before.missingBounds.upper);
  });

  it('duplicating an output record cannot change plan weights (INVALID, no score)', () => {
    const { assignments, comparisons } = nGroupFixture(3, (g) => (g <= 2 ? W : L));
    const report = reportFor(assignments, [...comparisons, comparisons[0]], { design: 'CHANGE_VS_BASELINE' });
    expect(report.status).toBe('INVALID');
    expect(report.pointEstimate).toBe(null);
    expect(report.rankingEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeJudgments contract details (CONTRACT 5.1 / 5.2).
// ---------------------------------------------------------------------------

describe('mergeJudgments record handling', () => {
  const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
  const key = keyOf(a1);
  const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
  const key2 = keyOf(a2);

  function judgment(overrides: Record<string, unknown> = {}) {
    return {
      judgmentId: 'j1',
      assignmentKey: key,
      judgeProtocolRef: 'jp-test@1',
      comparisonInputDigest: 'sha256:input',
      displayVerdict: 'A_BETTER',
      attempt: 1,
      judgeSlotId: 'slot-1',
      ...overrides,
    };
  }

  it('judgment records outside the plan are rejected, not silently ignored', () => {
    const plan = makePlan([a1]);
    const merged = mergeJudgments({
      plan,
      judgments: [judgment({ judgmentId: 'j-extra', assignmentKey: 'cfg-candidate+case-9@v1+opp-1+rep-1+ref-1' })],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems.some((p) => p.code === 'EXTRA_JUDGMENT_KEY')).toBe(true);
    expect(merged.invalidRecords).toBe(1);
    expect(merged.finalComparisons).toHaveLength(1); // planned unit still present, UNKNOWN
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
  });

  it('more judgment records than the protocol preregistered is over-voting and invalid', () => {
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const merged = mergeJudgments({
      plan,
      judgments: [judgment({ judgmentId: 'j1' }), judgment({ judgmentId: 'j2', displayVerdict: 'TIE', judgeSlotId: 'slot-2' }), judgment({ judgmentId: 'j3', displayVerdict: 'TIE', judgeSlotId: 'slot-3' })],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' }, j3: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems.some((p) => p.code === 'JUDGMENT_COUNT_EXCEEDED')).toBe(true);
    expect(merged.finalComparisons[0].reasonCode).toBe('JUDGMENT_COUNT_EXCEEDED');
  });

  it('fewer records than required keeps the unit as UNKNOWN (MISSING_JUDGMENTS is not a problem)', () => {
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const merged = mergeJudgments({
      plan,
      judgments: [judgment()],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('MISSING_JUDGMENTS');
  });

  it('duplicate judgment ids, wrong protocol version and UNKNOWN without reason are invalid records', () => {
    const plan = makePlan([a1]);
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' } } };
    const dup = mergeJudgments({ plan, judgments: [judgment(), judgment({ judgmentId: 'j1', displayVerdict: 'TIE' })], blindmap });
    expect(dup.problems.some((p) => p.code === 'DUPLICATE_JUDGMENT_ID')).toBe(true);
    expect(dup.invalidRecords).toBe(1);

    const wrongProtocol = mergeJudgments({ plan, judgments: [judgment({ judgeProtocolRef: 'jp-other@7' })], blindmap });
    expect(wrongProtocol.problems.some((p) => p.code === 'JUDGMENT_WRONG_PROTOCOL')).toBe(true);

    const unknownNoReason = mergeJudgments({ plan, judgments: [judgment({ displayVerdict: 'UNKNOWN' })], blindmap });
    expect(unknownNoReason.problems.some((p) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);
  });

  it('a missing blindmap mapping for a judged unit is invalid evidence, never guessed', () => {
    const plan = makePlan([a1]);
    const merged = mergeJudgments({ plan, judgments: [judgment()], blindmap: { map: {} } });
    expect(merged.problems.some((p) => p.code === 'BLINDMAP_MISSING')).toBe(true);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('BLINDMAP_MISSING');
    // A unit without judgments does not need a mapping.
    const plan2 = makePlan([a1, a2], { requiredJudgments: 1 });
    const merged2 = mergeJudgments({ plan: plan2, judgments: [judgment()], blindmap: { map: {} } });
    expect(merged2.problems.some((p) => p.code === 'BLINDMAP_MISSING')).toBe(true); // case-1 has records
    expect(merged2.finalComparisons.find((fc) => fc.assignmentKey === key2)?.reasonCode).toBe('MISSING_JUDGMENTS');
  });

  it('a malformed blindmap entry (same role on both sides) is rejected', () => {
    const plan = makePlan([a1]);
    const merged = mergeJudgments({
      plan,
      judgments: [judgment()],
      blindmap: { map: { j1: { A: 'candidate', B: 'candidate' } } },
    });
    expect(merged.problems.some((p) => p.code === 'BLINDMAP_INVALID')).toBe(true);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
  });

  it('arbitration: adopted when complete and explicit, UNKNOWN when uncertain or incompletely bound', () => {
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' } } };
    const conflicting = [judgment({ judgmentId: 'j1', displayVerdict: 'A_BETTER' }), judgment({ judgmentId: 'j2', displayVerdict: 'B_BETTER', judgeSlotId: 'slot-2' })];

    const adopted = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], boundComparisonInputDigests: ['sha256:input'], verdict: 'TIE' }],
      blindmap,
    });
    expect(adopted.problems).toEqual([]);
    expect(adopted.finalComparisons[0].verdict).toBe('TIE');
    expect(adopted.finalComparisons[0].resolvedBy).toBe('BLIND_ARBITRATION');
    expect(adopted.finalComparisons[0].arbitrationRef).toBe('arb1');

    const incomplete = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1'], boundComparisonInputDigests: ['sha256:input'], verdict: 'TIE' }],
      blindmap,
    });
    expect(incomplete.problems).toEqual([]);
    expect(incomplete.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(incomplete.finalComparisons[0].reasonCode).toBe('ARBITRATION_INCOMPLETE_BINDING');

    const uncertain = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], boundComparisonInputDigests: ['sha256:input'], verdict: 'UNKNOWN' }],
      blindmap,
    });
    expect(uncertain.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(uncertain.finalComparisons[0].reasonCode).toBe('ARBITRATION_UNCERTAIN');
    expect(uncertain.finalComparisons[0].resolvedBy).toBe('UNRESOLVED');
  });

  it('duplicate or out-of-plan arbitration records are invalid', () => {
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' } } };
    const duplicate = mergeJudgments({
      plan,
      judgments: [judgment()],
      arbitrations: [
        { arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1'], boundComparisonInputDigests: ['sha256:input'], verdict: 'TIE' },
        { arbitrationId: 'arb2', assignmentKey: key, boundJudgmentIds: ['j1'], boundComparisonInputDigests: ['sha256:input'], verdict: 'TIE' },
      ],
      blindmap,
    });
    expect(duplicate.problems.some((p) => p.code === 'DUPLICATE_ARBITRATION')).toBe(true);

    const extra = mergeJudgments({
      plan,
      judgments: [judgment()],
      arbitrations: [{ arbitrationId: 'arb-x', assignmentKey: key2, boundJudgmentIds: ['j1'], boundComparisonInputDigests: ['sha256:input'], verdict: 'TIE' }],
      blindmap,
    });
    expect(extra.problems.some((p) => p.code === 'EXTRA_ARBITRATION_KEY')).toBe(true);
  });

  it('UNKNOWN judgments require a reason and stay UNKNOWN when consistent', () => {
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' } } };
    const merged = mergeJudgments({
      plan,
      judgments: [
        judgment({ judgmentId: 'j1', displayVerdict: 'UNKNOWN', unknownReason: 'evidence truncated' }),
        judgment({ judgmentId: 'j2', displayVerdict: 'UNKNOWN', unknownReason: 'not comparable', judgeSlotId: 'slot-2' }),
      ],
      blindmap,
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('JUDGMENTS_UNKNOWN');
    expect(merged.finalComparisons[0].resolvedBy).toBe('CONSISTENT_JUDGMENTS');
  });

  it('non-array judgments input is a problem, and a plan missing alpha is INVALID through the report', () => {
    const plan = makePlan([a1]);
    const merged = mergeJudgments({ plan, judgments: { nope: true }, blindmap: { map: {} } });
    expect(merged.problems.some((p) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);

    const changePlan = makePlan([a1], { design: 'CHANGE_VS_BASELINE', omitAnalysisPolicy: true });
    const report = buildAlignmentReport({
      plan: changePlan,
      finalComparisons: [finalComparison(a1, W)],
      sourceGroups: sourceGroupsFor([a1]),
    });
    expect(report.status).toBe('INVALID');
    expect(report.problems.some((p) => p.code === 'ALPHA_NOT_PREREGISTERED')).toBe(true);
  });

  it('FinalComparison records with a wrong or missing protocol binding are rejected', () => {
    const wrongVersion = buildAlignmentReport({
      plan: makePlan([a1]),
      finalComparisons: [finalComparison(a1, W, { judgeProtocolRef: 'jp-other@9' })],
      sourceGroups: sourceGroupsFor([a1]),
    });
    expect(wrongVersion.status).toBe('INVALID');
    expect(wrongVersion.problems.some((p) => p.code === 'WRONG_PROTOCOL_VERSION')).toBe(true);

    const missingProtocol = buildAlignmentReport({
      plan: makePlan([a1]),
      finalComparisons: [finalComparison(a1, W, { judgeProtocolRef: undefined })],
      sourceGroups: sourceGroupsFor([a1]),
    });
    expect(missingProtocol.status).toBe('INVALID');
    expect(missingProtocol.problems.some((p) => p.code === 'INVALID_COMPARISON_RECORD')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B1 (PR #2696 remediation, 2026-11-17 Owner instruction): judge evidence
// binding. Structural completeness is not evidence credibility: a judged
// unit without its pre-registered evidence bindings (candidate/reference
// trajectory refs + expectation profile ref), or whose judgment records do
// not share one frozen comparison input, stays UNKNOWN (never a formal
// verdict). T4 has no display-order-to-digest mapping, so differing
// comparisonInputDigest values inside one unit are a conflict, and string
// equality of evidenceRefs never substitutes for the bindings.
// ---------------------------------------------------------------------------

describe('B1 judge evidence binding (PR #2696 remediation)', () => {
  const jp = 'jp-test@1';

  function record(id: string, assignmentKey: string, displayVerdict: string, digest = 'sha256:frozen-input') {
    return { judgmentId: id, assignmentKey, judgeProtocolRef: jp, comparisonInputDigest: digest, displayVerdict, attempt: 1, judgeSlotId: `slot-${id}` };
  }

  it('the B1 repro is no longer formally valid: unbound refs + conflicting digests + two A_BETTER records stay UNKNOWN with missingBounds, not CANDIDATE_BETTER/ESTIMABLE/point 100', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const unbound = { ...a1, candidateTrajectoryRef: null, referenceTrajectoryRef: null, expectationRef: null };
    const plan = makePlan([unbound], { requiredJudgments: 2 });
    const key = keyOf(unbound);
    const judgments = [
      record('j1', key, 'A_BETTER', 'sha256:input-1'),
      record('j2', key, 'A_BETTER', 'sha256:input-2'),
    ];
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' } } };
    const merged = mergeJudgments({ plan, judgments, blindmap });
    // Unverified evidence is not structural corruption: no run-invalidating
    // problems, but structured evidence problems and no formal verdict.
    expect(merged.problems).toEqual([]);
    const codes = merged.evidenceProblems.map((p: { code: string }) => p.code);
    expect(codes).toContain('EVIDENCE_BINDING_INCOMPLETE');
    expect(codes).toContain('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].resolvedBy).toBe('UNRESOLVED');
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([unbound]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
    expect(report.rankingEligible).toBe(false);
    expect(report.evidenceProblems.map((p: { code: string }) => p.code)).toContain('EVIDENCE_BINDING_INCOMPLETE');
  });

  it('a judged unit with complete evidence bindings and one frozen input still resolves normally', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' }); // unit() carries the three binding refs
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const merged = mergeJudgments({
      plan,
      judgments: [record('j1', key, 'A_BETTER')],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.finalComparisons[0].resolvedBy).toBe('CONSISTENT_JUDGMENTS');
  });

  it('missing binding refs alone degrade the judged unit to UNKNOWN and name the missing refs', () => {
    const a1 = { ...unit({ caseId: 'case-1', scenarioId: 'SC1' }), expectationRef: null };
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const merged = mergeJudgments({
      plan,
      judgments: [record('j1', key, 'A_BETTER')],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('EVIDENCE_BINDING_INCOMPLETE');
    const binding = merged.evidenceProblems.find((p: { code: string }) => p.code === 'EVIDENCE_BINDING_INCOMPLETE');
    expect(binding.assignmentKey).toBe(key);
    expect(binding.detail.missingRefs).toEqual(['expectationRef']);
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
  });

  it('records of one unit with different comparisonInputDigest values conflict the unit: no frozen display-order-to-digest mapping exists at T4', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const merged = mergeJudgments({
      plan,
      judgments: [record('j1', key, 'A_BETTER', 'sha256:input-1'), record('j2', key, 'A_BETTER', 'sha256:input-2')],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'COMPARISON_INPUT_DIGEST_CONFLICT')).toBe(true);
    // An arbitration record cannot rescue a unit whose inputs never formed
    // one frozen comparison (B2 covers binding; here the unit stops early).
  });

  it('judgment-record evidenceRefs strings never substitute for the pre-registered bindings (string equality is necessary, never sufficient)', () => {
    const a1 = { ...unit({ caseId: 'case-1', scenarioId: 'SC1' }), candidateTrajectoryRef: null, referenceTrajectoryRef: null, expectationRef: null };
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const merged = mergeJudgments({
      plan,
      judgments: [{ ...record('j1', key, 'A_BETTER'), evidenceRefs: [`traj-cand-case-1`, `traj-ref-case-1`, `exp-case-1`] }],
      blindmap: { map: { j1: { A: 'candidate', B: 'reference' } } },
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('EVIDENCE_BINDING_INCOMPLETE');
    // The collected refs are still preserved for audit, but they do not
    // upgrade the unit. Round-3 rectification: audit lists are emitted in
    // deterministic sorted order so that input permutation cannot change
    // any emitted value (same three refs, sorted).
    expect(merged.finalComparisons[0].evidenceRefs).toEqual(['exp-case-1', 'traj-cand-case-1', 'traj-ref-case-1']);
  });
});

// ---------------------------------------------------------------------------
// B2 (PR #2696 remediation, 2026-11-17 Owner instruction): attempt / exchange
// / arbitration binding. Five distinct layers: (1) pre-registered Judge Slot
// (judgeSlotId), (2) A-B display exchange (blindmap identity mapping per
// record), (3) model invocation Attempt (attempt), (4) failed technical retry
// (a further attempt of the same slot; its recovery policy is T7a), (5) the
// final valid Judgment (one participating record after dedup + validation).
// Votes come from valid judge slots after (judgeSlotId, attempt) dedup, never
// from raw record counts; a missing attempt is never defaulted to 1; a
// duplicate persistence of one attempt never votes twice; distinct judges
// legally share attempt=1; arbitration must bind every participating record
// and their comparison-input digests.
// ---------------------------------------------------------------------------

describe('B2 attempt/exchange/arbitration binding (PR #2696 remediation)', () => {
  function rec(id: string, assignmentKey: string, displayVerdict: string, extra: Record<string, unknown> = {}) {
    return {
      judgmentId: id,
      assignmentKey,
      judgeProtocolRef: 'jp-test@1',
      comparisonInputDigest: 'sha256:frozen',
      displayVerdict,
      attempt: 1,
      judgeSlotId: `slot-${id}`,
      ...extra,
    };
  }

  function blindmapFor(...ids: string[]) {
    const map: Record<string, { A: string; B: string }> = {};
    for (const id of ids) {
      map[id] = { A: 'candidate', B: 'reference' };
    }
    return { map };
  }

  it('attempt missing is never defaulted to 1: the unit stays UNKNOWN with ATTEMPT_MISSING (fail loud)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const judgments = [{ judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen', displayVerdict: 'A_BETTER', judgeSlotId: 'slot-1' }];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1') });
    expect(merged.problems).toEqual([]); // unverified evidence, not corruption
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('ATTEMPT_MISSING');
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'ATTEMPT_MISSING')).toBe(true);
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
  });

  it('the same (judgeSlotId, attempt) persisted under two judgmentIds votes once (DUPLICATE_ATTEMPT_RECORD), not twice', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [
      rec('j1', key, 'A_BETTER'),
      rec('j2', key, 'A_BETTER', { judgeSlotId: 'slot-j1' }), // double persistence of slot-j1 attempt 1
      rec('j3', key, 'A_BETTER', { judgeSlotId: 'slot-j3' }),
    ];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1', 'j3') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER'); // resolved by the two valid votes
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'DUPLICATE_ATTEMPT_RECORD')).toBe(true);
    const dup = merged.evidenceProblems.find((p: { code: string }) => p.code === 'DUPLICATE_ATTEMPT_RECORD');
    expect(dup.detail.groups).toEqual([{ judgeSlotId: 'slot-j1', attempt: 1, kept: 'j1', dropped: ['j2'] }]);
    // judgmentRefs keeps the full audit trail; the duplicate simply did not vote.
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['j1', 'j2', 'j3']);
    // and a double-persisted pair alone cannot satisfy requiredJudgments=2:
    const mergedShort = mergeJudgments({
      plan,
      judgments: [rec('j1', key, 'A_BETTER'), rec('j2', key, 'A_BETTER', { judgeSlotId: 'slot-j1' })],
      blindmap: blindmapFor('j1'),
    });
    expect(mergedShort.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(mergedShort.finalComparisons[0].reasonCode).toBe('DUPLICATE_ATTEMPT_RECORD');
  });

  it('different judges legally sharing attempt=1 pass as independent votes (distinct frozen slots)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [rec('j1', key, 'A_BETTER', { judgeSlotId: 'slot-A' }), rec('j2', key, 'A_BETTER', { judgeSlotId: 'slot-B' })];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.finalComparisons[0].resolvedBy).toBe('CONSISTENT_JUDGMENTS');
  });

  it('judgeSlotId missing leaves slot independence unverifiable: unit UNKNOWN (historical format degraded, never fabricated)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const judgments = [{ judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen', displayVerdict: 'A_BETTER', attempt: 1 }];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('JUDGE_SLOT_BINDING_MISSING');
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'JUDGE_SLOT_BINDING_MISSING')).toBe(true);
  });

  it('attempt history can never pad the electorate: same slot with agreeing attempts 1 and 2 is ONE seat (round-3 semantics), while distinct extra slots still exceed the protocol', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    // Round-3 mapping record: the former expectation (attempts 1+2 -> 2
    // participating records -> JUDGMENT_COUNT_EXCEEDED) encoded exactly the
    // defect-A semantics being fixed - attempt numbers grew the seat count.
    // Under the corrected rule one judge slot contributes at most one seat,
    // so the agreeing retry pair satisfies requiredJudgments=1 and is
    // disclosed as MULTI_ATTEMPT_AGREEMENT; it is never counted as two.
    const agreeing = [rec('j1', key, 'A_BETTER', { judgeSlotId: 'slot-A', attempt: 1 }), rec('j2', key, 'A_BETTER', { judgeSlotId: 'slot-A', attempt: 2 })];
    const merged = mergeJudgments({ plan, judgments: agreeing, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'MULTI_ATTEMPT_AGREEMENT')).toBe(true);
    const agreement = merged.evidenceProblems.find((p: { code: string }) => p.code === 'MULTI_ATTEMPT_AGREEMENT');
    expect(agreement.detail.groups).toEqual([{ judgeSlotId: 'slot-A', attempts: [1, 2], kept: 'j1', dropped: ['j2'] }]);

    // Over-voting across genuinely distinct slots remains structural
    // corruption: seats, not records, are counted against the protocol.
    const plan2 = makePlan([a1], { requiredJudgments: 2 });
    const threeSlots = [rec('j1', key, 'A_BETTER', { judgeSlotId: 'slot-A' }), rec('j2', key, 'A_BETTER', { judgeSlotId: 'slot-B' }), rec('j3', key, 'A_BETTER', { judgeSlotId: 'slot-C' })];
    const merged2 = mergeJudgments({ plan: plan2, judgments: threeSlots, blindmap: blindmapFor('j1', 'j2', 'j3') });
    expect(merged2.problems.some((p: { code: string }) => p.code === 'JUDGMENT_COUNT_EXCEEDED')).toBe(true);
    expect(merged2.finalComparisons[0].reasonCode).toBe('JUDGMENT_COUNT_EXCEEDED');
    expect(merged2.finalComparisons[0].verdict).toBe('UNKNOWN');
  });

  it('arbitration must bind every participating record AND their comparison-input digests', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const conflicting = [rec('j1', key, 'A_BETTER'), rec('j2', key, 'B_BETTER', { judgeSlotId: 'slot-j2' })];
    const blindmap = blindmapFor('j1', 'j2');

    // No digest binding at all: malformed arbitration record (CONTRACT 5.2
    // step 5 requires binding input versions), never silently adopted.
    const noDigests = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], verdict: 'TIE' }],
      blindmap,
    });
    expect(noDigests.problems.some((p: { code: string }) => p.code === 'INVALID_ARBITRATION_RECORD')).toBe(true);
    expect(noDigests.finalComparisons[0].verdict).toBe('UNKNOWN');

    // Digests bound and matching: adopted.
    const adopted = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], boundComparisonInputDigests: ['sha256:frozen'], verdict: 'TIE' }],
      blindmap,
    });
    expect(adopted.problems).toEqual([]);
    expect(adopted.finalComparisons[0].verdict).toBe('TIE');
    expect(adopted.finalComparisons[0].resolvedBy).toBe('BLIND_ARBITRATION');

    // The records' comparison input changed after the arbitration was made
    // (both records re-judged on a new frozen input): the old arbitration no
    // longer binds the participating records' input versions - stale,
    // invalid, re-verification required.
    const stale = mergeJudgments({
      plan,
      judgments: [rec('j1', key, 'A_BETTER', { comparisonInputDigest: 'sha256:frozen-v2' }), rec('j2', key, 'B_BETTER', { judgeSlotId: 'slot-j2', comparisonInputDigest: 'sha256:frozen-v2' })],
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], boundComparisonInputDigests: ['sha256:frozen'], verdict: 'TIE' }],
      blindmap,
    });
    expect(stale.problems).toEqual([]);
    expect(stale.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(stale.finalComparisons[0].reasonCode).toBe('ARBITRATION_INCOMPLETE_BINDING');

    // One participating record missing from the binding: incomplete.
    const incomplete = mergeJudgments({
      plan,
      judgments: conflicting,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1'], boundComparisonInputDigests: ['sha256:frozen'], verdict: 'TIE' }],
      blindmap,
    });
    expect(incomplete.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(incomplete.finalComparisons[0].reasonCode).toBe('ARBITRATION_INCOMPLETE_BINDING');
  });

  it('a digest-conflicted unit never reaches arbitration, even with a well-formed arbitration record', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [
      rec('j1', key, 'A_BETTER', { comparisonInputDigest: 'sha256:input-1' }),
      rec('j2', key, 'B_BETTER', { judgeSlotId: 'slot-j2', comparisonInputDigest: 'sha256:input-2' }),
    ];
    const merged = mergeJudgments({
      plan,
      judgments,
      arbitrations: [{ arbitrationId: 'arb1', assignmentKey: key, boundJudgmentIds: ['j1', 'j2'], boundComparisonInputDigests: ['sha256:input-1', 'sha256:input-2'], verdict: 'CANDIDATE_BETTER' }],
      blindmap: blindmapFor('j1', 'j2'),
    });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.finalComparisons[0].resolvedBy).toBe('UNRESOLVED');
  });
});

// ---------------------------------------------------------------------------
// B3 (PR #2696 remediation, 2026-11-17 Owner instruction): formal ranking
// eligibility is independent of the computable status. Three concepts stay
// separated: (1) computable status ESTIMABLE/BOUNDED_ONLY/INVALID, (2)
// formal ranking eligibility rankingEligible, (3) the descriptive
// CHANGE_VS_BASELINE decision IMPROVED/REGRESSION/INCONCLUSIVE. Owner
// promotion is a governance-gate decision and appears in none of them. At
// T4 the formal qualification credentials (judge calibration, frozen
// analysis policy, minimum independent source groups, version
// comparability, research admission status, source-group independence
// evidence) do not exist, so rankingEligible defaults to false and the
// rankingQualification block honestly discloses every unmet criterion.
// ---------------------------------------------------------------------------

describe('B3 ranking eligibility separation (PR #2696 remediation)', () => {
  const BASE_UNMET_CRITERIA = [
    'JUDGE_CALIBRATION_NOT_VERIFIED',
    'ANALYSIS_POLICY_BOOTSTRAP_NOT_FROZEN',
    'MINIMUM_INDEPENDENT_SOURCE_GROUPS_NOT_PREREGISTERED',
    'VERSION_COMPARABILITY_NOT_VERIFIED',
    'RESEARCH_ADMISSION_NOT_VERIFIED',
    'SOURCE_GROUP_INDEPENDENCE_NOT_VERIFIED',
    // Round-3 rectification: without a plan-level judgeSlots registry the
    // report cannot claim preregistered independent judge seats. (Full
    // slot registration belongs to T7a; CONTRACT 5.2a.)
    'JUDGE_SLOT_REGISTRATION_UNVERIFIED',
  ];

  it('an ESTIMABLE report no longer claims ranking eligibility; the qualification block names every unmet criterion', () => {
    const { report } = nGroupFixture(2, (g) => (g === 1 ? W : L));
    expect(report.status).toBe('ESTIMABLE'); // only: every planned unit has a computable point value
    expect(report.pointEstimate).toBe(50);
    expect(report.missingBounds).toEqual({ lower: 50, upper: 50 });
    expect(report.rankingEligible).toBe(false);
    expect(report.rankingQualification.eligible).toBe(false);
    for (const criterion of BASE_UNMET_CRITERIA) {
      expect(report.rankingQualification.unmetCriteria).toContain(criterion);
    }
    expect(report.rankingQualification.unmetCriteria).not.toContain('SOURCE_GROUP_RATIONALE_MISSING'); // rationales present in this fixture
    // Interval honesty belongs to the same disclosure.
    expect(report.samplingInterval.status).toBe('NOT_ESTIMABLE');
    expect(report.samplingInterval.reason).toBe('ANALYSIS_POLICY_BOOTSTRAP_NOT_FROZEN_OFFLINE');
  });

  it('the descriptive CHANGE_VS_BASELINE decision still runs independently of eligibility (SC-13 shape: IMPROVED is not a ranking promotion)', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 12 ? W : L));
    expect(report.status).toBe('ESTIMABLE');
    expect(report.rankingEligible).toBe(false);
    expect(report.rankingQualification.eligible).toBe(false);
    expect(report.decision).not.toBe(null);
    if (!report.decision) return;
    expect(report.decision.outcome).toBe('IMPROVED');
    expect(report.decision.threshold).toBe(12);
    expect(report.decision.definiteWins).toBe(12);
  });

  it('BOUNDED_ONLY and INVALID reports are never ranking-eligible either, with honest qualification disclosure', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const bounded = reportFor([a1, a2], [finalComparison(a1, W)]);
    expect(bounded.status).toBe('BOUNDED_ONLY');
    expect(bounded.rankingEligible).toBe(false);
    expect(bounded.rankingQualification.eligible).toBe(false);
    expect(bounded.rankingQualification.unmetCriteria.length).toBeGreaterThan(0);

    const invalid = reportFor([a1], [finalComparison(a1, W), finalComparison(a1, W)]);
    expect(invalid.status).toBe('INVALID');
    expect(invalid.rankingEligible).toBe(false);
    expect(invalid.rankingQualification.eligible).toBe(false);
    expect(invalid.rankingQualification.unmetCriteria).toContain('REPORT_STATUS_INVALID');
  });
});

// ---------------------------------------------------------------------------
// B4 (PR #2696 remediation): canonical digest strictness per CONTRACT 1.1.
// Undefined-valued keys, NaN/Infinity, functions and symbols are not legal
// JSON values: they are rejected with a typed error instead of being
// silently canonicalized into a different object. Key order never matters,
// array order always matters, identical input digests stably. No audited
// stricter canonicalization existed in the repository to reuse (the other
// canonicalJson implementations either drop undefined keys or emit them
// verbatim), so the module owns this strict version. T4 has no historical
// digest semantics to preserve, so tightening is safe; no CLI consumer is
// affected because JSON-parsed input cannot contain these values.
// ---------------------------------------------------------------------------

describe('B4 canonical digest strictness (PR #2696 remediation)', () => {
  function reportInputWith(plan: Record<string, unknown>) {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    return {
      plan,
      finalComparisons: [finalComparison(a1, W)],
      sourceGroups: sourceGroupsFor([a1]),
    };
  }

  function catchError(run: () => unknown): Error {
    let caught: unknown = null;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBe(null);
    return caught as Error;
  }

  it('an undefined-valued key is rejected with a typed error, not silently dropped from the canonical form', () => {
    const plan = makePlan([unit({ caseId: 'case-1', scenarioId: 'SC1' })]) as Record<string, unknown>;
    (plan as { ghost?: unknown }).ghost = undefined; // invisible to JSON.parse, present in memory
    const error = catchError(() => buildAlignmentReport(reportInputWith(plan)));
    expect(error.name).toBe('CanonicalJsonError');
    expect(error.message).toContain('undefined');
  });

  it('NaN and Infinity are rejected as non-finite JSON values', () => {
    const nanPlan = makePlan([unit({ caseId: 'case-1', scenarioId: 'SC1' })]) as Record<string, unknown>;
    (nanPlan as { annotation?: unknown }).annotation = Number.NaN;
    const nanError = catchError(() => buildAlignmentReport(reportInputWith(nanPlan)));
    expect(nanError.name).toBe('CanonicalJsonError');

    const infPlan = makePlan([unit({ caseId: 'case-1', scenarioId: 'SC1' })]) as Record<string, unknown>;
    (infPlan as { annotation?: unknown }).annotation = Number.POSITIVE_INFINITY;
    const infError = catchError(() => buildAlignmentReport(reportInputWith(infPlan)));
    expect(infError.name).toBe('CanonicalJsonError');
  });

  it('functions and symbols are rejected as illegal JSON values', () => {
    const fnPlan = makePlan([unit({ caseId: 'case-1', scenarioId: 'SC1' })]) as Record<string, unknown>;
    (fnPlan as { annotation?: unknown }).annotation = () => 'nope';
    const fnError = catchError(() => buildAlignmentReport(reportInputWith(fnPlan)));
    expect(fnError.name).toBe('CanonicalJsonError');

    const symPlan = makePlan([unit({ caseId: 'case-1', scenarioId: 'SC1' })]) as Record<string, unknown>;
    (symPlan as { annotation?: unknown }).annotation = Symbol('nope');
    const symError = catchError(() => buildAlignmentReport(reportInputWith(symPlan)));
    expect(symError.name).toBe('CanonicalJsonError');
  });

  it('key insertion order never changes the digest; nested key order neither', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const ordered = makePlan([a1]);
    const scrambled = {
      assignments: [{ scenarioId: 'SC1', referenceId: a1.referenceId, repetitionId: a1.repetitionId, opportunityId: a1.opportunityId, caseVersion: a1.caseVersion, caseId: a1.caseId, candidateConfigId: a1.candidateConfigId, candidateTrajectoryRef: a1.candidateTrajectoryRef, referenceTrajectoryRef: a1.referenceTrajectoryRef, expectationRef: a1.expectationRef }],
      scenarios: ordered.scenarios,
      owners: ordered.owners,
      judgeProtocol: ordered.judgeProtocol,
      judgeProtocolRef: ordered.judgeProtocolRef,
      comparisonDesign: ordered.comparisonDesign,
      benchmarkVersion: ordered.benchmarkVersion,
      benchmarkId: ordered.benchmarkId,
      schemaVersion: ordered.schemaVersion,
      analysisPolicy: { alpha: 0.05 },
    };
    const fromOrdered = buildAlignmentReport({ plan: ordered, finalComparisons: [finalComparison(a1, W)], sourceGroups: sourceGroupsFor([a1]) });
    const fromScrambled = buildAlignmentReport({ plan: scrambled, finalComparisons: [finalComparison(a1, W)], sourceGroups: sourceGroupsFor([a1]) });
    expect(fromScrambled.status).toBe('ESTIMABLE');
    expect(fromScrambled.bindings.planDigest).toBe(fromOrdered.bindings.planDigest);
    expect(fromScrambled.bindings.comparisonsDigest).toBe(fromOrdered.bindings.comparisonsDigest);
  });

  it('array order is preserved as significant: reordered comparison records change the digest but not the score', () => {
    const assignments = [
      unit({ caseId: 'case-1', scenarioId: 'SC1' }),
      unit({ caseId: 'case-2', scenarioId: 'SC1' }),
      unit({ caseId: 'case-3', scenarioId: 'SC1' }),
    ];
    const comparisons = [finalComparison(assignments[0], W), finalComparison(assignments[1], T), finalComparison(assignments[2], L)];
    const forward = buildAlignmentReport({ plan: makePlan(assignments), finalComparisons: comparisons, sourceGroups: sourceGroupsFor(assignments) });
    const reordered = buildAlignmentReport({ plan: makePlan(assignments), finalComparisons: [...comparisons].reverse(), sourceGroups: sourceGroupsFor(assignments) });
    expect(forward.pointEstimate).toBe(reordered.pointEstimate);
    expect(forward.bindings.comparisonsDigest).not.toBe(reordered.bindings.comparisonsDigest);
  });
});

// ---------------------------------------------------------------------------
// B5 (PR #2696 remediation): source-group rationale evidence. Structural
// validity of the mapping stays as-is (SC-12/SC-19); what B5 adds is the
// separation between structural validity and independence EVIDENCE: a
// source-group mapping without published grouping rationales is not
// formally confirmable evidence. The offline computation stays runnable
// (synthetic SC fixtures keep every number), the condition is disclosed
// in rankingQualification (rankingEligible=false already bars formal
// conclusions), per-session independence itself stays the upstream T7a
// admission responsibility (declared via SOURCE_GROUP_INDEPENDENCE_NOT_
// VERIFIED), and no logic may ever re-interpret the frozen 14 groups as
// 16 independent samples.
// ---------------------------------------------------------------------------

describe('B5 source group rationale evidence (PR #2696 remediation)', () => {
  it('a mapping without rationales stays computable but discloses SOURCE_GROUP_RATIONALE_MISSING with the affected groups named', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const report = buildAlignmentReport({
      plan: makePlan([a1, a2]),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, L)],
      sourceGroups: { groups: { 'case-1': 'sg-1', 'case-2': 'sg-2' } }, // no rationales at all
    });
    // Structure valid, offline numbers unchanged:
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    expect(report.problems).toEqual([]);
    // Evidence gap disclosed, groups named:
    expect(report.rankingQualification.unmetCriteria).toContain('SOURCE_GROUP_RATIONALE_MISSING');
    expect(report.rankingQualification.rationaleMissingGroups).toEqual(['sg-1', 'sg-2']);
    expect(report.rankingEligible).toBe(false);
  });

  it('empty or whitespace-only rationales count as missing; partially covered groups are named individually', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const emptyStrings = buildAlignmentReport({
      plan: makePlan([a1, a2]),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, L)],
      sourceGroups: { groups: { 'case-1': 'sg-1', 'case-2': 'sg-2' }, rationales: { 'sg-1': '', 'sg-2': '   ' } },
    });
    expect(emptyStrings.rankingQualification.unmetCriteria).toContain('SOURCE_GROUP_RATIONALE_MISSING');
    expect(emptyStrings.rankingQualification.rationaleMissingGroups).toEqual(['sg-1', 'sg-2']);

    const partial = buildAlignmentReport({
      plan: makePlan([a1, a2]),
      finalComparisons: [finalComparison(a1, W), finalComparison(a2, L)],
      sourceGroups: { groups: { 'case-1': 'sg-1', 'case-2': 'sg-2' }, rationales: { 'sg-1': 'documented same-session merge' } },
    });
    expect(partial.rankingQualification.unmetCriteria).toContain('SOURCE_GROUP_RATIONALE_MISSING');
    expect(partial.rankingQualification.rationaleMissingGroups).toEqual(['sg-2']);
  });

  it('complete rationales produce no rationale criterion, and synthetic decision fixtures stay computable (SC-13 shape)', () => {
    const { report } = nGroupFixture(14, (g) => (g <= 12 ? W : L));
    expect(report.rankingQualification.unmetCriteria).not.toContain('SOURCE_GROUP_RATIONALE_MISSING');
    expect(report.rankingQualification.rationaleMissingGroups).toBeUndefined();
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBeCloseTo(85.7143, 3);
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.outcome).toBe('IMPROVED');
  });
});

// ---------------------------------------------------------------------------
// B6 (PR #2696 remediation): decision.groups[] is a derived diagnostic
// detail, not an independent statistical result. Owner-visible audit field:
// every group's [lower_g, upper_g], containsUnknown and classification must
// be independently recomputable from the plan + FinalComparison records via
// the CONTRACT 6.1 aggregation (UNKNOWN units contribute [0, 1]).
// ---------------------------------------------------------------------------

describe('B6 decision.groups derived diagnostic (PR #2696 remediation)', () => {
  it('decision.groups[] can be recomputed independently from the plan + FinalComparison records', () => {
    // sg-1: two units (win + UNKNOWN) in two opportunities of one case.
    // sg-2: one losing unit. sg-3: one tie unit.
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-1' });
    const a2 = unit({ caseId: 'case-1', scenarioId: 'SC1', repetitionId: 'rep-2' });
    const a3 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const a4 = unit({ caseId: 'case-3', scenarioId: 'SC1' });
    const assignments = [a1, a2, a3, a4];
    const comparisons = [finalComparison(a1, W), finalComparison(a3, L), finalComparison(a4, T)]; // a2 unjudged -> UNKNOWN
    const report = buildAlignmentReport({
      plan: makePlan(assignments, { design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: comparisons,
      sourceGroups: sourceGroupsFor(assignments),
    });
    if (!report.decision) throw new Error('decision missing');

    // Independent recomputation (test-side implementation of CONTRACT 6.1
    // trial->opportunity->case->group means with UNKNOWN -> [0, 1]).
    const value = (verdict: string) => (verdict === 'CANDIDATE_BETTER' ? 1 : verdict === 'TIE' ? 0.5 : verdict === 'REFERENCE_BETTER' ? 0 : null);
    const verdictByKey = new Map(comparisons.map((comparison) => [comparison.assignmentKey, comparison.verdict] as const));
    const trialNode = (assignment: ReturnType<typeof unit>) => {
      const v = value(verdictByKey.get(keyOf(assignment)) ?? null);
      return { lower: v === null ? 0 : v, upper: v === null ? 1 : v, unknown: v === null };
    };
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
    const groupOf = (caseId: string) => `sg-${caseId}`;
    const recomputed = ['case-1', 'case-2', 'case-3'].map((caseId) => {
      const caseAssignments = assignments.filter((assignment) => assignment.caseId === caseId);
      const trialNodes = caseAssignments.map(trialNode);
      const lower = mean(trialNodes.map((node) => node.lower));
      const upper = mean(trialNodes.map((node) => node.upper));
      const containsUnknown = trialNodes.some((node) => node.unknown);
      const classification = lower > 0.5 ? 'DEFINITE_WIN' : upper < 0.5 ? 'DEFINITE_LOSS' : 'UNDETERMINED';
      return {
        sourceGroupId: groupOf(caseId),
        scenarioId: 'SC1',
        plannedUnits: caseAssignments.length,
        lower_g: lower,
        upper_g: upper,
        containsUnknown,
        classification,
      };
    });
    expect(recomputed).toEqual(report.decision.groups);
    expect(report.decision.groups[0].classification).toBe('UNDETERMINED');
    expect(report.decision.groups[0].containsUnknown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-3 rectification (PR #2696): Judge Slot / Attempt Integrity.
// Owner instruction 2026-11-17 (third round). Frozen semantics (CONTRACT
// 5.2a): the Judge Slot is the vote unit and requiredJudgments counts valid,
// independent slots ("seats"), never raw records; attempts are one slot's
// invocation history and can never grow the seat count; binding/conflict
// checks run on the RAW candidate set BEFORE any dedup and conflicting
// records are never resolved by judgmentId, timestamp, attempt number or
// file order - they gate the unit to UNKNOWN and stay in the audit trail.
// ---------------------------------------------------------------------------

describe('Judge Slot / Attempt Integrity (round-3 rectification)', () => {
  function slotRecord(id: string, assignmentKey: string, judgeSlotId: string, attempt: number, displayVerdict = 'A_BETTER', extra: Record<string, unknown> = {}) {
    return {
      judgmentId: id,
      assignmentKey,
      judgeProtocolRef: 'jp-test@1',
      comparisonInputDigest: 'sha256:frozen',
      displayVerdict,
      attempt,
      judgeSlotId,
      ...extra,
    };
  }

  function blindmapFor(...ids: string[]) {
    const map: Record<string, { A: string; B: string }> = {};
    for (const id of ids) {
      map[id] = { A: 'candidate', B: 'reference' };
    }
    return { map };
  }

  it('seat table 1: one slot, one valid attempt -> exactly 1 seat (requiredJudgments=1 resolves; 2 does not)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('j1', key, 'slot-A', 1)];

    const required1 = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments, blindmap: blindmapFor('j1') });
    expect(required1.problems).toEqual([]);
    expect(required1.evidenceProblems).toHaveLength(0); // no disclosure: nothing was consolidated
    expect(required1.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');

    // Seat boundary (EP-09.5): one seat against requiredJudgments=2 is a
    // shortfall -> UNKNOWN MISSING_JUDGMENTS, never a verdict.
    const required2 = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 2 }), judgments, blindmap: blindmapFor('j1') });
    expect(required2.problems).toEqual([]);
    expect(required2.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(required2.finalComparisons[0].reasonCode).toBe('MISSING_JUDGMENTS');
  });

  it('seat table 2: slot-A attempts 1+2 (agreeing) -> at most 1 seat; cannot satisfy requiredJudgments=2 and cannot produce CANDIDATE_BETTER (12)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('j1', key, 'slot-A', 1), slotRecord('j2', key, 'slot-A', 2)];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 2 }), judgments, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN'); // 1 seat < 2 required
    expect(merged.finalComparisons[0].reasonCode).toBe('MULTI_ATTEMPT_AGREEMENT');
    const report = buildAlignmentReport({
      plan: makePlan([a1], { requiredJudgments: 2, design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    // 13: a seat shortfall never becomes a fake definite conclusion.
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
    if (!report.decision) throw new Error('decision missing');
    expect(report.decision.groups[0].classification).toBe('UNDETERMINED');
    expect(report.decision.groups[0].containsUnknown).toBe(true);
    expect(report.decision.outcome).toBe('INCONCLUSIVE');
    expect(report.decision.definiteWins).toBe(0);
  });

  it('seat table 3: slot-A with two conflicting attempt-1 records -> 0 seats and the unit stays UNKNOWN (6: verdict conflict)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('a-keep', key, 'slot-A', 1, 'A_BETTER'), slotRecord('z-conflict', key, 'slot-A', 1, 'B_BETTER')];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments, blindmap: blindmapFor('a-keep', 'z-conflict') });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('CONFLICTING_ATTEMPT_RECORDS');
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('CONFLICTING_ATTEMPT_RECORDS');
    // No selection priority: neither record was picked, both stay named.
    expect(merged.evidenceProblems[0].detail.records.map((r: { judgmentId: string }) => r.judgmentId)).toEqual(['a-keep', 'z-conflict']);
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['a-keep', 'z-conflict']);
    // The evidence problem carries the assignment key and is disclosed once.
    expect(merged.evidenceProblems[0].assignmentKey).toBe(key);
  });

  it('seat table 4: slot-A + slot-B preregistered in the plan -> 2 seats, verdict computed, registration criterion satisfied (8)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const plan = makePlan([a1], { requiredJudgments: 2, judgeSlots: ['slot-A', 'slot-B'] });
    const judgments = [slotRecord('j1', key, 'slot-A', 1), slotRecord('j2', key, 'slot-B', 1)];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(0);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.finalComparisons[0].resolvedBy).toBe('CONSISTENT_JUDGMENTS');
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(100);
    // The minimal preregistration credential exists, so the report does not
    // flag slot registration; every other T4 criterion stays unmet.
    expect(report.rankingQualification.unmetCriteria).not.toContain('JUDGE_SLOT_REGISTRATION_UNVERIFIED');
    expect(report.rankingEligible).toBe(false); // never relaxed
  });

  it('7: different slot strings without any registry cannot claim independent preregistered seats - the report discloses JUDGE_SLOT_REGISTRATION_UNVERIFIED (merge verdict stays descriptive; rankingEligible stays false)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const plan = makePlan([a1], { requiredJudgments: 2 }); // no judgeSlots registry
    const judgments = [slotRecord('j1', key, 'slot-XYZ-1', 1), slotRecord('j2', key, 'slot-XYZ-2', 1)];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER'); // descriptive only
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.rankingQualification.unmetCriteria).toContain('JUDGE_SLOT_REGISTRATION_UNVERIFIED');
    expect(report.rankingEligible).toBe(false);
    expect(report.rankingQualification.eligible).toBe(false);
  });

  it('with a registry, a vote from a slot outside the preregistered seats gates the unit (JUDGE_SLOT_NOT_PREREGISTERED)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const plan = makePlan([a1], { requiredJudgments: 1, judgeSlots: ['slot-A'] });
    const judgments = [slotRecord('j1', key, 'slot-IMPOSTOR', 1)];
    const merged = mergeJudgments({ plan, judgments, blindmap: blindmapFor('j1') });
    expect(merged.problems).toEqual([]); // evidence problem, not run corruption
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('JUDGE_SLOT_NOT_PREREGISTERED');
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('JUDGE_SLOT_NOT_PREREGISTERED');
    // The healthy counterpart still resolves.
    const healthy = mergeJudgments({ plan, judgments: [slotRecord('j1', key, 'slot-A', 1)], blindmap: blindmapFor('j1') });
    expect(healthy.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
  });

  it('a malformed judgeSlots registry is a plan structural problem (INVALID), not a silent default', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1, judgeSlots: ['slot-A', 'slot-A'] }); // duplicate id
    const key = keyOf(a1);
    const merged = mergeJudgments({ plan, judgments: [slotRecord('j1', key, 'slot-A', 1)], blindmap: blindmapFor('j1') });
    expect(merged.problems.some((p: { code: string }) => p.code === 'INVALID_PLAN_FIELD')).toBe(true);
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
    });
    expect(report.status).toBe('INVALID');
    expect(report.pointEstimate).toBe(null);
  });

  it('3: declared-failed attempt + successful retry recover legally per the frozen CONTRACT 5.2a rule (per-attempt assertions)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [
      slotRecord('j1', key, 'slot-A', 1, 'A_BETTER', { attemptStatus: 'FAILED' }),
      slotRecord('j2', key, 'slot-A', 2, 'A_BETTER', { attemptStatus: 'SUCCEEDED' }),
    ];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments, blindmap: blindmapFor('j2') });
    expect(merged.problems).toEqual([]);
    // Per-attempt evidence: attempt 1 excluded by its declared FAILED status,
    // attempt 2 is the slot's single surviving candidate and votes.
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('ATTEMPT_FAILED_EXCLUDED');
    expect(merged.evidenceProblems[0].detail.excluded).toEqual([{ judgmentId: 'j1', attempt: 1 }]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['j1', 'j2']);
    // A slot whose every attempt declared FAILED has no candidate and no seat.
    const allFailed = [
      slotRecord('j1', key, 'slot-A', 1, 'A_BETTER', { attemptStatus: 'FAILED' }),
      slotRecord('j2', key, 'slot-A', 2, 'B_BETTER', { attemptStatus: 'FAILED' }),
    ];
    const mergedFailed = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments: allFailed, blindmap: blindmapFor('j1', 'j2') });
    expect(mergedFailed.problems).toEqual([]);
    expect(mergedFailed.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(mergedFailed.finalComparisons[0].reasonCode).toBe('ATTEMPT_FAILED_EXCLUDED');
  });

  it('3 negative: without an authoritative status, two differing successful attempts are never auto-preferred - the slot cannot prove its final attempt (2)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('j1', key, 'slot-A', 1, 'A_BETTER'), slotRecord('j2', key, 'slot-A', 2, 'B_BETTER')];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments, blindmap: blindmapFor('j1', 'j2') });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('CONFLICTING_ATTEMPT_RECORDS');
    expect(merged.evidenceProblems[0].detail.records).toEqual([
      { judgmentId: 'j1', attempt: 1, attemptStatus: null, comparisonInputDigest: 'sha256:frozen', displayVerdict: 'A_BETTER' },
      { judgmentId: 'j2', attempt: 2, attemptStatus: null, comparisonInputDigest: 'sha256:frozen', displayVerdict: 'B_BETTER' },
    ]);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('CONFLICTING_ATTEMPT_RECORDS');
  });

  it('4: identical duplicate persistence of one (slot, attempt) is idempotent - one vote, deterministic representative, disclosure (kept/dropped)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('j2', key, 'slot-A', 1), slotRecord('j1', key, 'slot-A', 1), slotRecord('j3', key, 'slot-B', 1)];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 2 }), judgments, blindmap: blindmapFor('j1', 'j2', 'j3') });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0].verdict).toBe('CANDIDATE_BETTER');
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('DUPLICATE_ATTEMPT_RECORD');
    // Input order cannot influence the representative: smallest judgmentId.
    expect(merged.evidenceProblems[0].detail.groups).toEqual([{ judgeSlotId: 'slot-A', attempt: 1, kept: 'j1', dropped: ['j2'] }]);
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['j1', 'j2', 'j3']);
  });

  it('5: same slot/attempt with differing comparisonInputDigest conflicts on the RAW set before dedup - no vote, disclosed, nothing dropped', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [slotRecord('a-keep', key, 'slot-A', 1, 'A_BETTER', { comparisonInputDigest: 'sha256:input-1' }), slotRecord('z-conflict', key, 'slot-A', 1, 'A_BETTER', { comparisonInputDigest: 'sha256:input-2' })];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 2 }), judgments, blindmap: blindmapFor('a-keep', 'z-conflict') });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.evidenceProblems[0].detail.digests).toEqual(['sha256:input-1', 'sha256:input-2']);
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['a-keep', 'z-conflict']);
  });

  it('14: a digest conflict really blocks the unit even when another valid seat exists - never "drop one record and continue"', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const judgments = [
      slotRecord('a-keep', key, 'slot-A', 1, 'A_BETTER', { comparisonInputDigest: 'sha256:input-1' }),
      slotRecord('z-conflict', key, 'slot-A', 1, 'A_BETTER', { comparisonInputDigest: 'sha256:input-2' }),
      slotRecord('j3', key, 'slot-B', 1, 'A_BETTER'),
    ];
    const merged = mergeJudgments({ plan: makePlan([a1], { requiredJudgments: 1 }), judgments, blindmap: blindmapFor('a-keep', 'z-conflict', 'j3') });
    expect(merged.problems).toEqual([]);
    // The raw-set digest conflict gates the whole unit although slot-B's
    // single valid vote would satisfy requiredJudgments=1: the conflicting
    // evidence is not silently shed to let the remaining seat decide.
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['a-keep', 'j3', 'z-conflict']);
    const report = buildAlignmentReport({
      plan: makePlan([a1], { requiredJudgments: 1, design: 'CHANGE_VS_BASELINE' }),
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
    expect(report.evidenceProblems.map((p: { code: string }) => p.code)).toContain('COMPARISON_INPUT_DIGEST_CONFLICT');
  });

  it('9/10: a missing attempt is never defaulted and gates its slot; an illegal attempt value is a structural invalid record that never counts', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const key = keyOf(a1);
    const missing = mergeJudgments({
      plan: makePlan([a1], { requiredJudgments: 1 }),
      judgments: [slotRecord('j1', key, 'slot-A', 1), slotRecord('j2', key, 'slot-B', 1, 'A_BETTER', { attempt: undefined })],
      blindmap: blindmapFor('j1', 'j2'),
    });
    expect(missing.problems).toEqual([]);
    expect(missing.evidenceProblems).toHaveLength(1);
    expect(missing.evidenceProblems[0].code).toBe('ATTEMPT_MISSING');
    expect(missing.evidenceProblems[0].detail.judgeSlotId).toBe('slot-B');
    expect(missing.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(missing.finalComparisons[0].reasonCode).toBe('ATTEMPT_MISSING');

    const illegal = mergeJudgments({
      plan: makePlan([a1], { requiredJudgments: 1 }),
      judgments: [slotRecord('j1', key, 'slot-A', 0)],
      blindmap: blindmapFor('j1'),
    });
    expect(illegal.problems.some((p: { code: string }) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);
    expect(illegal.invalidRecords).toBe(1);
    expect(illegal.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(illegal.finalComparisons[0].reasonCode).toBe('MISSING_JUDGMENTS'); // the record never entered the count

    const badStatus = mergeJudgments({
      plan: makePlan([a1], { requiredJudgments: 1 }),
      judgments: [slotRecord('j1', key, 'slot-A', 1, 'A_BETTER', { attemptStatus: 'MAYBE' })],
      blindmap: blindmapFor('j1'),
    });
    expect(badStatus.problems.some((p: { code: string }) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);
    expect(badStatus.invalidRecords).toBe(1);
    expect(badStatus.finalComparisons[0].reasonCode).toBe('MISSING_JUDGMENTS');

    const nullStatus = mergeJudgments({
      plan: makePlan([a1], { requiredJudgments: 1 }),
      judgments: [slotRecord('j-null-status', key, 'slot-A', 1, 'A_BETTER', { attemptStatus: null })],
      blindmap: blindmapFor('j-null-status'),
    });
    expect(nullStatus.problems.some((p: { code: string }) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);
    expect(nullStatus.invalidRecords).toBe(1);
    expect(nullStatus.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(nullStatus.finalComparisons[0].reasonCode).toBe('MISSING_JUDGMENTS');
    const invalidReport = buildAlignmentReport({
      plan: makePlan([a1], { requiredJudgments: 1 }),
      finalComparisons: nullStatus.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: nullStatus.problems,
      evidenceProblems: nullStatus.evidenceProblems,
      invalidRecords: nullStatus.invalidRecords,
    });
    expect(invalidReport.status).toBe('INVALID');
    expect(invalidReport.pointEstimate).toBe(null);
  });

  it('11: permutation invariance - every input order of the judgment array produces byte-identical merge results and reports', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const plan = makePlan([a1, a2], { requiredJudgments: 2, design: 'CHANGE_VS_BASELINE' });
    const k1 = keyOf(a1);
    const k2 = keyOf(a2);
    const judgments = [
      slotRecord('j1', k1, 'slot-A', 1),
      slotRecord('j2', k1, 'slot-A', 1), // idempotent duplicate
      slotRecord('j3', k1, 'slot-B', 2, 'A_BETTER', { attemptStatus: 'FAILED' }),
      slotRecord('j4', k1, 'slot-B', 3),
      slotRecord('j5', k2, 'slot-C', 1),
      slotRecord('j6', k2, 'slot-D', 1),
    ];
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' }, j4: { A: 'candidate', B: 'reference' }, j5: { A: 'candidate', B: 'reference' }, j6: { A: 'candidate', B: 'reference' } } };
    const permutations = [
      judgments,
      [judgments[3], judgments[0], judgments[5], judgments[2], judgments[1], judgments[4]],
      [judgments[5], judgments[4], judgments[3], judgments[2], judgments[1], judgments[0]],
      [judgments[2], judgments[5], judgments[1], judgments[4], judgments[0], judgments[3]],
    ];
    const results = permutations.map((order) => mergeJudgments({ plan, judgments: order, blindmap }));
    for (const result of results.slice(1)) {
      expect(result.finalComparisons).toEqual(results[0].finalComparisons);
      expect(result.problems).toEqual(results[0].problems);
      expect(result.evidenceProblems).toEqual(results[0].evidenceProblems);
      expect(result.invalidRecords).toBe(results[0].invalidRecords);
    }
    // unit-1: slot-A idempotent dedup (1 seat) + slot-B failed retry recovery (1 seat) = 2 seats.
    const unit1 = results[0].finalComparisons.find((fc: { assignmentKey: string }) => fc.assignmentKey === k1);
    expect(unit1.verdict).toBe('CANDIDATE_BETTER');
    const unit1Codes = results[0].evidenceProblems.filter((p: { assignmentKey: string }) => p.assignmentKey === k1).map((p: { code: string }) => p.code);
    expect(unit1Codes).toEqual(['ATTEMPT_FAILED_EXCLUDED', 'DUPLICATE_ATTEMPT_RECORD']);
    // unit-2: two distinct slots -> 2 seats, clean.
    const unit2 = results[0].finalComparisons.find((fc: { assignmentKey: string }) => fc.assignmentKey === k2);
    expect(unit2.verdict).toBe('CANDIDATE_BETTER');
    // And the whole report is permutation-invariant too.
    const reports = results.map((result) => buildAlignmentReport({
      plan,
      finalComparisons: result.finalComparisons,
      sourceGroups: sourceGroupsFor([a1, a2]),
      problems: result.problems,
      evidenceProblems: result.evidenceProblems,
      invalidRecords: result.invalidRecords,
    }));
    for (const report of reports.slice(1)) {
      expect(report).toEqual(reports[0]);
    }
  });

  it('judge slot identity layers stay distinct: same slot across DIFFERENT assignments is still one judge, not one merged seat', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const judgments = [
      slotRecord('j1', keyOf(a1), 'slot-shared-judge', 1),
      slotRecord('j2', keyOf(a2), 'slot-shared-judge', 1),
    ];
    const merged = mergeJudgments({
      plan: makePlan([a1, a2], { requiredJudgments: 1 }),
      judgments,
      blindmap: blindmapFor('j1', 'j2'),
    });
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(0); // slot grouping is per assignment
    expect(merged.finalComparisons.map((fc: { verdict: string }) => fc.verdict)).toEqual(['CANDIDATE_BETTER', 'CANDIDATE_BETTER']);
  });
});

// ---------------------------------------------------------------------------
// Round-3 rectification (PR #2696): Judge Slot / Attempt Integrity.
// Phase 1 defect reproductions — these two tests fail against the pre-fix
// head 666e604c8 and pin the corrected semantics.
// ---------------------------------------------------------------------------

describe('Judge Slot / Attempt Integrity defect reproductions (PR #2696 round 3)', () => {
  it('DEFECT-A repro: one judge slot with attempts 1+2 must contribute at most one seat (requiredJudgments=2 stays UNKNOWN, never CANDIDATE_BETTER)', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 2 });
    const key = keyOf(a1);
    const judgments = [
      { judgmentId: 'j1', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen', displayVerdict: 'A_BETTER', attempt: 1, judgeSlotId: 'slot-A' },
      { judgmentId: 'j2', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:frozen', displayVerdict: 'A_BETTER', attempt: 2, judgeSlotId: 'slot-A' },
    ];
    const blindmap = { map: { j1: { A: 'candidate', B: 'reference' }, j2: { A: 'candidate', B: 'reference' } } };
    const merged = mergeJudgments({ plan, judgments, blindmap });
    // Judge Slot is the vote unit; the attempt history of one slot can never
    // grow the effective seat count, so requiredJudgments=2 is unmet.
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.problems).toEqual([]);
    expect(merged.evidenceProblems).toHaveLength(1);
    expect(merged.evidenceProblems[0].code).toBe('MULTI_ATTEMPT_AGREEMENT');
    expect(merged.finalComparisons[0].reasonCode).toBe('MULTI_ATTEMPT_AGREEMENT');
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['j1', 'j2']);
    const report = buildAlignmentReport({
      plan,
      finalComparisons: merged.finalComparisons,
      sourceGroups: sourceGroupsFor([a1]),
      problems: merged.problems,
      evidenceProblems: merged.evidenceProblems,
    });
    expect(report.status).toBe('BOUNDED_ONLY');
    expect(report.pointEstimate).toBe(null);
    expect(report.missingBounds).toEqual({ lower: 0, upper: 100 });
  });

  it('DEFECT-B repro: same slot/attempt records with conflicting digests must block the unit, not silently keep the lexicographically smallest judgmentId', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1 });
    const key = keyOf(a1);
    const judgments = [
      { judgmentId: 'a-keep', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:input-1', displayVerdict: 'A_BETTER', attempt: 1, judgeSlotId: 'slot-A' },
      { judgmentId: 'z-conflict', assignmentKey: key, judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:input-2', displayVerdict: 'B_BETTER', attempt: 1, judgeSlotId: 'slot-A' },
    ];
    const blindmap = { map: { 'a-keep': { A: 'candidate', B: 'reference' }, 'z-conflict': { A: 'candidate', B: 'reference' } } };
    const merged = mergeJudgments({ plan, judgments, blindmap });
    // The conflict is detected on the RAW candidate set BEFORE any dedup:
    // the unit is blocked and both records stay visible in the audit trail.
    expect(merged.finalComparisons[0].verdict).toBe('UNKNOWN');
    expect(merged.finalComparisons[0].reasonCode).toBe('COMPARISON_INPUT_DIGEST_CONFLICT');
    expect(merged.evidenceProblems.some((p: { code: string }) => p.code === 'COMPARISON_INPUT_DIGEST_CONFLICT')).toBe(true);
    expect(merged.finalComparisons[0].judgmentRefs).toEqual(['a-keep', 'z-conflict']);
  });
});

// ---------------------------------------------------------------------------
// Module purity contract (HANDOFF T4): no filesystem, environment or clock.
// ---------------------------------------------------------------------------

describe('alignment-report.mjs purity', () => {
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'pd-lab', 'alignment-report.mjs');

  it('contains no fs / process.env / current-time dependencies', () => {
    const source = fs.readFileSync(modulePath, 'utf8');
    expect(source).not.toMatch(/\bfs\b/);
    expect(source).not.toMatch(/node:fs/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/readFile/);
    expect(source).not.toMatch(/writeFile/);
  });

  it('exports exactly mergeJudgments, buildAlignmentReport and twoSidedThreshold', async () => {
    // PRI-1258: twoSidedThreshold joined the pinned surface as the single
    // statistical authority for k(n, alpha) — the T6 qualification engine
    // reuses it instead of duplicating the exact BigInt tail math. The
    // TECH 3.2 export table is updated in the same change.
    const module = await import('../dev/pd-lab/alignment-report.mjs');
    expect(Object.keys(module).sort()).toEqual(['buildAlignmentReport', 'mergeJudgments', 'twoSidedThreshold']);
  });
});

// ---------------------------------------------------------------------------
// PRI-1252 r4 — TEST-2696-A..H. Exact-rational aggregation, BigInt
// thresholds, candidate identity, evidence-ref binding, sourceGroups digest,
// FAILED-attempt parsing. Expected values cross-checked against an
// INDEPENDENT oracle (exact BigInt binomial tail sums and rational means),
// never against the module under test.
// ---------------------------------------------------------------------------

/** Six-group exact tie: EACH group holds three cases valued 5/6, 3/6, 1/6 →
 *  group mean (5/6+3/6+1/6)/3 = exactly 1/2. Case value = 6 repetitions. */
function sixGroupTieAssignments() {
  const assignments: Array<ReturnType<typeof unit>> = [];
  const comparisons: Array<ReturnType<typeof finalComparison>> = [];
  for (let groupIndex = 0; groupIndex < 6; groupIndex += 1) {
    for (const wins of [5, 3, 1]) {
      const caseId = `case-g${groupIndex}-w${wins}`;
      for (let rep = 1; rep <= 6; rep += 1) {
        const a = unit({ caseId, scenarioId: 'SC1', repetitionId: `rep-${rep}` });
        assignments.push(a);
        comparisons.push(finalComparison(a, rep <= wins ? W : L));
      }
    }
  }
  return { assignments, comparisons, groupOverride: (() => {
    const groups: Record<string, string> = {};
    for (let groupIndex = 0; groupIndex < 6; groupIndex += 1) {
      for (const wins of [5, 3, 1]) {
        groups[`case-g${groupIndex}-w${wins}`] = `sg-${groupIndex}`;
      }
    }
    return groups;
  })() };
}

describe('PRI-1252 r4 — exact statistics (TEST-2696-A/B/C/D)', () => {
  it('TEST-2696-A: six exact-1/2 groups are UNDETERMINED — no float 0.5000000000000001 bias, outcome INCONCLUSIVE', () => {
    const { assignments, comparisons, groupOverride } = sixGroupTieAssignments();
    const report = reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE', alpha: 0.05 }, groupOverride);
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    const decision = report.decision as Record<string, unknown>;
    const groups = decision.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(6);
    for (const group of groups) {
      // EXACT half, both bounds — the float defect produced 0.5000000000000001.
      expect(group.lower_g).toBe(0.5);
      expect(group.upper_g).toBe(0.5);
      expect(group.classification).toBe('UNDETERMINED');
    }
    expect(decision.definiteWins).toBe(0);
    expect(decision.definiteLosses).toBe(0);
    expect(decision.outcome).toBe('INCONCLUSIVE');
  });

  it('TEST-2696-B: the mirrored tie (verdicts flipped) yields the same exact UNDETERMINED — no false REGRESSION', () => {
    const { assignments, comparisons, groupOverride } = sixGroupTieAssignments();
    const flipped = comparisons.map((c) => ({
      ...c,
      verdict: c.verdict === W ? L : (c.verdict === L ? W : c.verdict),
    }));
    const report = reportFor(assignments, flipped, { design: 'CHANGE_VS_BASELINE', alpha: 0.05 }, groupOverride);
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(50);
    const decision = report.decision as Record<string, unknown>;
    expect(decision.definiteLosses).toBe(0);
    expect(decision.definiteWins).toBe(0);
    expect(decision.outcome).toBe('INCONCLUSIVE');
  });

  it('TEST-2696-C: exact ties at repetition/case/group layers never misclassify (multi-layer boundaries)', () => {
    // case value 1/2 via 2 repetitions (W,L); another group: two such cases —
    // every layer aggregates to exactly 1/2.
    const assignments: Array<ReturnType<typeof unit>> = [];
    const comparisons: Array<ReturnType<typeof finalComparison>> = [];
    const pushCase = (caseId: string, reps: number) => {
      for (let r = 1; r <= reps; r += 1) {
        const a = unit({ caseId, scenarioId: 'SC1', repetitionId: `rep-${r}` });
        assignments.push(a);
        comparisons.push(finalComparison(a, r % 2 === 1 ? W : L));
      }
    };
    pushCase('case-a', 2); // group A: one case, 2 reps W/L -> exactly 1/2
    pushCase('case-b1', 2); // group B: two cases of W/L -> exactly 1/2
    pushCase('case-b2', 2);
    const sourceGroups = { 'case-a': 'sg-a', 'case-b1': 'sg-b', 'case-b2': 'sg-b' };
    const report = reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE', alpha: 0.05 }, sourceGroups);
    const decision = report.decision as Record<string, unknown>;
    const groups = decision.groups as Array<Record<string, unknown>>;
    for (const group of groups) {
      expect(group.lower_g).toBe(0.5);
      expect(group.upper_g).toBe(0.5);
      expect(group.classification).toBe('UNDETERMINED');
    }
    expect(decision.outcome).toBe('INCONCLUSIVE');
  });

  it('TEST-2696-D: large-n thresholds match the independent exact oracle (n=1023/1024/1025, boundaries ±1, mirror)', { timeout: 600_000 }, () => {
    const build = (n: number, wins: number) => {
      const assignments: Array<ReturnType<typeof unit>> = [];
      const comparisons: Array<ReturnType<typeof finalComparison>> = [];
      for (let i = 1; i <= n; i += 1) {
        const a = unit({ caseId: `case-${i}`, scenarioId: 'SC1' });
        assignments.push(a);
        comparisons.push(finalComparison(a, i <= wins ? W : L));
      }
      return reportFor(assignments, comparisons, { design: 'CHANGE_VS_BASELINE', alpha: 0.05 });
    };
    // Oracle values (exact BigInt cross-multiplication computed INDEPENDENTLY
    // of this module): n=1023 -> 544, n=1024 -> 544, n=1025 -> 545. The
    // pre-fix float `2 ** n` path returned garbage (observed threshold 381 at
    // n=1024 and a false IMPROVED at W=520).
    expect((build(1024, 520).decision as Record<string, unknown>).threshold).toBe(544);
    expect((build(1024, 520).decision as Record<string, unknown>).outcome).toBe('INCONCLUSIVE');
    expect((build(1023, 520).decision as Record<string, unknown>).threshold).toBe(544);
    expect((build(1025, 521).decision as Record<string, unknown>).threshold).toBe(545);
    // Boundary: one win below the threshold stays INCONCLUSIVE...
    expect((build(1024, 543).decision as Record<string, unknown>).outcome).toBe('INCONCLUSIVE');
    // ...and exactly at the threshold it flips to IMPROVED.
    expect((build(1024, 544).decision as Record<string, unknown>).outcome).toBe('IMPROVED');
    // Mirror: losses follow the identical threshold.
    const mirror = build(1024, 1024 - 544);
    expect((mirror.decision as unknown as Record<string, unknown>).threshold).toBe(544);
    expect((mirror.decision as unknown as Record<string, unknown>).outcome).toBe('REGRESSION');
  });
});

describe('PRI-1252 r4 — candidate identity, evidence refs, digest binding (TEST-2696-E/F/G)', () => {
  it('TEST-2696-E: two distinct candidates in one plan are refused fail-closed, never blended', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2Raw = { ...unit({ caseId: 'case-1', scenarioId: 'SC1' }), candidateConfigId: 'cfg-candidate-2' };
    const report = reportFor([a1, a2Raw as ReturnType<typeof unit>], [
      finalComparison(a1, W),
      finalComparison(a2Raw as ReturnType<typeof unit>, L),
    ], { design: 'CHANGE_VS_BASELINE', alpha: 0.05 });
    expect(report.status).toBe('INVALID');
    expect(report.pointEstimate).toBeNull();
    expect(report.problems.some((p: { code: string }) => p.code === 'CANDIDATE_IDENTITY_CONFLICT')).toBe(true);
    // Single-candidate positive control is exercised by every other fixture.
  });

  it('TEST-2696-F: FinalComparison refs contradicting the frozen assignment refuse the record (all three fields)', () => {
    for (const field of ['candidateTrajectoryRef', 'referenceTrajectoryRef', 'expectationRef'] as const) {
      const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
      const wrong = { ...finalComparison(a1, W), [field]: `wrong-${field}` };
      const report = reportFor([a1], [wrong], { design: 'CHANGE_VS_BASELINE', alpha: 0.05 });
      expect(report.status, `${field} mismatch must invalidate`).toBe('INVALID');
      expect(report.pointEstimate).toBeNull();
      const problem = (report.problems as Array<{ code: string; detail?: { assignmentKey?: string; claimed?: string } }>)
        .find((p) => p.code === 'COMPARISON_REF_MISMATCH');
      expect(problem, 'audit trail keeps assignmentKey and claimed ref').toBeDefined();
      expect(problem?.detail?.claimed).toBe(`wrong-${field}`);
    }
    // Positive control: refs matching the frozen assignment are accepted.
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const matching = {
      ...finalComparison(a1, W),
      candidateTrajectoryRef: 'traj-cand-case-1',
      referenceTrajectoryRef: 'traj-ref-case-1',
      expectationRef: 'exp-case-1',
    };
    const report = reportFor([a1], [matching], { design: 'CHANGE_VS_BASELINE', alpha: 0.05 });
    expect(report.status).toBe('ESTIMABLE');
    expect(report.pointEstimate).toBe(100);
  });

  it('TEST-2696-G: regrouping the same cases changes sourceGroupsDigest while plan/comparison digests hold', () => {
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const a2 = unit({ caseId: 'case-2', scenarioId: 'SC1' });
    const comparisons = [finalComparison(a1, W), finalComparison(a2, L)];
    const options = { design: 'CHANGE_VS_BASELINE' as const, alpha: 0.05 };
    const split = reportFor([a1, a2], comparisons, options, { 'case-1': 'sg-1', 'case-2': 'sg-2' });
    const merged = reportFor([a1, a2], comparisons, options, { 'case-1': 'sg-1', 'case-2': 'sg-1' });
    const bindingsOf = (r: unknown) => (r as { bindings: Record<string, unknown> }).bindings;
    expect(bindingsOf(split).sourceGroupsDigest).toBeDefined();
    expect(bindingsOf(split).sourceGroupsDigest).not.toEqual(bindingsOf(merged).sourceGroupsDigest);
    expect(bindingsOf(split).planDigest).toBe(bindingsOf(merged).planDigest);
    expect(bindingsOf(split).comparisonsDigest).toBe(bindingsOf(merged).comparisonsDigest);
  });
});

describe('PRI-1252 r4 — FAILED attempt lifecycle (TEST-2696-H)', () => {
  it('TEST-2696-H: a FAILED attempt without a verdict stays as audit evidence, does not vote, and the retry decides', async () => {
    const { mergeJudgments } = await import('../dev/pd-lab/alignment-report.mjs');
    const a1 = unit({ caseId: 'case-1', scenarioId: 'SC1' });
    const plan = makePlan([a1], { requiredJudgments: 1, judgeSlots: ['slot-A'] });
    const judgments = [
      // Attempt 1: the technical call FAILED — no verdict is legitimate.
      { judgmentId: 'j-try1', assignmentKey: keyOf(a1), judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:in-1', attempt: 1, judgeSlotId: 'slot-A', attemptStatus: 'FAILED' },
      // Attempt 2 of the SAME slot: the successful retry decides the vote.
      { judgmentId: 'j-try2', assignmentKey: keyOf(a1), judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:in-1', displayVerdict: 'A_BETTER', attempt: 2, judgeSlotId: 'slot-A', attemptStatus: 'SUCCEEDED' },
    ];
    const merged = mergeJudgments({
      plan,
      judgments,
      blindmap: { map: { 'j-try2': { A: 'candidate', B: 'reference' } } },
    });
    const invalid = merged.problems.filter((p: { code: string }) => p.code === 'INVALID_JUDGMENT_RECORD');
    expect(invalid, 'the FAILED record must not be rejected as malformed').toEqual([]);
    const fc = merged.finalComparisons[0];
    expect(fc.verdict).toBe('CANDIDATE_BETTER');
    expect(fc.judgmentRefs).toContain('j-try2');
    expect(fc.judgmentRefs).toContain('j-try1'); // the failure stays in the audit trail
    // Negative control: SUCCEEDED still requires a valid verdict.
    const badSucceeded = { judgmentId: 'j-bad', assignmentKey: keyOf(a1), judgeProtocolRef: 'jp-test@1', comparisonInputDigest: 'sha256:x', attempt: 1, judgeSlotId: 'slot-A', attemptStatus: 'SUCCEEDED' };
    const rejected = mergeJudgments({ plan, judgments: [badSucceeded], blindmap: { map: {} } });
    expect(rejected.problems.some((p: { code: string }) => p.code === 'INVALID_JUDGMENT_RECORD')).toBe(true);
  });
});
