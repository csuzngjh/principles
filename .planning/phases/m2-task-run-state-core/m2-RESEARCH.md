# Phase M2: Task/Run State Core - Research

**Researched:** 2026-04-22
**Domain:** SQLite-based task/run state management with lease semantics
**Confidence:** HIGH

## Summary

Phase M2 implements the persistent state layer for PD Runtime v2 — replacing marker-file and heartbeat-based completion inference with a deterministic SQLite-backed store. The core deliverables are TaskStore and RunStore abstractions with full CRUD, lease lifecycle management, retry policies with exponential backoff, and expired lease recovery. Key technical decisions are already locked (workspace-level DB at `.pd/state.db`, WAL mode, busy_timeout 5000ms, better-sqlite3). The research confirms these choices align with established codebase patterns and identifies the remaining discretionary areas (DDL tuning, backoff parameters, recovery sweep) with recommended defaults.

**Primary recommendation:** Follow the existing `trajectory-store.ts` pattern for SQLite access, use TypeBox `Value.Check()` for runtime validation on read, and implement lease atomicity using `db.transaction()` rather than `SELECT FOR UPDATE` (better-sqlite3 is single-threaded within a connection, making read-then-write inherently atomic in single-process scenarios).

---

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** All store code in `@principles/core` at `src/runtime-v2/store/`
- **D-02:** Files: `task-store.ts`, `run-store.ts`, `sqlite-task-store.ts`, `sqlite-run-store.ts`, `sqlite-connection.ts`
- **D-04:** Direct replacement of legacy evolution queue — no dual-write
- **D-05:** New store starts blank — no migration of existing queue data
- **D-08:** 1 Task : N Runs
- **D-09:** Run stores complete payload (input + output)
- **D-11:** Workspace-level DB at `<workspaceDir>/.pd/state.db`
- **D-12:** WAL mode + busy_timeout 5000ms
- **D-14:** Two tables: `tasks` and `runs` with indexes on status, leaseOwner, leaseExpiresAt

### Claude's Discretion
- Exact SQL schema DDL (column types, constraints, indexes)
- Lease duration default value
- Backoff policy parameters (initial delay, multiplier, max delay)
- Recovery sweep interval
- Event emission format
- TaskKind handling
- Whether RunRecord gets its own TypeBox schema

### Deferred Ideas (OUT OF SCOPE)
- Context retrieval pipeline (M3)
- Diagnostician runner (M4)
- Unified commit flow (M5)
- OpenClaw adapter demotion (M6)
- TaskKind canonical enum
- CLI surface expansion beyond M2 minimum

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-M2-TaskStore | Task store abstraction + SQLite implementation | Section 2 (Standard Stack), Section 3 (TaskStore) |
| REQ-M2-RunStore | Run store abstraction + SQLite implementation | Section 2 (Standard Stack), Section 3 (RunStore) |
| REQ-M2-Lease | Lease lifecycle (atomic lease, renew, release) | Section 4 (Lease Atomicity) |
| REQ-M2-Retry | Retry metadata (attemptCount, maxAttempts, backoff, error categorization) | Section 5 (Backoff Policy) |
| REQ-M2-Recovery | Expired lease recovery (detection, recovery, event emission, idempotency) | Section 6 (Recovery Pattern) |
| REQ-M2-Tests | Migration bridge + tests | Section 8 (Validation Architecture) |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Task/Run persistence | Database (SQLite) | — | SQLite at workspace level owns all state |
| Lease acquisition | API/Backend | — | LeaseManager orchestrates TaskStore + RunStore |
| Retry backoff calculation | API/Backend | — | Pure computation, no DB needed |
| Expired lease recovery | API/Backend | — | Sweep loop queries DB, updates state |
| Telemetry event emission | API/Backend | — | Structured events emitted on state transitions |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | 12.9.0 | SQLite database access | Already in package.json dependency; synchronous API matches codebase patterns |
| `@sinclair/typebox` | 0.34.49 | Schema definition + runtime validation | All M1 runtime-v2 types use TypeBox; `Value.Check()` used for validation |
| TypeScript | 6.0.3 | Type safety | Project standard |

