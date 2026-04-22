---
phase: m2
plan: 02
title: Run Store Foundation
wave: 2
type: execute
depends_on:
  - m2-01
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/run-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts
  - packages/principles-core/src/runtime-v2/index.ts
requirements_addressed:
  - REQ-M2-RunStore
---

<objective>
Build the RunStore foundation: RunStore interface and SqliteRunStore implementation. Run records track individual execution attempts, linked to tasks via taskId. 1 Task : N Runs.
</objective>

<tasks>

## Task 1: Define RunStore interface
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/run-store.ts
  - packages/principles-core/src/runtime-v2/runtime-protocol.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/storage-adapter.ts
<read_first>
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RunHandle, RunStatus, RunExecutionStatus (DO NOT MODIFY)
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord schema (for reference)
- `packages/principles-core/src/storage-adapter.ts` — Store interface pattern to follow
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/run-store.ts`:

```typescript
import type { RunHandle, RunStatus, RunExecutionStatus } from '../runtime-protocol.js';
import type { PDErrorCategory } from '../error-categories.js';

export interface RunRecord extends RunHandle {
  taskId: string;
  attemptNumber: number;
  inputPayload?: string;
  outputPayload?: string;
  errorCategory?: PDErrorCategory;
}

export interface RunStore {
  createRun(record: Omit<RunRecord, never>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: Partial<Pick<RunRecord,
    | 'executionStatus'
    | 'endedAt'
    | 'reason'
    | 'outputPayload'
    | 'errorCategory'
  >>): Promise<RunRecord>;
  listRunsByTask(taskId: string): Promise<RunRecord[]>;
  deleteRun(runId: string): Promise<boolean>;
}
```
</action>
<acceptance_criteria>
- [ ] `RunRecord` extends `RunHandle` with taskId, attemptNumber, inputPayload, outputPayload, errorCategory
- [ ] `RunStore` interface has 5 methods: createRun, getRun, updateRun, listRunsByTask, deleteRun
- [ ] All 5 methods return `Promise<RunRecord>` or `Promise<RunRecord | null>`
- [ ] RunStore uses same pattern as TaskStore (follows storage-adapter.ts)
</acceptance_criteria>

## Task 2: Implement SqliteRunStore
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts
  - packages/principles-core/src/runtime-v2/store/run-store.ts
  - packages/principles-core/src/trajectory-store.ts
  - packages/principles-core/src/runtime-v2/runtime-protocol.ts
<read_first>
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RunHandle, RunStatus types (DO NOT MODIFY)
- `packages/principles-core/src/trajectory-store.ts` — SQLite row mapping pattern
- `packages/principles-core/src/runtime-v2/store/run-store.ts` — RunStore interface to implement
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts`:

