/**
 * TaskStore — in-memory test double using a Map.
 */
import type { TaskRecord } from '../../task-status.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const full: TaskRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.taskId, full);
    return full;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord> {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as TaskRecord;
    this.tasks.set(taskId, updated);
    return updated;
  }

  async updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
  ): Promise<TaskRecord | null> {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    if ((existing.diagnosticJson ?? null) !== expectedDiagnosticJson) return null;
    return this.updateTask(taskId, patch);
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    let results = [...this.tasks.values()];
    if (filter?.status) results = results.filter((t) => t.status === filter.status);
    if (filter?.taskKind) results = results.filter((t) => t.taskKind === filter.taskKind);
    // Parity with SqliteTaskStore (A-liveness): silently ignoring
    // orderBy/afterCursor here would make cursor-based scans return wrong
    // pages under the memory store — a rc-9 silent degradation.
    if (filter?.afterCursor) {
      if (filter.orderBy !== 'updated_at_asc' && filter.orderBy !== 'updated_at_desc') {
        throw new Error('MemoryTaskStore.listTasks: afterCursor requires orderBy updated_at_asc|desc');
      }
      const { updatedAt, taskId } = filter.afterCursor;
      results = results.filter((t) => filter.orderBy === 'updated_at_asc'
        ? (t.updatedAt > updatedAt || (t.updatedAt === updatedAt && t.taskId > taskId))
        : (t.updatedAt < updatedAt || (t.updatedAt === updatedAt && t.taskId < taskId)));
    }
    if (filter?.orderBy === 'updated_at_asc') {
      results.sort((a, b) => a.updatedAt === b.updatedAt ? (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) : (a.updatedAt < b.updatedAt ? -1 : 1));
    } else if (filter?.orderBy === 'updated_at_desc') {
      results.sort((a, b) => a.updatedAt === b.updatedAt ? (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0) : (a.updatedAt > b.updatedAt ? -1 : 1));
    }
    if (filter?.offset) results = results.slice(filter.offset);
    if (filter?.limit) results = results.slice(0, filter.limit);
    return results;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  clear(): void {
    this.tasks.clear();
  }
}