### Supporting Patterns (from codebase)

| Pattern | Source | Usage |
|---------|--------|-------|
| `trajectory-store.ts` | `packages/principles-core/src/trajectory-store.ts` | SQLite read/write pattern (Database open, prepared statements, row mapping, graceful fallback if DB missing) |
| `atomicWriteFileSync` | `packages/principles-core/src/io.ts` | Crash-safe write pattern reference (not directly used in SQLite, but demonstrates atomicity thinking) |
| `Value.Check()` | `packages/principles-core/src/runtime-v2/error-categories.ts` | Runtime type guard pattern |
| `StorageAdapter` | `packages/principles-core/src/storage-adapter.ts` | Interface design precedent (loadLedger, saveLedger, mutateLedger pattern) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-sqlite3 | `sql.js` (WebAssembly port) | sql.js lacks WAL mode and has worse concurrent write performance |
| better-sqlite3 | `node:sqlite` (Node.js native) | node:sqlite is newer (Node.js 22.5+) and less battle-tested than better-sqlite3 |
| SQLite | In-memory + file polling | SQLite provides ACID guarantees and concurrent access that in-memory cannot |
| TypeBox | Zod | TypeBox is already in the codebase; Zod would be additional dependency |

---

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     PD Runtime v2 Consumer                       │
│         (Diagnostician runner, PD CLI, heartbeat loop)           │
└────────────────────────────┬────────────────────────────────────┘
                             │ calls
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     LeaseManager / RetryPolicy                   │
│           (Orchestrates TaskStore + RunStore)                   │
└──────────┬──────────────────────────────────┬───────────────────┘
           │                                  │
           ▼                                  ▼
┌─────────────────────┐            ┌─────────────────────┐
│     TaskStore       │            │       RunStore       │
│  (interface + impl) │◄──────────►│   (interface + impl) │
└──────────┬──────────┘            └──────────┬──────────┘
           │                                  │
           │           ┌────────┐             │
           └───────────┤        ├─────────────┘
                       │ Sqlite │
                       │Connection│
                       └────┬───┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  <workspace>/.pd/       │
              │      state.db           │
              │  ┌────────┬─────────┐  │
              │  │ tasks  │  runs   │  │
              │  └────────┴─────────┘  │
              │  WAL mode, busy_timeout │
              └─────────────────────────┘
