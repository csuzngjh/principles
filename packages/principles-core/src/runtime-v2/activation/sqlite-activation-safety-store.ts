import type { SqliteConnection } from '../store/sqlite-connection.js';
import type { ActivationControlState, ActivationDecisionKind, ActivationDecisionRecord } from './activation-control-types.js';

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
  const principal = requiredString(row, 'principal');
  const authentication = requiredString(row, 'authentication');
  if (principal !== 'configured_owner' && principal !== 'system_safety' && principal !== 'break_glass') throw new Error('Malformed activation decision row: principal');
  if (authentication !== 'console_token' && authentication !== 'cli_owner_credential' && authentication !== 'system' && authentication !== 'local_break_glass') throw new Error('Malformed activation decision row: authentication');
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
    operator: optionalString(row, 'operator') ?? undefined,
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

  async listDecisions(activationId: string): Promise<ActivationDecisionRecord[]> {
    const rows: unknown = this.connection.getDb().prepare(`
      SELECT decision_id, activation_id, artifact_id, artifact_digest, decision, principal,
             authentication, operator, reason_code, note, evidence_snapshot_id, decided_at
      FROM activation_decisions WHERE activation_id = ? ORDER BY decided_at, decision_id
    `).all(activationId);
    if (!Array.isArray(rows)) throw new Error('Malformed activation decision result');
    return rows.map(mapDecision);
  }

  async safetyIsolate(decision: ActivationDecisionRecord, expectedVersion: number): Promise<ActivationControlState> {
    if (decision.decision !== 'safety_isolate' || decision.principal !== 'system_safety' || decision.authentication !== 'system' || decision.subject.kind !== 'activation') {
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
          (decision_id, subject_kind, activation_id, artifact_id, artifact_digest, decision, principal,
           authentication, operator, reason_code, note, evidence_snapshot_id, decided_at)
        VALUES (?, 'activation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.decisionId, decision.subject.activationId, decision.subject.artifactId,
        decision.subject.artifactDigest, decision.decision, decision.principal, decision.authentication,
        decision.operator ?? null, decision.reasonCode, decision.note, decision.evidenceSnapshotId, decision.decidedAt,
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
}
