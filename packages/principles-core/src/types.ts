/**
 * Duplicated type shapes for principles-core.
 *
 * These types are minimal shapes duplicated from openclaw-plugin to avoid
 * cross-package imports. principles-core must NOT depend on openclaw-plugin.
 *
 * MAINTENANCE CONTRACT: When updating these types, also update the corresponding
 * source types in openclaw-plugin and vice-versa. These are the same shapes --
 * drift between them will cause subtle storage/pipeline bugs.
 *
 * Source locations:
 * - InjectablePrinciple  -> openclaw-plugin/src/core/principle-injection.ts
 * - HybridLedgerStore     -> openclaw-plugin/src/core/principle-tree-ledger.ts
 */

/**
 * Minimal InjectablePrinciple shape for principle injection.
 * Must stay in sync with openclaw-plugin/src/core/principle-injection.ts.
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
 * Must stay in sync with openclaw-plugin/src/core/principle-tree-ledger.ts.
 *
 * Note: tree.* fields use `unknown` to avoid importing the actual node types.
 * This is an intentional trade-off -- StorageAdapter implementations must
 * be careful to validate the shape of objects they store/retrieve.
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
