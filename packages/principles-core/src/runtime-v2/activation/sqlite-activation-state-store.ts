import type { ActivationStateReadModel, ActivationStatusRecord, PromptReplacementCommit, PromptReplacementOutcome } from './activation-types.js';
import type { SqliteConnection } from '../store/sqlite-connection.js';
import { createHash } from 'node:crypto';
import { isArtifactRevisionOf, type ArtifactLineageIdentity } from './activation-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readArtifactIdentity(row: unknown, artifactId: string): ArtifactLineageIdentity | null {
  if (!isRecord(row) || typeof row.source_task_id !== 'string' || typeof row.lineage_artifact_ids !== 'string') return null;
  let lineage: unknown;
  try { lineage = JSON.parse(row.lineage_artifact_ids); } catch { return null; }
  if (!Array.isArray(lineage) || !lineage.every((id): id is string => typeof id === 'string')) return null;
  return { artifactId, sourceTaskId: row.source_task_id, lineageArtifactIds: lineage,
    ...(typeof row.source_principle_id === 'string' ? { sourcePrincipleId: row.source_principle_id } : {}) };
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
    const { newRecord } = input;
    if (newRecord.activationId === input.supersededActivationId) {
      throw new Error('replacePromptActivation: new and superseded activation ids must be distinct');
    }
    if (newRecord.channel !== 'prompt' || newRecord.action !== 'prompt_activate' || newRecord.deactivatedAt !== null) {
      throw new Error('replacePromptActivation: replacement must be a live prompt activation');
    }
    if (newRecord.idempotencyKey !== `${newRecord.artifactId}::prompt`) {
      throw new Error('replacePromptActivation: idempotency key must identify the new artifact and channel');
    }
    const supersedeKey = `supersede-prompt:${newRecord.activationId}:${input.supersededActivationId}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const oldRows = db.prepare('SELECT * FROM activations WHERE activation_id = ? AND artifact_id = ?').all(input.supersededActivationId, input.supersededArtifactId);
      const [oldRaw] = oldRows;
      const old = mapRowToRecord(oldRaw);
      if (oldRows.length !== 1 || old === null || old.channel !== 'prompt' || old.action !== 'prompt_activate'
        || old.artifactId !== input.supersededArtifactId) {
        throw new Error('replacePromptActivation: superseded activation is not a live prompt activation of the expected artifact');
      }
      const oldArtifact = db.prepare('SELECT * FROM pi_artifacts WHERE artifact_id = ?').get(old.artifactId);
      if (!isRecord(oldArtifact) || typeof oldArtifact.content_json !== 'string') {
        throw new Error('replacePromptActivation: superseded artifact is unavailable');
      }
      const newArtifact = db.prepare('SELECT * FROM pi_artifacts WHERE artifact_id = ?').get(newRecord.artifactId);
      if (!isRecord(newArtifact)) throw new Error('replacePromptActivation: new artifact is unavailable');
      // Known source identities must agree even when lineage points at the old
      // artifact. Missing legacy identities are not invented or migrated.
      if (typeof oldArtifact.source_principle_id === 'string' && typeof newArtifact.source_principle_id === 'string'
        && oldArtifact.source_principle_id !== newArtifact.source_principle_id) {
        throw new Error('replacePromptActivation: replacement artifacts belong to different principles');
      }
      const oldIdentity = readArtifactIdentity(oldArtifact, old.artifactId);
      const newIdentity = readArtifactIdentity(newArtifact, newRecord.artifactId);
      if (oldIdentity === null || newIdentity === null || !isArtifactRevisionOf(newIdentity, oldIdentity)) {
        throw new Error('replacePromptActivation: artifacts have no verified revision relationship');
      }
      const digest = `sha256:${createHash('sha256').update(JSON.stringify({ artifact_id: old.artifactId, content_json: oldArtifact.content_json }), 'utf8').digest('hex')}`;
      const newRaw = db.prepare('SELECT * FROM activations WHERE idempotency_key = ?').get(newRecord.idempotencyKey);
      const existing = newRaw === undefined ? null : mapRowToRecord(newRaw);
      if (newRaw !== undefined && (existing === null || existing.activationId !== newRecord.activationId
        || existing.artifactId !== newRecord.artifactId || existing.channel !== 'prompt'
        || existing.action !== 'prompt_activate' || existing.targetRef !== newRecord.targetRef || existing.deactivatedAt !== null)) {
        throw new Error('replacePromptActivation: new activation identity conflicts with the stored version');
      }
      const decision = db.prepare('SELECT * FROM activation_decisions WHERE idempotency_key = ?').get(supersedeKey);
      if (decision !== undefined && (!isRecord(decision) || decision.activation_id !== old.activationId
        || decision.artifact_id !== old.artifactId || decision.decision !== 'supersede'
        || decision.artifact_digest !== digest)) {
        throw new Error('replacePromptActivation: supersede decision conflicts with this replacement');
      }
      if (old.deactivatedAt !== null) {
        if (existing === null || decision === undefined) {
          throw new Error('replacePromptActivation: superseded activation is inactive without a completed replacement');
        }
        db.exec('COMMIT');
        return { status: 'already_replaced', newActivationId: existing.activationId, supersededActivationId: old.activationId, supersedeDecisionId: supersedeKey };
      }
      if (existing === null) {
        const artifactExists = db.prepare('SELECT 1 FROM pi_artifacts WHERE artifact_id = ?').get(newRecord.artifactId);
        if (artifactExists === undefined) throw new Error('replacePromptActivation: new artifact is unavailable');
        const collisions = db.prepare('SELECT 1 FROM activations WHERE activation_id = ?').all(newRecord.activationId);
        if (collisions.length !== 0) throw new Error('replacePromptActivation: new activation identity is already occupied');
        db.prepare(`
          INSERT INTO activations
            (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(newRecord.activationId, newRecord.idempotencyKey, newRecord.artifactId, newRecord.channel,
          newRecord.action, newRecord.targetRef, newRecord.activatedAt, newRecord.promotedAt ?? null);
      }
      if (decision === undefined) {
        db.prepare(`
          INSERT INTO activation_decisions
            (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest,
             decision, principal_kind, owner_id, authentication_method, credential_id, reason_code, note, decided_at)
          VALUES (?, ?, 'activation', ?, ?, ?, 'supersede', 'configured_owner', ?, 'system', NULL, ?, ?, ?)
        `).run(supersedeKey, supersedeKey, old.activationId, old.artifactId, digest, input.decidedBy,
          input.reasonCode, `${input.note} Approved by ${input.decidedBy} via prompt approval.`, input.decidedAt);
      }
      const deactivationTime = isRecord(decision) && typeof decision.decided_at === 'string' ? decision.decided_at : input.decidedAt;
      const update = db.prepare(`
        UPDATE activations SET deactivated_at = ?
        WHERE activation_id = ? AND artifact_id = ? AND channel = 'prompt' AND deactivated_at IS NULL
      `).run(deactivationTime, old.activationId, old.artifactId);
      if (update.changes !== 1) throw new Error('replacePromptActivation: superseded activation changed during commit');
      db.exec('COMMIT');
      return { status: existing === null ? 'replaced' : 'already_replaced', newActivationId: newRecord.activationId, supersededActivationId: old.activationId, supersedeDecisionId: supersedeKey };
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
