/**
 * RunStore — abstract interface for run CRUD operations.
 *
 * 1 Task : N Runs. Each RunRecord tracks an individual execution attempt,
 * linked to a task via taskId.
 *
 * All run persistence goes through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { RunHandle, RunExecutionStatus } from '../runtime-protocol.js';
import type { PDErrorCategory } from '../error-categories.js';

export interface RunRecord extends RunHandle {
  taskId: string;
  attemptNumber: number;
  executionStatus: RunExecutionStatus;
  endedAt?: string;
  reason?: string;
  outputRef?: string;
  createdAt: string;
  updatedAt: string;
  inputPayload?: string;
  outputPayload?: string;
  errorCategory?: PDErrorCategory;
}

export interface RunStore {
  /**
   * Create a new run record.
   * createdAt / updatedAt are set by the store implementation.
   */
  createRun(record: Omit<RunRecord, 'createdAt' | 'updatedAt'>): Promise<RunRecord>;

  /** Fetch a single run by ID. Returns null if not found. */
  getRun(runId: string): Promise<RunRecord | null>;

  /**
   * Apply a partial update to a run. Returns the updated record.
   * @throws PDRuntimeError{storage_unavailable} if the run does not exist.
   */
  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'endedAt' | 'reason' | 'outputRef' | 'outputPayload' | 'errorCategory' | 'executionStatus'>>,
  ): Promise<RunRecord>;

  /** List all runs for a task, ordered by startedAt ascending. */
  listRunsByTask(taskId: string): Promise<RunRecord[]>;

  /** Delete a run by ID. Returns true if a row was deleted. */
  deleteRun(runId: string): Promise<boolean>;
}