```

### Recommended Project Structure

```
packages/principles-core/src/runtime-v2/
├── store/
│   ├── sqlite-connection.ts    # DB factory, WAL + busy_timeout, schema init
│   ├── task-store.ts           # TaskStore interface + TaskRecord type
│   ├── sqlite-task-store.ts    # SQLite implementation of TaskStore
│   ├── run-store.ts            # RunStore interface + RunRecord type
│   ├── sqlite-run-store.ts     # SQLite implementation of RunStore
│   ├── lease-manager.ts         # Lease lifecycle (acquire, release, isExpired, forceExpire)
│   ├── retry-policy.ts         # Backoff calculation, shouldRetry, markRetryWait
│   └── recovery-sweep.ts       # Expired lease recovery sweep
├── task-status.ts              # (M1 - DO NOT MODIFY)
├── runtime-protocol.ts         # (M1 - DO NOT MODIFY)
├── error-categories.ts         # (M1 - DO NOT MODIFY)
└── index.ts                    # Barrel exports (add store exports here)
```

### Pattern 1: SQLite Connection Initialization

**What:** Single shared `SqliteConnection` instance opens `<workspaceDir>/.pd/state.db` with WAL mode and busy_timeout 5000ms.

**When to use:** Every store operation uses this connection.

**Example:**
```typescript
// Source: trajectory-store.ts + better-sqlite3 docs
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
    
    // WAL mode for concurrent read-during-write
    this.db.pragma('journal_mode = WAL');
    // Wait up to 5s for locks before throwing SQLITE_BUSY
    this.db.pragma('busy_timeout = 5000');
    
    this.initSchema();
    return this.db;
  }

  private initSchema(): void {
    const db = this.db!;
    // tasks table
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
    
    // runs table (full schema per D-09, D-14)
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

### Pattern 2: TaskStore Interface

**What:** Abstract interface for task CRUD operations, mirroring the `StorageAdapter` pattern in the codebase.

**When to use:** All task persistence goes through this interface.

**Example:**
```typescript
// Source: StorageAdapter interface + Plan 01
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

### Pattern 3: Row-to-Record Mapping

**What:** Consistent snake_case DB row to camelCase TypeScript record mapping.

**When to use:** Every read from SQLite.

**Example:**
```typescript
// Source: trajectory-store.ts row mapping pattern
private rowToRecord(row: Record<string, unknown>): TaskRecord {
  return {
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
}
```

### Pattern 4: Lease Acquisition with Transaction

**What:** Use `db.transaction()` for atomic read-check-write lease acquisition.

**When to use:** `LeaseManager.acquireLease()` — must atomically check task is `pending`/`retry_wait` and then set to `leased`.

**Example:**
```typescript
// Source: better-sqlite3 transaction docs + Plan 03
import { PDRuntimeError } from '../error-categories.js';

async acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord> {
  const { taskId, owner, durationMs = 300_000, runtimeKind } = options;
  const db = this.connection.getDb();
  
  const tx = db.transaction(() => {
    // 1. Read current task state
    const row = db.prepare(
      'SELECT task_id, status, attempt_count FROM tasks WHERE task_id = ?'
    ).get(taskId) as Record<string, unknown> | undefined;
    
    if (!row) {
      throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
    }
    
    const currentStatus = String(row.status);
    if (currentStatus !== 'pending' && currentStatus !== 'retry_wait') {
      throw new PDRuntimeError('lease_conflict', 
        `Task ${taskId} is ${currentStatus}, expected pending/retry_wait`);
    }
    
    // 2. Calculate lease expiry
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const attemptNumber = Number(row.attempt_count ?? 0) + 1;
    
    // 3. Update task to leased
    db.prepare(`
      UPDATE tasks 
      SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE task_id = ?
    `).run(owner, expiresAt, nowIso, taskId);
    
    // 4. Create run record
    const runId = `run_${taskId}_${attemptNumber}`;
    db.prepare(`
      INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(runId, taskId, runtimeKind, nowIso, attemptNumber, nowIso, nowIso);
    
    return this.taskStore.getTask(taskId);
  });
  
  return tx() as Promise<TaskRecord>;
}
```

### Pattern 5: Recovery Sweep (Idempotent)

**What:** Periodic scan for expired leases, resetting them to `pending`.

**When to use:** On startup + periodic interval. Must be idempotent.

**Example:**
```typescript
// Source: Plan 04 research
async recoverExpiredLeases(): Promise<{ recovered: number }> {
  const db = this.connection.getDb();
  const now = new Date().toISOString();
  let recovered = 0;
  
  const tx = db.transaction(() => {
    // Find all leased tasks where lease_expires_at < now
    const expiredRows = db.prepare(`
      SELECT task_id FROM tasks 
      WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).all(now) as Record<string, unknown>[];
    
    for (const row of expiredRows) {
      const taskId = String(row.task_id);
      
      // Update to pending, clear lease fields
      const result = db.prepare(`
        UPDATE tasks 
        SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ? AND status = 'leased' AND lease_expires_at < ?
      `).run(now, taskId, now);
      
      if (result.changes > 0) {
        recovered++;
        // Emit telemetry event (idempotent — recovery is logged once per sweep pass)
        this.emitTelemetryEvent({
          eventType: 'lease_recovered',
          traceId: taskId,
          timestamp: now,
          sessionId: 'system',
          payload: { taskId, recoveredAt: now },
        });
      }
    }
  });
  
  tx();
  return { recovered };
}
```

### Pattern 6: Exponential Backoff with Jitter

**What:** Retry delay calculation with exponential base and random jitter.

**When to use:** `RetryPolicy.calculateBackoff()` for `retry_wait` state.

**Example:**
```typescript
// Source: Plan 03 + standard backoff patterns
calculateBackoff(attemptNumber: number): number {
  // Exponential: baseDelay * 2^attempt
  const rawDelay = this.baseDelayMs * Math.pow(2, attemptNumber);
  
  // Cap at max
  const cappedDelay = Math.min(rawDelay, this.maxDelayMs);
  
  // Jitter: +/- jitterFactor/2
  const jitter = cappedDelay * this.jitterFactor;
  return Math.floor(cappedDelay - jitter / 2 + Math.random() * jitter);
}
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Database locking | Custom locking logic | SQLite WAL mode + busy_timeout | SQLite handles concurrent access via WAL; busy_timeout prevents SQLITE_BUSY errors |
| Atomic read-check-write | SELECT FOR UPDATE | `db.transaction()` | better-sqlite3's transaction wrapper handles BEGIN/COMMIT/ROLLBACK atomically |
| Schema migration | Custom migration runner | CREATE TABLE IF NOT EXISTS + ALTER TABLE | SQLite supports limited ALTER TABLE; simpler than full migration framework for M2 |
| ID generation | UUID library | String template `run_${taskId}_${attemptNumber}` | Simple, deterministic, avoids dependency |
| ISO timestamps | Manual date formatting | `new Date().toISOString()` | Built-in, consistent with existing codebase |

---

## Common Pitfalls

### Pitfall 1: Race condition in lease acquisition without transaction
**What goes wrong:** Two concurrent `acquireLease` calls both read task as `pending`, both proceed to update it, resulting in double-lease or corrupted state.

**Why it happens:** Separate `SELECT` then `UPDATE` statements without transactional grouping.

**How to avoid:** Wrap the entire read-check-update in `db.transaction()`. In better-sqlite3, a transaction is implicitly atomic for single-connection scenarios.

**Warning signs:** `SQLITE_BUSY` errors, tasks in impossible states, leaseOwner conflicts.

### Pitfall 2: WAL checkpoint issues on Windows
**What goes wrong:** WAL file grows unbounded on Windows if the reader process crashes, causing storage bloat and potential read errors.

**Why it happens:** Windows doesn't support `unix-dotfile` approach for WAL checkpoint notification. If the connection that started a checkpoint terminates, WAL can't checkpoint cleanly.

**How to avoid:** Set `busy_timeout = 5000` to allow writers to wait. Ensure `db.close()` is called on shutdown so checkpoint runs. For M2, this is acceptable since it's a CLI tool, not a long-running server.

### Pitfall 3: `attemptCount` mismatch between task and run
**What goes wrong:** Task's `attemptCount` incremented in `LeaseManager.acquireLease` but Run's `attemptNumber` set independently, causing divergence.

**Why it happens:** No single source of truth for "which attempt number is current."

**How to avoid:** The Run's `attemptNumber` is derived from `task.attemptCount + 1` at lease acquisition time. Both must use the same value. The `LeaseManager` creates the Run inside the same transaction as the task update, passing the calculated attempt number.

### Pitfall 4: Recovery sweep non-idempotency
**What goes wrong:** Recovery emits duplicate events or double-counts recovered tasks if sweep runs while another process is also recovering.

**Why it happens:** Sweep finds expired leases, updates to `pending`, but another concurrent sweep also finds the same (now-pending) leases and updates again, emitting events twice.

**How to avoid:** The `UPDATE ... WHERE status = 'leased' AND lease_expires_at < ?` filter in the recovery SQL ensures only currently-leased tasks are updated. If the task is already `pending`, the update changes 0 rows and no event is emitted.

### Pitfall 5: Uninitialized DB on first access
**What goes wrong:** `SqliteConnection` opens DB and returns it before schema initialization completes, causing subsequent store operations to fail with "no such table."

**Why it happens:** `getDb()` lazily initializes the schema only on first call, but if multiple store operations race to call `getDb()` before schema is done, there's a window where the DB exists but tables don't.

**How to avoid:** Initialize schema synchronously inside `getDb()` before returning. Since better-sqlite3 is single-threaded per connection, there's no actual race here — but schema init should complete before any prepared statements are created.

---

## Code Examples

### Creating a Task (SqliteTaskStore)

```typescript
// Source: trajectory-store.ts pattern + Plan 01
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
```

### Updating a Task (SqliteTaskStore)

```typescript
// Source: Plan 01
async updateTask(
  taskId: string, 
  patch: Partial<Pick<TaskRecord, 'status' | 'leaseOwner' | 'leaseExpiresAt' | 'attemptCount' | 'maxAttempts' | 'lastError' | 'inputRef' | 'resultRef' | 'updatedAt'>>
): Promise<TaskRecord> {
  const db = this.connection.getDb();
  const now = new Date().toISOString();
  
  // Build dynamic SET clause from patch keys
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updatedAt ?? now];
  
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
  
  if (result.changes === 0) {
    throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
  }
  
  return this.getTask(taskId) as Promise<TaskRecord>;
}
```

### TypeBox Validation on Read

```typescript
// Source: error-categories.ts + telemetry-event.ts pattern
import { Value } from '@sinclair/typebox/value';
import { PDTaskStatusSchema, TaskRecordSchema } from '../task-status.js';

private rowToRecord(row: Record<string, unknown>): TaskRecord {
  const record = {
    taskId: String(row.task_id),
    taskKind: String(row.task_kind),
    status: String(row.status) as PDTaskStatus,
    // ... rest of fields
  };
  
  // Validate on read — ensures DB state matches expected schema
  if (!Value.Check(TaskRecordSchema, record)) {
    throw new PDRuntimeError('storage_unavailable', 
      `Task ${record.taskId} has invalid schema — DB may be corrupted`);
  }
  
  return record;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Marker files for completion | Explicit `status` column in SQLite | M2 | Deterministic, queryable, no race condition |
| Heartbeat-based completion inference | Lease expiry timestamp | M2 | Task can self-report timeout without heartbeat |
| JSON file queue (`.state/evolution-queue.json`) | SQLite with WAL | M2 | ACID transactions, concurrent access, crash-safe |
| TaskResolution string for failure | PDErrorCategory union | M1 | Canonical error taxonomy across PD components |

**Deprecated/outdated:**
- `QueueStatus` ('pending', 'in_progress', 'completed', 'failed', 'canceled') — superseded by `PDTaskStatus` ('pending', 'leased', 'succeeded', 'retry_wait', 'failed')
- `evolution-queue.json` — superseded by `.pd/state.db`
- `diagnostician-task-store.ts` — superseded by TaskStore + RunStore

---

## Runtime State Inventory

> This section applies to rename/refactor/migration phases. M2 is a greenfield implementation creating new state — no existing runtime state needs migration.

**Nothing to migrate:** M2 creates a new store that starts blank (D-05). The legacy queue data is left on disk but not imported. No rename, rebrand, or string replacement is involved.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | better-sqlite3 transactions are atomic within a single Node.js process | Section 4 | Would require explicit BEGIN/COMMIT — better-sqlite3 guarantees this |
| A2 | The workspace directory is always accessible when stores are created | Architecture | If `.pd/` cannot be created, store initialization would fail — acceptable for M2 |
| A3 | Recovery sweep runs as part of PD CLI startup, not as a background daemon | Section 6 | If background sweep is needed, sweep implementation differs (needs interval timer) |
| A4 | TypeBox Value.Check validation on every read is acceptable for M2 performance | Common Pitfalls | Could be disabled in production with flag — plan should measure before optimizing |

---

## Open Questions

1. **Should `attemptNumber` on Run be derived from task's `attemptCount` at lease acquisition, or stored independently?**
   - What we know: D-08 says 1 Task : N Runs; D-10 says Run extends RunHandle with attempt field
   - What's unclear: Whether attempt number is purely derived or independently set
   - Recommendation: Derived — Run's `attemptNumber = task.attemptCount + 1` at lease acquisition. This ensures consistency and avoids the mismatch pitfall.

2. **Should recovery sweep emit a `TelemetryEvent` or a new event type?**
   - What we know: `TelemetryEvent` schema exists with `eventType` union; M2 state transitions should emit events
   - What's unclear: Whether `lease_recovered` fits the existing schema or needs a new event type
   - Recommendation: Extend `TelemetryEventType` union to include `lease_recovered` — aligns with D-08 (all state transitions emit telemetry).

3. **Should the lease duration default to 5 minutes or 30 minutes?**
   - What we know: Plan 03 mentions 5 minutes (300_000ms); context mentions 30 minutes for diagnostician
   - What's unclear: What the right default is for M2 general use
   - Recommendation: Default to 5 minutes (300_000ms) for M2 — allows configurability via `AcquireLeaseOptions.durationMs`, with diagnostician runner passing 30 minutes when it acquires leases.

4. **Run input/output payload — store as JSON column or as separate refs?**
   - What we know: D-09 says "Run stores complete payload (input + output), not just refs"
   - What's unclear: Whether this means JSON column in the runs table or refs to external storage
   - Recommendation: For M2, use TEXT column storing JSON (`input_payload TEXT`, `output_payload TEXT`). If payloads become large, M3 can migrate to external storage with ref columns.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | 22.x+ | N/A |
| better-sqlite3 | SQLite stores | ✓ (in package.json) | 12.9.0 | N/A |
| @sinclair/typebox | TypeBox schemas | ✓ | 0.34.49 | N/A |
| TypeScript | Type safety | ✓ | 6.0.3 | N/A |

**Missing dependencies with no fallback:**
- None identified — all required dependencies are declared in package.json.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | `packages/principles-core/vitest.config.ts` (or inherited from root) |
| Quick run command | `cd packages/principles-core && npx vitest run` |
| Full suite command | `cd packages/principles-core && npx vitest run --reporter=verbose` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|---------------|
| REQ-M2-TaskStore | TaskStore interface has 5 CRUD methods | Unit | `vitest run src/runtime-v2/store/task-store.ts` | Will be created |
| REQ-M2-TaskStore | SqliteTaskStore implements all 5 methods | Unit | `vitest run src/runtime-v2/store/sqlite-task-store.ts` | Will be created |
| REQ-M2-RunStore | RunStore interface has 5 CRUD methods | Unit | `vitest run src/runtime-v2/store/run-store.ts` | Will be created |
| REQ-M2-RunStore | SqliteRunStore implements all 5 methods | Unit | `vitest run src/runtime-v2/store/sqlite-run-store.ts` | Will be created |
| REQ-M2-Lease | LeaseManager.acquireLease sets status='leased' atomically | Unit | `vitest run src/runtime-v2/store/lease-manager.ts` | Will be created |
| REQ-M2-Lease | LeaseManager.releaseLease clears lease fields | Unit | `vitest run src/runtime-v2/store/lease-manager.ts` | Will be created |
| REQ-M2-Lease | LeaseManager.isLeaseExpired correctly detects expiry | Unit | `vitest run src/runtime-v2/store/lease-manager.ts` | Will be created |
| REQ-M2-Retry | RetryPolicy.calculateBackoff returns exponential delay with jitter | Unit | `vitest run src/runtime-v2/store/retry-policy.ts` | Will be created |
| REQ-M2-Retry | RetryPolicy.shouldRetry returns false when exhausted | Unit | `vitest run src/runtime-v2/store/retry-policy.ts` | Will be created |
| REQ-M2-Recovery | Recovery sweep recovers only expired leases | Unit | `vitest run src/runtime-v2/store/recovery-sweep.ts` | Will be created |
| REQ-M2-Recovery | Recovery sweep is idempotent (no double-count) | Unit | `vitest run src/runtime-v2/store/recovery-sweep.ts` | Will be created |
| REQ-M2-Tests | All stores compile without TypeScript errors | Type check | `npx tsc --noEmit` | Existing infra |

### Sampling Rate

- **Per task commit:** `cd packages/principles-core && npx vitest run` (full suite, fast enough)
- **Per wave merge:** Full suite + `cd packages/principles-core && npx tsc --noEmit`
- **Phase gate:** Full suite green + TypeScript clean before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/principles-core/src/runtime-v2/store/task-store.test.ts` — TaskStore interface tests
- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts` — SqliteTaskStore implementation tests
- [ ] `packages/principles-core/src/runtime-v2/store/run-store.test.ts` — RunStore interface tests
- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts` — SqliteRunStore implementation tests
- [ ] `packages/principles-core/src/runtime-v2/store/lease-manager.test.ts` — LeaseManager tests
- [ ] `packages/principles-core/src/runtime-v2/store/retry-policy.test.ts` — RetryPolicy tests
- [ ] `packages/principles-core/src/runtime-v2/store/recovery-sweep.test.ts` — Recovery sweep tests
- [ ] `packages/principles-core/vitest.config.ts` — vitest configuration if not already present

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | N/A — single-user CLI, no auth |
| V3 Session Management | No | N/A — no sessions in M2 |
| V4 Access Control | Yes | Workspace-level DB isolation; SQL parameterized queries prevent injection |
| V5 Input Validation | Yes | TypeBox `Value.Check()` on read from SQLite; parameterized queries on write |
| V6 Cryptography | No | N/A — no cryptographic operations in M2 |

### Known Threat Patterns for SQLite + TypeScript

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via task ID | Tampering | Parameterized queries (`db.prepare('... WHERE id = ?').run(id)`) — no string interpolation |
| Corrupted DB state causing invalid record reads | Information Disclosure | TypeBox `Value.Check()` validation on row-to-record mapping — throws if schema invalid |
| Race condition on lease acquisition | Tampering | `db.transaction()` wrapping read-check-update — atomic within single connection |
| Path traversal via workspaceDir | Spoofing | `workspaceDir` is caller-provided; SqliteConnection uses `path.join()` which normalizes `..` — but `.pd/` subdir is hardcoded, not user-supplied |

---

## Sources

### Primary (HIGH confidence)

- `packages/principles-core/src/trajectory-store.ts` — Existing SQLite pattern in codebase
- `packages/principles-core/src/runtime-v2/error-categories.ts` — TypeBox `Value.Check()` pattern
- `packages/principles-core/src/runtime-v2/task-status.ts` — M1 frozen TaskRecord schema
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — M1 frozen RunHandle/RunStatus schemas
- `packages/principles-core/package.json` — Dependency versions (better-sqlite3 12.9.0, typebox 0.34.49)
- `packages/principles-core/src/storage-adapter.ts` — Interface design precedent
- better-sqlite3 API docs (https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/api.md) — WAL mode, busy_timeout, transactions

### Secondary (MEDIUM confidence)

- `packages/principles-core/src/io.ts` — Crash-safe pattern (atomic write reference)
- `packages/principles-core/src/telemetry-event.ts` — Event schema pattern

### Tertiary (LOW confidence)

- Exponential backoff parameters — standard industry practice, not verified against project-specific benchmarks

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies verified in package.json, patterns from existing codebase
- Architecture: HIGH — decisions are locked in CONTEXT.md; patterns match existing trajectory-store.ts
- Pitfalls: MEDIUM — some pitfalls (Windows WAL checkpoint) based on general SQLite knowledge, not project-specific testing

**Research date:** 2026-04-22
**Valid until:** 2026-05-22 (30 days — stable domain)
