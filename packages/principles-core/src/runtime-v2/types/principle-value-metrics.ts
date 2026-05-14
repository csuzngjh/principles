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
