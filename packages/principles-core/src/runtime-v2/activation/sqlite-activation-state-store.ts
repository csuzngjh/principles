import type { ActivationStateReadModel, ActivationStatusRecord, PromptReplacementCommit, PromptReplacementOutcome } from './activation-types.js';
import type { SqliteConnection } from '../store/sqlite-connection.js';
import { createHash } from 'node:crypto';

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
    // PRI-904 SPEC §5.1: activation_id tie-break keeps the base order a total,
    // deterministic ordering when activated_at collides — the fair rotation
    // ring must not depend on SQLite's unspecified row order for equal keys.
    const sql = includeDeactivated
      ? `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'prompt' ORDER BY activated_at ASC, activation_id ASC`
      : `SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at FROM activations WHERE channel = 'prompt' AND deactivated_at IS NULL ORDER BY activated_at ASC, activation_id ASC`;
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

  /**
   * PD_PROMPT_CAPACITY_V1 R-B3: atomic prompt-version replacement — the
   * prompt-channel sibling of the RuleCode promotion commit's supersede
   * (sqlite-activation-safety-store.ts). ONE BEGIN IMMEDIATE transaction
   * commits, in order: (validations) → new activation row → immutable
   * `supersede` decision row → deactivation of the prior live activation.
   * A failure anywhere rolls back to the OLD-ONLY state (the Owner never
   * loses the working version); there is no stop-old-then-start-new window.
   *
   * Idempotent by construction: replaying after success takes the
   * `already_replaced` branch (new row already live; old deactivation and
   * decision row are INSERT OR IGNORE / idempotent UPDATE). It also RECOVERS
   * the rare "new artifact activated normally earlier" state by completing
   * the supersede inside the same transaction instead of failing.
   */
  async replacePromptActivation(input: PromptReplacementCommit): Promise<PromptReplacementOutcome> {
    const db = this.connection.getDb();
    const supersedeKey = `supersede-prompt:${input.newRecord.activationId}:${input.supersededActivationId}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const newRow = db.prepare(`
        SELECT activation_id FROM activations
        WHERE idempotency_key = ? AND deactivated_at IS NULL
      `).get(input.newRecord.idempotencyKey);
      if (newRow !== undefined) {
        // Replay / recovery path: the new version is already live. Complete
        // the supersede (decision + deactivation are idempotent) and report.
        const oldArtifact = db.prepare(`
          SELECT artifact_id, content_json FROM pi_artifacts WHERE artifact_id = ?
        `).get(input.supersededArtifactId) as { artifact_id: string; content_json: string } | undefined;
        const digest = oldArtifact !== undefined
          ? `sha256:${createHash('sha256').update(JSON.stringify(oldArtifact), 'utf8').digest('hex')}`
          : null;        db.prepare(`
          INSERT OR IGNORE INTO activation_decisions
            (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest,
             decision, principal_kind, owner_id, authentication_method, credential_id,
             reason_code, note, decided_at)
          VALUES (?, ?, 'activation', ?, ?, ?, 'supersede', 'configured_owner', ?, 'system', NULL, ?, ?, ?)
        `).run(
          supersedeKey, supersedeKey, input.supersededActivationId, input.supersededArtifactId, digest,
          input.decidedBy, input.reasonCode, input.note, input.decidedAt,
        );
        db.prepare(`
          UPDATE activations SET deactivated_at = ?
          WHERE activation_id = ? AND deactivated_at IS NULL
        `).run(input.decidedAt, input.supersededActivationId);
        db.exec('COMMIT');
        return {
          status: 'already_replaced',
          newActivationId: input.newRecord.activationId,
          supersededActivationId: input.supersededActivationId,
          supersedeDecisionId: supersedeKey,
        };
      }

      // Validations BEFORE any mutation (fail loud, keep old-only state).
      const artifactExists = db.prepare('SELECT 1 FROM pi_artifacts WHERE artifact_id = ?').get(input.newRecord.artifactId);
      if (!artifactExists) {
        throw new Error(`replacePromptActivation: activations.artifact_id references non-existent pi_artifacts: ${input.newRecord.artifactId}`);
      }
      // Same {artifact_id, content_json} digest shape as the replay branch —
      // one digest definition for one supersede fact.
      const oldRow = db.prepare(`
        SELECT p.artifact_id AS artifact_id, p.content_json AS content_json
        FROM activations a JOIN pi_artifacts p ON p.artifact_id = a.artifact_id
        WHERE a.activation_id = ? AND a.channel = 'prompt' AND a.deactivated_at IS NULL
      `).get(input.supersededActivationId) as { artifact_id: string; content_json: string } | undefined;
      if (oldRow === undefined || oldRow.artifact_id !== input.supersededArtifactId) {
        throw new Error(`replacePromptActivation: superseded activation ${input.supersededActivationId} is not a live prompt activation of artifact ${input.supersededArtifactId}`);
      }
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(oldRow), 'utf8').digest('hex')}`;

      // 1. new activation row (same shape as recordActivation; prompt channel
      //    seeds no control states).
      db.prepare(`
        INSERT OR REPLACE INTO activations
          (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.newRecord.activationId, input.newRecord.idempotencyKey, input.newRecord.artifactId,
        input.newRecord.channel, input.newRecord.action, input.newRecord.targetRef,
        input.newRecord.activatedAt, input.newRecord.promotedAt ?? null, null,
      );
      // 2. immutable supersede decision (append-only; UNIQUE idempotency_key).
      // principal/auth semantics: configured_owner + owner_id = the deciding
      // Owner (supersedeDecidedBy); authentication_method is schema-bound to
      // 'system' because this path carries no operator credential (the CHECK
      // constraint only admits credential-bearing methods or system) — the
      // Owner attribution itself lives in owner_id and the note.
      db.prepare(`
        INSERT INTO activation_decisions
          (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest,
           decision, principal_kind, owner_id, authentication_method, credential_id,
           reason_code, note, decided_at)
        VALUES (?, ?, 'activation', ?, ?, ?, 'supersede', 'configured_owner', ?, 'system', NULL, ?, ?, ?)
      `).run(
        supersedeKey, supersedeKey, input.supersededActivationId, input.supersededArtifactId, digest,
        input.decidedBy, input.reasonCode,
        `${input.note} Approved by ${input.decidedBy} via prompt approval.`,
        input.decidedAt,
      );
      // 3. deactivate the prior version — last, inside the same transaction.
      db.prepare(`
        UPDATE activations SET deactivated_at = ?
        WHERE activation_id = ? AND deactivated_at IS NULL
      `).run(input.decidedAt, input.supersededActivationId);

      db.exec('COMMIT');
      return {
        status: 'replaced',
        newActivationId: input.newRecord.activationId,
        supersededActivationId: input.supersededActivationId,
        supersedeDecisionId: supersedeKey,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
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
