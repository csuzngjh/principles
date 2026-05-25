/**
 * Lifecycle read model — re-export facade (PRI-56).
 *
 * All computation lives in @principles/core/runtime-v2.
 * This file re-exports types, the core builder, and provides
 * a backward-compatible path-based wrapper for existing consumers.
 */

// Re-export lifecycle types from core (PRI-51)
export type {
  LifecycleClassificationTotals,
  RuleReplayEvidence,
  RuleLiveEvidence,
  RuleLineageEvidence,
  ImplementationLifecycleEvidence,
  RuleLifecycleEvidence,
  PrincipleLifecycleEvidence,
  LifecycleReadModel,
} from '@principles/core/runtime-v2';

// Re-export core builder (PRI-56)
export { buildLifecycleReadModel } from '@principles/core/runtime-v2';

// Re-export adapter interface (PRI-56)
export type { LifecycleDatasource } from '@principles/core/runtime-v2';

// Re-export filesystem implementation (PRI-56)
export { FilesystemLifecycleDatasource, LineageSourceRetiredError } from './filesystem-lifecycle-datasource.js';

import { buildLifecycleReadModel } from '@principles/core/runtime-v2';
import { FilesystemLifecycleDatasource } from './filesystem-lifecycle-datasource.js';

/**
 * Backward-compatible wrapper — accepts directory paths like the original API.
 * Existing consumers (lifecycle-refresh, evolution-status, nocturnal-service)
 * continue using this without changes.
 */
export function buildLifecycleReadModelFromPaths(workspaceDir: string, stateDir: string) {
  return buildLifecycleReadModel(new FilesystemLifecycleDatasource(workspaceDir, stateDir));
}
