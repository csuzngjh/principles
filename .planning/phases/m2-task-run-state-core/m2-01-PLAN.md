---
phase: m2
plan: 01
title: Task Store Foundation
wave: 1
type: execute
depends_on: []
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/sqlite-connection.ts
  - packages/principles-core/src/runtime-v2/store/task-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts
  - packages/principles-core/src/runtime-v2/index.ts
requirements_addressed:
  - REQ-M2-TaskStore
---

<objective>
Build the TaskStore foundation: SqliteConnection with WAL mode + busy_timeout, TaskStore interface, and SqliteTaskStore implementation. This is the base layer all other plans depend on.
</objective>

<tasks>

## Task 1: Create SqliteConnection with WAL mode and schema initialization
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/sqlite-connection.ts
  - packages/principles-core/src/trajectory-store.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
<read_first>
- `packages/principles-core/src/trajectory-store.ts` — SQLite pattern to follow (WAL, busy_timeout, schema init)
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord schema to conform to
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts`:

```typescript
import Database from 'better-sqlite3';
import { join } from 'path';
import * as fs from 'fs';

export class SqliteConnection {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(workspaceDir: string) {
    const pdDir = join(workspaceDir, '.pd');
    if (!fs.existsSync(pdDir)) {
      fs.mkdirSync(pdDir, { recursive: true });
    }
    this.dbPath = join(pdDir, 'state.db');
  }

  getDb(): Database.Database {
    if (this.db) return this.db;

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
    return this.db;
  }

  private initSchema(): void {
    const db = this.db!;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        input_ref TEXT,
        result_ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_task_kind ON tasks(task_kind);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        execution_status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        reason TEXT,
        output_ref TEXT,
        error_category TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(execution_status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    `);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
```
</action>
<acceptance_criteria>
- [ ] `new Database(this.dbPath)` is called in getDb()
- [ ] `pragma('journal_mode = WAL')` is set
- [ ] `pragma('busy_timeout = 5000')` is set
- [ ] `CREATE TABLE IF NOT EXISTS tasks` creates tasks table with all columns
- [ ] `CREATE TABLE IF NOT EXISTS runs` creates runs table with all columns
- [ ] Indexes created on status, leaseOwner, leaseExpiresAt, taskKind
- [ ] Directory `.pd/` is created if it doesn't exist
- [ ] Schema initialization happens in initSchema() called from getDb()
</acceptance_criteria>

## Task 2: Define TaskStore interface and SqliteTaskStore implementation
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/task-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/storage-adapter.ts
<read_first>
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord, PDTaskStatus schemas (DO NOT MODIFY)
- `packages/principles-core/src/storage-adapter.ts` — Store interface pattern to follow
- `packages/principles-core/src/trajectory-store.ts` — SQLite row-to-record mapping pattern
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/task-store.ts`:

```typescript
import type { TaskRecord, PDTaskStatus, PDErrorCategory } from '../task-status.js';

export interface TaskStoreFilter {
  status?: PDTaskStatus;
  taskKind?: string;
  limit?: number;
  offset?: number;
}

export interface TaskStore {
  createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTask(taskId: string, patch: Partial<Pick<TaskRecord,
    | 'status'
    | 'leaseOwner'
    | 'leaseExpiresAt'
    | 'attemptCount'
    | 'maxAttempts'
    | 'lastError'
    | 'inputRef'
    | 'resultRef'
    | 'updatedAt'
  >>): Promise<TaskRecord>;
  listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;
  deleteTask(taskId: string): Promise<boolean>;
}
```

Create `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts`:

```typescript
import { Value } from '@sinclair/typebox/value';
import { TaskRecordSchema, type TaskRecord, type PDTaskStatus, type PDErrorCategory } from '../task-status.js';
import { PDRuntimeError } from '../error-categories.js';
import type { TaskStore, TaskStoreFilter } from './task-store.js';
import type { SqliteConnection } from './sqlite-connection.js';

export class SqliteTaskStore implements TaskStore {
  constructor(private connection: SqliteConnection) {}

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, input_ref, result_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.taskKind,
      record.status,
      now,
      now,
      record.attemptCount,
      record.maxAttempts,
      record.inputRef ?? null,
      record.resultRef ?? null
    );

    return this.getTask(record.taskId) as Promise<TaskRecord>;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  async updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRecord,
      | 'status' | 'leaseOwner' | 'leaseExpiresAt' | 'attemptCount'
      | 'maxAttempts' | 'lastError' | 'inputRef' | 'resultRef' | 'updatedAt'
    >>
  ): Promise<TaskRecord> {
    const db = this.connection.getDb();
    const now = patch.updatedAt ?? new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.status !== undefined) sets.push('status = ?'), values.push(patch.status);
    if (patch.leaseOwner !== undefined) sets.push('lease_owner = ?'), values.push(patch.leaseOwner ?? null);
    if (patch.leaseExpiresAt !== undefined) sets.push('lease_expires_at = ?'), values.push(patch.leaseExpiresAt ?? null);
    if (patch.attemptCount !== undefined) sets.push('attempt_count = ?'), values.push(patch.attemptCount);
    if (patch.maxAttempts !== undefined) sets.push('max_attempts = ?'), values.push(patch.maxAttempts);
    if (patch.lastError !== undefined) sets.push('last_error = ?'), values.push(patch.lastError ?? null);
    if (patch.inputRef !== undefined) sets.push('input_ref = ?'), values.push(patch.inputRef ?? null);
    if (patch.resultRef !== undefined) sets.push('result_ref = ?'), values.push(patch.resultRef ?? null);

    values.push(taskId);

    const result = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
    if (result.changes === 0) throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);

