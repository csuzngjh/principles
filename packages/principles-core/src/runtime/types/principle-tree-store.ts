import { Type, type Static } from '@sinclair/typebox';
import type { Principle, Rule, Implementation } from './principle-schema.js';
import type { PrincipleValueMetrics } from './principle-value-metrics.js';
import { PrincipleSchema, RuleSchema, ImplementationSchema } from './principle-schema.js';
import { PrincipleValueMetricsSchema } from './principle-value-metrics.js';

export interface PrincipleTreeStore {
  principles: Record<string, Principle>;
  rules: Record<string, Rule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}

export const PrincipleTreeStoreSchema = Type.Object({
  principles: Type.Record(Type.String(), PrincipleSchema),
  rules: Type.Record(Type.String(), RuleSchema),
  implementations: Type.Record(Type.String(), ImplementationSchema),
  metrics: Type.Record(Type.String(), PrincipleValueMetricsSchema),
  lastUpdated: Type.String(),
});
export type PrincipleTreeStoreStatic = Static<typeof PrincipleTreeStoreSchema>;
