import type { PrincipleValueMetrics } from './principle-value-metrics.js';

export type PrincipleEventType =
  | 'principle_created'
  | 'principle_updated'
  | 'principle_promoted'
  | 'principle_deprecated'
  | 'rule_created'
  | 'rule_enforced'
  | 'rule_retired'
  | 'implementation_added'
  | 'value_metrics_updated';

export interface PrincipleLifecycleEvent {
  ts: string;
  type: PrincipleEventType;
  data: {
    principleId?: string;
    ruleId?: string;
    implementationId?: string;
    reason: string;
    metrics?: Partial<PrincipleValueMetrics>;
  };
}
