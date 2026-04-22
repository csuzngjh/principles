/**
 * TaskStore — abstract interface for task CRUD operations.
 *
 * All task persistence goes through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { TaskRecord } from '../task-status.js';
import type { PDTaskStatus } from '../task-status.js';

export interface TaskStoreFilter {
  status?: PDTaskStatus;
  taskKind?: string;
  /** Filter tasks whose lease_expires_at is before this ISO timestamp. */
  leaseExpiresAtBefore?: string;
  limit?: number;
  offset?: number;
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

  /** List tasks with optional filter. */
  listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;

  /** Delete a task by ID. Returns true if a row was deleted. */
  deleteTask(taskId: string): Promise<boolean>;
}
