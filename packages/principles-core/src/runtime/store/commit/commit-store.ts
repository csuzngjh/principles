/**
 * CommitStore — abstract interface for commit record queries.
 */
export interface CommitRecord {
  commitId: string;
  taskId: string;
  runId: string;
  artifactId: string;
  idempotencyKey: string;
  status: string;
  createdAt: string;
}

export interface CommitStore {
  /**
   * Returns the most recent CommitRecord for a task, or null if no commit exists.
   */
  getCommitByTaskId(taskId: string): Promise<CommitRecord | null>;
}
