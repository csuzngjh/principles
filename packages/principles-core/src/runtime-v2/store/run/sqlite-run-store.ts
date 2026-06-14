/**
 * SQLite implementation of RunStore.
 *
 * Uses better-sqlite3 for atomic operations.
 * Validates every row read with TypeBox Value.Check().
 */
import { Value } from '@sinclair/typebox/value';
import { RuntimeKindSchema, RunRecordSchema, type RunRecord, type RunExecutionStatus } from '../../runtime-protocol.js';
import { PDRuntimeError, type PDErrorCategory } from '../../error-categories.js';
import type { SqliteConnection } from '../sqlite-connection.js';
import type { DegradedRunInfo, RunStore, TolerantRunListResult } from './run-store.js';

export class MalformedRunError extends PDRuntimeError {
  constructor(
    message: string,
    public readonly validRuns: RunRecord[],
    public readonly degradedRuns: DegradedRunInfo[],
  ) {
    super('storage_unavailable', message);
    this.name = 'MalformedRunError';
  }
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly connection: SqliteConnection) {}

  async createRun(record: Omit<RunRecord, 'createdAt' | 'updatedAt'>): Promise<RunRecord> {
    if (!Value.Check(RuntimeKindSchema, record.runtimeKind)) {
      throw new PDRuntimeError('input_invalid', `Invalid runtime kind: ${record.runtimeKind}`);
    }
    const db = this.connection.getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, output_ref, attempt_number, created_at, updated_at, input_payload, output_payload, error_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId,
      record.taskId,
      record.runtimeKind,
      record.executionStatus,
      record.startedAt,
      record.endedAt ?? null,
      record.reason ?? null,
      record.outputRef ?? null,
      record.attemptNumber,
      now,
      now,
      record.inputPayload ?? null,
      record.outputPayload ?? null,
      record.errorCategory ?? null,
    );

    return (await this.getRun(record.runId)) as RunRecord;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return SqliteRunStore.rowToRecord(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MalformedRunError(
        `Run ${runId} has invalid schema`,
        [],
        [{ runId, error: msg, rawRow: row }]
      );
    }
  }
  async updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'endedAt' | 'reason' | 'outputRef' | 'outputPayload' | 'errorCategory' | 'executionStatus'>>,
  ): Promise<RunRecord> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?');
      values.push(patch.endedAt ?? null);
    }
    if (patch.reason !== undefined) {
      sets.push('reason = ?');
      values.push(patch.reason ?? null);
    }
    if (patch.outputPayload !== undefined) {
      sets.push('output_payload = ?');
      values.push(patch.outputPayload ?? null);
    }
    if (patch.errorCategory !== undefined) {
      sets.push('error_category = ?');
      values.push(patch.errorCategory ?? null);
    }
    if (patch.outputRef !== undefined) {
      sets.push('output_ref = ?');
      values.push(patch.outputRef ?? null);
    }
    if (patch.executionStatus !== undefined) {
      sets.push('execution_status = ?');
      values.push(patch.executionStatus);
    }

    values.push(runId);

    const result = db
      .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`)
      .run(...values);

    if (result.changes === 0) {
      throw new PDRuntimeError('storage_unavailable', `Run not found: ${runId}`);
    }

    return (await this.getRun(runId)) as RunRecord;
  }

  async listRunsByTask(taskId: string): Promise<RunRecord[]> {
    const { runs, degradedRuns } = await this.listValidRunsByTaskTolerant(taskId);
    if (degradedRuns.length > 0) {
      throw new MalformedRunError(
        `Task ${taskId} has ${degradedRuns.length} malformed run(s)`,
        runs,
        degradedRuns,
      );
    }
    return runs;
  }

  async listValidRunsByTaskTolerant(taskId: string): Promise<TolerantRunListResult> {
    const db = this.connection.getDb();
    const rows = db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as Record<string, unknown>[];

    const runs: RunRecord[] = [];
    const degradedRuns: DegradedRunInfo[] = [];

    for (const row of rows) {
      try {
        const record = SqliteRunStore.rowToRecord(row);
        runs.push(record);
      } catch (err) {
        const runId = row.run_id ? String(row.run_id) : 'unknown';
        const msg = err instanceof Error ? err.message : String(err);
        degradedRuns.push({
          runId,
          error: msg,
          rawRow: row,
        });
      }
    }

    return { runs, degradedRuns };
  }

  async deleteRun(runId: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
    return result.changes > 0;
  }

  /**
   * Convert a raw DB row into a validated RunRecord.
   *
   * Public so the integrity-repair detection pass can reuse the EXACT same
   * validation logic as the production read path (EP-01: no duplicated
   * schema validation that can drift from the real one).
   *
   * @throws PDRuntimeError{storage_unavailable} if the row fails schema validation.
   */
  static rowToRecord(row: Record<string, unknown>): RunRecord {
    const runId = String(row.run_id);
    const record: RunRecord = {
      runId,
      taskId: String(row.task_id),
      runtimeKind: String(row.runtime_kind) as RunRecord['runtimeKind'],
      executionStatus: String(row.execution_status) as RunExecutionStatus,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      reason: row.reason ? String(row.reason) : undefined,
      outputRef: row.output_ref ? String(row.output_ref) : undefined,
      attemptNumber: Number(row.attempt_number ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      // Use ?? undefined so null DB values become undefined (TypeBox validates undefined for optional fields)
      inputPayload: (row.input_payload as string | null) ?? undefined,
      outputPayload: (row.output_payload as string | null) ?? undefined,
      errorCategory: (row.error_category as PDErrorCategory | null) ?? undefined,
    };

    if (!Value.Check(RunRecordSchema, record)) {
      const errors = [...Value.Errors(RunRecordSchema, record)];
      const details = errors.map(e => `${e.path}: ${e.message}`).join(', ');
      throw new PDRuntimeError(
        'storage_unavailable',
        `Run ${runId} has invalid schema: ${details}`,
      );
    }

    return record;
  }
}
