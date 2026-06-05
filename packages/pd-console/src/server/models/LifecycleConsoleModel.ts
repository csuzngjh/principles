import {
  buildLifecycleReadModel,
  computePrincipleAdherence,
  computeRuleMetrics,
} from '@principles/core/runtime-v2';
import type { RuleMetricResult } from '@principles/core/runtime-v2';
import { ConsoleLifecycleDatasource } from './ConsoleLifecycleDatasource.js';

export interface LifecycleMetricsResponse {
  principleId: string;
  adherence: {
    insufficientData: boolean;
    rate: number | null;
    note: string;
  };
  ruleMetrics: {
    ruleId: string;
    triggered: number;
    lastTriggeredAt: string | null;
  }[];
}

export class LifecycleConsoleModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = `${workspaceDir}/.state`;
  }

  getLifecycleMetrics(principleId: string): LifecycleMetricsResponse | null {
    const datasource = new ConsoleLifecycleDatasource(this.workspaceDir, this.stateDir);
    const readModel = buildLifecycleReadModel(datasource);

    const principle = readModel.principles.find((p) => p.principle.id === principleId);
    if (!principle) return null;

    const ruleMetricsMap: Record<string, RuleMetricResult> = {};
    for (const rule of principle.rules) {
      ruleMetricsMap[rule.rule.id] = computeRuleMetrics(rule);
    }

    const adherence = computePrincipleAdherence(principle, ruleMetricsMap);

    // Build ruleMetrics array from lifecycle evidence
    const ruleMetrics: LifecycleMetricsResponse['ruleMetrics'] = principle.rules.map((rule) => {
      const triggered = rule.replayEvidence.reportCount;
      const latestReport = rule.replayEvidence.latestReports.length > 0
        ? rule.replayEvidence.latestReports[0]
        : null;
      const lastTriggeredAt = latestReport?.generatedAt ?? null;
      return {
        ruleId: rule.rule.id,
        triggered,
        lastTriggeredAt,
      };
    });

    if (adherence.insufficientData) {
      return {
        principleId,
        adherence: {
          insufficientData: true,
          rate: null,
          note: '该原则尚无规则，无法计算依从率',
        },
        ruleMetrics,
      };
    }

    return {
      principleId,
      adherence: {
        insufficientData: false,
        rate: adherence.adherenceRate,
        note: '',
      },
      ruleMetrics,
    };
  }
}
