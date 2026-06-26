import type {
  ApprovalDecisionResult,
  ApprovalEditInput,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalListFilter,
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalStats,
  ApprovalStatus,
  InternalizationChannel,
  ActivationRiskLevel,
} from './activation-types.js';
import type { SqliteConnection } from '../store/sqlite-connection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(row: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(row, key)) return null;
  const val = row[key];
  return typeof val === 'string' ? val : null;
}

function readOptionalStringField(row: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(row, key)) return undefined;
  const val = row[key];
  if (val === null) return undefined;
  return typeof val === 'string' ? val : undefined;
}

function readOptionalNumberField(row: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(row, key)) return undefined;
  const val = row[key];
  if (val === null) return undefined;
  return typeof val === 'number' ? val : undefined;
}

// Validates an unknown DB row and maps to ApprovalRecord.
// Follows sqlite-activation-state-store.ts pattern (ERR-001 safe: no `as` cast on .get() result).
function mapRowToRecord(row: unknown): ApprovalRecord | null {
  if (!isRecord(row)) return null;

  const approvalId = readStringField(row, 'approval_id');
  const artifactId = readStringField(row, 'artifact_id');
  const channel = readStringField(row, 'channel');
  const riskLevel = readStringField(row, 'risk_level');
  const status = readStringField(row, 'status');
  const requestedAt = readStringField(row, 'requested_at');

  // Required fields must be present and string-typed
  if (!approvalId || !artifactId || !channel || !riskLevel || !status || !requestedAt) {
    return null;
  }

  return {
    approvalId,
    artifactId,
    channel: channel as InternalizationChannel,
    riskLevel: riskLevel as ActivationRiskLevel,
    status: status as ApprovalStatus,
    confidence: readOptionalNumberField(row, 'confidence'),
    requestedAt,
    decidedAt: readOptionalStringField(row, 'decided_at'),
    decidedBy: readOptionalStringField(row, 'decided_by'),
    decisionNote: readOptionalStringField(row, 'decision_note'),
    rejectionReason: readOptionalStringField(row, 'rejection_reason'),
    summary: readOptionalStringField(row, 'summary'),
    triggerReason: readOptionalStringField(row, 'trigger_reason'),
    confidenceExplanation: readOptionalStringField(row, 'confidence_explanation'),
    effectDescription: readOptionalStringField(row, 'effect_description'),
    rejectionEffect: readOptionalStringField(row, 'rejection_effect'),
    editedAt: readOptionalStringField(row, 'edited_at'),
    editedBy: readOptionalStringField(row, 'edited_by'),
    editReason: readOptionalStringField(row, 'edit_reason'),
    previousArtifactId: readOptionalStringField(row, 'previous_artifact_id'),
  };
}

interface ApprovalRow {
  approval_id: string;
  artifact_id: string;
  channel: string;
  risk_level: string;
  status: string;
  confidence: number | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  rejection_reason: string | null;
  summary: string | null;
  trigger_reason: string | null;
  confidence_explanation: string | null;
  effect_description: string | null;
  rejection_effect: string | null;
  edited_at: string | null;
  edited_by: string | null;
  edit_reason: string | null;
  previous_artifact_id: string | null;
}

function rowToRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    artifactId: row.artifact_id,
    channel: row.channel as InternalizationChannel,
    riskLevel: row.risk_level as ActivationRiskLevel,
    status: row.status as ApprovalStatus,
    confidence: row.confidence ?? undefined,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    summary: row.summary ?? undefined,
    triggerReason: row.trigger_reason ?? undefined,
    confidenceExplanation: row.confidence_explanation ?? undefined,
    effectDescription: row.effect_description ?? undefined,
    rejectionEffect: row.rejection_effect ?? undefined,
    editedAt: row.edited_at ?? undefined,
    editedBy: row.edited_by ?? undefined,
    editReason: row.edit_reason ?? undefined,
    previousArtifactId: row.previous_artifact_id ?? undefined,
  };
}

function makeApprovalId(artifactId: string, channel: InternalizationChannel): string {
  return 'apr_' + channel + '_' + artifactId;
}

export class SqliteApprovalQueueStore implements ApprovalQueueStore {
  constructor(private readonly connection: SqliteConnection) {}

