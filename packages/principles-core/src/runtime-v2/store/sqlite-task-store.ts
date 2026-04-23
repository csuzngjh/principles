/**
 * SQLite implementation of TaskStore.
 *
 * Uses better-sqlite3 transactions for atomic read-check-write operations.
 * Validates every row read with TypeBox Value.Check().
 */
import { Value } from '@sinclair/typebox/value';
import { TaskRecordSchema, type TaskRecord, type PDTaskStatus } from '../task-status.js';
import { PDRuntimeError } from '../error-categories.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';

export class SqliteTaskStore implements TaskStore {
  constructor(private readonly connection: SqliteConnection) {}

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'> & { diagnosticJson?: string }): Promise<TaskRecord> {
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
      (record as { diagnosticJson?: string }).diagnosticJson ?? null,
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
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
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

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private rowToRecord(this: SqliteTaskStore, row: Record<string, unknown>): TaskRecord {
    const taskId = String(row.task_id);
    const record: TaskRecord & { diagnosticJson?: string } = {
      taskId,
      taskKind: String(row.task_kind),
      status: String(row.status) as PDTaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      lastError: row.last_error ? String(row.last_error) as TaskRecord['lastError'] : undefined,
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
