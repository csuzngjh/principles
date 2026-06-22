/**
 * Ledger store types — pure type definitions, no I/O.
 *
 * Extracted from principle-tree-ledger.ts (PRI-443) to separate pure types
 * from filesystem operations. This module has zero fs/path imports and
 * can be consumed by any layer without pulling in I/O dependencies.
 *
 * IMPORTANT: The Principle/Rule/Implementation/PrincipleValueMetrics types
 * defined here are the LEDGER versions (simpler, file-based). They differ
 * from the richer principle-schema.ts versions used by lifecycle computation.
 * They are intentionally separate to avoid coupling the ledger to schema
 * requirements that the file-based store does not enforce.
 */

export type PrincipleStatus = 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';
export type PrinciplePriority = 'P0' | 'P1' | 'P2';
export type PrincipleScope = 'general' | 'domain';
export type PrincipleEvaluability = 'manual_only' | 'deterministic' | 'weak_heuristic';

export interface Principle {
  id: string;
  version: number;
  text: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Rule {
  id: string;
  principleId: string;
  ruleIds: string[];
  implementationIds: string[];
  type?: string;
  status?: string;
  lifecycleState?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Implementation {
  id: string;
  ruleId: string;
  type?: string;
  lifecycleState?: string;
  [key: string]: unknown;
}

export interface PrincipleValueMetrics {
  principleId: string;
  painPreventedCount?: number;
  lastPainPreventedAt?: string;
  avgPainSeverityPrevented?: number;
  totalOpportunities?: number;
  adheredCount?: number;
  violatedCount?: number;
  implementationCost?: number;
  benefitScore?: number;
  calculatedAt?: string;
}

export interface LedgerPrinciple extends Principle {
  suggestedRules?: string[];
  lastTriggeredAt?: string;
}

export interface LedgerRule extends Rule {
  implementationIds: string[];
}

export interface LedgerTreeStore {
  principles: Record<string, LedgerPrinciple>;
  rules: Record<string, LedgerRule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}

export interface LegacyPrincipleTrainingState {
  principleId: string;
  evaluability: 'deterministic' | 'weak_heuristic' | 'manual_only';
  applicableOpportunityCount: number;
  observedViolationCount: number;
  complianceRate: number;
  violationTrend: number;
  generatedSampleCount: number;
  approvedSampleCount: number;
  includedTrainRunIds: string[];
  deployedCheckpointIds: string[];
  lastEvalScore?: number;
  internalizationStatus:
    | 'prompt_only'
    | 'needs_training'
    | 'in_training'
    | 'deployed_pending_eval'
    | 'internalized'
    | 'regressed';
}

export type LegacyPrincipleTrainingStore = Record<string, LegacyPrincipleTrainingState>;

export interface HybridLedgerStore {
  trainingStore: LegacyPrincipleTrainingStore;
  tree: LedgerTreeStore;
}

export const TREE_NAMESPACE = '_tree';
