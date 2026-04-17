/**
 * Duplicated type shapes for principles-core.
 *
 * These types are minimal shapes duplicated from openclaw-plugin to avoid
 * cross-package imports. principles-core must NOT depend on openclaw-plugin.
 *
 * DO NOT import from openclaw-plugin here.
 */

/**
 * Minimal InjectablePrinciple shape for principle injection.
 * Duplicated from openclaw-plugin/src/core/principle-injection.ts.
 */
export interface InjectablePrinciple {
  id: string;
  text: string;
  /** Priority level. Defaults to 'P1' if not set by the source. */
  priority?: 'P0' | 'P1' | 'P2';
  createdAt: string;
}

/**
 * Minimal HybridLedgerStore shape for storage adapter interface.
 * Duplicated from openclaw-plugin/src/core/principle-tree-ledger.ts.
 */
export interface HybridLedgerStore {
  trainingStore: Record<string, {
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
    internalizationStatus: 'prompt_only' | 'needs_training' | 'in_training' | 'deployed_pending_eval' | 'internalized' | 'regressed';
  }>;
  tree: {
    principles: Record<string, unknown>;
    rules: Record<string, unknown>;
    implementations: Record<string, unknown>;
    metrics: Record<string, unknown>;
    lastUpdated: string;
  };
}
