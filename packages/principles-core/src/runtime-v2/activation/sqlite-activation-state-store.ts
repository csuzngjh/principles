import type { ActivationStateReadModel, ActivationStatusRecord } from './activation-types.js';
import type { SqliteConnection } from '../store/sqlite-connection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(row: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(row, key)) return null;
  const val = row[key];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function validateChannel(value: unknown): ActivationStatusRecord['channel'] | null {
  if (typeof value !== 'string') return null;
  const valid = ['prompt', 'defer_archive', 'code_tool_hook'] as const;
  for (const c of valid) {
    if (value === c) return c;
  }
  return null;
}

function mapRowToRecord(row: unknown): ActivationStatusRecord | null {
  if (!isRecord(row)) return null;

  const channel = validateChannel(row.channel);
  if (!channel) return null;

  const activationId = readStringField(row, 'activation_id');
  const idempotencyKey = readStringField(row, 'idempotency_key');
  const artifactId = readStringField(row, 'artifact_id');
  const action = readStringField(row, 'action');
  const activatedAt = readStringField(row, 'activated_at');

  if (!activationId || !idempotencyKey || !artifactId || !action || !activatedAt) {
    return null;
  }

  const targetRef = readStringField(row, 'target_ref');
  const deactivatedAt = readStringField(row, 'deactivated_at');
  const promotedAt = readStringField(row, 'promoted_at');

  return {
    activationId,
    idempotencyKey,
    artifactId,
    channel,
    action,
    targetRef: targetRef ?? '',
    activatedAt,
    promotedAt: promotedAt ?? null,
    deactivatedAt: deactivatedAt ?? null,
  };
}

export class SqliteActivationStateStore implements ActivationStateReadModel {
  constructor(private readonly connection: SqliteConnection) {}

  async getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null> {
    const db = this.connection.getDb();
    // Bug-Q fix: filter out deactivated records so that dispatcher allows re-activation.
    // recordActivation's INSERT OR REPLACE then overwrites the old deactivated row under
    // the UNIQUE INDEX on idempotency_key — intended behavior (latest activation wins).
    const row = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at
      FROM activations
      WHERE idempotency_key = ? AND deactivated_at IS NULL
    `).get(idempotencyKey);

    return mapRowToRecord(row);
  }

  async recordActivation(record: ActivationStatusRecord): Promise<void> {
    const db = this.connection.getDb();
    // P1-3: Application-layer FK check (DB-layer FK deferred to post-MVP table rebuild).
    // Fail loud if artifact_id references non-existent pi_artifact (ERR-009/ERR-010/ERR-002).
    const artifactExists = db.prepare('SELECT 1 FROM pi_artifacts WHERE artifact_id = ?').get(record.artifactId);
    if (!artifactExists) {
      throw new Error(
        `activations.artifact_id references non-existent pi_artifact: ${record.artifactId}`,
      );
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT OR REPLACE INTO activations
          (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.activationId, record.idempotencyKey, record.artifactId, record.channel, record.action,
        record.targetRef, record.activatedAt, record.promotedAt ?? null, record.deactivatedAt,
      );
      if (record.channel === 'code_tool_hook') {
        db.prepare(`
          INSERT OR IGNORE INTO activation_control_states
            (activation_id, enforcement, isolation_decision_id, version, updated_at)
          VALUES (?, 'eligible', NULL, 1, ?)
        `).run(record.activationId, record.activatedAt);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
  }

  async listPromptActivations(includeDeactivated = false): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const sql = includeDeactivated
      ? `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'prompt' ORDER BY activated_at ASC`
      : `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'prompt' AND deactivated_at IS NULL ORDER BY activated_at ASC`;
    const rows = db.prepare(sql).all();

    if (!Array.isArray(rows)) return [];

    const result: ActivationStatusRecord[] = [];
    for (const row of rows) {
      const record = mapRowToRecord(row);
      if (record) result.push(record);
    }
    return result;
  }

  async listCodeToolHookActivations(includeDeactivated = false): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const sql = includeDeactivated
      ? `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'code_tool_hook' ORDER BY activated_at ASC`
      : `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'code_tool_hook' AND deactivated_at IS NULL ORDER BY activated_at ASC`;
    const rows = db.prepare(sql).all();

    if (!Array.isArray(rows)) return [];

    const result: ActivationStatusRecord[] = [];
    for (const row of rows) {
      const record = mapRowToRecord(row);
      if (record) result.push(record);
    }
    return result;
  }

  async listAllActivations(): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at
      FROM activations
      ORDER BY activated_at ASC
    `).all();

    if (!Array.isArray(rows)) return [];

    const result: ActivationStatusRecord[] = [];
    for (const row of rows) {
      const record = mapRowToRecord(row);
      if (record) result.push(record);
    }
    return result;
  }

  async deactivateActivation(activationId: string, deactivatedAt: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare(`
      UPDATE activations
      SET deactivated_at = ?
      WHERE activation_id = ? AND deactivated_at IS NULL
    `).run(deactivatedAt, activationId);
    return result.changes > 0;
  }

  async promoteActivation(activationId: string, promotedAt: string): Promise<boolean> {
    const db = this.connection.getDb();
    // Wrap COUNT guard + UPDATE in a single IMMEDIATE transaction (CodeRabbit
    // PR #1122 finding): activation_id is NOT unique, so a shadow row inserted
    // between the COUNT and UPDATE would be silently promoted alongside the
    // original. BEGIN IMMEDIATE acquires a write lock so no concurrent insert
    // can sneak in, and the post-UPDATE row-count check (changes === 1) catches
    // any pre-existing duplicate that slipped past the COUNT guard inside the
    // same atomic window. ERR-083 (shared store contract): cross-package callers
    // must not observe a half-promoted state.
    db.exec('BEGIN IMMEDIATE');
    try {
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM activations
        WHERE activation_id = ?
          AND channel = 'code_tool_hook'
          AND action = 'code_tool_hook_shadow_activate'
          AND deactivated_at IS NULL
      `).get(activationId) as { cnt: number } | undefined;
      if (!countRow || countRow.cnt === 0) {
        db.exec('COMMIT');
        return false;
      }
      if (countRow.cnt > 1) {
        throw new Error(
          `promoteActivation refused: ${countRow.cnt} shadow activations share activation_id=${activationId}; resolve duplicates before promoting.`,
        );
      }
      const result = db.prepare(`
        UPDATE activations
        SET action = 'code_tool_hook_live_activate', promoted_at = ?
        WHERE activation_id = ?
          AND channel = 'code_tool_hook'
          AND action = 'code_tool_hook_shadow_activate'
          AND deactivated_at IS NULL
      `).run(promotedAt, activationId);
      if (result.changes !== 1) {
        throw new Error(
          `promoteActivation expected to update 1 row, updated ${result.changes}; activation_id=${activationId} (concurrent modification detected within transaction)`,
        );
      }
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best-effort: tx may already be rolled back */ }
      throw error;
    }
  }
}
