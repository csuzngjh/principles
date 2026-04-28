/**
 * SQLite implementation of TrajectoryLocator.
 *
 * Routes locate queries to appropriate handlers based on query fields.
 * All SQL uses parameterized queries (?), never string interpolation.
 * Validates output with TypeBox Value.Check() before returning.
 */
import { Value } from '@sinclair/typebox/value';
import {
  TrajectoryLocateResultSchema,
  type TrajectoryLocateQuery,
  type TrajectoryLocateResult,
  type TrajectoryCandidate,
} from '../context-payload.js';
import { PDRuntimeError } from '../error-categories.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { TrajectoryLocator } from './trajectory-locator.js';

export class SqliteTrajectoryLocator implements TrajectoryLocator {
  constructor(private readonly connection: SqliteConnection) {}

  async locate(query: TrajectoryLocateQuery): Promise<TrajectoryLocateResult> {
    const result = await this.routeQuery(query);

    if (!Value.Check(TrajectoryLocateResultSchema, result)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        'TrajectoryLocateResult schema validation failed — internal error',
      );
    }

    return result;
  }

  private async routeQuery(query: TrajectoryLocateQuery): Promise<TrajectoryLocateResult> {
    if (query.painId) {
      return this.locateByRunAlias(query.painId, query);
    }
    if (query.taskId) {
      return this.locateByTaskId(query.taskId, query);
    }
    if (query.runId) {
      return this.locateByRunId(query.runId, query);
    }
    if (query.sessionId && query.workspace) {
      return this.locateBySessionHint(query);
    }
    if (query.timeRange) {
      return this.locateByTimeRange(query.timeRange, query);
    }
    if (query.executionStatus) {
      return this.locateByExecutionStatus(query.executionStatus, query);
    }
    return { query, candidates: [] };
  }

  /**
   * Locate trajectory by run alias (run_id lookup without full reference).
   *
   * This is a fallback path: callers who only have a run_id string but no
   * formal lookup handle can use this to resolve it to a task_id.
   *
   * NOTE: The `painId` parameter name is a historical alias — it carries no
   * pain-signal semantics here. The parameter is the caller's run_id value.
   * If a true pain-signal → task lookup is needed, query against
   * tasks.diagnostic_json (SQLite JSON path extraction) instead.
   */
  private async locateByRunAlias(
    runAlias: string,
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT task_id FROM runs WHERE run_id = ?')
      .get(runAlias) as { task_id: string } | undefined;

    if (!row) {
      return { query, candidates: [] };
    }

    const candidate: TrajectoryCandidate = {
      trajectoryRef: row.task_id,
      confidence: 0.95, // Same query as locateByRunId → same confidence
      reasons: ['run_alias_lookup'],
      sourceTypes: ['runs_table'],
    };

    return { query, candidates: [candidate] };
  }

  private async locateByTaskId(
    taskId: string,
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const rows = db
      .prepare('SELECT run_id FROM runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as { run_id: string }[];

    if (rows.length === 0) {
      return { query, candidates: [] };
    }

    const candidate: TrajectoryCandidate = {
      trajectoryRef: taskId,
      confidence: 1.0,
      reasons: ['task_id_lookup'],
      sourceTypes: ['runs_table'],
    };

    return { query, candidates: [candidate] };
  }

  private async locateByRunId(
    runId: string,
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT task_id FROM runs WHERE run_id = ?')
      .get(runId) as { task_id: string } | undefined;

    if (!row) {
      return { query, candidates: [] };
    }

    // Verify runs exist for the containing task
    const runs = db
      .prepare('SELECT run_id FROM runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(row.task_id) as { run_id: string }[];

    if (runs.length === 0) {
      return { query, candidates: [] };
    }

    const candidate: TrajectoryCandidate = {
      trajectoryRef: row.task_id,
      confidence: 0.95,
      reasons: ['run_id_to_task_id'],
      sourceTypes: ['runs_table'],
    };

    return { query, candidates: [candidate] };
  }

  private async locateByTimeRange(
    timeRange: { start: string; end: string },
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const rows = db
      .prepare(
        'SELECT DISTINCT task_id FROM runs WHERE started_at >= ? AND started_at <= ?',
      )
      .all(timeRange.start, timeRange.end) as { task_id: string }[];

    if (rows.length === 0) {
      return { query, candidates: [] };
    }

    const candidates: TrajectoryCandidate[] = rows.map((row) => ({
      trajectoryRef: row.task_id,
      confidence: 0.7,
      reasons: ['date_range_match'],
      sourceTypes: ['runs_table'],
    }));

    return { query, candidates };
  }

  private async locateBySessionHint(
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();

    // Case A: sessionId is provided — use JSON extraction on diagnostic_json
    if (query.sessionId) {
      const rows = db
        .prepare(
          `SELECT DISTINCT task_id FROM tasks
           WHERE json_extract(diagnostic_json, '$.sessionIdHint') = ?`,
        )
        .all(query.sessionId) as { task_id: string }[];

      // If sessionId is provided but no tasks match, return empty candidates
      // (do NOT fall back to returning all tasks — that was the bug)
      if (rows.length === 0) {
        return { query, candidates: [] };
      }

      const candidates: TrajectoryCandidate[] = rows.map((row) => ({
        trajectoryRef: row.task_id,
        confidence: 0.8,
        reasons: ['session_id_json_extract'],
        sourceTypes: ['tasks_table'],
      }));

      return { query, candidates };
    }

    // Case B: sessionId absent, but timeRange is present — fall back to runs table
    if (query.timeRange) {
      const rows = db
        .prepare(
          'SELECT DISTINCT task_id FROM runs WHERE started_at >= ? AND started_at <= ?',
        )
        .all(query.timeRange.start, query.timeRange.end) as { task_id: string }[];

      if (rows.length === 0) {
        return { query, candidates: [] };
      }

      const candidates: TrajectoryCandidate[] = rows.map((row) => ({
        trajectoryRef: row.task_id,
        confidence: 0.7,
        reasons: ['date_range_match'],
        sourceTypes: ['runs_table'],
      }));

      return { query, candidates };
    }

    // No sessionId and no timeRange — nothing to filter on
    return { query, candidates: [] };
  }

  private async locateByExecutionStatus(
    executionStatus: string,
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const rows = db
      .prepare('SELECT DISTINCT task_id FROM runs WHERE execution_status = ?')
      .all(executionStatus) as { task_id: string }[];

    if (rows.length === 0) {
      return { query, candidates: [] };
    }

    const candidates: TrajectoryCandidate[] = rows.map((row) => ({
      trajectoryRef: row.task_id,
      confidence: 0.8,
      reasons: ['status_filter'],
      sourceTypes: ['runs_table'],
    }));

    return { query, candidates };
  }
}
