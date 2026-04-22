---
phase: m2
plan: 05
title: Integration Tests
wave: 5
type: execute
depends_on:
  - m2-04
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/sqlite-connection.test.ts
  - packages/principles-core/src/runtime-v2/store/task-store.test.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts
  - packages/principles-core/src/runtime-v2/store/run-store.test.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts
  - packages/principles-core/src/runtime-v2/store/lease-manager.test.ts
  - packages/principles-core/src/runtime-v2/store/retry-policy.test.ts
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.test.ts
requirements_addressed:
  - REQ-M2-Tests
---

<objective>
Create comprehensive test suite for all M2 store components. Tests use in-memory SQLite via tmpdir for isolation. Coverage target: 80%+ for new code.
</objective>

<tasks>

## Task 1: Create test infrastructure and SqliteTaskStore tests
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts
  - packages/principles-core/src/runtime-v2/store/task-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-connection.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` — Implementation to test
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord schema (DO NOT MODIFY)
- Existing test file for reference pattern: `packages/principles-core/src/pain-signal.test.ts` (vitest pattern)
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import type { TaskRecord, PDTaskStatus } from '../task-status.js';

const TEST_WORKSPACE = path.join(__dirname, '.test-tmp');

function createTestTask(overrides: Partial<TaskRecord> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId: overrides.taskId ?? `task_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    taskKind: overrides.taskKind ?? 'diagnostician',
    status: overrides.status ?? 'pending',
    attemptCount: overrides.attemptCount ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    inputRef: overrides.inputRef,
    resultRef: overrides.resultRef,
    leaseOwner: overrides.leaseOwner,
    leaseExpiresAt: overrides.leaseExpiresAt,
    lastError: overrides.lastError,
  };
}

