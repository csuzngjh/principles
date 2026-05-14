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

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    let results = [...this.tasks.values()];
    if (filter?.status) results = results.filter((t) => t.status === filter.status);
    if (filter?.taskKind) results = results.filter((t) => t.taskKind === filter.taskKind);
    return results;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  clear(): void {
    this.tasks.clear();
  }
}
