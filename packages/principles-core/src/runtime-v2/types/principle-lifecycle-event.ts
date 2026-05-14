import { Type, type Static } from '@sinclair/typebox';
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

export const PrincipleEventTypeSchema = Type.Union([
  Type.Literal('principle_created'),
  Type.Literal('principle_updated'),
  Type.Literal('principle_promoted'),
  Type.Literal('principle_deprecated'),
  Type.Literal('rule_created'),
  Type.Literal('rule_enforced'),
  Type.Literal('rule_retired'),
  Type.Literal('implementation_added'),
  Type.Literal('value_metrics_updated'),
]);

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

export const PrincipleLifecycleEventSchema = Type.Object({
  ts: Type.String(),
  type: PrincipleEventTypeSchema,
  data: Type.Object({
    principleId: Type.Optional(Type.String()),
    ruleId: Type.Optional(Type.String()),
    implementationId: Type.Optional(Type.String()),
    reason: Type.String(),
    metrics: Type.Optional(Type.Record(Type.String(), Type.Any())),
  }),
});
export type PrincipleLifecycleEventStatic = Static<typeof PrincipleLifecycleEventSchema>;
