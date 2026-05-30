import type { SqliteConnection } from '../store/sqlite-connection.js';

export interface ConfirmFirstStateRecord {
  sessionId: string;
  directiveActive: boolean;
  directivePrincipleId: string | null;
  directiveSetAt: string;
  approvalActive: boolean;
  approvalSetAt: string | null;
  lastSeenAt: string;
}

const MAX_SESSION_ENTRIES = 500;
const STALE_ROW_DAYS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(row: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(row, key)) return null;
  const val = row[key];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function mapRowToRecord(row: unknown): ConfirmFirstStateRecord | null {
  if (!isRecord(row)) return null;

  const sessionId = readStringField(row, 'session_id');
  const directiveSetAt = readStringField(row, 'directive_set_at');
  const lastSeenAt = readStringField(row, 'last_seen_at');

  if (!sessionId || !directiveSetAt || !lastSeenAt) return null;

  const directiveActive = row.directive_active === 1;
  const directivePrincipleId = readStringField(row, 'directive_principle_id');
  const approvalActive = row.approval_active === 1;
  const approvalSetAt = readStringField(row, 'approval_set_at');

  return {
    sessionId,
    directiveActive,
    directivePrincipleId,
    directiveSetAt,
    approvalActive,
    approvalSetAt,
    lastSeenAt,
  };
}

export class SqliteConfirmFirstStateStore {
  constructor(private readonly connection: SqliteConnection) {}

  upsertDirective(sessionId: string, active: boolean, principleId?: string | null): void {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO confirm_first_state (session_id, directive_active, directive_principle_id, directive_set_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        directive_active=excluded.directive_active,
        directive_principle_id=excluded.directive_principle_id,
        directive_set_at=excluded.directive_set_at,
        last_seen_at=excluded.last_seen_at
    `).run(sessionId, active ? 1 : 0, principleId ?? null, now, now);
  }

  upsertApproval(sessionId: string): void {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO confirm_first_state (session_id, approval_active, approval_set_at, last_seen_at, directive_active, directive_set_at)
      VALUES (?, 1, ?, ?, 0, '')
      ON CONFLICT(session_id) DO UPDATE SET
        approval_active=1,
        approval_set_at=excluded.approval_set_at,
        last_seen_at=excluded.last_seen_at
    `).run(sessionId, now, now);
  }

  getState(sessionId: string): ConfirmFirstStateRecord | null {
    try {
      const db = this.connection.getDb();
      const row = db.prepare(`
        SELECT session_id, directive_active, directive_principle_id, directive_set_at,
               approval_active, approval_set_at, last_seen_at
        FROM confirm_first_state
        WHERE session_id = ?
      `).get(sessionId);
      return mapRowToRecord(row);
    } catch (err) {
      if (err instanceof Error && err.message.includes('no such table')) return null;
      throw err;
    }
  }

  deleteState(sessionId: string): void {
    const db = this.connection.getDb();
    db.prepare('DELETE FROM confirm_first_state WHERE session_id = ?').run(sessionId);
  }

  deleteAllState(): void {
    const db = this.connection.getDb();
    db.prepare('DELETE FROM confirm_first_state').run();
  }

  pruneStaleRows(): number {
    const db = this.connection.getDb();
    const staleResult = db.prepare(
      `DELETE FROM confirm_first_state WHERE last_seen_at < datetime('now', '-${STALE_ROW_DAYS} days')`
    ).run();
    let pruned = staleResult.changes;

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM confirm_first_state').get();
    if (isRecord(countRow) && Object.hasOwn(countRow, 'cnt')) {
      const total = Number(countRow.cnt);
      if (total > MAX_SESSION_ENTRIES) {
        const excess = total - MAX_SESSION_ENTRIES;
        const excessResult = db.prepare(`
          DELETE FROM confirm_first_state
          WHERE session_id IN (
            SELECT session_id FROM confirm_first_state
            ORDER BY last_seen_at ASC
            LIMIT ?
          )
        `).run(excess);
        pruned += excessResult.changes;
      }
    }

    return pruned;
  }

  getAllState(): ConfirmFirstStateRecord[] {
    try {
      const db = this.connection.getDb();
      const rows = db.prepare(`
        SELECT session_id, directive_active, directive_principle_id, directive_set_at,
               approval_active, approval_set_at, last_seen_at
        FROM confirm_first_state
      `).all();

      if (!Array.isArray(rows)) return [];

      const result: ConfirmFirstStateRecord[] = [];
      for (const row of rows) {
        const record = mapRowToRecord(row);
        if (record) result.push(record);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('no such table')) return [];
      throw err;
    }
  }
}
