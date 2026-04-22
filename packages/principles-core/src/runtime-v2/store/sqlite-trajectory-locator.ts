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
      return this.locateByPainId(query.painId, query);
    }
    if (query.taskId) {
      return this.locateByTaskId(query.taskId, query);
    }
    if (query.runId) {
      return this.locateByRunId(query.runId, query);
    }
    if (query.timeRange) {
      return this.locateByTimeRange(query.timeRange, query);
    }
    if (query.sessionId && query.workspace) {
      return this.locateBySessionHint(query);
    }
    if (query.executionStatus) {
      return this.locateByExecutionStatus(query.executionStatus, query);
    }
    return { query, candidates: [] };
  }

  private async locateByPainId(
    painId: string,
    query: TrajectoryLocateQuery,
  ): Promise<TrajectoryLocateResult> {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT task_id FROM runs WHERE run_id = ?')
      .get(painId) as { task_id: string } | undefined;

    if (!row) {
      return { query, candidates: [] };
    }

    const candidate: TrajectoryCandidate = {
      trajectoryRef: row.task_id,
      confidence: 1.0,
      reasons: ['exact_match_on_run_id'],
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

    // Workspace is already isolated by SqliteConnection path (each workspace
    // has its own state.db). sessionId is NOT a column in runs or tasks tables,
    // so we return all trajectories in the connected workspace DB.
    let sql = 'SELECT DISTINCT task_id FROM runs';
    const values: unknown[] = [];

    if (query.timeRange) {
      sql += ' WHERE started_at >= ? AND started_at <= ?';
      values.push(query.timeRange.start, query.timeRange.end);
    }

    const rows = db
      .prepare(sql)
      .all(...values) as { task_id: string }[];

    if (rows.length === 0) {
      return { query, candidates: [] };
    }

    const candidates: TrajectoryCandidate[] = rows.map((row) => ({
      trajectoryRef: row.task_id,
      confidence: 0.5,
      reasons: ['session_hint_workspace_scoped'],
      sourceTypes: ['runs_table'],
    }));

    return { query, candidates };
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
