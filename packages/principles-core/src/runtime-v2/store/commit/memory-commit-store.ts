/**
 * CommitStore — in-memory test double using a Map.
 */
import type { CommitRecord, CommitStore } from './commit-store.js';

export class MemoryCommitStore implements CommitStore {
  private readonly commits = new Map<string, CommitRecord>();

  /**
   * Returns the first commit for the task by insertion order.
   * Note: SQLite version uses ORDER BY created_at DESC LIMIT 1 (newest first).
   * This test double returns the first match for simplicity.
   */
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