  async enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> {
    const db = this.connection.getDb();
    // P1-3: Application-layer FK check (DB-layer FK deferred to post-MVP table rebuild).
    // Fail loud if artifact_id references non-existent pi_artifact (ERR-009/ERR-010/ERR-002).
    const artifactExists = db.prepare('SELECT 1 FROM pi_artifacts WHERE artifact_id = ?').get(input.artifactId);
    if (!artifactExists) {
      throw new Error(
        `approvals.artifact_id references non-existent pi_artifact: ${input.artifactId}`,
      );
    }
    const approvalId = makeApprovalId(input.artifactId, input.channel);
    db.prepare(
      'INSERT OR IGNORE INTO approvals' +
        ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at,' +
        ' summary, trigger_reason, confidence_explanation, effect_description, rejection_effect)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      approvalId,
      input.artifactId,
      input.channel,
      input.riskLevel,
      'pending',
      input.confidence ?? null,
      now,
      input.summary ?? null,
      input.triggerReason ?? null,
      input.confidenceExplanation ?? null,
      input.effectDescription ?? null,
      input.rejectionEffect ?? null,
    );
    const row = db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
    if (!row) throw new Error('ApprovalQueue enqueue failed: no row found for ' + approvalId);
    return rowToRecord(row);
  }

  async getById(approvalId: string): Promise<ApprovalRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]> {
    const db = this.connection.getDb();
    let sql = "SELECT * FROM approvals WHERE status = 'pending'";
    const params: unknown[] = [];
    if (filter?.channel) { sql += ' AND channel = ?'; params.push(filter.channel); }
    if (filter?.riskLevel) { sql += ' AND risk_level = ?'; params.push(filter.riskLevel); }
    const rows = db.prepare(sql).all(...params) as ApprovalRow[];
    return rows.map(rowToRecord);
  }

  async listAll(filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    const db = this.connection.getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
    if (filter?.channel) { conditions.push('channel = ?'); params.push(filter.channel); }
    let sql = 'SELECT * FROM approvals';
    if (conditions.length > 0) { sql += ' WHERE ' + conditions.join(' AND '); }
    sql += ' ORDER BY requested_at DESC';
    const page = filter?.page ?? 1;
    const pageSize = filter?.pageSize ?? 0;
    if (pageSize > 0) {
      const offset = (page - 1) * pageSize;
      sql += ' LIMIT ? OFFSET ?';
      params.push(pageSize, offset);
    }
    const rows = db.prepare(sql).all(...params) as ApprovalRow[];
    return rows.map(rowToRecord);
  }

  async countByStatus(): Promise<ApprovalStats> {
    const db = this.connection.getDb();
    const rows = db.prepare('SELECT status, COUNT(*) as cnt FROM approvals GROUP BY status').all() as { status: string; cnt: number }[];
    const stats: ApprovalStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const row of rows) {
      if (row.status in stats) { stats[row.status as keyof ApprovalStats] = row.cnt; }
    }
    return stats;
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    // Single atomic statement: UPDATE + RETURNING eliminates the race window
    // between UPDATE and subsequent SELECT (ERR-015 stale state pattern).
    const record = mapRowToRecord(db.prepare(
      "UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = 'pending' RETURNING *"
    ).get(now, decidedBy, note ?? null, approvalId));
    if (!record) {
      const fresh = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
      if (!fresh) return { ok: false, error: 'not_found' };
      return { ok: false, error: 'already_decided', status: fresh.status as ApprovalStatus };
    }
    return { ok: true, record };
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    // Single atomic statement: UPDATE + RETURNING eliminates the race window
    // between UPDATE and subsequent SELECT (ERR-015 stale state pattern).
    const record = mapRowToRecord(db.prepare(
      "UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, rejection_reason = ? WHERE approval_id = ? AND status = 'pending' RETURNING *"
    ).get(now, decidedBy, reason, approvalId));
    if (!record) {
      const fresh = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
      if (!fresh) return { ok: false, error: 'not_found' };
      return { ok: false, error: 'already_decided', status: fresh.status as ApprovalStatus };
    }
    return { ok: true, record };
  }

  async resetToPending(approvalId: string): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_approved' }> {
    const db = this.connection.getDb();
    const existing = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'approved') return { ok: false, error: 'not_approved' };
    db.prepare("UPDATE approvals SET status = 'pending', decided_at = NULL, decided_by = NULL, decision_note = NULL WHERE approval_id = ? AND status = 'approved'").run(approvalId);
    return { ok: true };
  }

  async edit(input: ApprovalEditInput): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    // Single atomic statement: UPDATE + RETURNING eliminates the race window
    // between UPDATE and subsequent SELECT (ERR-015 stale state pattern).
    // Derives previous_artifact_id from current DB value to prevent lineage
    // drift during concurrent edits (ERR-004/ERR-008).
    const record = mapRowToRecord(db.prepare(
      "UPDATE approvals SET previous_artifact_id = artifact_id, artifact_id = ?, edited_at = ?, edited_by = ?, edit_reason = ? WHERE approval_id = ? AND status = 'pending' RETURNING *"
    ).get(input.newArtifactId, input.now, input.editedBy, input.editReason, input.approvalId));
    if (!record) {
      const fresh = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(input.approvalId) as { status: string } | undefined;
      if (!fresh) return { ok: false, error: 'not_found' };
      return { ok: false, error: 'already_decided', status: fresh.status as ApprovalStatus };
    }
    return { ok: true, record };
  }
}