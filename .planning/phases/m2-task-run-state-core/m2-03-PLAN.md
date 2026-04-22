---
phase: m2
plan: 03
title: Lease Lifecycle + Retry Policy
wave: 3
type: execute
depends_on:
  - m2-01
  - m2-02
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/retry-policy.ts
requirements_addressed:
  - REQ-M2-Lease
  - REQ-M2-Retry
---

<objective>
Implement lease lifecycle (atomic acquire, renew, release, expiry detection) and retry policy (exponential backoff with jitter, maxAttempts enforcement).
</objective>

<tasks>

## Task 1: Implement LeaseManager
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/task-store.ts
  - packages/principles-core/src/runtime-v2/store/run-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-connection.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/runtime-v2/error-categories.ts
  - packages/principles-core/src/runtime-v2/runtime-protocol.ts
<read_first>
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus state machine (DO NOT MODIFY)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError, PDErrorCategory (DO NOT MODIFY)
- `packages/principles-core/src/runtime-v2/store/task-store.ts` — TaskStore interface
- `packages/principles-core/src/runtime-v2/store/run-store.ts` — RunStore interface
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` — SqliteConnection (Plan 01 output)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RunExecutionStatus (DO NOT MODIFY)
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/lease-manager.ts`:

```typescript
import { PDRuntimeError } from '../error-categories.js';
import type { TaskStore } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { SqliteConnection } from './sqlite-connection.js';

export interface AcquireLeaseOptions {
  taskId: string;
  owner: string;
  durationMs?: number;
  runtimeKind: string;
}

export interface LeaseManager {
  acquireLease(options: AcquireLeaseOptions): Promise<import('../task-status.js').TaskRecord>;
  releaseLease(taskId: string, owner: string): Promise<import('../task-status.js').TaskRecord>;
  renewLease(taskId: string, owner: string, durationMs?: number): Promise<import('../task-status.js').TaskRecord>;
  isLeaseExpired(task: import('../task-status.js').TaskRecord): boolean;
  forceExpire(taskId: string): Promise<import('../task-status.js').TaskRecord>;
}

export class DefaultLeaseManager implements LeaseManager {
  constructor(
    private taskStore: TaskStore,
    private runStore: RunStore,
    private connection: SqliteConnection
  ) {}

  async acquireLease(options: AcquireLeaseOptions): Promise<import('../task-status.js').TaskRecord> {
    const { taskId, owner, durationMs = 300_000, runtimeKind } = options;
    const db = this.connection.getDb();

    const tx = db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, attempt_count FROM tasks WHERE task_id = ?'
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);

      const currentStatus = String(row.status);
      if (currentStatus !== 'pending' && currentStatus !== 'retry_wait') {
        throw new PDRuntimeError('lease_conflict', `Task ${taskId} is ${currentStatus}, expected pending/retry_wait`);
      }

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + durationMs).toISOString();
      const attemptNumber = Number(row.attempt_count ?? 0) + 1;

      db.prepare(`
        UPDATE tasks
        SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE task_id = ?
      `).run(owner, expiresAt, nowIso, taskId);

      const runId = `run_${taskId}_${attemptNumber}`;
      db.prepare(`
        INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, taskId, runtimeKind, nowIso, attemptNumber, nowIso, nowIso);

      return attemptNumber;
    });

    const attemptNumber = tx() as number;
    return this.taskStore.getTask(taskId) as Promise<import('../task-status.js').TaskRecord>;
  }

  async releaseLease(taskId: string, owner: string): Promise<import('../task-status.js').TaskRecord> {
    const db = this.connection.getDb();

    const tx = db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, lease_owner FROM tasks WHERE task_id = ?'
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
      if (String(row.lease_owner) !== owner) {
        throw new PDRuntimeError('lease_conflict', `Task ${taskId} is not owned by ${owner}`);
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE tasks SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ?
      `).run(nowIso, taskId);
    });

    tx();
    return this.taskStore.getTask(taskId) as Promise<import('../task-status.js').TaskRecord>;
  }

  async renewLease(taskId: string, owner: string, durationMs = 300_000): Promise<import('../task-status.js').TaskRecord> {
    const db = this.connection.getDb();

    const tx = db.transaction(() => {
      const row = db.prepare(
        'SELECT task_id, status, lease_owner FROM tasks WHERE task_id = ?'
      ).get(taskId) as Record<string, unknown> | undefined;

      if (!row) throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
      if (String(row.lease_owner) !== owner) {
        throw new PDRuntimeError('lease_conflict', `Task ${taskId} is not owned by ${owner}`);
      }
      if (String(row.status) !== 'leased') {
        throw new PDRuntimeError('lease_conflict', `Task ${taskId} is not leased`);
      }

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + durationMs).toISOString();
      db.prepare(`
        UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE task_id = ?
      `).run(expiresAt, nowIso, taskId);
    });

    tx();
    return this.taskStore.getTask(taskId) as Promise<import('../task-status.js').TaskRecord>;
  }

  isLeaseExpired(task: import('../task-status.js').TaskRecord): boolean {
    if (task.status !== 'leased' || !task.leaseExpiresAt) return false;
    return new Date(task.leaseExpiresAt) < new Date();
  }

  async forceExpire(taskId: string): Promise<import('../task-status.js').TaskRecord> {
    return this.taskStore.updateTask(taskId, {
      status: 'pending',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  }
}
```
</action>
<acceptance_criteria>
- [ ] `acquireLease` uses `db.transaction()` wrapping SELECT + UPDATE
- [ ] `acquireLease` checks task is pending/retry_wait before acquiring
- [ ] `acquireLease` creates Run record inside same transaction
- [ ] `acquireLease` sets lease_owner, lease_expires_at, status='leased'
- [ ] `releaseLease` verifies owner matches before releasing
- [ ] `releaseLease` sets status='pending', clears lease fields
- [ ] `renewLease` extends lease_expires_at for current owner
- [ ] `isLeaseExpired` compares leaseExpiresAt to current time
- [ ] `forceExpire` clears lease fields without owner check (recovery use)
- [ ] All use PDRuntimeError with appropriate PDErrorCategory
</acceptance_criteria>

## Task 2: Implement RetryPolicy
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/retry-policy.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/runtime-v2/error-categories.ts
<read_first>
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus, TaskRecord (DO NOT MODIFY)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory (DO NOT MODIFY)
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/retry-policy.ts`:

```typescript
import type { TaskRecord, PDErrorCategory } from '../task-status.js';

export interface RetryPolicyConfig {
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitterFactor?: number;
}

export interface RetryPolicy {
  calculateBackoff(attemptNumber: number): number;
  shouldRetry(task: TaskRecord): boolean;
  markRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord>;
  markFailed(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord>;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly multiplier: number;
  private readonly jitterFactor: number;

  constructor(config: RetryPolicyConfig = {}) {
    this.baseDelayMs = config.baseDelayMs ?? 30_000;
    this.maxDelayMs = config.maxDelayMs ?? 60_000;
    this.multiplier = config.multiplier ?? 2;
    this.jitterFactor = config.jitterFactor ?? 0.2;
  }

  calculateBackoff(attemptNumber: number): number {
    const rawDelay = this.baseDelayMs * Math.pow(this.multiplier, attemptNumber - 1);
    const cappedDelay = Math.min(rawDelay, this.maxDelayMs);
    const jitter = cappedDelay * this.jitterFactor;
    return Math.floor(cappedDelay - jitter / 2 + Math.random() * jitter);
  }

  shouldRetry(task: TaskRecord): boolean {
    return task.attemptCount < task.maxAttempts;
  }

  async markRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord> {
    return { taskId, errorCategory } as any;
  }

  async markFailed(taskId: string, errorCategory: PDErrorCategory): Promise<TaskRecord> {
    return { taskId, errorCategory } as any;
  }
}
```

Note: The actual updateTask calls are made by the caller (LeaseManager or store) using TaskStore. RetryPolicy provides the calculation logic.
</action>
<acceptance_criteria>
- [ ] `calculateBackoff` uses exponential base (baseDelay * 2^attempt)
- [ ] `calculateBackoff` caps at maxDelayMs
- [ ] `calculateBackoff` adds jitter (+/- jitterFactor/2)
- [ ] `shouldRetry` returns false when attemptCount >= maxAttempts
- [ ] `shouldRetry` returns true when attempts remain
- [ ] Default config: baseDelay=30s, maxDelay=60s, multiplier=2, jitter=20%
</acceptance_criteria>

</tasks>

<verification>
1. Run `npx tsc --noEmit` in packages/principles-core
2. Verify `acquireLease` uses `db.transaction()` — grep for "db.transaction"
3. Verify `releaseLease` checks owner — grep for "lease_owner !== owner"
4. Verify `calculateBackoff` caps at maxDelayMs — unit test
5. Verify `shouldRetry` enforces maxAttempts — unit test
</verification>

<success_criteria>
- [ ] LeaseManager.acquireLease atomically acquires lease and creates run record
- [ ] LeaseManager.releaseLease only releases if owner matches
- [ ] LeaseManager.renewLease extends lease for current owner only
- [ ] LeaseManager.isLeaseExpired detects expired leases correctly
- [ ] RetryPolicy.calculateBackoff returns exponential delay with jitter
- [ ] RetryPolicy.shouldRetry returns false when attempts exhausted
- [ ] TypeScript compiles without errors
</success_criteria>
