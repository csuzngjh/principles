/**
 * StorageAdapter interface for the Evolution SDK.
 *
 * This interface decouples the evolution engine from specific persistence
 * implementations (file system, SQLite, remote API). All higher-level
 * modules that need to read or mutate the principle ledger should depend
 * on this interface rather than importing principle-tree-ledger directly.
 *
 * The interface uses HybridLedgerStore from principle-tree-ledger as the
 * canonical store shape, but future adapters can map alternative backends
 * to this shape.
 */
import type { HybridLedgerStore } from './principle-tree-ledger.js';

// ---------------------------------------------------------------------------
// StorageAdapter Interface
// ---------------------------------------------------------------------------

/**
 * Abstract storage adapter for the principle ledger.
 *
 * Implementations must guarantee:
 * - Atomic writes (no partial/corrupted state on crash)
 * - Thread-safe concurrent access (locking or equivalent)
 * - Consistent read-after-write visibility
 *
 * The `mutateLedger` method is the preferred way to perform read-modify-write
 * cycles. It encapsulates locking so callers never need to manage it.
 */
export interface StorageAdapter {
  /**
   * Load the current ledger state from persistence.
   *
   * If no persisted state exists (first run), returns an empty store.
   */
  loadLedger(): Promise<HybridLedgerStore>;

  /**
   * Persist the full ledger state.
   *
   * Must be atomic — partial writes must never be visible to readers.
   */
  saveLedger(store: HybridLedgerStore): Promise<void>;

  /**
   * Perform a read-modify-write cycle with automatic locking.
   *
   * The `mutate` function receives the current store and may return a
   * value synchronously or via Promise. The store is persisted after
   * the mutate function resolves, regardless of its return value.
   *
   * If two concurrent `mutateLedger` calls overlap, one must wait for
   * the other to complete (pessimistic locking) or retry on conflict
   * (optimistic locking). The choice is left to the implementation.
   *
   * @example
   * ```ts
   * const count = await adapter.mutateLedger((store) => {
   *   store.tree.principles['p-1'] = newPrinciple;
   *   return Object.keys(store.tree.principles).length;
   * });
   * ```
   */
  mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T>;
}
