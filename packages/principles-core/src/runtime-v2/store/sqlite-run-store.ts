/**
 * SQLite implementation of RunStore.
 *
 * Uses better-sqlite3 for atomic operations.
 * Validates every row read with TypeBox Value.Check().
 */
import { Value } from '@sinclair/typebox/value';
import { RunRecordSchema, type RunRecord, type RunExecutionStatus } from '../runtime-protocol.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { RunStore } from './run-store.js';

export class SqliteRunStore implements RunStore {
  constructor(private readonly connection: SqliteConnection) {}

  async createRun(record: Omit<RunRecord, never>): Promise<RunRecord> {
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
    return SqliteRunStore.rowToRecord(row);
  }

  async updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'endedAt' | 'reason' | 'outputPayload' | 'errorCategory'>>,
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
    const db = this.connection.getDb();
    const rows = db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => SqliteRunStore.rowToRecord(row));
  }

  async deleteRun(runId: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
    return result.changes > 0;
  }

  private static rowToRecord(row: Record<string, unknown>): RunRecord {
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
      throw new PDRuntimeError(
        'storage_unavailable',
        `Run ${runId} has invalid schema — DB may be corrupted`,
      );
    }

    return record;
  }
}
