import type { ActivationStateReadModel, ActivationStatusRecord } from './activation-types.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';

export class SqliteActivationStateStore implements ActivationStateReadModel {
  constructor(private readonly connection: SqliteConnection) {}

  async getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at
      FROM activations
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as {
      activation_id: string;
      idempotency_key: string;
      artifact_id: string;
      channel: string;
      action: string;
      target_ref: string;
      activated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      activationId: row.activation_id,
      idempotencyKey: row.idempotency_key,
      artifactId: row.artifact_id,
      channel: row.channel as ActivationStatusRecord['channel'],
      action: row.action,
      targetRef: row.target_ref,
      activatedAt: row.activated_at,
    };
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
}
