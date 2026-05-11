/**
 * SQLite implementation of CandidateStore.
 */
import type { SqliteConnection } from '../sqlite-connection.js';
import type { CandidateRecord, CandidateStore } from './candidate-store.js';

export class SqliteCandidateStore implements CandidateStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT pc.candidate_id, pc.artifact_id, pc.task_id, pc.source_run_id,
             pc.title, pc.description, pc.confidence, pc.status, pc.created_at, pc.source_recommendation_json
      FROM principle_candidates pc
      JOIN commits c ON c.artifact_id = pc.artifact_id
      JOIN runs r ON r.run_id = c.run_id
      JOIN tasks t ON t.task_id = r.task_id
      WHERE t.task_id = ?
      ORDER BY pc.created_at DESC
    `).all(taskId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; status: string; created_at: string; source_recommendation_json: string }[];
    return rows.map((r) => ({
      candidateId: r.candidate_id,
      artifactId: r.artifact_id,
      taskId: r.task_id,
      sourceRunId: r.source_run_id,
      title: r.title,
      description: r.description,
      confidence: r.confidence,
      sourceRecommendationJson: r.source_recommendation_json,
      status: r.status as CandidateRecord['status'],
      createdAt: r.created_at,
    }));
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, status, created_at
      FROM principle_candidates WHERE candidate_id = ?
    `).get(candidateId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; source_recommendation_json: string; status: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      candidateId: row.candidate_id,
      artifactId: row.artifact_id,
      taskId: row.task_id,
      sourceRunId: row.source_run_id,
      title: row.title,
      description: row.description,
      confidence: row.confidence,
      sourceRecommendationJson: row.source_recommendation_json,
      status: row.status as CandidateRecord['status'],
      createdAt: row.created_at,
    };
  }

  async updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean> {
    const db = this.connection.getDb();
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ?')
      .run(patch.status, candidateId);
    return info.changes > 0;
  }

  async transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean> {
    const db = this.connection.getDb();
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ? AND status = ?')
      .run(newStatus, candidateId, expectedStatus);
    return info.changes > 0;
  }
}
