/**
 * RunStore — abstract interface for run CRUD operations.
 *
 * 1 Task : N Runs. Each RunRecord tracks an individual execution attempt,
 * linked to a task via taskId.
 *
 * All run persistence goes through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { RunHandle, RunExecutionStatus } from '../../runtime-protocol.js';
import type { PDErrorCategory } from '../../error-categories.js';

/**
 * Information about a run row that failed schema validation.
 *
 * Returned (never thrown) by the tolerant accessors so callers on the
 * execution/completion path can keep working with the valid runs while
 * still observing which historical rows are malformed (ERR-002).
 */
export interface DegradedRunInfo {
  runId: string;
  error: string;
  rawRow: Record<string, unknown>;
}

/** Result of a tolerant run listing: valid runs plus any degraded rows. */
export interface TolerantRunListResult {
  runs: RunRecord[];
  degradedRuns: DegradedRunInfo[];
}

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

  /**
   * Tolerant variant of listRunsByTask: returns the valid runs AND any
   * degraded (schema-invalid) rows instead of throwing MalformedRunError.
   *
   * Used by the runner execution/completion path so that malformed
   * historical run rows do not block recovery of a task that has at
   * least one valid run (the one created by acquireLease). Callers MUST
   * observe non-empty `degradedRuns` via telemetry/notes (ERR-002).
   */
  listValidRunsByTaskTolerant(taskId: string): Promise<TolerantRunListResult>;

  /** Delete a run by ID. Returns true if a row was deleted. */
  deleteRun(runId: string): Promise<boolean>;
}