describe('SqliteTaskStore', () => {
  let connection: SqliteConnection;
  let store: SqliteTaskStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    connection = new SqliteConnection(TEST_WORKSPACE);
    store = new SqliteTaskStore(connection);
  });

  afterEach(() => {
    connection.close();
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe('createTask', () => {
    it('creates a task and returns it', async () => {
      const input = createTestTask({ taskId: 'test-task-1' });
      const result = await store.createTask(input);
      expect(result.taskId).toBe('test-task-1');
      expect(result.taskKind).toBe('diagnostician');
      expect(result.status).toBe('pending');
      expect(result.attemptCount).toBe(0);
      expect(result.maxAttempts).toBe(3);
    });

    it('rejects duplicate taskId', async () => {
      const input = createTestTask({ taskId: 'test-task-dup' });
      await store.createTask(input);
      await expect(store.createTask(input)).rejects.toThrow();
    });
  });

  describe('getTask', () => {
    it('returns null for non-existent task', async () => {
      const result = await store.getTask('non-existent');
      expect(result).toBeNull();
    });

    it('returns created task', async () => {
      const input = createTestTask({ taskId: 'test-task-get' });
      await store.createTask(input);
      const result = await store.getTask('test-task-get');
      expect(result?.taskId).toBe('test-task-get');
    });
  });

  describe('updateTask', () => {
    it('updates task fields', async () => {
      await store.createTask(createTestTask({ taskId: 'test-task-update' }));
      const result = await store.updateTask('test-task-update', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-1');
    });

    it('throws for non-existent task', async () => {
      await expect(store.updateTask('non-existent', { status: 'leased' })).rejects.toThrow();
    });
  });

  describe('listTasks', () => {
    it('returns all tasks when no filter', async () => {
      await store.createTask(createTestTask({ taskId: 'list-1' }));
      await store.createTask(createTestTask({ taskId: 'list-2' }));
      const results = await store.listTasks();
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by status', async () => {
      await store.createTask(createTestTask({ taskId: 'filter-1', status: 'pending' }));
      await store.createTask(createTestTask({ taskId: 'filter-2', status: 'leased' }));
      const results = await store.listTasks({ status: 'leased' });
      expect(results.every(t => t.status === 'leased')).toBe(true);
    });
  });

  describe('deleteTask', () => {
    it('deletes existing task', async () => {
      await store.createTask(createTestTask({ taskId: 'delete-1' }));
      const deleted = await store.deleteTask('delete-1');
      expect(deleted).toBe(true);
      expect(await store.getTask('delete-1')).toBeNull();
    });

    it('returns false for non-existent task', async () => {
      const deleted = await store.deleteTask('non-existent');
      expect(deleted).toBe(false);
    });
  });
});
```
</action>
<acceptance_criteria>
- [ ] Test file imports from sqlite-task-store.ts
- [ ] Uses tmpdir for workspace isolation
- [ ] beforeEach creates connection + store, afterEach closes and cleans
- [ ] Tests createTask, getTask, updateTask, listTasks, deleteTask
- [ ] Tests error handling (duplicate taskId, non-existent task)
- [ ] Tests filter by status in listTasks
</acceptance_criteria>

## Task 2: Create SqliteRunStore tests
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts
  - packages/principles-core/src/runtime-v2/store/run-store.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts` — Implementation to test
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts` — Test pattern to follow
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';

const TEST_WORKSPACE = path.join(__dirname, '.test-tmp');

function createTestTask(taskId: string) {
  return {
    taskId,
    taskKind: 'diagnostician' as const,
    status: 'pending' as const,
    attemptCount: 0,
    maxAttempts: 3,
  };
}

function createTestRun(taskId: string, attemptNumber: number = 1): Omit<RunRecord, never> {
  const now = new Date().toISOString();
  return {
    runId: `run_${taskId}_${attemptNumber}`,
    taskId,
    runtimeKind: 'principles',
    executionStatus: 'queued' as RunExecutionStatus,
    startedAt: now,
    attemptNumber,
    createdAt: now,
    updatedAt: now,
  };
}

describe('SqliteRunStore', () => {
  let taskConnection: SqliteConnection;
  let runConnection: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    taskConnection = new SqliteConnection(TEST_WORKSPACE);
    runConnection = new SqliteConnection(TEST_WORKSPACE);
    taskStore = new SqliteTaskStore(taskConnection);
    runStore = new SqliteRunStore(runConnection);
  });

  afterEach(() => {
    taskConnection.close();
    runConnection.close();
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe('createRun', () => {
    it('creates a run record', async () => {
      const taskId = 'task-run-create';
      await taskStore.createTask(createTestTask(taskId));
      const run = createTestRun(taskId, 1);
      const result = await runStore.createRun(run);
      expect(result.runId).toBe(`run_${taskId}_1`);
      expect(result.taskId).toBe(taskId);
      expect(result.attemptNumber).toBe(1);
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const result = await runStore.getRun('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('listRunsByTask', () => {
    it('returns all runs for a task ordered by started_at', async () => {
      const taskId = 'task-runs-list';
      await taskStore.createTask(createTestTask(taskId));
      await runStore.createRun(createTestRun(taskId, 1));
      await runStore.createRun(createTestRun(taskId, 2));
      const results = await runStore.listRunsByTask(taskId);
      expect(results.length).toBe(2);
      expect(results[0].attemptNumber).toBe(1);
      expect(results[1].attemptNumber).toBe(2);
    });
  });

  describe('updateRun', () => {
    it('updates run execution status', async () => {
      const taskId = 'task-run-update';
      await taskStore.createTask(createTestTask(taskId));
      const run = await runStore.createRun(createTestRun(taskId, 1));
      const result = await runStore.updateRun(run.runId, {
        executionStatus: 'succeeded',
        endedAt: new Date().toISOString(),
      });
      expect(result.executionStatus).toBe('succeeded');
    });
  });
});
```
</action>
<acceptance_criteria>
- [ ] Test file imports from sqlite-run-store.ts
- [ ] Uses tmpdir for workspace isolation
- [ ] Tests createRun, getRun, updateRun, listRunsByTask, deleteRun
- [ ] Tests 1:N relationship via listRunsByTask
- [ ] Tests execution status updates
</acceptance_criteria>

## Task 3: Create LeaseManager tests
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/lease-manager.test.ts
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — Implementation to test
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts` — Test pattern to follow
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/lease-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { DefaultLeaseManager } from './lease-manager.js';
import type { TaskRecord } from '../task-status.js';

const TEST_WORKSPACE = path.join(__dirname, '.test-tmp');

function createTestTask(taskId: string, overrides: Partial<TaskRecord> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('DefaultLeaseManager', () => {
  let connection: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;
  let leaseManager: DefaultLeaseManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    connection = new SqliteConnection(TEST_WORKSPACE);
    taskStore = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
    leaseManager = new DefaultLeaseManager(taskStore, runStore, connection);
  });

  afterEach(() => {
    connection.close();
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe('acquireLease', () => {
    it('acquires lease on pending task', async () => {
      await taskStore.createTask(createTestTask('lease-task-1'));
      const result = await leaseManager.acquireLease({
        taskId: 'lease-task-1',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'principles',
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-1');
    });

    it('throws when task not found', async () => {
      await expect(leaseManager.acquireLease({
        taskId: 'non-existent',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'principles',
      })).rejects.toThrow();
    });

    it('throws when task already leased', async () => {
      await taskStore.createTask(createTestTask('lease-task-2'));
      await leaseManager.acquireLease({
        taskId: 'lease-task-2',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'principles',
      });
      await expect(leaseManager.acquireLease({
        taskId: 'lease-task-2',
        owner: 'agent-2',
        durationMs: 60_000,
        runtimeKind: 'principles',
      })).rejects.toThrow();
    });
  });

  describe('releaseLease', () => {
    it('releases lease for owner', async () => {
      await taskStore.createTask(createTestTask('release-task-1'));
      await leaseManager.acquireLease({
        taskId: 'release-task-1',
        owner: 'agent-release',
        durationMs: 60_000,
        runtimeKind: 'principles',
      });
      const result = await leaseManager.releaseLease('release-task-1', 'agent-release');
      expect(result.status).toBe('pending');
      expect(result.leaseOwner).toBeUndefined();
    });

    it('throws when not owner', async () => {
      await taskStore.createTask(createTestTask('release-task-2'));
      await leaseManager.acquireLease({
        taskId: 'release-task-2',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'principles',
      });
      await expect(leaseManager.releaseLease('release-task-2', 'wrong-owner')).rejects.toThrow();
    });
  });

  describe('isLeaseExpired', () => {
    it('returns false for non-leased task', () => {
      const task = createTestTask('expire-task-1') as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(false);
    });

    it('returns false for leased task with future expiry', () => {
      const task = createTestTask('expire-task-2', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }) as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(false);
    });

    it('returns true for leased task with past expiry', () => {
      const task = createTestTask('expire-task-3', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }) as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(true);
    });
  });

  describe('forceExpire', () => {
    it('clears lease without owner check', async () => {
      await taskStore.createTask(createTestTask('force-task-1'));
      await leaseManager.acquireLease({
        taskId: 'force-task-1',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'principles',
      });
      const result = await leaseManager.forceExpire('force-task-1');
      expect(result.status).toBe('pending');
      expect(result.leaseOwner).toBeUndefined();
    });
  });
});
```
</action>
<acceptance_criteria>
- [ ] Test file imports from lease-manager.ts
- [ ] Uses tmpdir for workspace isolation
- [ ] Tests acquireLease, releaseLease, isLeaseExpired, forceExpire
- [ ] Tests owner-only enforcement on releaseLease
- [ ] Tests isLeaseExpired with past/future expiry
</acceptance_criteria>

## Task 4: Create RetryPolicy and RecoverySweep tests
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/retry-policy.test.ts
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.test.ts
  - packages/principles-core/src/runtime-v2/store/retry-policy.ts
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` — Implementation to test
- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` — Implementation to test
- `packages/principles-core/src/runtime-v2/store/lease-manager.test.ts` — Test pattern to follow
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/retry-policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DefaultRetryPolicy } from './retry-policy.js';
import type { TaskRecord } from '../task-status.js';

