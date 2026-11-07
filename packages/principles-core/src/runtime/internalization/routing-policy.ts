import type { PrinciplePriority, PrincipleEvaluability, RuleType } from '../types/index.js';
import type { PrincipleLifecycleEvidence } from './lifecycle-types.js';
import {
  computePrincipleAdherence,
  computeRuleMetrics,
  type PrincipleAdherenceResult,
  type RuleMetricResult,
} from './lifecycle-metrics.js';

// ── Public types ────────────────────────────────────────────────────────────

export type LifecycleRoute = 'skill' | 'code' | 'defer';

export interface LifecycleRouteEvidenceSummary {
  replayReportCount: number;
  activeImplementationCount: number;
  candidateImplementationCount: number;
  repeatedErrorSignal: number;
  averageRuleCoverage: number;
  averageFalsePositiveRate: number;
  highestRuleCoverageGap: number;
  dominantRuleType: RuleType | 'mixed';
}

export interface LifecycleRouteRecommendation {
  principleId: string;
  route: LifecycleRoute;
  confidence: number;
  reasonCodes: string[];
  evidenceSummary: LifecycleRouteEvidenceSummary;
  nextAction: string;
}

// ── Named constants ─────────────────────────────────────────────────────────

// Axiom-based heuristic boost values
const AXIOM_GOVERNANCE_BOOST = 15;
const AXIOM_KNOWLEDGE_BOOST = 15;

// Sparse evidence thresholds
const SPARSE_MAX_REPEATED_ERRORS = 2;

// Stable-enough-to-wait thresholds
const STABLE_MIN_COVERAGE = 80;
const STABLE_MAX_FP_RATE = 15;

// Confidence: defer (insufficient data)
const CONFIDENCE_DEFER_INSUFFICIENT = 50;

// Confidence: defer (sparse evidence)
const CONFIDENCE_DEFER_SPARSE_BASE = 78;
const CONFIDENCE_DEFER_SPARSE_PENALTY = 8;

// Confidence: defer (stable enough)
const CONFIDENCE_DEFER_STABLE_BASE = 70;
const CONFIDENCE_DEFER_STABLE_COVERAGE_WEIGHT = 0.2;

// Confidence: skill route
const CONFIDENCE_SKILL_BASE = 62;
const CONFIDENCE_SKILL_ERROR_REDUCTION_WEIGHT = 0.12;
const CONFIDENCE_SKILL_FP_PENALTY_WEIGHT = 0.15;

// Confidence: code route
const CONFIDENCE_CODE_BASE = 58;
const CONFIDENCE_CODE_COVERAGE_GAP_WEIGHT = 0.2;
const CONFIDENCE_CODE_REPEATED_ERROR_BOOST = 6;
const CONFIDENCE_CODE_HIGH_RISK_BOOST = 8;

// Skill route threshold
const SKILL_ROUTE_MAX_REPEATED_ERRORS = 2;

// ── Internal helpers ────────────────────────────────────────────────────────

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

  const types = principle.rules.map((rule) => rule.rule.type);
  const defined = types.filter((t): t is RuleType => t !== undefined);
  const distinctTypes = new Set(defined);
  return distinctTypes.size === 1 ? (defined[0] as RuleType | 'mixed') : 'mixed';
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
): LifecycleRouteEvidenceSummary {
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

// ── Public decision function ────────────────────────────────────────────────

export function recommendLifecycleRoute(
  principle: PrincipleLifecycleEvidence,
  precomputedRuleMetrics?: Record<string, RuleMetricResult>,
  precomputedAdherence?: PrincipleAdherenceResult,
): LifecycleRouteRecommendation {
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
    codeBoost = AXIOM_GOVERNANCE_BOOST;
    reasonCodes.push('axiom_governance_enforcement');
  } else if (axiomId === 'T-01' || axiomId === 'T-03' || axiomId === 'T-04') {
    skillBoost = AXIOM_KNOWLEDGE_BOOST;
    reasonCodes.push('axiom_knowledge_guidance');
  }

  const highRisk = isHighRisk(principle.principle.priority, principle.principle.evaluability);
  const hasSparseEvidence =
    principle.summary.replayReportCount < Math.max(1, principle.rules.length) &&
    principle.summary.activeImplementationCount === 0 &&
    principle.summary.candidateImplementationCount === 0 &&
    principle.summary.repeatedErrorSignal < SPARSE_MAX_REPEATED_ERRORS;
  const stableEnoughToWait =
    adherence.averageRuleCoverage >= STABLE_MIN_COVERAGE &&
    adherence.averageFalsePositiveRate <= STABLE_MAX_FP_RATE &&
    principle.summary.repeatedErrorSignal === 0;

  if (principle.rules.length === 0) {
    reasonCodes.push('insufficient_data', 'no_material_rules');
    return {
      principleId: principle.principle.id,
      route: 'defer',
      confidence: CONFIDENCE_DEFER_INSUFFICIENT,
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
      confidence: clampToPercentage(CONFIDENCE_DEFER_SPARSE_BASE - principle.summary.repeatedErrorSignal * CONFIDENCE_DEFER_SPARSE_PENALTY),
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
      confidence: clampToPercentage(CONFIDENCE_DEFER_STABLE_BASE + adherence.averageRuleCoverage * CONFIDENCE_DEFER_STABLE_COVERAGE_WEIGHT),
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
      principle.summary.repeatedErrorSignal <= SKILL_ROUTE_MAX_REPEATED_ERRORS) ||
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
        CONFIDENCE_SKILL_BASE + adherence.repeatedErrorReductionScore * CONFIDENCE_SKILL_ERROR_REDUCTION_WEIGHT - adherence.averageFalsePositiveRate * CONFIDENCE_SKILL_FP_PENALTY_WEIGHT + skillBoost,
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
      CONFIDENCE_CODE_BASE +
        evidenceSummary.highestRuleCoverageGap * CONFIDENCE_CODE_COVERAGE_GAP_WEIGHT +
        principle.summary.repeatedErrorSignal * CONFIDENCE_CODE_REPEATED_ERROR_BOOST +
        (highRisk ? CONFIDENCE_CODE_HIGH_RISK_BOOST : 0) +
        codeBoost,
    ),
    reasonCodes,
    evidenceSummary,
    nextAction: 'Prepare a code implementation candidate and keep promotion manual after replay validation.',
  };
}
