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
   * to `expectedDiagnosticJson` (null matches a NULL column). Single SQL
   * conditional mutation — no read→JS-compare→write race window. Returns the
   * updated record on success, or null when the precondition failed (task
   * missing or diagnostic_json changed concurrently).
   */
  updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
  ): Promise<TaskRecord | null>;

  /** List tasks with optional filter. */
  listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;

  /** Delete a task by ID. Returns true if a row was deleted. */
  deleteTask(taskId: string): Promise<boolean>;
}