describe('DefaultRetryPolicy', () => {
  const policy = new DefaultRetryPolicy({
    baseDelayMs: 30_000,
    maxDelayMs: 60_000,
    multiplier: 2,
    jitterFactor: 0.2,
  });

  describe('calculateBackoff', () => {
    it('returns base delay for first attempt', () => {
      const delay = policy.calculateBackoff(1);
      const expected = 30_000;
      expect(delay).toBeGreaterThanOrEqual(expected * 0.8);
      expect(delay).toBeLessThanOrEqual(expected * 1.2);
    });

    it('doubles for second attempt', () => {
      const delay1 = policy.calculateBackoff(1);
      const delay2 = policy.calculateBackoff(2);
      expect(delay2).toBeGreaterThan(delay1);
    });

    it('caps at maxDelayMs', () => {
      const delay = policy.calculateBackoff(10);
      expect(delay).toBeLessThanOrEqual(60_000);
    });
  });

  describe('shouldRetry', () => {
    function makeTask(attemptCount: number, maxAttempts: number): TaskRecord {
      return {
        taskId: 'test-task',
        taskKind: 'diagnostician',
        status: 'retry_wait',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount,
        maxAttempts,
      };
    }

    it('returns true when attempts remain', () => {
      expect(policy.shouldRetry(makeTask(1, 3))).toBe(true);
      expect(policy.shouldRetry(makeTask(2, 3))).toBe(true);
    });

    it('returns false when maxAttempts reached', () => {
      expect(policy.shouldRetry(makeTask(3, 3))).toBe(false);
      expect(policy.shouldRetry(makeTask(4, 3))).toBe(false);
    });
  });
});
```

Create `packages/principles-core/src/runtime-v2/store/recovery-sweep.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { DefaultLeaseManager } from './lease-manager.js';
import { DefaultRetryPolicy } from './retry-policy.js';
import { DefaultRecoverySweep } from './recovery-sweep.js';
import type { TaskRecord } from '../task-status.js';

