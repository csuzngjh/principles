import type {
  ApprovalDecisionResult,
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
  };
}

function makeApprovalId(artifactId: string, channel: InternalizationChannel): string {
  return 'apr_' + channel + '_' + artifactId;
}

export class SqliteApprovalQueueStore implements ApprovalQueueStore {
  constructor(private readonly connection: SqliteConnection) {}

  async enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> {
    const db = this.connection.getDb();
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
    const existing = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') { return { ok: false, error: 'already_decided', status: existing.status as ApprovalStatus }; }
    const now = new Date().toISOString();
    const updateResult = db.prepare("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = 'pending'").run(now, decidedBy, note ?? null, approvalId);
    if (updateResult.changes === 0) {
      const fresh = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
      if (!fresh) return { ok: false, error: 'not_found' };
      return { ok: false, error: 'already_decided', status: fresh.status as ApprovalStatus };
    }
    const row = db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow;
    return { ok: true, record: rowToRecord(row) };
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    const existing = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') { return { ok: false, error: 'already_decided', status: existing.status as ApprovalStatus }; }
    const now = new Date().toISOString();
    const updateResult = db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, rejection_reason = ? WHERE approval_id = ? AND status = 'pending'").run(now, decidedBy, reason, approvalId);
    if (updateResult.changes === 0) {
      const fresh = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId) as { status: string } | undefined;
      if (!fresh) return { ok: false, error: 'not_found' };
      return { ok: false, error: 'already_decided', status: fresh.status as ApprovalStatus };
    }
    const row = db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow;
    return { ok: true, record: rowToRecord(row) };
  }
}