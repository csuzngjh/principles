import type { SqliteConnection } from '../sqlite-connection.js';
import type { PIArtifactRecord, PIArtifactStore } from '../../internalization/pi-artifact.js';
import { parsePITaskMetadata, PI_METADATA_KEY } from '../../internalization/pitask-metadata.js';

export interface PiArtifactRow {
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

/**
 * The ONE pi_artifacts row -> PIArtifactRecord mapping. Exported so
 * enforcement-time consumers (host-runtime production gate, OpenClaw plugin
 * RuleHost) can rebuild the exact snapshot object the promotion chain hashed:
 * `computeArtifactDigest(mapPiArtifactRow(row))` reproduces the
 * `activation_decisions.artifact_digest` byte-for-byte, because JSON.stringify
 * preserves this function's key order. Do not hand-roll a second mapping — a
 * divergent key order would silently break digest verification.
 */
export function mapPiArtifactRow(row: PiArtifactRow): PIArtifactRecord {
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

function isPiArtifactRow(value: unknown): value is PiArtifactRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['artifact_id', 'artifact_kind', 'source_task_id', 'lineage_artifact_ids', 'validation_status', 'content_json', 'created_at', 'updated_at'];
  if (!fields.every(key => typeof Reflect.get(value, key) === 'string')) return false;
  if (!['source_principle_id', 'source_rule_id'].every(key => Reflect.get(value, key) === null || typeof Reflect.get(value, key) === 'string')) return false;
  const raw: unknown = Reflect.get(value, 'lineage_artifact_ids');
  if (typeof raw !== 'string') return false;
  try {
    const lineage: unknown = JSON.parse(raw);
    return Array.isArray(lineage) && lineage.every(id => typeof id === 'string');
  } catch { return false; }
}

function mapValidatedPiArtifactRows(rows: unknown[]): PIArtifactRecord[] {
  return rows.map(row => {
    if (!isPiArtifactRow(row)) throw new Error('pi_artifact_row_invalid');
    return mapPiArtifactRow(row);
  });
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
    const source: unknown = db.prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?').get(record.sourceTaskId);
    const diagnostic: unknown = source !== null && typeof source === 'object' ? Reflect.get(source, 'diagnostic_json') : null;
    const metadata = typeof diagnostic === 'string' ? parsePITaskMetadata(diagnostic) : null;
    if (typeof diagnostic === 'string' && !metadata) {
      // Unparseable diagnostic JSON must fail with the structured reason, not
      // a raw SyntaxError (rc-3/rc-9).
      let parsed: unknown;
      try {
        parsed = JSON.parse(diagnostic);
      } catch {
        throw new Error('artifact_revision_metadata_invalid');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, PI_METADATA_KEY)) {
        throw new Error('artifact_revision_metadata_invalid');
      }
    }
    const revisionEpoch = metadata?.revisionCount ?? 0;
    if (!Number.isSafeInteger(revisionEpoch) || revisionEpoch < 0) throw new Error('invalid_artifact_revision_epoch');
    const latest: unknown = db.prepare('SELECT MAX(revision_epoch) AS epoch FROM pi_artifacts WHERE source_task_id = ?').get(record.sourceTaskId);
    const latestEpoch: unknown = latest !== null && typeof latest === 'object' ? Reflect.get(latest, 'epoch') : null;
    if (typeof latestEpoch === 'number' && latestEpoch > revisionEpoch) throw new Error('artifact_revision_epoch_regressed');
    const lineageJson = JSON.stringify(record.lineageArtifactIds);
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at, revision_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_task_id, artifact_kind, revision_epoch) DO UPDATE SET
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
      revisionEpoch,
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
    return mapPiArtifactRow(row);
  }

  async listBySourceTaskId(sourceTaskId: string): Promise<PIArtifactRecord[]> {
    const db = this.connection.getDb();
    const columns: unknown[] = db.prepare('PRAGMA table_info(pi_artifacts)').all();
    const hasEpoch = columns.some(column => column !== null && typeof column === 'object' && Reflect.get(column, 'name') === 'revision_epoch');
    // Readonly inspection must work before a normal writer upgrades an older database.
    if (!hasEpoch) {
      const legacy = db.prepare(`
        SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at
        FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at ASC
      `).all(sourceTaskId);
      return mapValidatedPiArtifactRows(legacy);
    }
    // Preserve the established current-output view; historical approval/lineage refs
    // continue to resolve by artifactId without mixing epochs into current prompts.
    const rows = db.prepare(`
      SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at
      FROM pi_artifacts WHERE source_task_id = ?
        AND revision_epoch = (SELECT MAX(revision_epoch) FROM pi_artifacts WHERE source_task_id = ?)
      ORDER BY created_at ASC
    `).all(sourceTaskId, sourceTaskId);
    return mapValidatedPiArtifactRows(rows);
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
    return rows.map(mapPiArtifactRow);
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
