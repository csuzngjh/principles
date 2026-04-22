/**
 * TaskStore interface stub.
 *
 * This is a placeholder interface for type use. The actual TaskStore interface
 * and SqliteTaskStore implementation are created by plan m2-01.
 *
 * @see m2-01-PLAN.md Task 1 for full implementation
 */
import type { TaskRecord } from '../task-status.js';

export interface TaskStore {
  getTask(taskId: string): Promise<TaskRecord>;
  updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'leaseOwner' | 'leaseExpiresAt' | 'attemptCount' | 'lastError'>>,
  ): Promise<TaskRecord>;
}
