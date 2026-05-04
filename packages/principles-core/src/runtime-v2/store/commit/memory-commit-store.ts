/**
 * CommitStore — in-memory test double using a Map.
 */
import type { CommitRecord, CommitStore } from './commit-store.js';

export class MemoryCommitStore implements CommitStore {
  private readonly commits = new Map<string, CommitRecord>();

  async getCommitByTaskId(taskId: string): Promise<CommitRecord | null> {
    return [...this.commits.values()].find((c) => c.taskId === taskId) ?? null;
  }

  insert(record: CommitRecord): void {
    this.commits.set(record.commitId, record);
  }

  clear(): void {
    this.commits.clear();
  }
}
