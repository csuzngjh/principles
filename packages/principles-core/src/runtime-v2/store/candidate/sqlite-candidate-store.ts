import type { SqliteConnection } from '../sqlite-connection.js';
import type { CandidateRecord, CandidateStore } from './candidate-store.js';
import { resolveRecommendationKind } from './recommendation-kind-resolver.js';

interface CandidateRow {
  candidate_id: string;
  artifact_id: string;
  task_id: string;
  source_run_id: string;
  title: string;
  description: string;
  confidence: number | null;
  source_recommendation_json: string;
  recommendation_kind: string;
  status: string;
  created_at: string;
}

function mapRow(r: CandidateRow): CandidateRecord {
  return {
    candidateId: r.candidate_id,
    artifactId: r.artifact_id,
    taskId: r.task_id,
    sourceRunId: r.source_run_id,
    title: r.title,
    description: r.description,
    confidence: r.confidence,
    sourceRecommendationJson: r.source_recommendation_json,
    recommendationKind: resolveRecommendationKind(r.recommendation_kind),
    status: r.status as CandidateRecord['status'],
    createdAt: r.created_at,
  };
}

export class SqliteCandidateStore implements CandidateStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT pc.candidate_id, pc.artifact_id, pc.task_id, pc.source_run_id,
             pc.title, pc.description, pc.confidence, pc.status, pc.created_at,
             pc.source_recommendation_json, pc.recommendation_kind
      FROM principle_candidates pc
      JOIN commits c ON c.artifact_id = pc.artifact_id
      JOIN runs r ON r.run_id = c.run_id
      JOIN tasks t ON t.task_id = r.task_id
      WHERE t.task_id = ? OR t.input_ref = ?
      ORDER BY pc.created_at DESC
    `).all(taskId, taskId) as CandidateRow[];
    return rows.map(mapRow);
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, recommendation_kind, status, created_at
      FROM principle_candidates WHERE candidate_id = ?
    `).get(candidateId) as CandidateRow | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  async updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean> {
    const db = this.connection.getDb();
    // F13 (PRI-442): when transitioning to 'consumed', set consumed_at in
    // the same statement so the row satisfies the schema CHECK constraint
    // (status='consumed' → consumed_at IS NOT NULL). Previously this method
    // left consumed_at NULL and a separate ensureConsumedAt() patch fixed it
    // post-hoc — but that left a window where the row violated the invariant.
    if (patch.status === 'consumed') {
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE principle_candidates SET status = ?, consumed_at = COALESCE(consumed_at, ?) WHERE candidate_id = ?')
        .run(patch.status, now, candidateId);
      return info.changes > 0;
    }
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ?')
      .run(patch.status, candidateId);
    return info.changes > 0;
  }

  async transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean> {
    const db = this.connection.getDb();
    // F13 (PRI-442): same CHECK-constraint fix as updateCandidateStatus —
    // set consumed_at atomically when the new status is 'consumed'.
    if (newStatus === 'consumed') {
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE principle_candidates SET status = ?, consumed_at = COALESCE(consumed_at, ?) WHERE candidate_id = ? AND status = ?')
        .run(newStatus, now, candidateId, expectedStatus);
      return info.changes > 0;
    }
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ? AND status = ?')
      .run(newStatus, candidateId, expectedStatus);
    return info.changes > 0;
  }
}
