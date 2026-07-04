/**
 * SqliteDeadLetterStore — durable store for pain signals that failed to be
 * recorded by PainToPrincipleService.
 *
 * Task 3: When `emitPainDetectedEvent` in pain.ts catches an exception from
 * `service.recordPain()`, the pain data is written here so it is not silently
 * lost (rc-9: no silent fallback). `pd pain retry --pain-id <id>` can later
 * read the dead letter and replay the pain through PainSignalBridge.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: DB rows treated as unknown; painData parsed as
 *   unknown and never `as`-cast to a typed shape.
 * - EP-01 / ERR-013: Object.hasOwn not needed here — we read column names from
 *   sqlite rows via String()/Number() guards, not `in` or bracket access on
 *   untrusted keys.
 * - EP-03 / ERR-002: write failures return { ok: false, error } so callers
 *   can log an observable reason (rc-9). Parse failures on read are wrapped
 *   into a structured object so the caller can observe them.
 * - EP-05 / ERR-015: markRetried reads fresh row state via UPDATE ... WHERE
 *   pain_id = ?, so retry_count is always incremented from the latest value.
 */

import type { SqliteConnection } from '../sqlite-connection.js';

/** A row in the dead_letter_pains table. painData is unknown (rc-1). */
export interface DeadLetterRow {
  id: string;
  painId: string;
  painData: unknown;
  failedAt: string;
  retryCount: number;
  retriedAt: string | null;
}

/** Result of an insert or markRetried operation. */
export type DeadLetterOpResult = { ok: true } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Map a sqlite row (Record<string, unknown>) to a DeadLetterRow.
 * painData is JSON.parse'd into unknown; parse failures are wrapped into a
 * structured object so the caller can observe them (rc-9: no silent fallback).
 */
function rowToRecord(row: Record<string, unknown>): DeadLetterRow {
  let painData: unknown = null;
  if (typeof row.pain_data === 'string') {
    try {
      painData = JSON.parse(row.pain_data);
    } catch (parseErr) {
      // rc-9: wrap parse failure so the caller can observe it instead of
      // silently getting a raw string masquerading as the original object.
      painData = {
        __deadLetterParseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
        raw: row.pain_data,
      };
    }
  }
  return {
    id: String(row.id),
    painId: String(row.pain_id),
    painData,
    failedAt: String(row.failed_at),
    retryCount: Number(row.retry_count ?? 0),
    retriedAt: row.retried_at ? String(row.retried_at) : null,
  };
}

export class SqliteDeadLetterStore {
  constructor(private readonly connection: SqliteConnection) {}

  /**
   * Persist a pain signal that failed to be recorded.
   * painData is JSON.stringify'd before storage; non-serializable values are
   * wrapped in a fallback envelope so the insert never silently drops data.
   */
  insertDeadLetter(input: { painId: string; painData: unknown }): DeadLetterOpResult {
    try {
      const db = this.connection.getDb();
      const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const failedAt = new Date().toISOString();
      let painDataJson: string;
      try {
        painDataJson = JSON.stringify(input.painData);
      } catch (serializeErr) {
        // rc-9: keep an observable envelope instead of dropping the row.
        painDataJson = JSON.stringify({
          __deadLetterSerializeError: serializeErr instanceof Error ? serializeErr.message : String(serializeErr),
          painId: input.painId,
        });
      }
      db.prepare(
        'INSERT INTO dead_letter_pains (id, pain_id, pain_data, failed_at, retry_count, retried_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.painId, painDataJson, failedAt, 0, null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List dead letters, most recent first. */
  listDeadLetters(filter?: { limit?: number }): DeadLetterRow[] {
    const db = this.connection.getDb();
    const limit = filter?.limit ?? 100;
    const rows = db
      .prepare('SELECT * FROM dead_letter_pains ORDER BY failed_at DESC LIMIT ?')
      .all(limit);
    return rows.filter(isRecord).map((row) => rowToRecord(row));
  }

  /**
   * Mark a dead letter as retried.
   * - success=true:  retry_count++, retried_at = now
   * - success=false: retry_count++ only (retried_at stays null so it remains retryable)
   */
  markRetried(painId: string, success: boolean): DeadLetterOpResult {
    try {
      const db = this.connection.getDb();
      if (success) {
        const retriedAt = new Date().toISOString();
        const result = db
          .prepare(
            'UPDATE dead_letter_pains SET retry_count = retry_count + 1, retried_at = ? WHERE pain_id = ?',
          )
          .run(retriedAt, painId);
        if (result.changes === 0) {
          return { ok: false, error: `No dead letter found for painId: ${painId}` };
        }
      } else {
        const result = db
          .prepare('UPDATE dead_letter_pains SET retry_count = retry_count + 1 WHERE pain_id = ?')
          .run(painId);
        if (result.changes === 0) {
          return { ok: false, error: `No dead letter found for painId: ${painId}` };
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get the most recent dead letter for a painId, or null if none. */
  getByPainId(painId: string): DeadLetterRow | null {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT * FROM dead_letter_pains WHERE pain_id = ? ORDER BY failed_at DESC LIMIT 1')
      .get(painId);
    if (!isRecord(row)) return null;
    return rowToRecord(row);
  }
}
