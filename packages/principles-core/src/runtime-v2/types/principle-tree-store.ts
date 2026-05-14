import type { Principle, Rule, Implementation } from './principle-schema.js';
import type { PrincipleValueMetrics } from './principle-value-metrics.js';

export interface PrincipleTreeStore {
  principles: Record<string, Principle>;
  rules: Record<string, Rule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}
