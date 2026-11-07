/**
 * SqliteReconciliationCursorStore — durable scan-progress cursor for the
 * succeeded-transition reconciliation (A-liveness).
 *
 * One row per scope. Restart-durable: the auto-consumer persists the cursor
 * after each bounded sweep so progress is never permanently reset.
 * Pure SQLite I/O belongs to the core store layer (same placement as the
 * other Sqlite*Store classes); no business logic here.
 */
import type { SqliteConnection } from './sqlite-connection.js';

export interface ReconciliationCursor {
  lastUpdatedAt: string;
  lastTaskId: string;
}

export const SUCCEEDED_TRANSITIONS_SCOPE = 'succeeded-transitions';

export class SqliteReconciliationCursorStore {
  constructor(private readonly connection: SqliteConnection) {}

  get(scope: string): ReconciliationCursor | null {
    const row = this.connection.getDb()
      .prepare('SELECT last_updated_at, last_task_id FROM reconciliation_cursor WHERE scope = ?')
      .get(scope) as { last_updated_at?: unknown; last_task_id?: unknown } | undefined;
    if (!row || typeof row.last_updated_at !== 'string' || typeof row.last_task_id !== 'string') {
      return null;
    }
    return { lastUpdatedAt: row.last_updated_at, lastTaskId: row.last_task_id };
  }

  set(scope: string, cursor: ReconciliationCursor): void {
    this.connection.getDb()
      .prepare(`
        INSERT INTO reconciliation_cursor (scope, last_updated_at, last_task_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          last_updated_at = excluded.last_updated_at,
          last_task_id = excluded.last_task_id,
          updated_at = excluded.updated_at
      `)
      .run(scope, cursor.lastUpdatedAt, cursor.lastTaskId, new Date().toISOString());
  }

  clear(scope: string): void {
    this.connection.getDb()
      .prepare('DELETE FROM reconciliation_cursor WHERE scope = ?')
      .run(scope);
  }
}
