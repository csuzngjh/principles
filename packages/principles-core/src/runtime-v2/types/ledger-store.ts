/**
 * Ledger store types — pure type definitions, no I/O.
 *
 * Extracted from principle-tree-ledger.ts (PRI-443) to separate pure types
 * from filesystem operations. This module has zero fs/path imports and
 * can be consumed by any layer without pulling in I/O dependencies.
 *
 * PRI-459: The ledger `Principle` and its enums are now re-exported from the
 * rich `principle-schema.ts` / `principle-enums.ts` SSOT. Historically the
 * ledger declared its own narrower copy and the openclaw-plugin's
 * `LedgerPrinciple` was built on the rich schema, so consumers (e.g.
 * evolution-worker reading `compilationRetryCount`) depended on rich fields
 * that the narrow ledger type silently lacked at the type level (the values
 * survived at runtime via the codec's `{...value}` spread). Aligning the
 * ledger type with the rich schema removes that drift: one Principle type,
 * matching what the file actually stores. Rule/Implementation/PrincipleValue
 * Metrics remain ledger-specific shapes.
 */

// Single source of truth for enums (principle-enums.ts) and the Principle
// entity (principle-schema.ts). Principle is aligned with the rich schema
// (PRI-459) because consumers read rich-only fields like compilationRetryCount.
// Rule / Implementation / PrincipleValueMetrics stay ledger-specific narrow
// shapes — they are intentionally looser than the rich schema (a candidate
// implementation created at intake only has id/ruleId/lifecycleState), so the
// codec can store partial entities.
export type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  ImplementationLifecycleState,
} from './principle-enums.js';
export type { Principle } from './principle-schema.js';

// Re-import for local use below (LedgerPrinciple extends Principle;
// Implementation.lifecycleState uses ImplementationLifecycleState).
import type { Principle } from './principle-schema.js';
import type { ImplementationLifecycleState } from './principle-enums.js';

export interface Rule {
  id: string;
  principleId: string;
  // ruleIds = child rules (nesting). Leaf rules (the common case, e.g. a
  // compiled gate) have none, so this is optional. parseRules in the codec
  // normalizes absent → [].
  ruleIds?: string[];
  implementationIds: string[];
  type?: string;
  status?: string;
  lifecycleState?: string;
  createdAt?: string;
  updatedAt?: string;
  // PRI-459: rich-schema Rule fields that ledger consumers (bootstrap-rules,
  // ledger-registrar, principle-lifecycle-service) write. Kept optional so the
  // narrow ledger shape still allows minimal rule creation.
  version?: number;
  name?: string;
  description?: string;
  triggerCondition?: string;
  enforcement?: string;
  action?: string;
  coverageRate?: number;
  falsePositiveRate?: number;
}

export interface Implementation {
  id: string;
  ruleId: string;
  type?: string;
  lifecycleState?: ImplementationLifecycleState;
  // PRI-459: rich-schema Implementation fields that ledger consumers
  // (promote/rollback/archive/disable commands) read. Optional because a
  // candidate implementation created at intake does not carry all of them.
  previousActive?: string;
  version?: string;
  disabledReason?: string;
  disabledAt?: string;
  disabledBy?: string;
  [key: string]: unknown;
}

// NOTE: ledger PrincipleValueMetrics is intentionally PARTIAL (all metric
// fields optional) — unlike the richer principle-value-metrics.ts version
// used by lifecycle computation. A principle may have no metrics recorded
// yet, so parseMetrics builds a partial object and the file stores whatever
// subset exists. Do NOT align this with the required-field rich version.
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
  // PRI-459: detector metadata is written by the evolution reducer and lives
  // as a plugin-side structure (PrincipleDetectorSpec). Kept as unknown here so
  // the core ledger type does not couple to the plugin type; the codec's
  // {...value} spread preserves it on disk regardless.
  detectorMetadata?: unknown;
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
