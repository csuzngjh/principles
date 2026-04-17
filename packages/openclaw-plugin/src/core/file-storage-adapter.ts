/**
 * FileStorageAdapter — file-backed implementation of StorageAdapter.
 *
 * Wraps principle-tree-ledger functions with the async StorageAdapter
 * contract. Uses withLockAsync for thread-safe mutateLedger with
 * retry with exponential backoff for lock acquisition (5 retries).
 * Write failures are logged via SystemLogger and re-thrown.
 *
 * Guarantees:
 * - Atomic writes via atomicWriteFileSync (temp + rename)
 * - Thread-safe concurrent access via file locks
 * - Consistent read-after-write visibility
 * - Write failures logged to SystemLogger and re-thrown
 */
import * as fs from 'fs';
import * as path from 'path';
import type { StorageAdapter } from './storage-adapter.js';
import type { HybridLedgerStore } from './principle-tree-ledger.js';
import { TREE_NAMESPACE } from './principle-tree-ledger.js';
import {
  loadLedger as loadLedgerFromFile,
  saveLedgerAsync,
} from './principle-tree-ledger.js';
import { withLockAsync, type LockOptions, LockAcquisitionError } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { SystemLogger } from './system-logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum retries for lock acquisition in mutateLedger. */
const MUTATE_RETRY_COUNT = 5;

/** Base delay in ms for exponential backoff between retries. */
const MUTATE_BACKOFF_BASE_MS = 50;

/** Maximum backoff delay in ms. */
const MUTATE_BACKOFF_MAX_MS = 500;

const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Serialize the hybrid ledger store to JSON.
 * Mirrors the unexported serializeLedger from principle-tree-ledger.ts.
 */
function serializeStore(store: HybridLedgerStore): string {
  return JSON.stringify(
    {
      ...store.trainingStore,
      [TREE_NAMESPACE]: {
        ...store.tree,
        lastUpdated: new Date().toISOString(),
      },
    },
    null,
    2,
  );
}

/** Ensure the parent directory exists before writing. */
function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// FileStorageAdapter
// ---------------------------------------------------------------------------

/**
 * File-system backed storage adapter for the principle ledger.
 *
 * Delegates read/write operations to principle-tree-ledger while providing
 * the async StorageAdapter interface. The mutateLedger method uses
 * withLockAsync with exponential backoff retry for robust concurrent access.
 */
export class FileStorageAdapter implements StorageAdapter {
  private readonly stateDir: string;
  private readonly workspaceDir: string | undefined;

  constructor(stateDir: string, workspaceDir?: string) {
    this.stateDir = stateDir;
    this.workspaceDir = workspaceDir;
  }

  /** Resolve the ledger file path for this state directory. */
  private get filePath(): string {
    return path.join(this.stateDir, PRINCIPLE_TRAINING_FILE);
  }

  /**
   * Load the current ledger state from the file system.
   *
   * Returns an empty store if no persisted state exists (first run).
   * Uses the synchronous loadLedger from principle-tree-ledger which
   * handles missing/corrupted files gracefully.
   */
  async loadLedger(): Promise<HybridLedgerStore> {
    return loadLedgerFromFile(this.stateDir);
  }

  /**
   * Persist the full ledger state atomically.
   *
   * Delegates to principle-tree-ledger's saveLedgerAsync which uses
   * withLockAsync internally. Logs failures via SystemLogger.
   */
  async saveLedger(store: HybridLedgerStore): Promise<void> {
    try {
      await saveLedgerAsync(this.stateDir, store);
    } catch (err) {
      SystemLogger.log(
        this.workspaceDir,
        'STORAGE_WRITE_FAILED',
        `FileStorageAdapter.saveLedger failed: ${String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Perform a read-modify-write cycle with automatic locking and retry.
   *
   * Uses withLockAsync to acquire a file lock, reads the current store,
   * applies the mutate function, then writes the modified store atomically.
   * On lock acquisition failure, retries up to MUTATE_RETRY_COUNT (5) times
   * with exponential backoff + jitter to reduce contention.
   *
   * Write failures are logged to SystemLogger and re-thrown so callers
   * can decide how to handle persistence errors.
   */
  async mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MUTATE_RETRY_COUNT; attempt++) {
      try {
        const lockOptions: LockOptions = {
          maxRetries: 3,
          baseRetryDelayMs: 10,
          maxRetryDelayMs: 200,
          lockStaleMs: 10_000,
        };

        const ledgerPath = this.filePath;

        return await withLockAsync(ledgerPath, async () => {
          const store = loadLedgerFromFile(this.stateDir);
          const result = await mutate(store);

          // Write directly — we already hold the lock, so we must NOT
          // call saveLedger/saveLedgerAsync (they try to acquire the same lock).
          try {
            ensureParentDir(ledgerPath);
            atomicWriteFileSync(ledgerPath, serializeStore(store));
          } catch (writeErr) {
            SystemLogger.log(
              this.workspaceDir,
              'STORAGE_WRITE_FAILED',
              `FileStorageAdapter.mutateLedger write failed: ${String(writeErr)}`,
            );
            throw writeErr;
          }

          return result;
        }, lockOptions);
      } catch (err) {
        lastError = err as Error;

        // Only retry on lock acquisition errors
        if (err instanceof LockAcquisitionError && attempt < MUTATE_RETRY_COUNT - 1) {
          const delay = Math.min(
            MUTATE_BACKOFF_BASE_MS * Math.pow(2, attempt),
            MUTATE_BACKOFF_MAX_MS,
          );
          // Add jitter (0-20%) to avoid thundering herd
          const jitter = delay * 0.2 * Math.random();
          const totalDelay = Math.floor(delay + jitter);

          await new Promise((resolve) => setTimeout(resolve, totalDelay));
          continue;
        }

        // Non-retryable error or exhausted retries
        SystemLogger.log(
          this.workspaceDir,
          'STORAGE_MUTATE_FAILED',
          `FileStorageAdapter.mutateLedger failed after ${attempt + 1} attempts: ${String(err)}`,
        );
        throw err;
      }
    }

    // Should not reach here, but satisfy the type checker
    throw lastError ?? new Error('FileStorageAdapter.mutateLedger: unexpected state');
  }
}
