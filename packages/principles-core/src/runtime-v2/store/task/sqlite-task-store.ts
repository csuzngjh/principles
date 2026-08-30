/**
 * SQLite implementation of TaskStore.
 *
 * Uses better-sqlite3 transactions for atomic read-check-write operations.
 * Validates every row read with TypeBox Value.Check().
 */
import { Value } from '@sinclair/typebox/value';
import { TaskRecordSchema, type TaskRecord, type PDTaskStatus } from '../../task-status.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { SqliteConnection } from '../sqlite-connection.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';
import type { FailedTaskSummary, FailedTaskFilter, FailedTaskDetail } from './task-types.js';
import type { RunRecord } from '../run/run-store.js';
import { SqliteRunStore } from '../run/sqlite-run-store.js';

// ── Field-level runtime readers for failed-task summary rows (rc-1, rc-3) ────
//
// These readers enforce that DB row fields have the expected runtime shape
// before being used. Required fields fail loud; nullable fields only accept
// string|null. This mirrors the pattern in sqlite-run-store.ts.

function readRequiredStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Invalid task row: /${fieldName}: expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value;
}

function readNullableStringField(
  value: unknown,
  fieldName: string,
  taskIdForError: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Task ${taskIdForError} has invalid schema: /${fieldName}: expected string|null, got ${typeof value}`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely extract `sourcePainId` from the `diagnostic_json` column.
 *
 * `diagnostic_json` is an optional JSON string that may carry PI metadata
 * including the originating pain signal ID (for diagnostician tasks). We
 * parse it defensively: malformed JSON or non-string sourcePainId yield
 * null rather than throwing, so one bad row does not break the entire
 * failed-task list (rc-9: graceful degradation — painId is an optional
 * summary field; the caller observes null and can surface it in UI).
 */
function extractPainIdFromDiagnosticJson(
  diagnosticJson: unknown,
  taskIdForError: string,
): string | null {
  if (diagnosticJson === null || diagnosticJson === undefined) return null;
  if (typeof diagnosticJson !== 'string') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Task ${taskIdForError} has invalid schema: /diagnostic_json: expected string|null, got ${typeof diagnosticJson}`,
    );
  }
  if (diagnosticJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (!isPlainObject(parsed)) return null;
    if (!Object.hasOwn(parsed, 'sourcePainId')) return null;
    const { sourcePainId } = parsed;
    if (typeof sourcePainId !== 'string' || sourcePainId.length === 0) return null;
    return sourcePainId;
  } catch {
    return null;
  }
}

