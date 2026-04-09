import type { PrincipleLifecycleEvidence } from './lifecycle-read-model.js';
import { computePrincipleAdherence, computeRuleMetrics, type PrincipleAdherenceResult, type RuleMetricResult } from './lifecycle-metrics.js';

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

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

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
  if (adherence.averageRuleCoverage < 75) {
    blockingReasons.push('Rule coverage is not yet stable enough to absorb the principle.');
  }
  if (adherence.averageFalsePositiveRate > 20) {
    blockingReasons.push('False-positive rate remains too high for deprecation readiness.');
  }
  if (adherence.repeatedErrorSignal > 0 || adherence.repeatedErrorReductionScore < 70) {
    blockingReasons.push('Repeated related errors have not fallen enough yet.');
  }

  const score = clampScore(
    adherence.adherenceRate * 0.45 +
      adherence.averageRuleCoverage * 0.25 +
      (100 - adherence.averageFalsePositiveRate) * 0.15 +
      adherence.repeatedErrorReductionScore * 0.15,
  );

  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all if/else branches
  let status: DeprecatedReadinessStatus;
  if (blockingReasons.length === 0 && stableCoverageRatio === 1) {
    status = 'ready';
  } else if (score >= 55 && principle.summary.activeImplementationCount > 0 && stableCoverageRatio >= 0.5) {
    status = 'watch';
  } else {
    status = 'not-ready';
  }

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
