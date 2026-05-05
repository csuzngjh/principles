import type { PrincipleLifecycleEvidence } from './lifecycle-types.js';
import {
  computePrincipleAdherence,
  computeRuleMetrics,
  type PrincipleAdherenceResult,
  type RuleMetricResult,
} from './lifecycle-metrics.js';

// ===== Named constants (PRI-53: extracted from magic numbers) =====

// Readiness score weights (must sum to 1.0)
const READINESS_WEIGHT_ADHERENCE = 0.45;
const READINESS_WEIGHT_COVERAGE = 0.25;
const READINESS_WEIGHT_FP_INVERTED = 0.15;
const READINESS_WEIGHT_ERROR_REDUCTION = 0.15;

// Deprecation thresholds
const DEPRECATION_MIN_COVERAGE = 75;
const DEPRECATION_MAX_FP_RATE = 20;
const DEPRECATION_MIN_ERROR_REDUCTION = 70;

// Watch status thresholds
const WATCH_MIN_SCORE = 55;
const WATCH_MIN_STABLE_RATIO = 0.5;

// Ready status threshold
const READY_STABLE_RATIO = 1.0;

// ===== Types =====

export type DeprecatedReadinessStatus = 'ready' | 'watch' | 'not-ready';

export interface DeprecatedReadinessAssessment {
  status: DeprecatedReadinessStatus;
  score: number;
  blockingReasons: string[];
  supportingRuleIds: string[];
  evidence: {
    adherenceRate: number;
    averageRuleCoverage: number;
    averageFalsePositiveRate: number;
    repeatedErrorReductionScore: number;
    repeatedErrorSignal: number;
    stableRuleCount: number;
    activeImplementationCount: number;
  };
}

// ===== Helpers =====

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

// ===== Exported functions =====

export function assessDeprecatedReadiness(
  principle: PrincipleLifecycleEvidence,
  precomputedRuleMetrics?: Record<string, RuleMetricResult>,
  precomputedAdherence?: PrincipleAdherenceResult,
): DeprecatedReadinessAssessment {
  const ruleMetrics = precomputedRuleMetrics ?? Object.fromEntries(
    principle.rules.map((rule) => [rule.rule.id, computeRuleMetrics(rule)]),
  );
  const adherence = precomputedAdherence ?? computePrincipleAdherence(principle, ruleMetrics);
  const blockingReasons: string[] = [];
  const stableCoverageRatio =
    principle.rules.length > 0 ? adherence.stableRuleIds.length / principle.rules.length : 0;

  if (principle.rules.length === 0) {
    blockingReasons.push('No material rules are attached to this principle yet.');
  }
  if (principle.summary.activeImplementationCount === 0) {
    blockingReasons.push('No active lower-layer implementation is absorbing the principle.');
  }
  if (adherence.averageRuleCoverage < DEPRECATION_MIN_COVERAGE) {
    blockingReasons.push('Rule coverage is not yet stable enough to absorb the principle.');
  }
  if (adherence.averageFalsePositiveRate > DEPRECATION_MAX_FP_RATE) {
    blockingReasons.push('False-positive rate remains too high for deprecation readiness.');
  }
  if (adherence.repeatedErrorSignal > 0 || adherence.repeatedErrorReductionScore < DEPRECATION_MIN_ERROR_REDUCTION) {
    blockingReasons.push('Repeated related errors have not fallen enough yet.');
  }

  const score = clampScore(
    adherence.adherenceRate * READINESS_WEIGHT_ADHERENCE +
      adherence.averageRuleCoverage * READINESS_WEIGHT_COVERAGE +
      (100 - adherence.averageFalsePositiveRate) * READINESS_WEIGHT_FP_INVERTED +
      adherence.repeatedErrorReductionScore * READINESS_WEIGHT_ERROR_REDUCTION,
  );

  const status: DeprecatedReadinessStatus =
    blockingReasons.length === 0 && stableCoverageRatio === READY_STABLE_RATIO
      ? 'ready'
      : score >= WATCH_MIN_SCORE && principle.summary.activeImplementationCount > 0 && stableCoverageRatio >= WATCH_MIN_STABLE_RATIO
        ? 'watch'
        : 'not-ready';

  return {
    status,
    score,
    blockingReasons,
    supportingRuleIds: adherence.stableRuleIds,
    evidence: {
      adherenceRate: adherence.adherenceRate,
      averageRuleCoverage: adherence.averageRuleCoverage,
      averageFalsePositiveRate: adherence.averageFalsePositiveRate,
      repeatedErrorReductionScore: adherence.repeatedErrorReductionScore,
      repeatedErrorSignal: adherence.repeatedErrorSignal,
      stableRuleCount: adherence.stableRuleIds.length,
      activeImplementationCount: principle.summary.activeImplementationCount,
    },
  };
}
