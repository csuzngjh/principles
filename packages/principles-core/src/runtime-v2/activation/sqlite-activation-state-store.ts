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

  return {
    activationId,
    idempotencyKey,
    artifactId,
    channel,
    action,
    targetRef: targetRef ?? '',
    activatedAt,
    deactivatedAt: deactivatedAt ?? null,
  };
}

export class SqliteActivationStateStore implements ActivationStateReadModel {
  constructor(private readonly connection: SqliteConnection) {}

  async getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at
      FROM activations
      WHERE idempotency_key = ?
    `).get(idempotencyKey);

    return mapRowToRecord(row);
  }

  async recordActivation(record: ActivationStatusRecord): Promise<void> {
    const db = this.connection.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO activations
        (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.activationId,
      record.idempotencyKey,
      record.artifactId,
      record.channel,
      record.action,
      record.targetRef,
      record.activatedAt,
      record.deactivatedAt,
    );
  }

  async listPromptActivations(): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at
      FROM activations
      WHERE channel = 'prompt' AND deactivated_at IS NULL
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

  async listAllActivations(): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at
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
}
