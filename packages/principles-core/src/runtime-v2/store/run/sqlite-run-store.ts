/**
 * SQLite implementation of RunStore.
 *
 * Uses better-sqlite3 for atomic operations.
 * Validates every row read with TypeBox Value.Check().
 */
import { Value } from '@sinclair/typebox/value';
import { RuntimeKindSchema, RunRecordSchema, type RunRecord, type RunExecutionStatus } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { SqliteConnection } from '../sqlite-connection.js';
import type { DegradedRunInfo, RunStore, TolerantRunListResult } from './run-store.js';

// ── Field-level runtime readers (trust boundary for untrusted DB rows) ───────
//
// These exist because String()/Number() coercion washes missing/wrong-typed
// values into legal-looking ones (e.g. String(undefined) → "undefined" passes
// Type.String()), which hides malformed rows from detection. Each reader is a
// runtime guard: required fields fail loud, optional fields only accept their
// declared nullable shape. Enum fields are intentionally NOT coerced here —
// TypeBox Value.Check is the single authority on enum membership.

/** Read a required non-empty string. Fails loud on missing/non-string/empty. */
function readRequiredString(value: unknown, fieldName: string, runIdForError: string): string {
  if (typeof value !== 'string') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Run ${runIdForError} has invalid schema: /${fieldName}: expected string, got ${value === null ? 'null' : typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Run ${runIdForError} has invalid schema: /${fieldName}: expected non-empty string`,
    );
  }
  return value;
}

/**
 * Read a required non-negative integer. Fails loud on missing/non-number/
 * non-integer/negative. NaN is explicitly rejected (Number(undefined)===NaN
 * must not silently become 0).
 */
function readRequiredInt(value: unknown, fieldName: string, runIdForError: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Run ${runIdForError} has invalid schema: /${fieldName}: expected integer, got ${value === null ? 'null' : typeof value}`,
    );
  }
  if (value < 0) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Run ${runIdForError} has invalid schema: /${fieldName}: expected non-negative integer, got ${value}`,
    );
  }
  return value;
}

/**
 * Read an optional string. Only string | null | undefined are acceptable.
 * A non-string truthy value (number, object, etc.) is a malformed row and
 * fails loud rather than being coerced. null/undefined → undefined.
 */
function readOptionalString(value: unknown, fieldName: string, runIdForError: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Run ${runIdForError} has invalid schema: /${fieldName}: expected string|null, got ${typeof value}`,
    );
  }
  return value;
}

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
   * Trust boundary (ERR-001, ERR-005): the row is UNTRUSTED data. We must NOT
   * use String()/Number() coercion — that washes missing fields into legal
   * strings/numbers (e.g. `String(undefined)` → `"undefined"` passes Type.String()),
   * hiding malformed rows from detection. Instead each field is read with a
   * runtime guard; required fields fail loud, optional fields only accept their
   * declared nullable shape, and enum fields are passed through as-is so TypeBox
   * is the single authority on enum validity.
   *
   * @throws PDRuntimeError{storage_unavailable} if the row fails schema validation.
   */
  static rowToRecord(row: Record<string, unknown>): RunRecord {
    // runId is extracted first (best-effort) so error messages can name the row,
    // but it is still validated below — do not trust this value for logic.
    const runIdForError = typeof row.run_id === 'string' && row.run_id.length > 0
      ? row.run_id
      : '<missing run_id>';

    const record: RunRecord = {
      runId: readRequiredString(row.run_id, 'run_id', runIdForError),
      taskId: readRequiredString(row.task_id, 'task_id', runIdForError),
      // Enums: read the raw value without coercion. TypeBox Value.Check below is
      // the single authority on whether it is a valid enum member.
      runtimeKind: row.runtime_kind as RunRecord['runtimeKind'],
      executionStatus: row.execution_status as RunExecutionStatus,
      startedAt: readRequiredString(row.started_at, 'started_at', runIdForError),
      attemptNumber: readRequiredInt(row.attempt_number, 'attempt_number', runIdForError),
      createdAt: readRequiredString(row.created_at, 'created_at', runIdForError),
      updatedAt: readRequiredString(row.updated_at, 'updated_at', runIdForError),
      // Optional strings: only string | null | undefined are acceptable shapes.
      endedAt: readOptionalString(row.ended_at, 'ended_at', runIdForError),
      reason: readOptionalString(row.reason, 'reason', runIdForError),
      outputRef: readOptionalString(row.output_ref, 'output_ref', runIdForError),
      inputPayload: readOptionalString(row.input_payload, 'input_payload', runIdForError),
      outputPayload: readOptionalString(row.output_payload, 'output_payload', runIdForError),
      // Optional enum: pass through as-is; TypeBox validates enum membership.
      errorCategory: (row.error_category ?? undefined) as RunRecord['errorCategory'],
    };

    if (!Value.Check(RunRecordSchema, record)) {
      const errors = [...Value.Errors(RunRecordSchema, record)];
      const details = errors.map(e => `${e.path}: ${e.message}`).join(', ');
      throw new PDRuntimeError(
        'storage_unavailable',
        `Run ${runIdForError} has invalid schema: ${details}`,
      );
    }

    return record;
  }
}
