import type { SqliteConnection } from '../sqlite-connection.js';
import type { PIArtifactRecord, PIArtifactStore } from '../../internalization/pi-artifact.js';

interface PiArtifactRow {
  artifact_id: string;
  artifact_kind: string;
  source_task_id: string;
  source_principle_id: string | null;
  source_rule_id: string | null;
  lineage_artifact_ids: string;
  validation_status: string;
  content_json: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: PiArtifactRow): PIArtifactRecord {
  return {
    artifactId: row.artifact_id,
    artifactKind: row.artifact_kind as PIArtifactRecord['artifactKind'],
    sourceTaskId: row.source_task_id,
    sourcePrincipleId: row.source_principle_id ?? undefined,
    sourceRuleId: row.source_rule_id ?? undefined,
    lineageArtifactIds: JSON.parse(row.lineage_artifact_ids) as string[],
    validationStatus: row.validation_status as PIArtifactRecord['validationStatus'],
    contentJson: row.content_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlitePIArtifactStore implements PIArtifactStore {
  constructor(private readonly connection: SqliteConnection) {}

  async createArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord> {
    const db = this.connection.getDb();
    // P1-3: Application-layer FK check (DB-layer FK deferred to post-MVP table rebuild).
    // Fail loud if source_task_id references non-existent task (ERR-009/ERR-010/ERR-002).
    const taskExists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(record.sourceTaskId);
    if (!taskExists) {
      throw new Error(
        `pi_artifacts.source_task_id references non-existent task: ${record.sourceTaskId}`,
      );
    }
    const lineageJson = JSON.stringify(record.lineageArtifactIds);
    try {
      db.prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactId,
        record.artifactKind,
        record.sourceTaskId,
        record.sourcePrincipleId ?? null,
        record.sourceRuleId ?? null,
        lineageJson,
        record.validationStatus,
        record.contentJson,
        record.createdAt,
        record.updatedAt,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed')) {
        throw new Error(
          `Duplicate PIArtifact: sourceTaskId=${record.sourceTaskId} artifactKind=${record.artifactKind} already exists`,
          { cause: err },
        );
      }
      throw err;
    }
    return record;
  }

  async upsertArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord> {
    const db = this.connection.getDb();
    const lineageJson = JSON.stringify(record.lineageArtifactIds);
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET
        artifact_id = excluded.artifact_id,
        source_principle_id = excluded.source_principle_id,
        source_rule_id = excluded.source_rule_id,
        lineage_artifact_ids = excluded.lineage_artifact_ids,
        validation_status = excluded.validation_status,
        content_json = excluded.content_json,
        updated_at = excluded.updated_at
    `).run(
      record.artifactId,
      record.artifactKind,
      record.sourceTaskId,
      record.sourcePrincipleId ?? null,
      record.sourceRuleId ?? null,
      lineageJson,
      record.validationStatus,
      record.contentJson,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  async getArtifactById(artifactId: string): Promise<PIArtifactRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at
      FROM pi_artifacts WHERE artifact_id = ?
    `).get(artifactId) as PiArtifactRow | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }

  async listBySourceTaskId(sourceTaskId: string): Promise<PIArtifactRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at
      FROM pi_artifacts WHERE source_task_id = ?
      ORDER BY created_at ASC
    `).all(sourceTaskId) as PiArtifactRow[];
    return rows.map(rowToRecord);
  }

  async listLineage(artifactId: string): Promise<PIArtifactRecord[]> {
    const db = this.connection.getDb();
    const artifact = await this.getArtifactById(artifactId);
    if (!artifact) return [];

    if (artifact.lineageArtifactIds.length === 0) return [];

    const placeholders = artifact.lineageArtifactIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at
      FROM pi_artifacts WHERE artifact_id IN (${placeholders})
    `).all(...artifact.lineageArtifactIds) as PiArtifactRow[];
    return rows.map(rowToRecord);
  }

  async updateValidationStatus(artifactId: string, validationStatus: PIArtifactRecord['validationStatus']): Promise<boolean> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE pi_artifacts SET validation_status = ?, updated_at = ?
      WHERE artifact_id = ?
    `).run(validationStatus, now, artifactId);
    return result.changes > 0;
  }
}
