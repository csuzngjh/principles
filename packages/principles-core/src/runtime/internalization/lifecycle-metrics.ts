import type { PrincipleLifecycleEvidence, RuleLifecycleEvidence } from './lifecycle-types.js';

// ===== Result interfaces =====

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

// ===== Named constants (PRI-52: extracted from magic numbers) =====

// Implementation stability score weights
const ACTIVE_IMPL_WEIGHT = 35;
const PASSING_ACTIVE_IMPL_WEIGHT = 30;
const PASSING_REPLAY_IMPL_WEIGHT = 20;
const CANDIDATE_PRESENCE_WEIGHT = 10;
const REPLAY_REPORT_PRESENCE_WEIGHT = 15;
const CLEAN_ACTIVE_IMPL_BONUS = 10;
const DURABLE_PENALTY_WEIGHT = 12;
const ROLLBACK_PENALTY_WEIGHT = 8;

// Live penalty calculation
const LIVE_PENALTY_CAP = 15;
const LIVE_DURABLE_WEIGHT = 5;
const LIVE_ROLLBACK_WEIGHT = 3;

// Coverage rate composite weights (must sum to 1.0)
const COVERAGE_MIX_PAIN_NEG = 0.5;
const COVERAGE_MIX_PRINCIPLE_ANCHOR = 0.3;
const COVERAGE_MIX_IMPL_STABILITY = 0.2;

// Stability classification thresholds
const STABLE_COVERAGE_THRESHOLD = 70;
const STABLE_FP_THRESHOLD = 25;

// Error pressure weights
const ERROR_PRESSURE_SIGNAL_WEIGHT = 10;
const ERROR_PRESSURE_UNSTABLE_WEIGHT = 12;
const ERROR_PRESSURE_FP_MIX = 0.4;

// Adherence rate composite weights (must sum to 1.0)
const ADHERENCE_MIX_COVERAGE = 0.7;
const ADHERENCE_MIX_REDUCTION = 0.3;

// ===== Internal helpers =====

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
    score += ACTIVE_IMPL_WEIGHT;
  }
  if (liveEvidence.hasPassingActiveImplementation) {
    score += PASSING_ACTIVE_IMPL_WEIGHT;
  } else if (replayEvidence.passingImplementationIds.length > 0) {
    score += PASSING_REPLAY_IMPL_WEIGHT;
  }
  if (liveEvidence.candidateCount > 0) {
    score += CANDIDATE_PRESENCE_WEIGHT;
  }
  if (replayEvidence.reportCount > 0) {
    score += REPLAY_REPORT_PRESENCE_WEIGHT;
  }
  if (
    liveEvidence.hasActiveImplementation &&
    liveEvidence.durablePenaltyCount === 0 &&
    liveEvidence.rollbackEvidenceCount === 0
  ) {
    score += CLEAN_ACTIVE_IMPL_BONUS;
  }

  score -= liveEvidence.durablePenaltyCount * DURABLE_PENALTY_WEIGHT;
  score -= liveEvidence.rollbackEvidenceCount * ROLLBACK_PENALTY_WEIGHT;

  return clampRate(score);
}

// ===== Exported functions =====

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
    LIVE_PENALTY_CAP,
    rule.liveEvidence.durablePenaltyCount * LIVE_DURABLE_WEIGHT + rule.liveEvidence.rollbackEvidenceCount * LIVE_ROLLBACK_WEIGHT,
  );

  return {
    coverageRate: clampRate(
      painNegativeHitRate * COVERAGE_MIX_PAIN_NEG + principleAnchorPassRate * COVERAGE_MIX_PRINCIPLE_ANCHOR + implementationStabilityScore * COVERAGE_MIX_IMPL_STABILITY,
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
    .filter((entry) => entry.metrics.coverageRate >= STABLE_COVERAGE_THRESHOLD && entry.metrics.falsePositiveRate <= STABLE_FP_THRESHOLD)
    .map((entry) => entry.ruleId);
  const unstableRuleIds = ruleMetrics
    .filter((entry) => !stableRuleIds.includes(entry.ruleId))
    .map((entry) => entry.ruleId);

  const repeatedErrorPressure =
    principle.summary.repeatedErrorSignal * ERROR_PRESSURE_SIGNAL_WEIGHT + unstableRuleIds.length * ERROR_PRESSURE_UNSTABLE_WEIGHT + averageFalsePositiveRate * ERROR_PRESSURE_FP_MIX;
  const repeatedErrorReductionScore = clampRate(100 - repeatedErrorPressure);

  return {
    adherenceRate: clampRate(averageRuleCoverage * ADHERENCE_MIX_COVERAGE + repeatedErrorReductionScore * ADHERENCE_MIX_REDUCTION),
    averageRuleCoverage: clampRate(averageRuleCoverage),
    averageFalsePositiveRate: clampRate(averageFalsePositiveRate),
    repeatedErrorReductionScore,
    repeatedErrorSignal: principle.summary.repeatedErrorSignal,
    stableRuleIds,
    unstableRuleIds,
  };
}