    return this.getTask(taskId) as Promise<TaskRecord>;
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    const db = this.connection.getDb();
    let sql = 'SELECT * FROM tasks';
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.status) { conditions.push('status = ?'); values.push(filter.status); }
    if (filter?.taskKind) { conditions.push('task_kind = ?'); values.push(filter.taskKind); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    if (filter?.limit) { sql += ' LIMIT ?'; values.push(filter.limit); }
    if (filter?.offset) { sql += ' OFFSET ?'; values.push(filter.offset); }

    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(row => this.rowToRecord(row));
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
    return result.changes > 0;
  }

  private rowToRecord(row: Record<string, unknown>): TaskRecord {
    const record: TaskRecord = {
      taskId: String(row.task_id),
      taskKind: String(row.task_kind),
      status: String(row.status) as PDTaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      lastError: row.last_error ? String(row.last_error) as PDErrorCategory : undefined,
      inputRef: row.input_ref ? String(row.input_ref) : undefined,
      resultRef: row.result_ref ? String(row.result_ref) : undefined,
    };

    if (!Value.Check(TaskRecordSchema, record)) {
      throw new PDRuntimeError('storage_unavailable', `Task ${record.taskId} has invalid schema — DB may be corrupted`);
    }
    return record;
  }
}
```
</action>
<acceptance_criteria>
- [ ] `TaskStore` interface has 5 methods: createTask, getTask, updateTask, listTasks, deleteTask
- [ ] `SqliteTaskStore` constructor takes `SqliteConnection` as dependency
- [ ] `createTask` uses parameterized INSERT
- [ ] `getTask` uses parameterized SELECT
- [ ] `updateTask` builds dynamic SET clause and uses parameterized UPDATE
- [ ] `listTasks` supports status and taskKind filters with limit/offset
- [ ] `rowToRecord` maps snake_case DB columns to camelCase TaskRecord fields
- [ ] `Value.Check(TaskRecordSchema, record)` validates on every read
- [ ] PDRuntimeError thrown when task not found on update
</acceptance_criteria>

## Task 3: Export TaskStore from runtime-v2/index.ts
type: execute
files:
  - packages/principles-core/src/runtime-v2/index.ts
<read_first>
- `packages/principles-core/src/runtime-v2/index.ts` — Barrel exports (M1 frozen — add only new exports)
</read_first>
<action>
Add to the exports in `packages/principles-core/src/runtime-v2/index.ts`:

```typescript
// Store
export { SqliteConnection } from './store/sqlite-connection.js';
export { SqliteTaskStore } from './store/sqlite-task-store.js';
export type { TaskStore, TaskStoreFilter } from './store/task-store.js';
```
</action>
<acceptance_criteria>
- [ ] `SqliteConnection` is exported
- [ ] `SqliteTaskStore` is exported
- [ ] `TaskStore` and `TaskStoreFilter` types are exported
- [ ] `npx tsc --noEmit` passes for packages/principles-core
</acceptance_criteria>

</tasks>

<verification>
1. Run `npx tsc --noEmit` in packages/principles-core
2. Verify `SqliteConnection` sets WAL mode + busy_timeout 5000ms
3. Verify `SqliteTaskStore` implements all 5 TaskStore interface methods
4. Verify `Value.Check(TaskRecordSchema, record)` is called on every read
</verification>

<success_criteria>
- [ ] SqliteConnection opens DB at `<workspaceDir>/.pd/state.db`
- [ ] WAL mode + busy_timeout 5000ms configured
- [ ] TaskStore interface has 5 CRUD methods
- [ ] SqliteTaskStore implements TaskStore with parameterized SQL
- [ ] All new exports added to runtime-v2/index.ts
- [ ] TypeScript compiles without errors
</success_criteria>
