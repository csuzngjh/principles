import type { PrincipleLifecycleEvidence, RuleLifecycleEvidence } from './lifecycle-read-model.js';

export interface RuleMetricResult {
  coverageRate: number;
  falsePositiveRate: number;
  painNegativeHitRate: number;
  principleAnchorPassRate: number;
  implementationStabilityScore: number;
  replayFalsePositiveRate: number;
  livePenaltyRate: number;
}

export interface PrincipleAdherenceResult {
  /** True when no rules exist — all numeric fields are defaults, not computed values */
  insufficientData?: boolean;
  adherenceRate: number;
  averageRuleCoverage: number;
  averageFalsePositiveRate: number;
  repeatedErrorReductionScore: number;
  repeatedErrorSignal: number;
  stableRuleIds: string[];
  unstableRuleIds: string[];
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function ratio(passed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return (passed / total) * 100;
}

function computeImplementationStabilityScore(rule: RuleLifecycleEvidence): number {
  const { liveEvidence, replayEvidence } = rule;

  let score = 0;

  if (liveEvidence.hasActiveImplementation) {
    score += 35;
  }
  if (liveEvidence.hasPassingActiveImplementation) {
    score += 30;
  } else if (replayEvidence.passingImplementationIds.length > 0) {
    score += 20;
  }
  if (liveEvidence.candidateCount > 0) {
    score += 10;
  }
  if (replayEvidence.reportCount > 0) {
    score += 15;
  }
  if (
    liveEvidence.hasActiveImplementation &&
    liveEvidence.durablePenaltyCount === 0 &&
    liveEvidence.rollbackEvidenceCount === 0
  ) {
    score += 10;
  }

  score -= liveEvidence.durablePenaltyCount * 12;
  score -= liveEvidence.rollbackEvidenceCount * 8;

  return clampRate(score);
}

export function computeRuleMetrics(rule: RuleLifecycleEvidence): RuleMetricResult {
  const painNegativeHitRate = ratio(rule.replayEvidence.painNegative.passed, rule.replayEvidence.painNegative.total);
  const principleAnchorPassRate = ratio(
    rule.replayEvidence.principleAnchor.passed,
    rule.replayEvidence.principleAnchor.total,
  );
  const implementationStabilityScore = computeImplementationStabilityScore(rule);
  const replayFalsePositiveRate = ratio(
    rule.replayEvidence.successPositive.failed,
    rule.replayEvidence.successPositive.total,
  );
  const livePenaltyRate = Math.min(
    15,
    rule.liveEvidence.durablePenaltyCount * 5 + rule.liveEvidence.rollbackEvidenceCount * 3,
  );

  return {
    coverageRate: clampRate(
      painNegativeHitRate * 0.5 + principleAnchorPassRate * 0.3 + implementationStabilityScore * 0.2,
    ),
    falsePositiveRate: clampRate(replayFalsePositiveRate + livePenaltyRate),
    painNegativeHitRate: clampRate(painNegativeHitRate),
    principleAnchorPassRate: clampRate(principleAnchorPassRate),
    implementationStabilityScore,
    replayFalsePositiveRate: clampRate(replayFalsePositiveRate),
    livePenaltyRate: clampRate(livePenaltyRate),
  };
}

export function computePrincipleAdherence(
  principle: PrincipleLifecycleEvidence,
  precomputedRuleMetrics?: Record<string, RuleMetricResult>,
): PrincipleAdherenceResult {
  const metricsByRuleId = precomputedRuleMetrics ?? Object.fromEntries(
    principle.rules.map((rule) => [rule.rule.id, computeRuleMetrics(rule)]),
  );

  if (principle.rules.length === 0) {
    return {
      insufficientData: true,
      adherenceRate: 0,
      averageRuleCoverage: 0,
      averageFalsePositiveRate: 0,
      repeatedErrorReductionScore: 0,
      repeatedErrorSignal: principle.summary.repeatedErrorSignal,
      stableRuleIds: [],
      unstableRuleIds: [],
    };
  }

  const ruleMetrics = principle.rules.map((rule) => ({
    ruleId: rule.rule.id,
    metrics: metricsByRuleId[rule.rule.id] ?? computeRuleMetrics(rule),
  }));
  const averageRuleCoverage = ruleMetrics.reduce((sum, entry) => sum + entry.metrics.coverageRate, 0) / ruleMetrics.length;
  const averageFalsePositiveRate =
    ruleMetrics.reduce((sum, entry) => sum + entry.metrics.falsePositiveRate, 0) / ruleMetrics.length;

  const stableRuleIds = ruleMetrics
    .filter((entry) => entry.metrics.coverageRate >= 70 && entry.metrics.falsePositiveRate <= 25)
    .map((entry) => entry.ruleId);
  const unstableRuleIds = ruleMetrics
    .filter((entry) => !stableRuleIds.includes(entry.ruleId))
    .map((entry) => entry.ruleId);

  const repeatedErrorPressure =
    principle.summary.repeatedErrorSignal * 10 + unstableRuleIds.length * 12 + averageFalsePositiveRate * 0.4;
  const repeatedErrorReductionScore = clampRate(100 - repeatedErrorPressure);

  return {
    adherenceRate: clampRate(averageRuleCoverage * 0.7 + repeatedErrorReductionScore * 0.3),
    averageRuleCoverage: clampRate(averageRuleCoverage),
    averageFalsePositiveRate: clampRate(averageFalsePositiveRate),
    repeatedErrorReductionScore,
    repeatedErrorSignal: principle.summary.repeatedErrorSignal,
    stableRuleIds,
    unstableRuleIds,
  };
}
