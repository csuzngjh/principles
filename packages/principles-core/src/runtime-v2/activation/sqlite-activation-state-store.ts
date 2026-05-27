import type { ActivationStateReadModel, ActivationStatusRecord } from './activation-types.js';
import type { SqliteConnection } from '../store/sqlite-connection.js';

function validateChannel(value: unknown): ActivationStatusRecord['channel'] | null {
  if (typeof value !== 'string') return null;
  const valid = ['prompt', 'defer_archive', 'code_tool_hook'] as const;
  for (const c of valid) {
    if (value === c) return c;
  }
  return null;
}

function mapRowToRecord(row: Record<string, unknown>): ActivationStatusRecord | null {
  const channel = validateChannel(row.channel);
  if (!channel) return null;
  return {
    activationId: typeof row.activation_id === 'string' ? row.activation_id : '',
    idempotencyKey: typeof row.idempotency_key === 'string' ? row.idempotency_key : '',
    artifactId: typeof row.artifact_id === 'string' ? row.artifact_id : '',
    channel,
    action: typeof row.action === 'string' ? row.action : '',
    targetRef: typeof row.target_ref === 'string' ? row.target_ref : '',
    activatedAt: typeof row.activated_at === 'string' ? row.activated_at : '',
  };
}

export class SqliteActivationStateStore implements ActivationStateReadModel {
  constructor(private readonly connection: SqliteConnection) {}

  async getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at
      FROM activations
      WHERE idempotency_key = ?
    `).get(idempotencyKey);

    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

    return mapRowToRecord(row as Record<string, unknown>);
  }

  async recordActivation(record: ActivationStatusRecord): Promise<void> {
    const db = this.connection.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO activations
        (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.activationId,
      record.idempotencyKey,
      record.artifactId,
      record.channel,
      record.action,
      record.targetRef,
      record.activatedAt,
    );
  }

  async listPromptActivations(): Promise<ActivationStatusRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at
      FROM activations
      WHERE channel = 'prompt'
      ORDER BY activated_at ASC
    `).all();

    if (!Array.isArray(rows)) return [];

    const result: ActivationStatusRecord[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const record = mapRowToRecord(row as Record<string, unknown>);
      if (record) result.push(record);
    }
    return result;
  }
}
