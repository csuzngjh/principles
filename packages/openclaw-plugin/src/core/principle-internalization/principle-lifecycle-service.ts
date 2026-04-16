import {
  loadLedger,
  updatePrinciple,
  updatePrincipleValueMetrics,
  updateRule,
} from '../principle-tree-ledger.js';
import type { PrincipleValueMetrics } from '../../types/principle-tree-schema.js';
import { buildLifecycleReadModel, type LifecycleReadModel, type PrincipleLifecycleEvidence } from './lifecycle-read-model.js';
import {
  computePrincipleAdherence,
  computeRuleMetrics,
  type PrincipleAdherenceResult,
  type RuleMetricResult,
} from './lifecycle-metrics.js';
import {
  assessDeprecatedReadiness,
  type DeprecatedReadinessAssessment,
} from './deprecated-readiness.js';
import {
  recommendInternalizationRoute,
  type InternalizationRouteRecommendation,
} from './internalization-routing-policy.js';

export interface RecomputedPrincipleLifecycle {
  principleId: string;
  ruleMetrics: Record<string, RuleMetricResult>;
  adherence: PrincipleAdherenceResult;
  deprecatedReadiness: DeprecatedReadinessAssessment;
  routeRecommendation: InternalizationRouteRecommendation;
}

export interface PrincipleLifecycleAssessment {
  principle: PrincipleLifecycleEvidence['principle'];
  summary: PrincipleLifecycleEvidence['summary'];
  ruleMetrics: Record<string, RuleMetricResult>;
  adherence: PrincipleAdherenceResult;
  deprecatedReadiness: DeprecatedReadinessAssessment;
  routeRecommendation: InternalizationRouteRecommendation;
}

     
function createValueMetrics(
  principle: PrincipleLifecycleEvidence,
  adherence: PrincipleAdherenceResult,
  current: PrincipleValueMetrics | undefined,
): PrincipleValueMetrics {
  const violatedCount = principle.summary.repeatedErrorSignal;
  const totalOpportunities = Math.max(
    violatedCount + principle.summary.replayReportCount,
    current?.totalOpportunities ?? 0,
  );
  const adheredCount = Math.max(0, Math.round((adherence.adherenceRate / 100) * totalOpportunities));

  return {
    principleId: principle.principle.id,
    painPreventedCount: current?.painPreventedCount ?? principle.principle.painPreventedCount,
    avgPainSeverityPrevented: current?.avgPainSeverityPrevented ?? 0,
    lastPainPreventedAt: current?.lastPainPreventedAt ?? principle.principle.lastPainPreventedAt,
    totalOpportunities,
    adheredCount,
    violatedCount,
    implementationCost: current?.implementationCost ?? 0,
    benefitScore: Number(
      (
        (current?.painPreventedCount ?? principle.principle.painPreventedCount) *
        Math.max(current?.avgPainSeverityPrevented ?? 0, 1) *
        (adherence.adherenceRate / 100)
      ).toFixed(2)
    ),
    calculatedAt: new Date().toISOString(),
  };
}

export class PrincipleLifecycleService {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  constructor(
    workspaceDir: string,
    stateDir: string,
  ) {
    this.workspaceDir = workspaceDir;
    this.stateDir = stateDir;
  }

  buildReadModel(): LifecycleReadModel {
    return buildLifecycleReadModel(this.workspaceDir, this.stateDir);
  }

  listAssessments(readModel = this.buildReadModel()): PrincipleLifecycleAssessment[] {
    return readModel.principles.map((principleEvidence) => {
      const ruleMetrics = Object.fromEntries(
        principleEvidence.rules.map((ruleEvidence) => [
          ruleEvidence.rule.id,
          computeRuleMetrics(ruleEvidence),
        ]),
      ) as Record<string, RuleMetricResult>;
      const adherence = computePrincipleAdherence(principleEvidence, ruleMetrics);
      const deprecatedReadiness = assessDeprecatedReadiness(
        principleEvidence,
        ruleMetrics,
        adherence,
      );
      const routeRecommendation = recommendInternalizationRoute(
        principleEvidence,
        ruleMetrics,
        adherence,
      );

      return {
        principle: principleEvidence.principle,
        summary: principleEvidence.summary,
        ruleMetrics,
        adherence,
        deprecatedReadiness,
        routeRecommendation,
      };
    });
  }

  listRouteRecommendations(readModel = this.buildReadModel()): InternalizationRouteRecommendation[] {
    return this.listAssessments(readModel).map((assessment) => assessment.routeRecommendation);
  }

  recomputeAll(): RecomputedPrincipleLifecycle[] {
    const ledger = loadLedger(this.stateDir);
    const readModel = this.buildReadModel();
    const assessments = this.listAssessments(readModel);

    return assessments.map((assessment) => {
      const principleEvidence = readModel.principles.find(
        (principle) => principle.principle.id === assessment.principle.id,
      );
      if (!principleEvidence) {
        throw new Error(`Missing lifecycle evidence for principle "${assessment.principle.id}".`);
      }

      for (const [ruleId, metrics] of Object.entries(assessment.ruleMetrics)) {
        updateRule(this.stateDir, ruleId, {
            coverageRate: metrics.coverageRate,
            falsePositiveRate: metrics.falsePositiveRate,
            updatedAt: readModel.generatedAt,
          });
      }

      updatePrinciple(this.stateDir, principleEvidence.principle.id, {
        adherenceRate: assessment.adherence.adherenceRate,
        updatedAt: readModel.generatedAt,
      });
      updatePrincipleValueMetrics(
        this.stateDir,
        principleEvidence.principle.id,
        createValueMetrics(
          principleEvidence,
          assessment.adherence,
          ledger.tree.metrics[principleEvidence.principle.id],
        ),
      );

      return {
        principleId: principleEvidence.principle.id,
        ruleMetrics: assessment.ruleMetrics,
        adherence: assessment.adherence,
        deprecatedReadiness: assessment.deprecatedReadiness,
        routeRecommendation: assessment.routeRecommendation,
      };
    });
  }
}
