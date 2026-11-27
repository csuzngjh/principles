/**
 * TaskStore — abstract interface for task CRUD operations.
 *
 * All task persistence goes through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { TaskRecord } from '../../task-status.js';
import type { PDTaskStatus } from '../../task-status.js';

export interface TaskStoreFilter {
  status?: PDTaskStatus;
  /** Multi-status membership filter. Used by bounded repair scans that must
   * cover legacy rows already moved to retry_wait without widening the page
   * to terminal/leased tasks. */
  statuses?: readonly PDTaskStatus[];
  taskKind?: string;
  /** Filter tasks whose lease_expires_at is before this ISO timestamp. */
  leaseExpiresAtBefore?: string;
  limit?: number;
  offset?: number;
  /**
   * Stable total order for pagination-backed scans (A-liveness). Only this
   * ordering is legal to combine with afterCursor — cursor pagination on a
   * non-deterministic ORDER BY silently skips/duplicates rows.
   */
  orderBy?: 'updated_at_asc' | 'updated_at_desc';
  /**
   * Exclusive tuple cursor: rows strictly after (updatedAt, taskId) under the
   * selected orderBy. Requires orderBy to be set.
   */
  afterCursor?: { updatedAt: string; taskId: string };
  /**
   * PRI-1274 (B1 / P1-3): match tasks whose `diagnostic_json.recovery.state`
   * equals this value (e.g. `waiting_for_target_evidence`). Applied in the
   * SAME WHERE clause as status/kind — before any ORDER BY/LIMIT — so the
   * candidate picker never spends its bounded window on ineligible rows.
   */
  recoveryState?: string;
  /**
   * PRI-1274 (B1 / P1-3): exclude tasks whose `diagnostic_json.recovery.state`
   * is one of these values. Applied in the SAME WHERE clause — before any
   * ORDER BY/LIMIT — so a waiting task cannot displace an admissible one
   * inside the picker's bounded LIMIT window.
   */
  excludeRecoveryStates?: readonly string[];
  /**
   * PRI-1296: match tasks whose root `diagnostic_json.hostKind` equals this
   * governed host. Applied in the SAME WHERE clause before ORDER BY/LIMIT so
   * a host-scoped bounded scan only spends its window on its own candidates.
   */
  diagnosticHostKind?: string;
  /**
   * Exact PI metadata parent task id filter (`$.pi_metadata.parentTaskId`).
   * Missing/null values never match, including when the filter is an empty string.
   */
  piParentTaskId?: string;
  /**
   * Exact PI metadata channel filter (`$.pi_metadata.channel`).
   * Missing/null values never match, including when the filter is an empty string.
   */
  piChannel?: string;
}

/** Narrow patch type — only the fields that are mutable in practice.
 *
 * `undefined` means "do not change this field".
 * `null` means "explicitly set this field to NULL / clear it".
 */
export type TaskStoreUpdatePatch = Partial<
  Pick<
    TaskRecord,
    | 'status'
    | 'attemptCount'
    | 'maxAttempts'
    | 'updatedAt'
  >
> & {
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: TaskRecord['lastError'] | null;
  inputRef?: string | null;
  resultRef?: string | null;
  diagnosticJson?: string | null;
};

export interface TaskStore {
  /**
   * Create a new task record.
   * createdAt / updatedAt are set by the store implementation.
   */
  createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord>;

  /** Fetch a single task by ID. Returns null if not found. */
  getTask(taskId: string): Promise<TaskRecord | null>;

  /**
   * Apply a partial update to a task. Returns the updated record.
   * @throws PDRuntimeError{storage_unavailable} if the task does not exist.
   */
  updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord>;

  /**
   * Narrow compare-and-swap (PRI-629 owner-resolution concurrency):
   * apply `patch` only when the task's current diagnostic_json is byte-equal
   * to `expectedDiagnosticJson` (null matches a NULL column) — and, when
   * `options.expectedStatus` is given (PRI-983, SPEC-PD-IAER-001 §6.3), only
   * while the task still sits in that status. PRI-991 (P1-04) extends the
   * same single conditional UPDATE with the remaining decision-snapshot
   * preconditions (attempt budget / maxAttempts / lease owner + expiry) so a
   * caller whose decision depends on those fields cannot be raced by a
   * writer that leaves status and metadata untouched. Single conditional
   * mutation — no read→JS-compare→write race window. Returns the updated
   * record on success, or null when any precondition failed (task missing,
   * diagnostic_json changed, or the status/fields moved concurrently). The
   * status precondition arbitrates resets whose metadata write is
   * content-neutral (e.g. an authority reset with nothing to clear).
   */
  updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
    options?: {
      readonly expectedStatus?: string;
      readonly expectedAttemptCount?: number;
      readonly expectedMaxAttempts?: number;
      readonly expectedLeaseOwner?: string | null;
      readonly expectedLeaseExpiresAt?: string | null;
      /** PRI-1274 review round 2 (directive G1): lease generation fencing. */
      readonly expectedLeaseGeneration?: number;
    },
  ): Promise<TaskRecord | null>;

  /** List tasks with optional filter. */
  listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;

  /**
   * Run a logical read-check-write unit inside the store's write-serializing
   * transaction boundary. SQLite implementations use BEGIN IMMEDIATE so
   * independent connections cannot interleave lookup and insert. Nested calls
   * join the already-active unit; implementations serialize top-level units.
   */
  withWriteTransaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Delete a task by ID. Returns true if a row was deleted. */
  deleteTask(taskId: string): Promise<boolean>;
}
