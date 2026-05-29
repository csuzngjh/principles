import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './task/sqlite-task-store.js';
import { SqliteRunStore } from './run/sqlite-run-store.js';
import { DefaultRecoverySweep } from './lifecycle/recovery-sweep.js';
import { DefaultRetryPolicy } from './lifecycle/retry-policy.js';
import type { TaskRecord } from '../task-status.js';
import type { LeaseManager } from './lifecycle/lease-manager.js';

describe('IdempotentStateTransitions', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let tmpdir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let connection: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let taskStore: SqliteTaskStore;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let _runStore: SqliteRunStore;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let retryPolicy: DefaultRetryPolicy;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
    taskStore = new SqliteTaskStore(connection);
    _runStore = new SqliteRunStore(connection);
    retryPolicy = new DefaultRetryPolicy();
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  async function createLeasedTask(taskId: string, expired = false) {
    const expiresAt = expired
      ? new Date(Date.now() - 60_000).toISOString()
      : new Date(Date.now() + 300_000).toISOString();
    await taskStore.createTask({
      taskId,
      taskKind: 'test',
      status: 'leased',
      attemptCount: 1,
      maxAttempts: 3,
      leaseOwner: 'test-owner',
      leaseExpiresAt: expiresAt,
    });
  }

  it('recoverTask on non-leased task returns null (idempotent no-op)', async () => {
    await taskStore.createTask({
      taskId: 'task-pending',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: () => false,
    } as unknown as LeaseManager, retryPolicy, connection);

    const result = await sweep.recoverTask('task-pending');
    expect(result).toBeNull();
  });

  it('recoverTask on non-expired lease returns null (idempotent no-op)', async () => {
    await createLeasedTask('task-not-expired', false);

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: () => false,
    } as unknown as LeaseManager, retryPolicy, connection);

    const result = await sweep.recoverTask('task-not-expired');
    expect(result).toBeNull();
  });

  it('recoverTask on expired lease transitions to retry_wait', async () => {
    await createLeasedTask('task-expired', true);

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: (task: TaskRecord) => task.taskId === 'task-expired',
    } as unknown as LeaseManager, retryPolicy, connection);

    const result = await sweep.recoverTask('task-expired');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.newStatus).toBe('retry_wait');
      expect(result.previousStatus).toBe('leased');
    }
  });

  it('recoverTask on expired lease with maxAttempts reached transitions to failed', async () => {
    await taskStore.createTask({
      taskId: 'task-max-attempts',
      taskKind: 'test',
      status: 'leased',
      attemptCount: 3,
      maxAttempts: 3,
      leaseOwner: 'test-owner',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: (_task: TaskRecord) => true,
    } as unknown as LeaseManager, retryPolicy, connection);

    const result = await sweep.recoverTask('task-max-attempts');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.newStatus).toBe('failed');
      expect(result.wasLeaseExpired).toBe(true);
    }
  });

  it('recoverTask can be called multiple times safely (idempotent)', async () => {
    await createLeasedTask('task-idempotent', true);

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: (task: TaskRecord) => task.status === 'leased' && task.taskId === 'task-idempotent',
    } as unknown as LeaseManager, retryPolicy, connection);

    const first = await sweep.recoverTask('task-idempotent');
    expect(first).not.toBeNull();
    if (first) {
      expect(first.newStatus).toBe('retry_wait');
    }

    const second = await sweep.recoverTask('task-idempotent');
    expect(second).toBeNull();

    const third = await sweep.recoverTask('task-idempotent');
    expect(third).toBeNull();
  });

  it('recoverAll skips already-recovered tasks without error', async () => {
    await taskStore.createTask({
      taskId: 'task-a',
      taskKind: 'test',
      status: 'leased',
      attemptCount: 1,
      maxAttempts: 3,
      leaseOwner: 'test-owner',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await taskStore.createTask({
      taskId: 'task-b',
      taskKind: 'test',
      status: 'leased',
      attemptCount: 1,
      maxAttempts: 3,
      leaseOwner: 'test-owner',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const sweep = new DefaultRecoverySweep(taskStore, {
      isLeaseExpired: (_task: TaskRecord) => true,
    } as unknown as LeaseManager, retryPolicy, connection);

    const firstRun = await sweep.recoverAll();
    expect(firstRun.recovered).toBe(2);
    expect(firstRun.errors).toHaveLength(0);

    const secondRun = await sweep.recoverAll();
    expect(secondRun.recovered).toBe(0);
    expect(secondRun.errors).toHaveLength(0);
  });

  it('transition from retry_wait back to leased preserves attemptCount', async () => {
    await taskStore.createTask({
      taskId: 'task-retry',
      taskKind: 'test',
      status: 'retry_wait',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: 'lease_expired',
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    await taskStore.updateTask('task-retry', {
      status: 'leased',
      leaseOwner: 'runtime-A',
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const task = await taskStore.getTask('task-retry');
    expect(task).not.toBeNull();
    if (task) {
      expect(task.status).toBe('leased');
      expect(task.leaseOwner).toBe('runtime-A');
    }
  });
});
