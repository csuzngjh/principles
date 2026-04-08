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

export interface RecomputedPrincipleLifecycle {
  principleId: string;
  ruleMetrics: Record<string, RuleMetricResult>;
  adherence: PrincipleAdherenceResult;
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
  constructor(
    private readonly workspaceDir: string,
    private readonly stateDir: string,
  ) {}

  buildReadModel(): LifecycleReadModel {
    return buildLifecycleReadModel(this.workspaceDir, this.stateDir);
  }

  recomputeAll(): RecomputedPrincipleLifecycle[] {
    const ledger = loadLedger(this.stateDir);
    const readModel = this.buildReadModel();

    return readModel.principles.map((principleEvidence) => {
      const ruleMetrics = Object.fromEntries(
        principleEvidence.rules.map((ruleEvidence) => {
          const metrics = computeRuleMetrics(ruleEvidence);
          updateRule(this.stateDir, ruleEvidence.rule.id, {
            coverageRate: metrics.coverageRate,
            falsePositiveRate: metrics.falsePositiveRate,
            updatedAt: readModel.generatedAt,
          });
          return [ruleEvidence.rule.id, metrics];
        }),
      ) as Record<string, RuleMetricResult>;

      const adherence = computePrincipleAdherence(principleEvidence, ruleMetrics);

      updatePrinciple(this.stateDir, principleEvidence.principle.id, {
        adherenceRate: adherence.adherenceRate,
        updatedAt: readModel.generatedAt,
      });
      updatePrincipleValueMetrics(
        this.stateDir,
        principleEvidence.principle.id,
        createValueMetrics(
          principleEvidence,
          adherence,
          ledger.tree.metrics[principleEvidence.principle.id],
        ),
      );

      return {
        principleId: principleEvidence.principle.id,
        ruleMetrics,
        adherence,
      };
    });
  }
}
