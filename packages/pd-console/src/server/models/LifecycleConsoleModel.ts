import {
  buildLifecycleReadModel,
  computePrincipleAdherence,
  computeRuleMetrics,
} from '@principles/core/runtime-v2';
import type { RuleMetricResult } from '@principles/core/runtime-v2';
import { ConsoleLifecycleDatasource } from './ConsoleLifecycleDatasource.js';

export interface LifecycleMetricsResponse {
  principleId: string;
  adherenceRate: number | null;
  insufficientData: boolean;
  note?: string;
  ruleMetrics: Record<string, RuleMetricResult>;
  generatedAt: string;
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

    const ruleMetrics: Record<string, RuleMetricResult> = {};
    for (const rule of principle.rules) {
      ruleMetrics[rule.rule.id] = computeRuleMetrics(rule);
    }

    const adherence = computePrincipleAdherence(principle, ruleMetrics);

    if (adherence.insufficientData) {
      return {
        principleId,
        adherenceRate: null,
        insufficientData: true,
        note: '该原则尚无规则，无法计算依从率',
        ruleMetrics,
        generatedAt: readModel.generatedAt,
      };
    }

    return {
      principleId,
      adherenceRate: adherence.adherenceRate,
      insufficientData: false,
      ruleMetrics,
      generatedAt: readModel.generatedAt,
    };
  }
}
