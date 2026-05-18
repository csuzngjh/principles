import type {
  ApprovalDecisionResult,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalQueueStore,
  ApprovalRecord,
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
  };
}

function makeApprovalId(artifactId: string, channel: InternalizationChannel): string {
  return `apr_${channel}_${artifactId}`;
}

export class SqliteApprovalQueueStore implements ApprovalQueueStore {
  constructor(private readonly connection: SqliteConnection) {}

  async enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> {
    const db = this.connection.getDb();
    const approvalId = makeApprovalId(input.artifactId, input.channel);
    db.prepare(`INSERT OR IGNORE INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      approvalId,
      input.artifactId,
      input.channel,
      input.riskLevel,
      'pending',
      input.confidence ?? null,
      now,
    );
    const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as ApprovalRow;
    return rowToRecord(row);
  }

  async getById(approvalId: string): Promise<ApprovalRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as ApprovalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]> {
    const db = this.connection.getDb();
    let sql = `SELECT * FROM approvals WHERE status = 'pending'`;
    const params: unknown[] = [];
    if (filter?.channel) {
      sql += ` AND channel = ?`;
      params.push(filter.channel);
    }
    if (filter?.riskLevel) {
      sql += ` AND risk_level = ?`;
      params.push(filter.riskLevel);
    }
    const rows = db.prepare(sql).all(...params) as ApprovalRow[];
    return rows.map(rowToRecord);
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    const existing = db.prepare(`SELECT status FROM approvals WHERE approval_id = ?`).get(approvalId) as { status: string } | undefined;
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status as ApprovalStatus };
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = 'pending'`).run(now, decidedBy, note ?? null, approvalId);
    const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as ApprovalRow;
    return { ok: true, record: rowToRecord(row) };
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const db = this.connection.getDb();
    const existing = db.prepare(`SELECT status FROM approvals WHERE approval_id = ?`).get(approvalId) as { status: string } | undefined;
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status as ApprovalStatus };
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, rejection_reason = ? WHERE approval_id = ? AND status = 'pending'`).run(now, decidedBy, reason, approvalId);
    const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as ApprovalRow;
    return { ok: true, record: rowToRecord(row) };
  }
}