export class SqliteTaskStore implements TaskStore {
  constructor(private readonly connection: SqliteConnection) {}

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, lease_owner, lease_expires_at, last_error, input_ref, result_ref, diagnostic_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.taskKind,
      record.status,
      now,
      now,
      record.attemptCount,
      record.maxAttempts,
      record.leaseOwner ?? null,
      record.leaseExpiresAt ?? null,
      record.lastError ?? null,
      record.inputRef ?? null,
      record.resultRef ?? null,
      record.diagnosticJson ?? null,
    );

    return (await this.getTask(record.taskId)) as TaskRecord;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const db = this.connection.getDb();
    const row = db
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  async updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord> {
    const db = this.connection.getDb();
    const now = patch.updatedAt ?? new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.leaseOwner !== undefined) { sets.push('lease_owner = ?'); values.push(patch.leaseOwner); }
    if (patch.leaseExpiresAt !== undefined) { sets.push('lease_expires_at = ?'); values.push(patch.leaseExpiresAt); }
    if (patch.attemptCount !== undefined) { sets.push('attempt_count = ?'); values.push(patch.attemptCount); }
    if (patch.maxAttempts !== undefined) { sets.push('max_attempts = ?'); values.push(patch.maxAttempts); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); values.push(patch.lastError); }
    if (patch.inputRef !== undefined) { sets.push('input_ref = ?'); values.push(patch.inputRef); }
    if (patch.resultRef !== undefined) { sets.push('result_ref = ?'); values.push(patch.resultRef); }
    if (patch.diagnosticJson !== undefined) { sets.push('diagnostic_json = ?'); values.push(patch.diagnosticJson); }

    values.push(taskId);

    const result = db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`)
      .run(...values);

    if (result.changes === 0) {
      throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
    }

    return (await this.getTask(taskId)) as TaskRecord;
  }

  async updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
  ): Promise<TaskRecord | null> {
    const db = this.connection.getDb();
    const now = patch.updatedAt ?? new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.leaseOwner !== undefined) { sets.push('lease_owner = ?'); values.push(patch.leaseOwner); }
    if (patch.leaseExpiresAt !== undefined) { sets.push('lease_expires_at = ?'); values.push(patch.leaseExpiresAt); }
    if (patch.attemptCount !== undefined) { sets.push('attempt_count = ?'); values.push(patch.attemptCount); }
    if (patch.maxAttempts !== undefined) { sets.push('max_attempts = ?'); values.push(patch.maxAttempts); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); values.push(patch.lastError); }
    if (patch.inputRef !== undefined) { sets.push('input_ref = ?'); values.push(patch.inputRef); }
    if (patch.resultRef !== undefined) { sets.push('result_ref = ?'); values.push(patch.resultRef); }
    if (patch.diagnosticJson !== undefined) { sets.push('diagnostic_json = ?'); values.push(patch.diagnosticJson); }

    values.push(taskId, expectedDiagnosticJson);

    // Single conditional mutation: `IS` gives NULL-safe equality, so the
    // precondition covers both a NULL column and a byte-equal JSON string.
    const result = db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ? AND diagnostic_json IS ?`)
      .run(...values);

    if (result.changes === 0) {
      return null;
    }
    return (await this.getTask(taskId));
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    const db = this.connection.getDb();
    let sql = 'SELECT * FROM tasks';
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.status) { conditions.push('status = ?'); values.push(filter.status); }
    if (filter?.taskKind) { conditions.push('task_kind = ?'); values.push(filter.taskKind); }
    if (filter?.leaseExpiresAtBefore) {
      conditions.push('lease_expires_at IS NOT NULL AND lease_expires_at < ?');
      values.push(filter.leaseExpiresAtBefore);
    }
    if (filter?.afterCursor) {
      // Exclusive tuple cursor under the deterministic (updated_at, task_id)
      // order — pagination must never run on a non-deterministic ORDER BY.
      if (filter.orderBy === 'updated_at_asc') {
        conditions.push('(updated_at > ? OR (updated_at = ? AND task_id > ?))');
      } else if (filter.orderBy === 'updated_at_desc') {
        conditions.push('(updated_at < ? OR (updated_at = ? AND task_id < ?))');
      } else {
        throw new PDRuntimeError('input_invalid', 'afterCursor requires orderBy updated_at_asc|desc');
      }
      values.push(filter.afterCursor.updatedAt, filter.afterCursor.updatedAt, filter.afterCursor.taskId);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    if (filter?.orderBy === 'updated_at_asc') { sql += ' ORDER BY updated_at ASC, task_id ASC'; }
    else if (filter?.orderBy === 'updated_at_desc') { sql += ' ORDER BY updated_at DESC, task_id DESC'; }
    if (filter?.limit) { sql += ' LIMIT ?'; values.push(filter.limit); }
    if (filter?.offset) { sql += ' OFFSET ?'; values.push(filter.offset); }

    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
    return result.changes > 0;
  }

  // ── Failed-task observability methods (Task 8) ────────────────────────────

  /**
   * Shared helper for listFailedTasks / countFailedTasks: build the
   * kind/since WHERE conditions and parameter values, scoped to the given
   * table alias. Keeping this in one place ensures the list query and the
   * count query stay consistent when since semantics or task_kind filtering
   * change — divergence would cause list/total mismatch in the Failed
   * Tasks UI pagination.
   */
  private static buildFailedTaskConditions(
    filter: Pick<FailedTaskFilter, 'kind' | 'since'> | undefined,
    tableAlias: string,
  ): { conditions: string[]; values: unknown[] } {
    const conditions: string[] = [`${tableAlias}status IN ('failed', 'needs_human_review')`];
    const values: unknown[] = [];

    if (filter?.kind !== undefined) {
      conditions.push(`${tableAlias}task_kind = ?`);
      values.push(filter.kind);
    }

    if (filter?.since !== undefined) {
      const sinceIso = new Date(filter.since).toISOString();
      conditions.push(
        `(SELECT MAX(r.started_at) FROM runs r WHERE r.task_id = ${tableAlias}task_id) >= ?`,
      );
      values.push(sinceIso);
    }

    return { conditions, values };
  }

  /**
   * List tasks in 'failed' or 'needs_human_review' status, sorted by last
   * attempt time descending (most recent failures first).
   *
   * `lastAttemptAt` is derived from `MAX(runs.started_at)` via a correlated
   * subquery; tasks with no runs have NULL lastAttemptAt and sort last
   * (NULL sorts last in SQLite DESC by default).
   *
   * `painId` is extracted from `diagnostic_json.sourcePainId` when present.
   *
   * @param filter Optional kind/since/limit/offset filter.
   */
  async listFailedTasks(filter?: FailedTaskFilter): Promise<FailedTaskSummary[]> {
    const db = this.connection.getDb();
    const { conditions, values } = SqliteTaskStore.buildFailedTaskConditions(filter, 't.');

    let sql = `
      SELECT
        t.task_id,
        t.task_kind,
        t.status,
        t.last_error,
        t.attempt_count,
        t.max_attempts,
        t.created_at,
        t.diagnostic_json,
        (SELECT MAX(r.started_at) FROM runs r WHERE r.task_id = t.task_id) AS last_attempt_at
      FROM tasks t
      WHERE ${conditions.join(' AND ')}
      ORDER BY last_attempt_at DESC, t.task_id DESC
    `;

    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
    }
    if (filter?.offset !== undefined) {
      sql += ' OFFSET ?';
      values.push(filter.offset);
    }

    // runtime-contract-exempt: ERR-001 better-sqlite3 .all() returns unknown[]; narrowing to Record<string, unknown>[] is type-only (row fields are validated downstream in rowToFailedTaskSummary via typeof / Object.hasOwn)
    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map((row) => SqliteTaskStore.rowToFailedTaskSummary(row));
  }

  /**
   * Fetch full detail for a single failed task: the task record, its run
   * history (most recent first), the last error category, and a pending
   * agent draft (null in Task 8; Task 13 wires the real store).
   *
   * Returns null if the task does not exist or is not in a failed /
   * needs_human_review status.
   */
  async getFailedTaskDetail(taskId: string): Promise<FailedTaskDetail | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'needs_human_review') return null;

    // Reuse SqliteRunStore's tolerant reader — malformed historical run rows
    // are skipped rather than blocking the detail view. The tolerant method
    // tracks degraded runs internally (rc-9).
    const runStore = new SqliteRunStore(this.connection);
    const { runs: runsAsc } = await runStore.listValidRunsByTaskTolerant(taskId);
    const runs: RunRecord[] = [...runsAsc].reverse(); // DESC by startedAt

    return {
      task,
      runs,
      lastError: task.lastError ?? null,
      pendingAgentDraft: null, // Task 13 will wire PendingAgentDraftStore
    };
  }

  /**
   * Count tasks in 'failed' or 'needs_human_review' status, with the same
   * kind/since filtering as listFailedTasks. Used for pagination totals.
   */
  async countFailedTasks(filter?: Pick<FailedTaskFilter, 'kind' | 'since'>): Promise<number> {
    const db = this.connection.getDb();
    // tableAlias must be 'tasks.' (not '') so the correlated subquery
    // `r.task_id = tasks.task_id` resolves to the OUTER tasks table. With an
    // empty alias, `r.task_id = task_id` would resolve to the inner runs
    // table, making the subquery return MAX(runs.started_at) across ALL runs
    // and breaking the since filter (false-healthy count).
    const { conditions, values } = SqliteTaskStore.buildFailedTaskConditions(filter, 'tasks.');

    const sql = `SELECT COUNT(*) as cnt FROM tasks WHERE ${conditions.join(' AND ')}`;
    // runtime-contract-exempt: ERR-001 better-sqlite3 .get() returns unknown; narrowing to Record<string, unknown> | undefined is type-only (cnt field is validated below via typeof row.cnt === 'number')
    const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
    if (!row || typeof row.cnt !== 'number' || !Number.isInteger(row.cnt)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        'countFailedTasks: expected integer cnt from COUNT(*) query',
      );
    }
    return row.cnt;
  }

  /**
   * Convert a raw DB row into a validated FailedTaskSummary.
   *
   * Trust boundary (rc-1, rc-2, rc-3): the row is UNTRUSTED data. Each field
   * is read with a runtime guard; required fields fail loud, nullable fields
   * only accept their declared shape.
   */
  private static rowToFailedTaskSummary(row: Record<string, unknown>): FailedTaskSummary {
    const taskId = readRequiredStringField(row.task_id, 'task_id');
    const taskKind = readRequiredStringField(row.task_kind, 'task_kind');
    const createdAt = readRequiredStringField(row.created_at, 'created_at');

    // status: must be 'failed' or 'needs_human_review' (enforced by SQL WHERE,
    // but we validate the DB output per rc-1 — never trust the query alone).
    const statusRaw = row.status;
    if (statusRaw !== 'failed' && statusRaw !== 'needs_human_review') {
      throw new PDRuntimeError(
        'storage_unavailable',
        `Task ${taskId} has invalid status for failed-task summary: expected 'failed'|'needs_human_review', got ${statusRaw === null ? 'null' : typeof statusRaw}`,
      );
    }

    // attempt_count: required non-negative integer
    const attemptCountRaw = row.attempt_count;
    if (
      typeof attemptCountRaw !== 'number' ||
      !Number.isInteger(attemptCountRaw) ||
      attemptCountRaw < 0
    ) {
      throw new PDRuntimeError(
        'storage_unavailable',
        `Task ${taskId} has invalid attempt_count: expected non-negative integer, got ${attemptCountRaw === null ? 'null' : typeof attemptCountRaw}`,
      );
    }

    // max_attempts: required positive integer (retry budget; consumers pair it
    // with attemptCount to detect exhaustion)
    const maxAttemptsRaw = row.max_attempts;
    if (
      typeof maxAttemptsRaw !== 'number' ||
      !Number.isInteger(maxAttemptsRaw) ||
      maxAttemptsRaw < 1
    ) {
      throw new PDRuntimeError(
        'storage_unavailable',
        `Task ${taskId} has invalid max_attempts: expected positive integer, got ${maxAttemptsRaw === null ? 'null' : typeof maxAttemptsRaw}`,
      );
    }

    const lastError = readNullableStringField(row.last_error, 'last_error', taskId);
    const lastAttemptAt = readNullableStringField(row.last_attempt_at, 'last_attempt_at', taskId);
    const painId = extractPainIdFromDiagnosticJson(row.diagnostic_json, taskId);

    return {
      taskId,
      taskKind,
      painId,
      status: statusRaw,
      lastError,
      attemptCount: attemptCountRaw,
      maxAttempts: maxAttemptsRaw,
      createdAt,
      lastAttemptAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private rowToRecord(this: SqliteTaskStore, row: Record<string, unknown>): TaskRecord {
    const taskId = String(row.task_id);
    const record: TaskRecord = {
      taskId,
      taskKind: String(row.task_kind),
      status: String(row.status) as PDTaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      lastError: row.last_error ? String(row.last_error) as TaskRecord['lastError'] : null,
      inputRef: row.input_ref ? String(row.input_ref) : undefined,
      resultRef: row.result_ref ? String(row.result_ref) : undefined,
    };

    if (row.diagnostic_json && typeof row.diagnostic_json === 'string') {
      record.diagnosticJson = row.diagnostic_json;
    }

    if (!Value.Check(TaskRecordSchema, record)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        `Task ${taskId} has invalid schema — DB may be corrupted`,
      );
    }

    return record;
  }
}
