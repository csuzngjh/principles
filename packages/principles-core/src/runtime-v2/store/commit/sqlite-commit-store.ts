/**
 * SQLite implementation of CommitStore.
 */
import type { SqliteConnection } from '../sqlite-connection.js';
import type { CommitRecord, CommitStore } from './commit-store.js';

export class SqliteCommitStore implements CommitStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getCommitByTaskId(taskId: string): Promise<CommitRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at
      FROM commits WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(taskId) as { commit_id: string; task_id: string; run_id: string; artifact_id: string; idempotency_key: string; status: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      commitId: row.commit_id,
      taskId: row.task_id,
      runId: row.run_id,
      artifactId: row.artifact_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
