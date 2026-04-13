import type { PrinciplePriority, PrincipleEvaluability, RuleType } from '../../types/principle-tree-schema.js';
import type { PrincipleLifecycleEvidence } from './lifecycle-read-model.js';
import {
  computePrincipleAdherence,
  computeRuleMetrics,
  type PrincipleAdherenceResult,
  type RuleMetricResult,
} from './lifecycle-metrics.js';

export type InternalizationRoute = 'skill' | 'code' | 'defer';

export interface InternalizationRouteEvidenceSummary {
  replayReportCount: number;
  activeImplementationCount: number;
  candidateImplementationCount: number;
  repeatedErrorSignal: number;
  averageRuleCoverage: number;
  averageFalsePositiveRate: number;
  highestRuleCoverageGap: number;
  dominantRuleType: RuleType | 'mixed';
}

export interface InternalizationRouteRecommendation {
  principleId: string;
  route: InternalizationRoute;
  confidence: number;
  reasonCodes: string[];
  evidenceSummary: InternalizationRouteEvidenceSummary;
  nextAction: string;
}

function clampToPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function dominantRuleType(principle: PrincipleLifecycleEvidence): RuleType | 'mixed' {
  if (principle.rules.length === 0) {
    return 'mixed';
  }

  const distinctTypes = Array.from(new Set(principle.rules.map((rule) => rule.rule.type)));
  return distinctTypes.length === 1 ? distinctTypes[0] : 'mixed';
}

function averageCoverageGap(ruleMetrics: Record<string, RuleMetricResult>): number {
  const coverageGaps = Object.values(ruleMetrics).map((metrics) => Math.max(0, 100 - metrics.coverageRate));

  if (coverageGaps.length === 0) {
    return 0;
  }

  return clampToPercentage(
    coverageGaps.reduce((sum, gap) => sum + gap, 0) / coverageGaps.length,
  );
}

function isHighRisk(priority: PrinciplePriority, evaluability: PrincipleEvaluability): boolean {
  return priority === 'P0' || evaluability === 'deterministic';
}

function supportsSkillRoute(principle: PrincipleLifecycleEvidence): boolean {
  return principle.rules.every((rule) =>
    rule.rule.enforcement !== 'block' || ['skill', 'prompt', 'test'].includes(rule.rule.type),
  );
}

function buildEvidenceSummary(
  principle: PrincipleLifecycleEvidence,
  adherence: PrincipleAdherenceResult,
  ruleMetrics: Record<string, RuleMetricResult>,
): InternalizationRouteEvidenceSummary {
  return {
    replayReportCount: principle.summary.replayReportCount,
    activeImplementationCount: principle.summary.activeImplementationCount,
    candidateImplementationCount: principle.summary.candidateImplementationCount,
    repeatedErrorSignal: principle.summary.repeatedErrorSignal,
    averageRuleCoverage: adherence.averageRuleCoverage,
    averageFalsePositiveRate: adherence.averageFalsePositiveRate,
    highestRuleCoverageGap: averageCoverageGap(ruleMetrics),
    dominantRuleType: dominantRuleType(principle),
  };
}

    // eslint-disable-next-line complexity -- refactor candidate
