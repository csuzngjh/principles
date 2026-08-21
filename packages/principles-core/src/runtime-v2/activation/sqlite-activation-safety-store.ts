import type { SqliteConnection } from '../store/sqlite-connection.js';
import type { ActivationControlState, ActivationDecisionKind, ActivationDecisionRecord, GlobalRuleCodePause } from './activation-control-types.js';
import type { PromotionCommitInput } from './rulecode-owner-decision-service.js';
import { createHash } from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = Object.hasOwn(row, key) ? row[key] : undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed activation safety row: ${key}`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = Object.hasOwn(row, key) ? row[key] : undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed activation safety row: ${key}`);
  return value;
}

function mapControl(row: unknown): ActivationControlState | null {
  if (row === undefined) return null;
  if (!isRecord(row)) throw new Error('Malformed activation control row');
  const enforcement = requiredString(row, 'enforcement');
  const version = Object.hasOwn(row, 'version') ? row.version : undefined;
  if ((enforcement !== 'eligible' && enforcement !== 'safety_isolated') || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('Malformed activation control row: enforcement or version');
  }
  return {
    activationId: requiredString(row, 'activation_id'),
    enforcement,
    isolationDecisionId: optionalString(row, 'isolation_decision_id'),
    version,
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function mapGlobalPause(row: unknown): GlobalRuleCodePause | null {
  if (row === undefined) return null;
  if (!isRecord(row)) throw new Error('Malformed global RuleCode pause row');
  const status = requiredString(row, 'status');
  const version = Object.hasOwn(row, 'version') ? row.version : undefined;
  let affected: unknown;
  try { affected = JSON.parse(requiredString(row, 'affected_activation_ids')); } catch { throw new Error('Malformed global RuleCode pause row: affected_activation_ids'); }
  if ((status !== 'paused' && status !== 'released') || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
    || !Array.isArray(affected) || !affected.every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Malformed global RuleCode pause row: status, version, or affected ids');
  }
  return { pauseId: requiredString(row, 'pause_id'), status, incidentDecisionId: requiredString(row, 'incident_decision_id'),
    releaseDecisionId: optionalString(row, 'release_decision_id'), affectedActivationIds: affected,
    pausedAt: requiredString(row, 'paused_at'), releasedAt: optionalString(row, 'released_at'), version };
}

const DECISIONS: readonly ActivationDecisionKind[] = [
  'continue_observing', 'promote_live', 'reject_after_shadow', 'emergency_deactivate',
  'global_emergency_pause', 'global_emergency_pause_release', 'safety_isolate',
  'recover_to_shadow', 'supersede',
];

function isActivationDecisionKind(value: string): value is ActivationDecisionKind {
  return DECISIONS.some(candidate => candidate === value);
}

function mapDecision(row: unknown): ActivationDecisionRecord {
  if (!isRecord(row)) throw new Error('Malformed activation decision row');
  const decision = requiredString(row, 'decision');
  if (!isActivationDecisionKind(decision)) throw new Error('Malformed activation decision row: decision');
  const principalKind = requiredString(row, 'principal_kind');
  const authenticationMethod = requiredString(row, 'authentication_method');
  const principal = principalKind === 'configured_owner'
    ? { kind: principalKind, ownerId: requiredString(row, 'owner_id') } as const
    : principalKind === 'system_safety'
      ? { kind: principalKind, policyVersion: requiredString(row, 'policy_version') } as const
      : principalKind === 'break_glass' && requiredString(row, 'break_glass_reason') === 'local_no_auth_emergency'
        ? { kind: principalKind, reason: 'local_no_auth_emergency' } as const
        : null;
  const authentication = authenticationMethod === 'console_token' || authenticationMethod === 'cli_owner_credential'
    ? { method: authenticationMethod, credentialId: requiredString(row, 'credential_id') } as const
    : authenticationMethod === 'system' || authenticationMethod === 'local_break_glass'
      ? { method: authenticationMethod } as const
      : null;
  if (!principal) throw new Error('Malformed activation decision row: principal');
  if (!authentication) throw new Error('Malformed activation decision row: authentication');
  const operatorKind = optionalString(row, 'operator_kind');
  const operatorId = optionalString(row, 'operator_id');
  if ((operatorKind === null) !== (operatorId === null) || (operatorKind !== null && operatorKind !== 'local_user')) throw new Error('Malformed activation decision row: operator');
  return {
    decisionId: requiredString(row, 'decision_id'),
    subject: {
      kind: 'activation',
      activationId: requiredString(row, 'activation_id'),
      artifactId: requiredString(row, 'artifact_id'),
      artifactDigest: requiredString(row, 'artifact_digest'),
    },
    decision,
    principal,
    authentication,
    operator: operatorId === null ? undefined : { kind: 'local_user', operatorId },
    reasonCode: requiredString(row, 'reason_code'),
    note: optionalString(row, 'note'),
    evidenceSnapshotId: optionalString(row, 'evidence_snapshot_id'),
    decidedAt: requiredString(row, 'decided_at'),
  };
}

export class SqliteActivationSafetyStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getControlState(activationId: string): Promise<ActivationControlState | null> {
    const row: unknown = this.connection.getDb().prepare(`
      SELECT activation_id, enforcement, isolation_decision_id, version, updated_at
      FROM activation_control_states WHERE activation_id = ?
    `).get(activationId);
    return mapControl(row);
  }

  async getActiveGlobalPause(): Promise<GlobalRuleCodePause | null> {
    const row: unknown = this.connection.getDb().prepare(`
      SELECT pause_id, status, incident_decision_id, release_decision_id, affected_activation_ids, paused_at, released_at, version
      FROM global_rulecode_pauses WHERE status = 'paused'
    `).get();
    return mapGlobalPause(row);
  }

  async pauseAllLive(decision: ActivationDecisionRecord, pauseId: string, idempotencyKey: string): Promise<GlobalRuleCodePause> {
    const authorized = decision.subject.kind === 'all_live_rulecode' && decision.decision === 'global_emergency_pause'
      && ((decision.principal.kind === 'break_glass' && decision.authentication.method === 'local_break_glass')
        || (decision.principal.kind === 'configured_owner' && decision.authentication.method === 'console_token'));
    if (!authorized) throw new Error('pauseAllLive requires authorized global_emergency_pause decision');
    const db = this.connection.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = mapGlobalPause(db.prepare(`SELECT pause_id, status, incident_decision_id, release_decision_id, affected_activation_ids, paused_at, released_at, version FROM global_rulecode_pauses WHERE status = 'paused'`).get());
      if (existing) { db.exec('COMMIT'); return existing; }
      const rows: unknown = db.prepare(`SELECT activation_id FROM activations WHERE channel = 'code_tool_hook' AND action = 'code_tool_hook_live_activate' AND deactivated_at IS NULL ORDER BY activation_id`).all();
      if (!Array.isArray(rows)) throw new Error('Malformed live activation result');
      const affected = rows.map(row => isRecord(row) ? requiredString(row, 'activation_id') : (() => { throw new Error('Malformed live activation row'); })());
      db.prepare(`INSERT INTO activation_decisions (decision_id, idempotency_key, subject_kind, decision, principal_kind, owner_id, policy_version, break_glass_reason, authentication_method, credential_id, operator_kind, operator_id, reason_code, note, decided_at) VALUES (?, ?, 'all_live_rulecode', 'global_emergency_pause', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.decisionId, idempotencyKey, decision.principal.kind,
          decision.principal.kind === 'configured_owner' ? decision.principal.ownerId : null,
          decision.principal.kind === 'break_glass' ? decision.principal.reason : null,
          decision.authentication.method,
          decision.authentication.method === 'console_token' ? decision.authentication.credentialId : null,
          decision.operator?.kind ?? null, decision.operator?.operatorId ?? null, decision.reasonCode, decision.note, decision.decidedAt);
      db.prepare(`INSERT INTO global_rulecode_pauses (pause_id, status, incident_decision_id, release_decision_id, affected_activation_ids, paused_at, released_at, version) VALUES (?, 'paused', ?, NULL, ?, ?, NULL, 1)`)
        .run(pauseId, decision.decisionId, JSON.stringify(affected), decision.decidedAt);
      const result = mapGlobalPause(db.prepare(`SELECT pause_id, status, incident_decision_id, release_decision_id, affected_activation_ids, paused_at, released_at, version FROM global_rulecode_pauses WHERE pause_id = ?`).get(pauseId));
      if (!result) throw new Error('Global pause missing after insert');
      db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  }

  async releaseGlobalPause(decision: ActivationDecisionRecord, input: { pauseId: string; expectedVersion: number; idempotencyKey: string }): Promise<GlobalRuleCodePause> {
    const { pauseId, expectedVersion, idempotencyKey } = input;
    if (decision.subject.kind !== 'all_live_rulecode' || decision.decision !== 'global_emergency_pause_release'
      || decision.principal.kind !== 'configured_owner' || decision.authentication.method !== 'console_token') {
      throw new Error('releaseGlobalPause requires authenticated configured_owner release decision');
    }
    const db = this.connection.getDb(); db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO activation_decisions (decision_id, idempotency_key, subject_kind, decision, principal_kind, owner_id, authentication_method, credential_id, operator_kind, operator_id, reason_code, note, decided_at) VALUES (?, ?, 'all_live_rulecode', 'global_emergency_pause_release', 'configured_owner', ?, 'console_token', ?, ?, ?, ?, ?, ?)`)
        .run(decision.decisionId, idempotencyKey, decision.principal.ownerId, decision.authentication.credentialId,
          decision.operator?.kind ?? null, decision.operator?.operatorId ?? null, decision.reasonCode, decision.note, decision.decidedAt);
      const update = db.prepare(`UPDATE global_rulecode_pauses SET status = 'released', release_decision_id = ?, released_at = ?, version = version + 1 WHERE pause_id = ? AND status = 'paused' AND version = ?`)
        .run(decision.decisionId, decision.decidedAt, pauseId, expectedVersion);
      if (update.changes !== 1) throw new Error(`Global pause expected version ${expectedVersion}: ${pauseId}`);
      const result = mapGlobalPause(db.prepare(`SELECT pause_id, status, incident_decision_id, release_decision_id, affected_activation_ids, paused_at, released_at, version FROM global_rulecode_pauses WHERE pause_id = ?`).get(pauseId));
      if (!result) throw new Error('Global pause missing after release');
      db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  }

  async deactivateWithDecision(decision: ActivationDecisionRecord, idempotencyKey: string): Promise<{ activationId: string; decisionId: string; deactivatedAt: string }> {
    if (decision.subject.kind !== 'activation') throw new Error('deactivateWithDecision requires activation subject');
    const ownerAuthenticated = decision.principal.kind === 'configured_owner'
      && (decision.authentication.method === 'console_token' || decision.authentication.method === 'cli_owner_credential');
    const breakGlass = decision.principal.kind === 'break_glass' && decision.authentication.method === 'local_break_glass';
    const authorized = decision.decision === 'reject_after_shadow' ? ownerAuthenticated
      : decision.decision === 'emergency_deactivate' && (ownerAuthenticated || breakGlass);
    if (!authorized) throw new Error('deactivateWithDecision requires authorized rejection or emergency decision');

    const db = this.connection.getDb(); db.exec('BEGIN IMMEDIATE');
    try {
      const rejectAfterShadow = decision.decision === 'reject_after_shadow';
      const subjectStatement = rejectAfterShadow
        ? db.prepare(`SELECT COUNT(*) AS count FROM activations WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook' AND action = 'code_tool_hook_shadow_activate' AND deactivated_at IS NULL`)
        : db.prepare(`SELECT COUNT(*) AS count FROM activations WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook' AND deactivated_at IS NULL`);
      const subject: unknown = subjectStatement
        .get(decision.subject.activationId, decision.subject.artifactId);
      if (!isRecord(subject) || subject.count !== 1) throw new Error(`Deactivation requires exactly one matching active activation: ${decision.subject.activationId}`);
      db.prepare(`INSERT INTO activation_decisions
        (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest, decision,
         principal_kind, owner_id, policy_version, break_glass_reason, authentication_method, credential_id,
         operator_kind, operator_id, reason_code, note, evidence_snapshot_id, decided_at)
        VALUES (?, ?, 'activation', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.decisionId, idempotencyKey, decision.subject.activationId, decision.subject.artifactId,
          decision.subject.artifactDigest, decision.decision, decision.principal.kind,
          decision.principal.kind === 'configured_owner' ? decision.principal.ownerId : null,
          decision.principal.kind === 'break_glass' ? decision.principal.reason : null,
          decision.authentication.method,
          decision.authentication.method === 'console_token' || decision.authentication.method === 'cli_owner_credential'
            ? decision.authentication.credentialId : null,
          decision.operator?.kind ?? null, decision.operator?.operatorId ?? null, decision.reasonCode,
          decision.note, decision.evidenceSnapshotId, decision.decidedAt);
      const updateStatement = rejectAfterShadow
        ? db.prepare(`UPDATE activations SET deactivated_at = ? WHERE activation_id = ? AND artifact_id = ? AND action = 'code_tool_hook_shadow_activate' AND deactivated_at IS NULL`)
        : db.prepare(`UPDATE activations SET deactivated_at = ? WHERE activation_id = ? AND artifact_id = ? AND deactivated_at IS NULL`);
      const update = updateStatement
        .run(decision.decidedAt, decision.subject.activationId, decision.subject.artifactId);
      if (update.changes !== 1) throw new Error('Activation state changed during atomic deactivation');
      db.exec('COMMIT');
      return { activationId: decision.subject.activationId, decisionId: decision.decisionId, deactivatedAt: decision.decidedAt };
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  }

  async recordOwnerDecision(decision: ActivationDecisionRecord, idempotencyKey: string): Promise<{ decisionId: string }> {
    if (decision.subject.kind !== 'activation' || decision.decision !== 'continue_observing'
      || decision.principal.kind !== 'configured_owner'
      || (decision.authentication.method !== 'console_token' && decision.authentication.method !== 'cli_owner_credential')) {
      throw new Error('recordOwnerDecision requires authenticated configured_owner continue_observing decision');
    }
    const db = this.connection.getDb(); db.exec('BEGIN IMMEDIATE');
    try {
      const subject: unknown = db.prepare(`SELECT COUNT(*) AS count FROM activations WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook' AND action = 'code_tool_hook_shadow_activate' AND deactivated_at IS NULL`)
        .get(decision.subject.activationId, decision.subject.artifactId);
      if (!isRecord(subject) || subject.count !== 1) throw new Error(`Continue observing requires exactly one active shadow activation: ${decision.subject.activationId}`);
      db.prepare(`INSERT INTO activation_decisions
        (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest, decision,
         principal_kind, owner_id, authentication_method, credential_id, operator_kind, operator_id,
         reason_code, note, evidence_snapshot_id, decided_at)
        VALUES (?, ?, 'activation', ?, ?, ?, 'continue_observing', 'configured_owner', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.decisionId, idempotencyKey, decision.subject.activationId, decision.subject.artifactId,
          decision.subject.artifactDigest, decision.principal.ownerId, decision.authentication.method,
          decision.authentication.credentialId, decision.operator?.kind ?? null, decision.operator?.operatorId ?? null,
          decision.reasonCode, decision.note, decision.evidenceSnapshotId, decision.decidedAt);
      db.exec('COMMIT'); return { decisionId: decision.decisionId };
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  }

  async recoverToShadow(decision: ActivationDecisionRecord, input: { expectedControlVersion: number; newActivationId: string; idempotencyKey: string }): Promise<{ sourceActivationId: string; shadowActivationId: string; decisionId: string }> {
    if (decision.subject.kind !== 'activation' || decision.decision !== 'recover_to_shadow'
      || decision.principal.kind !== 'configured_owner' || decision.authentication.method !== 'console_token') {
      throw new Error('recoverToShadow requires authenticated configured_owner recovery decision');
    }
    const db = this.connection.getDb(); db.exec('BEGIN IMMEDIATE');
    try {
      const source: unknown = db.prepare(`SELECT artifact_id, target_ref FROM activations WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook' AND action = 'code_tool_hook_live_activate' AND deactivated_at IS NULL`).get(decision.subject.activationId, decision.subject.artifactId);
      if (!isRecord(source) || requiredString(source, 'artifact_id') !== decision.subject.artifactId) throw new Error(`Recovery requires one isolated live activation: ${decision.subject.activationId}`);
      const control: unknown = db.prepare(`SELECT enforcement, version FROM activation_control_states WHERE activation_id = ?`).get(decision.subject.activationId);
      if (!isRecord(control) || control.enforcement !== 'safety_isolated' || control.version !== input.expectedControlVersion) throw new Error(`Recovery expected isolated control version ${input.expectedControlVersion}`);
      db.prepare(`INSERT INTO activation_decisions (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest, decision, principal_kind, owner_id, authentication_method, credential_id, reason_code, note, evidence_snapshot_id, decided_at) VALUES (?, ?, 'activation', ?, ?, ?, 'recover_to_shadow', 'configured_owner', ?, 'console_token', ?, ?, ?, ?, ?)`)
        .run(decision.decisionId, input.idempotencyKey, decision.subject.activationId, decision.subject.artifactId, decision.subject.artifactDigest, decision.principal.ownerId, decision.authentication.credentialId, decision.reasonCode, decision.note, decision.evidenceSnapshotId, decision.decidedAt);
      db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at) VALUES (?, ?, ?, 'code_tool_hook', 'code_tool_hook_shadow_activate', ?, ?, NULL, NULL)`)
        .run(input.newActivationId, `recovery:${decision.subject.activationId}:${input.idempotencyKey}`, decision.subject.artifactId, requiredString(source, 'target_ref'), decision.decidedAt);
      db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at) VALUES (?, 'eligible', NULL, 1, ?)`).run(input.newActivationId, decision.decidedAt);
      db.exec('COMMIT'); return { sourceActivationId: decision.subject.activationId, shadowActivationId: input.newActivationId, decisionId: decision.decisionId };
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  }

  async listDecisions(activationId: string): Promise<ActivationDecisionRecord[]> {
    const rows: unknown = this.connection.getDb().prepare(`
      SELECT decision_id, activation_id, artifact_id, artifact_digest, decision, principal_kind,
             owner_id, policy_version, break_glass_reason, authentication_method, credential_id,
             operator_kind, operator_id, reason_code, note, evidence_snapshot_id, decided_at
      FROM activation_decisions WHERE activation_id = ? ORDER BY decided_at, decision_id
    `).all(activationId);
    if (!Array.isArray(rows)) throw new Error('Malformed activation decision result');
    return rows.map(mapDecision);
  }

  async safetyIsolate(decision: ActivationDecisionRecord, expectedVersion: number): Promise<ActivationControlState> {
    if (decision.decision !== 'safety_isolate' || decision.principal.kind !== 'system_safety' || decision.authentication.method !== 'system' || decision.subject.kind !== 'activation') {
      throw new Error('safetyIsolate requires a system_safety/system safety_isolate activation decision');
    }
    const db = this.connection.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const subjectRow: unknown = db.prepare(`
        SELECT COUNT(*) AS count FROM activations
        WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook' AND deactivated_at IS NULL
      `).get(decision.subject.activationId, decision.subject.artifactId);
      if (!isRecord(subjectRow) || typeof subjectRow.count !== 'number' || subjectRow.count !== 1) {
        throw new Error(`Safety isolation subject mismatch or duplicate activation: ${decision.subject.activationId}`);
      }
      db.prepare(`
        INSERT INTO activation_decisions
          (decision_id, subject_kind, activation_id, artifact_id, artifact_digest, decision, principal_kind,
           owner_id, policy_version, break_glass_reason, authentication_method, credential_id,
           operator_kind, operator_id, reason_code, note, evidence_snapshot_id, decided_at)
        VALUES (?, 'activation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.decisionId, decision.subject.activationId, decision.subject.artifactId,
        decision.subject.artifactDigest, decision.decision, decision.principal.kind,
        null, decision.principal.policyVersion, null, decision.authentication.method, null,
        decision.operator?.kind ?? null, decision.operator?.operatorId ?? null,
        decision.reasonCode, decision.note, decision.evidenceSnapshotId, decision.decidedAt,
      );
      const result = db.prepare(`
        UPDATE activation_control_states
        SET enforcement = 'safety_isolated', isolation_decision_id = ?, version = version + 1, updated_at = ?
        WHERE activation_id = ? AND version = ?
      `).run(decision.decisionId, decision.decidedAt, decision.subject.activationId, expectedVersion);
      if (result.changes !== 1) throw new Error(`Safety isolation expected version ${expectedVersion} for activation ${decision.subject.activationId}`);
      const state = mapControl(db.prepare(`
        SELECT activation_id, enforcement, isolation_decision_id, version, updated_at
        FROM activation_control_states WHERE activation_id = ?
      `).get(decision.subject.activationId));
      if (!state) throw new Error(`Safety isolation control state missing for activation ${decision.subject.activationId}`);
      db.exec('COMMIT');
      return state;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
  }

  async commitPromotion(input: PromotionCommitInput): Promise<{ activationId: string; decisionId: string; promotedAt: string }> {
    const { decision, evidenceSnapshot } = input;
    if (decision.decision !== 'promote_live' || decision.subject.kind !== 'activation'
      || decision.principal.kind !== 'configured_owner'
      || (decision.authentication.method !== 'console_token' && decision.authentication.method !== 'cli_owner_credential')) {
      throw new Error('commitPromotion requires an authenticated configured_owner promote_live decision');
    }
    if (decision.evidenceSnapshotId !== evidenceSnapshot.snapshotId
      || input.evidenceSnapshotDigest !== evidenceSnapshot.snapshotDigest
      || decision.subject.artifactDigest !== evidenceSnapshot.artifactDigest) {
      throw new Error('Promotion evidence binding mismatch');
    }
    if (!Array.isArray(evidenceSnapshot.lineageRefs) || !evidenceSnapshot.lineageRefs.every(value => typeof value === 'string' && value.length > 0)
      || !Array.isArray(evidenceSnapshot.safetyGateResults)
      || !evidenceSnapshot.safetyGateResults.every(value => value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof value.checkId === 'string' && (value.status === 'passed' || value.status === 'failed'))) {
      throw new Error('Promotion evidence snapshot is malformed');
    }

    const db = this.connection.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay: unknown = db.prepare(`
        SELECT decision_id, activation_id, decided_at FROM activation_decisions WHERE idempotency_key = ?
      `).get(input.idempotencyKey);
      if (replay !== undefined) {
        if (!isRecord(replay)) throw new Error('Malformed promotion idempotency row');
        const activationId = requiredString(replay, 'activation_id');
        if (activationId !== decision.subject.activationId) throw new Error('Promotion idempotency key subject mismatch');
        db.exec('COMMIT');
        return { activationId, decisionId: requiredString(replay, 'decision_id'), promotedAt: requiredString(replay, 'decided_at') };
      }

      const subject: unknown = db.prepare(`
        SELECT COUNT(*) AS count FROM activations
        WHERE activation_id = ? AND artifact_id = ? AND channel = 'code_tool_hook'
          AND action = 'code_tool_hook_shadow_activate' AND deactivated_at IS NULL
      `).get(decision.subject.activationId, decision.subject.artifactId);
      if (!isRecord(subject) || subject.count !== 1) throw new Error(`Promotion requires exactly one active shadow activation: ${decision.subject.activationId}`);
      const control: unknown = db.prepare(`
        SELECT enforcement, version FROM activation_control_states WHERE activation_id = ?
      `).get(decision.subject.activationId);
      if (!isRecord(control) || control.enforcement !== 'eligible' || control.version !== input.expectedControlVersion) {
        throw new Error(`Promotion expected control version ${input.expectedControlVersion} in eligible state for activation ${decision.subject.activationId}`);
      }

      db.prepare(`
        INSERT INTO activation_evidence_snapshots
          (snapshot_id, snapshot_digest, artifact_digest, lineage_refs, host_runtime_version,
           safety_gate_results, shadow_summary, configuration_version, redaction_metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidenceSnapshot.snapshotId, evidenceSnapshot.snapshotDigest, evidenceSnapshot.artifactDigest,
        JSON.stringify(evidenceSnapshot.lineageRefs), evidenceSnapshot.hostRuntimeVersion,
        JSON.stringify(evidenceSnapshot.safetyGateResults), JSON.stringify(evidenceSnapshot.shadowSummary),
        evidenceSnapshot.configurationVersion, JSON.stringify(evidenceSnapshot.redaction), evidenceSnapshot.createdAt,
      );
      db.prepare(`
        INSERT INTO activation_decisions
          (decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest, decision,
           principal_kind, owner_id, policy_version, break_glass_reason, authentication_method, credential_id,
           operator_kind, operator_id, reason_code, note, evidence_snapshot_id, readiness_evaluation_id,
           evidence_snapshot_digest, decided_at)
        VALUES (?, ?, 'activation', ?, ?, ?, 'promote_live', 'configured_owner', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.decisionId, input.idempotencyKey, decision.subject.activationId, decision.subject.artifactId,
        decision.subject.artifactDigest, decision.principal.ownerId, decision.authentication.method,
        decision.authentication.credentialId, decision.operator?.kind ?? null, decision.operator?.operatorId ?? null,
        decision.reasonCode, decision.note, decision.evidenceSnapshotId, input.readinessEvaluationId,
        input.evidenceSnapshotDigest, decision.decidedAt,
      );
      const newPrinciple: unknown = db.prepare(`SELECT COALESCE(source_principle_id, json_extract(content_json, '$.principleId'), json_extract(content_json, '$.sourcePrincipleId')) AS principle_id FROM pi_artifacts WHERE artifact_id = ?`).get(decision.subject.artifactId);
      const principleId = isRecord(newPrinciple) && (typeof newPrinciple.principle_id === 'string' ? newPrinciple.principle_id : null);
      if (principleId) {
        const oldRows: unknown = db.prepare(`SELECT a.activation_id, a.artifact_id, p.artifact_kind, p.source_task_id, p.source_principle_id, p.source_rule_id, p.lineage_artifact_ids, p.validation_status, p.content_json, p.created_at, p.updated_at FROM activations a JOIN pi_artifacts p ON p.artifact_id = a.artifact_id WHERE a.channel = 'code_tool_hook' AND a.action = 'code_tool_hook_live_activate' AND a.deactivated_at IS NULL AND a.activation_id <> ? AND COALESCE(p.source_principle_id, json_extract(p.content_json, '$.principleId'), json_extract(p.content_json, '$.sourcePrincipleId')) = ?`).all(decision.subject.activationId, principleId);
        if (!Array.isArray(oldRows) || oldRows.length > 1) throw new Error(`Promotion replacement requires at most one prior live RuleCode for Principle ${principleId}`);
        for (const old of oldRows) {
          if (!isRecord(old)) throw new Error('Malformed prior live RuleCode row');
          const lineage: unknown = JSON.parse(requiredString(old, 'lineage_artifact_ids'));
          if (!Array.isArray(lineage) || !lineage.every(value => typeof value === 'string')) throw new Error('Malformed prior artifact lineage');
          const oldArtifact = { artifactId: requiredString(old, 'artifact_id'), artifactKind: requiredString(old, 'artifact_kind'), sourceTaskId: requiredString(old, 'source_task_id'), ...(optionalString(old, 'source_principle_id') ? { sourcePrincipleId: optionalString(old, 'source_principle_id') } : {}), ...(optionalString(old, 'source_rule_id') ? { sourceRuleId: optionalString(old, 'source_rule_id') } : {}), lineageArtifactIds: lineage, validationStatus: requiredString(old, 'validation_status'), contentJson: requiredString(old, 'content_json'), createdAt: requiredString(old, 'created_at'), updatedAt: requiredString(old, 'updated_at') };
          const oldActivationId = requiredString(old, 'activation_id'); const oldArtifactDigest = `sha256:${createHash('sha256').update(JSON.stringify(oldArtifact), 'utf8').digest('hex')}`;
          db.prepare(`INSERT INTO activation_decisions (decision_id, subject_kind, activation_id, artifact_id, artifact_digest, decision, principal_kind, owner_id, authentication_method, credential_id, reason_code, note, evidence_snapshot_id, decided_at) VALUES (?, 'activation', ?, ?, ?, 'supersede', 'configured_owner', ?, ?, ?, 'new_rulecode_version_promoted', ?, NULL, ?)`)
            .run(`${decision.decisionId}:supersede:${oldActivationId}`, oldActivationId, oldArtifact.artifactId, oldArtifactDigest, decision.principal.ownerId, decision.authentication.method, decision.authentication.credentialId, `Superseded by ${decision.subject.activationId}.`, decision.decidedAt);
          db.prepare(`UPDATE activations SET deactivated_at = ? WHERE activation_id = ? AND deactivated_at IS NULL`).run(decision.decidedAt, oldActivationId);
        }
      }
      const activationResult = db.prepare(`
        UPDATE activations SET action = 'code_tool_hook_live_activate', promoted_at = ?
        WHERE activation_id = ? AND artifact_id = ? AND action = 'code_tool_hook_shadow_activate' AND deactivated_at IS NULL
      `).run(decision.decidedAt, decision.subject.activationId, decision.subject.artifactId);
      const controlResult = db.prepare(`
        UPDATE activation_control_states SET version = version + 1, updated_at = ?
        WHERE activation_id = ? AND enforcement = 'eligible' AND version = ?
      `).run(decision.decidedAt, decision.subject.activationId, input.expectedControlVersion);
      if (activationResult.changes !== 1 || controlResult.changes !== 1) throw new Error('Promotion state changed during atomic commit');
      db.exec('COMMIT');
      return { activationId: decision.subject.activationId, decisionId: decision.decisionId, promotedAt: decision.decidedAt };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
  }
}