```typescript
import { Value } from '@sinclair/typebox/value';
import { RunRecordSchema, type RunRecord, type RunExecutionStatus } from '../runtime-protocol.js';
import { PDRuntimeError } from '../error-categories.js';
import type { RunStore } from './run-store.js';
import type { SqliteConnection } from './sqlite-connection.js';

export class SqliteRunStore implements RunStore {
  constructor(private connection: SqliteConnection) {}

  async createRun(record: Omit<RunRecord, never>): Promise<RunRecord> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, output_ref, error_category, attempt_number, created_at, updated_at, input_payload, output_payload)
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
      record.errorCategory ?? null,
      record.attemptNumber,
      now,
      now,
      record.inputPayload ?? null,
      record.outputPayload ?? null
    );

    return this.getRun(record.runId) as Promise<RunRecord>;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  async updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord,
      | 'executionStatus' | 'endedAt' | 'reason' | 'outputPayload' | 'errorCategory'
    >>
  ): Promise<RunRecord> {
    const db = this.connection.getDb();
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.executionStatus !== undefined) sets.push('execution_status = ?'), values.push(patch.executionStatus);
    if (patch.endedAt !== undefined) sets.push('ended_at = ?'), values.push(patch.endedAt ?? null);
    if (patch.reason !== undefined) sets.push('reason = ?'), values.push(patch.reason ?? null);
    if (patch.outputPayload !== undefined) sets.push('output_payload = ?'), values.push(patch.outputPayload ?? null);
    if (patch.errorCategory !== undefined) sets.push('error_category = ?'), values.push(patch.errorCategory ?? null);

    values.push(runId);

    const result = db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...values);
    if (result.changes === 0) throw new PDRuntimeError('storage_unavailable', `Run not found: ${runId}`);

    return this.getRun(runId) as Promise<RunRecord>;
  }

  async listRunsByTask(taskId: string): Promise<RunRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC').all(taskId) as Record<string, unknown>[];
    return rows.map(row => this.rowToRecord(row));
  }

  async deleteRun(runId: string): Promise<boolean> {
    const db = this.connection.getDb();
    const result = db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
    return result.changes > 0;
  }

  private rowToRecord(row: Record<string, unknown>): RunRecord {
    const record: RunRecord = {
      runId: String(row.run_id),
      taskId: String(row.task_id),
      runtimeKind: String(row.runtime_kind),
      executionStatus: String(row.execution_status) as RunExecutionStatus,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      reason: row.reason ? String(row.reason) : undefined,
      outputRef: row.output_ref ? String(row.output_ref) : undefined,
      attemptNumber: Number(row.attempt_number ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      inputPayload: row.input_payload ? String(row.input_payload) : undefined,
      outputPayload: row.output_payload ? String(row.output_payload) : undefined,
      errorCategory: row.error_category ? String(row.error_category) as import('../error-categories.js').PDErrorCategory : undefined,
    };

    if (!Value.Check(RunRecordSchema, record)) {
      throw new PDRuntimeError('storage_unavailable', `Run ${record.runId} has invalid schema — DB may be corrupted`);
    }
    return record;
  }
}
```
</action>
<acceptance_criteria>
- [ ] `SqliteRunStore` constructor takes `SqliteConnection` as dependency
- [ ] `createRun` uses parameterized INSERT with all RunRecord fields
- [ ] `getRun` uses parameterized SELECT
- [ ] `updateRun` supports executionStatus, endedAt, reason, outputPayload, errorCategory patches
- [ ] `listRunsByTask` returns all runs for a task ordered by started_at ASC
- [ ] `rowToRecord` maps snake_case DB columns to camelCase RunRecord fields
- [ ] `Value.Check(RunRecordSchema, record)` validates on every read
- [ ] PDRuntimeError thrown when run not found on update
</acceptance_criteria>

## Task 3: Export RunStore from runtime-v2/index.ts
type: execute
files:
  - packages/principles-core/src/runtime-v2/index.ts
<read_first>
- `packages/principles-core/src/runtime-v2/index.ts` — Barrel exports (M1 frozen — add only new exports)
</read_first>
<action>
Add to the exports in `packages/principles-core/src/runtime-v2/index.ts`:

```typescript
// Run Store
export { SqliteRunStore } from './store/sqlite-run-store.js';
export type { RunStore, RunRecord } from './store/run-store.js';
```
</action>
<acceptance_criteria>
- [ ] `SqliteRunStore` is exported
- [ ] `RunStore` and `RunRecord` types are exported
- [ ] `npx tsc --noEmit` passes for packages/principles-core
</acceptance_criteria>

</tasks>

<verification>
1. Run `npx tsc --noEmit` in packages/principles-core
2. Verify `SqliteRunStore` implements all 5 RunStore interface methods
3. Verify `Value.Check(RunRecordSchema, record)` is called on every read
4. Verify runs table has task_id foreign key to tasks table
</verification>

<success_criteria>
- [ ] RunStore interface has 5 CRUD methods
- [ ] SqliteRunStore implements RunStore with parameterized SQL
- [ ] 1 Task : N Runs relationship via listRunsByTask(taskId)
- [ ] Run stores complete payload (inputPayload + outputPayload)
- [ ] All new exports added to runtime-v2/index.ts
- [ ] TypeScript compiles without errors
</success_criteria>