export function recommendInternalizationRoute(
  principle: PrincipleLifecycleEvidence,
  precomputedRuleMetrics?: Record<string, RuleMetricResult>,
  precomputedAdherence?: PrincipleAdherenceResult,
): InternalizationRouteRecommendation {
  const ruleMetrics = precomputedRuleMetrics ?? Object.fromEntries(
    principle.rules.map((rule) => [rule.rule.id, computeRuleMetrics(rule)]),
  );
  const adherence = precomputedAdherence ?? computePrincipleAdherence(principle, ruleMetrics);
  const evidenceSummary = buildEvidenceSummary(principle, adherence, ruleMetrics);
    const reasonCodes: string[] = [];
  
  // ── Axiom-based heuristic modifiers ──
  const axiomId = principle.principle.coreAxiomId;
  let codeBoost = 0;
  let skillBoost = 0;
  if (axiomId === 'T-05' || axiomId === 'T-08') {
    codeBoost = 15;
    reasonCodes.push('axiom_governance_enforcement');
  } else if (axiomId === 'T-01' || axiomId === 'T-03' || axiomId === 'T-04') {
    skillBoost = 15;
    reasonCodes.push('axiom_knowledge_guidance');
  }

  const highRisk = isHighRisk(principle.principle.priority, principle.principle.evaluability);
  const hasSparseEvidence =
    principle.summary.replayReportCount < Math.max(1, principle.rules.length) &&
    principle.summary.activeImplementationCount === 0 &&
    principle.summary.candidateImplementationCount === 0 &&
    principle.summary.repeatedErrorSignal < 2;
  const stableEnoughToWait =
    adherence.averageRuleCoverage >= 80 &&
    adherence.averageFalsePositiveRate <= 15 &&
    principle.summary.repeatedErrorSignal === 0;

  if (principle.rules.length === 0) {
    reasonCodes.push('insufficient_data', 'no_material_rules');
    return {
      principleId: principle.principle.id,
      route: 'defer',
      confidence: 50,
      reasonCodes,
      evidenceSummary,
      nextAction: 'No rules defined for this principle. Create at least one rule via pain→principle→rule pipeline before internalization routing can produce meaningful recommendations.',
    };
  }

  if (hasSparseEvidence) {
    reasonCodes.push('sparse_evidence');
    return {
      principleId: principle.principle.id,
      route: 'defer',
      confidence: clampToPercentage(78 - principle.summary.repeatedErrorSignal * 8),
      reasonCodes,
      evidenceSummary,
      nextAction: 'Collect more replay evidence or live violations before committing to a heavier implementation path.',
    };
  }

  if (stableEnoughToWait) {
    reasonCodes.push('already_absorbing');
    return {
      principleId: principle.principle.id,
      route: 'defer',
      confidence: clampToPercentage(70 + adherence.averageRuleCoverage * 0.2),
      reasonCodes,
      evidenceSummary,
      nextAction: 'Defer new implementation work and keep monitoring until the lower layer proves it needs another route.',
    };
  }

  const prefersSkillRoute =
    supportsSkillRoute(principle) &&
    (
      (!highRisk &&
      principle.principle.evaluability !== 'deterministic' &&
      principle.summary.repeatedErrorSignal <= 2) ||
      (skillBoost > 0 && codeBoost === 0)
    ) && codeBoost === 0;

  if (prefersSkillRoute) {
    reasonCodes.push('cheapest_viable_skill');
    if (principle.summary.activeImplementationCount === 0) {
      reasonCodes.push('no_hard_boundary_required');
    }

    return {
      principleId: principle.principle.id,
      route: 'skill',
      confidence: clampToPercentage(
        62 + adherence.repeatedErrorReductionScore * 0.12 - adherence.averageFalsePositiveRate * 0.15 + skillBoost,
      ),
      reasonCodes,
      evidenceSummary,
      nextAction: 'Prefer a skill or prompt-level intervention first, then replay again before escalating to code.',
    };
  }

  reasonCodes.push('deterministic_or_high_risk');
  if (principle.summary.replayReportCount > 0) {
    reasonCodes.push('replay_evidence_sufficient');
  }
  if (principle.summary.repeatedErrorSignal > 0) {
    reasonCodes.push('repeated_errors_continue');
  }

  return {
    principleId: principle.principle.id,
    route: 'code',
    confidence: clampToPercentage(
      58 +
        evidenceSummary.highestRuleCoverageGap * 0.2 +
        principle.summary.repeatedErrorSignal * 6 +
        (highRisk ? 8 : 0) +
        codeBoost,
    ),
    reasonCodes,
    evidenceSummary,
    nextAction: 'Prepare a code implementation candidate and keep promotion manual after replay validation.',
  };
}
