/**
 * RunStore interface stub.
 *
 * This is a placeholder interface for type use. The actual RunStore interface
 * and SqliteRunStore implementation are created by plan m2-02.
 *
 * @see m2-02-PLAN.md Task 1 for full implementation
 */
import type { RunHandle, RunExecutionStatus } from '../runtime-protocol.js';
import type { PDErrorCategory } from '../error-categories.js';

export interface RunRecord extends RunHandle {
  taskId: string;
  attemptNumber: number;
  inputPayload?: string;
  outputPayload?: string;
  errorCategory?: PDErrorCategory;
  reason?: string;
  endedAt?: string;
  executionStatus: RunExecutionStatus;
}

export interface RunStore {
  createRun(record: Omit<RunRecord, never>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'executionStatus' | 'endedAt' | 'reason' | 'outputPayload' | 'errorCategory'>>,
  ): Promise<RunRecord>;
  listRunsByTask(taskId: string): Promise<RunRecord[]>;
  deleteRun(runId: string): Promise<boolean>;
}
