/**
 * Principle Tree Ledger — plugin adapter (re-export) over @principles/core.
 *
 * PRI-459: This file WAS a full duplicate implementation of
 * principle_training_state.json parsing / serialization / mutation (~600
 * lines of inlined parsers, serializers, mutators, and a parallel codec).
 * That dual ownership caused two real failure classes:
 *
 *   1. Lost updates — core wrote the file UNLOCKED, the plugin wrote it WITH
 *      a lock, and neither knew the other's lock. Concurrent writers (e.g.
 *      evolution-worker async + a pd-cli command) could silently drop edits.
 *   2. Silent field loss — the two codecs parsed the same bytes at different
 *      strictness; a field one side persisted could be dropped on the next
 *      load by the other.
 *
 * Both are now fixed by converging on a SINGLE source of truth in core:
 *   - parse/serialize: @principles/core/runtime-v2/principle-tree/ledger-codec
 *   - mutation (with cross-process file lock): @principles/core/principle-tree-ledger
 *
 * This file is now a thin re-export so existing relative imports
 * (`from './principle-tree-ledger.js'`) keep resolving. Consumers get the
 * exact same API surface, now backed by the locked core implementation.
 *
 * Do NOT reintroduce parsing / serialization / mutation logic here. The
 * architecture-regression guard "PRI-459: single principle_training_state
 * ledger implementation" enforces this.
 */
export {
  // Types
  type Principle,
  type Rule,
  type Implementation,
  type PrincipleValueMetrics,
  type LedgerPrinciple,
  type LedgerRule,
  type LedgerTreeStore,
  type LegacyPrincipleTrainingState,
  type LegacyPrincipleTrainingStore,
  type HybridLedgerStore,
  type ImplementationLifecycleState,
  type PrincipleSubtree,
  // Constants
  TREE_NAMESPACE,
  // Lock
  LockAcquisitionError,
  // I/O + mutators
  loadLedger,
  saveLedger,
  saveLedgerAsync,
  updateTrainingStore,
  addPrincipleToLedger,
  createRule,
  createImplementation,
  updatePrinciple,
  updateRule,
  deleteRule,
  updateImplementation,
  deleteImplementation,
  listImplementationsForRule,
  getPrincipleSubtree,
  updatePrincipleValueMetrics,
  // Lifecycle
  isValidLifecycleTransition,
  getAllowedTransitions,
  transitionImplementationState,
  listRuleImplementationsByState,
  findActiveImplementation,
} from '@principles/core/principle-tree-ledger';

// Back-compat alias: the historical plugin module exported `getLedgerFilePath`
// (core names it `getLedgerFilePathPublic` for the same path). Keep the old
// name resolvable for any consumer still on it; both compute
// path.join(stateDir, 'principle_training_state.json').
import { getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
export const getLedgerFilePath = getLedgerFilePathPublic;
