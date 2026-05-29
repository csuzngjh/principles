/**
 * SQLite implementation of ArtifactStore.
 */
import type { SqliteConnection } from '../sqlite-connection.js';
import type { CandidateRecord } from '../candidate/candidate-store.js';
import type { ArtifactRecord, ArtifactWithCandidates, ArtifactStore } from './artifact-store.js';

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT artifact_id, run_id, task_id, artifact_kind, content_json, created_at
      FROM artifacts WHERE artifact_id = ?
    `).get(artifactId) as { artifact_id: string; run_id: string; task_id: string; artifact_kind: string; content_json: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      artifactId: row.artifact_id,
      runId: row.run_id,
      taskId: row.task_id,
      artifactKind: row.artifact_kind,
      contentJson: row.content_json,
      createdAt: row.created_at,
    };
  }

  async getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) return null;
    const db = this.connection.getDb();
    const candidateRows = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, recommendation_kind, status, created_at
      FROM principle_candidates WHERE artifact_id = ?
      ORDER BY created_at DESC
    `).all(artifactId) as { candidate_id: string; artifact_id: string; task_id: string; source_run_id: string; title: string; description: string; confidence: number | null; source_recommendation_json: string; recommendation_kind: string; status: string; created_at: string }[];
    const candidates: CandidateRecord[] = candidateRows.map((r) => ({
      candidateId: r.candidate_id,
      artifactId: r.artifact_id,
      taskId: r.task_id,
      sourceRunId: r.source_run_id,
      title: r.title,
      description: r.description,
      confidence: r.confidence,
      sourceRecommendationJson: r.source_recommendation_json,
      recommendationKind: (r.recommendation_kind as CandidateRecord['recommendationKind']) ?? 'principle',
      status: r.status as CandidateRecord['status'],
      createdAt: r.created_at,
    }));
    return { artifact, candidates };
  }
}