const TEST_WORKSPACE = path.join(__dirname, '.test-tmp');

function createTestTask(taskId: string, overrides: Partial<TaskRecord> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('DefaultRecoverySweep', () => {
  let connection: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let leaseManager: DefaultLeaseManager;
  let retryPolicy: DefaultRetryPolicy;
  let recoverySweep: DefaultRecoverySweep;

  beforeEach(() => {
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    connection = new SqliteConnection(TEST_WORKSPACE);
    taskStore = new SqliteTaskStore(connection);
    const runStore = { } as any;
    leaseManager = new DefaultLeaseManager(taskStore, runStore, connection);
    retryPolicy = new DefaultRetryPolicy({ baseDelayMs: 30_000, maxDelayMs: 60_000 });
    recoverySweep = new DefaultRecoverySweep(taskStore, leaseManager, retryPolicy);
  });

  afterEach(() => {
    connection.close();
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe('detectExpiredLeases', () => {
    it('returns empty when no expired leases', async () => {
      await taskStore.createTask(createTestTask('no-expire'));
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toEqual([]);
    });

    it('detects expired lease', async () => {
      await taskStore.createTask(createTestTask('expired-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }));
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toContain('expired-task');
    });
  });

  describe('recoverTask', () => {
    it('returns null for non-leased task', async () => {
      await taskStore.createTask(createTestTask('not-leased'));
      const result = await recoverySweep.recoverTask('not-leased');
      expect(result).toBeNull();
    });

    it('returns null for non-expired lease', async () => {
      await taskStore.createTask(createTestTask('not-expired', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const result = await recoverySweep.recoverTask('not-expired');
      expect(result).toBeNull();
    });

    it('recovers expired lease to retry_wait when attempts remain', async () => {
      await taskStore.createTask(createTestTask('retry-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }));
      const result = await recoverySweep.recoverTask('retry-task');
      expect(result?.newStatus).toBe('retry_wait');
      expect(result?.wasLeaseExpired).toBe(true);
    });

    it('recovers to failed when maxAttempts exceeded', async () => {
      await taskStore.createTask(createTestTask('fail-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        attemptCount: 3,
        maxAttempts: 3,
      }));
      const result = await recoverySweep.recoverTask('fail-task');
      expect(result?.newStatus).toBe('failed');
    });
  });

  describe('recoverAll', () => {
    it('recovers all expired tasks', async () => {
      await taskStore.createTask(createTestTask('multi-expire-1', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }));
      await taskStore.createTask(createTestTask('multi-expire-2', {
        status: 'leased',
        leaseOwner: 'agent-2',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }));
      const { recovered, errors } = await recoverySweep.recoverAll();
      expect(recovered).toBe(2);
      expect(errors).toEqual([]);
    });

    it('is idempotent', async () => {
      await taskStore.createTask(createTestTask('idempotent-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }));
      await recoverySweep.recoverAll();
      const { recovered } = await recoverySweep.recoverAll();
      expect(recovered).toBe(0);
    });
  });
});
```
</action>
<acceptance_criteria>
- [ ] RetryPolicy tests cover calculateBackoff, shouldRetry
- [ ] RecoverySweep tests cover detectExpiredLeases, recoverTask, recoverAll
- [ ] Tests idempotency of recoverAll
- [ ] Tests recovery to retry_wait vs failed based on attempt count
</acceptance_criteria>

## Task 5: Run full test suite and TypeScript check
type: execute
files:
  - packages/principles-core
<read_first>
- `packages/principles-core/tsconfig.json` — TypeScript config
</read_first>
<action>
Run the full test suite and TypeScript check:

```bash
cd packages/principles-core && npx tsc --noEmit
cd packages/principles-core && npx vitest run --reporter=verbose
```

All tests must pass. TypeScript must compile without errors.
</action>
<acceptance_criteria>
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] All store test files pass: `vitest run store/`
- [ ] Test coverage >= 80% for new store code
</acceptance_criteria>

</tasks>

<verification>
1. Run `npx tsc --noEmit` in packages/principles-core
2. Run `npx vitest run --reporter=verbose` in packages/principles-core
3. Verify coverage report shows >= 80% for store modules
</verification>

<success_criteria>
- [ ] All 8 test files created (sqlite-connection, task-store, sqlite-task-store, run-store, sqlite-run-store, lease-manager, retry-policy, recovery-sweep)
- [ ] All tests pass
- [ ] TypeScript compiles without errors
- [ ] Coverage >= 80% for new store code
</success_criteria>
