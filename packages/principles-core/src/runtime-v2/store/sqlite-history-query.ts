/**
 * SQLite implementation of HistoryQuery.
 *
 * Retrieves bounded history entries from run records with cursor-based
 * keyset pagination and time-window scoping. Each RunRecord maps to
 * 2 HistoryQueryEntry items (system + assistant roles).
 *
 * All SQL uses parameterized queries (?), never string interpolation.
 * Validates output with TypeBox Value.Check() before returning.
 */
import { Value } from '@sinclair/typebox/value';
import {
  HistoryQueryResultSchema,
  type HistoryQueryEntry,
  type HistoryQueryResult,
} from '../context-payload.js';
import { PDRuntimeError } from '../error-categories.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type {
  HistoryQuery,
  HistoryQueryCursorData,
  HistoryQueryOptions,
} from './history-query.js';
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_TIME_WINDOW_MS,
} from './history-query.js';

/** Parameters for a paginated history SQL query. */
interface QueryParams {
  trajectoryRef: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  runLimit: number;
}

/** Parameters for a cursor-based history SQL query. */
interface CursorQueryParams extends QueryParams {
  cursor: string;
}

export class SqliteHistoryQuery implements HistoryQuery {
  constructor(private readonly connection: SqliteConnection) {}

  async query(
    trajectoryRef: string,
    cursor?: string,
    options?: HistoryQueryOptions,
  ): Promise<HistoryQueryResult> {
    return this.executeQuery(trajectoryRef, cursor, options);
  }

  private async executeQuery(
    trajectoryRef: string,
    cursor: string | undefined,
    options: HistoryQueryOptions | undefined,
  ): Promise<HistoryQueryResult> {
    const effectiveEntryLimit = Math.min(
      Math.max(1, options?.limit ?? DEFAULT_HISTORY_PAGE_SIZE),
      MAX_HISTORY_PAGE_SIZE,
    );

    const now = new Date();
    const timeWindowEnd = options?.timeWindowEnd ?? now.toISOString();
    const timeWindowStart =
      options?.timeWindowStart ??
      new Date(now.getTime() - DEFAULT_TIME_WINDOW_MS).toISOString();

    // Each run maps to 2 entries (system + assistant), so fetch enough runs
    // to potentially fill the entry limit. Fetch one extra run to detect truncation.
    const runLimit = Math.ceil(effectiveEntryLimit / 2) + 1;

    const queryParams: QueryParams = {
      trajectoryRef,
      timeWindowStart,
      timeWindowEnd,
      runLimit,
    };

    const rows = cursor
      ? this.queryWithCursor({ ...queryParams, cursor })
      : this.queryFirstPage(queryParams);

    // Map all fetched runs to entries
    const allEntries = rows.flatMap((row) => SqliteHistoryQuery.mapRunToEntries(row));

    const hasMore = allEntries.length > effectiveEntryLimit;
    const entries = hasMore ? allEntries.slice(0, effectiveEntryLimit) : allEntries;

    // Find the last run row that contributed to the returned entries
    const lastEntryRunCount = Math.ceil(entries.length / 2);
    const lastRow = rows[lastEntryRunCount - 1];

    const nextCursor = hasMore && lastRow
      ? SqliteHistoryQuery.buildCursor(lastRow, trajectoryRef)
      : undefined;

    const result: HistoryQueryResult = {
      sourceRef: trajectoryRef,
      entries,
      truncated: hasMore,
      nextCursor,
    };

    if (!Value.Check(HistoryQueryResultSchema, result)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        'History query result schema validation failed',
      );
    }

    return result;
  }

  private queryFirstPage(params: QueryParams): Record<string, unknown>[] {
    const db = this.connection.getDb();
    return db
      .prepare(
        `SELECT * FROM runs
         WHERE task_id = ?
           AND started_at >= ?
           AND started_at <= ?
         ORDER BY started_at DESC, run_id DESC
         LIMIT ?`,
      )
      .all(
        params.trajectoryRef,
        params.timeWindowStart,
        params.timeWindowEnd,
        params.runLimit,
      ) as Record<string, unknown>[];
  }

  private queryWithCursor(params: CursorQueryParams): Record<string, unknown>[] {
    const cursorData = SqliteHistoryQuery.decodeCursor(params.cursor, params.trajectoryRef);
    const cursorStartedAt = this.getRunStartedAt(cursorData.lastRunId);

    if (cursorStartedAt === null) {
      throw new PDRuntimeError(
        'input_invalid',
        'Cursor references a run that no longer exists',
      );
    }

    const db = this.connection.getDb();
    return db
      .prepare(
        `SELECT * FROM runs
         WHERE task_id = ?
           AND started_at >= ?
           AND started_at <= ?
           AND (started_at < ? OR (started_at = ? AND run_id < ?))
         ORDER BY started_at DESC, run_id DESC
         LIMIT ?`,
      )
      .all(
        params.trajectoryRef,
        params.timeWindowStart,
        params.timeWindowEnd,
        cursorStartedAt,
        cursorStartedAt,
        cursorData.lastRunId,
        params.runLimit,
      ) as Record<string, unknown>[];
  }

  private getRunStartedAt(runId: string): string | null {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT started_at FROM runs WHERE run_id = ?')
      .get(runId) as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  private static decodeCursor(cursor: string, expectedTaskId: string): HistoryQueryCursorData {
    try {
      const json = Buffer.from(cursor, 'base64').toString('utf-8');
      const data = JSON.parse(json) as HistoryQueryCursorData;

      if (!data.taskId || !data.lastRunId || !data.direction) {
        throw new PDRuntimeError(
          'input_invalid',
          'Cursor missing required fields (taskId, lastRunId, direction)',
        );
      }

      if (data.taskId !== expectedTaskId) {
        throw new PDRuntimeError(
          'input_invalid',
          `Cursor taskId mismatch: expected ${expectedTaskId}, got ${data.taskId}`,
        );
      }

      return data;
    } catch (e) {
      if (e instanceof PDRuntimeError) throw e;
      throw new PDRuntimeError(
        'input_invalid',
        `Malformed cursor: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private static buildCursor(lastRow: Record<string, unknown>, taskId: string): string {
    const cursorData: HistoryQueryCursorData = {
      taskId,
      lastRunId: String(lastRow.run_id),
      direction: 'forward',
    };
    return Buffer.from(JSON.stringify(cursorData), 'utf-8').toString('base64');
  }

  private static mapRunToEntries(row: Record<string, unknown>): HistoryQueryEntry[] {
    const startedAt = String(row.started_at);
    const endedAt = row.ended_at ? String(row.ended_at) : startedAt;
    const inputPayload = (row.input_payload as string | null) ?? undefined;
    const outputPayload = (row.output_payload as string | null) ?? undefined;

    return [
      // Entry 1: system role (input)
      {
        ts: startedAt,
        role: 'system' as const,
        text: inputPayload,
      },
      // Entry 2: assistant role (output)
      {
        ts: endedAt,
        role: 'assistant' as const,
        text: outputPayload,
      },
    ];
  }
}
