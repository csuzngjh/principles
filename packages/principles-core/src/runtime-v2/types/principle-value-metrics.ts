import { Type, type Static } from '@sinclair/typebox';

export interface PrincipleValueMetrics {
  principleId: string;
  painPreventedCount: number;
  avgPainSeverityPrevented: number;
  lastPainPreventedAt?: string;
  totalOpportunities: number;
  adheredCount: number;
  violatedCount: number;
  implementationCost: number;
  benefitScore: number;
  calculatedAt: string;
}

export const PrincipleValueMetricsSchema = Type.Object({
  principleId: Type.String(),
  painPreventedCount: Type.Number(),
  avgPainSeverityPrevented: Type.Number(),
  lastPainPreventedAt: Type.Optional(Type.String()),
  totalOpportunities: Type.Number(),
  adheredCount: Type.Number(),
  violatedCount: Type.Number(),
  implementationCost: Type.Number(),
  benefitScore: Type.Number(),
  calculatedAt: Type.String(),
});
export type PrincipleValueMetricsStatic = Static<typeof PrincipleValueMetricsSchema>;
