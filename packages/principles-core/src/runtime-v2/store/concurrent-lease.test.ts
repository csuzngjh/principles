import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { DefaultLeaseManager } from './lease-manager.js';

describe('ConcurrentLeaseConflict', () => {
  let tmpdir: string;
  let connection: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;
  let leaseManager: DefaultLeaseManager;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
    taskStore = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
    leaseManager = new DefaultLeaseManager(taskStore, runStore, connection);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  it('second acquireLease on same task throws lease_conflict', async () => {
    await taskStore.createTask({
      taskId: 'task-1',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await leaseManager.acquireLease({
      taskId: 'task-1',
      owner: 'runtime-A',
      runtimeKind: 'test',
    });

    await expect(
      leaseManager.acquireLease({
        taskId: 'task-1',
        owner: 'runtime-B',
        runtimeKind: 'test',
      })
    ).rejects.toThrow('lease_conflict');
  });

  it('releaseLease by non-owner throws lease_conflict', async () => {
    await taskStore.createTask({
      taskId: 'task-2',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await leaseManager.acquireLease({
      taskId: 'task-2',
      owner: 'runtime-A',
      runtimeKind: 'test',
    });

    await expect(
      leaseManager.releaseLease('task-2', 'runtime-B')
    ).rejects.toThrow('lease_conflict');
  });

  it('renewLease by non-owner throws lease_conflict', async () => {
    await taskStore.createTask({
      taskId: 'task-3',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await leaseManager.acquireLease({
      taskId: 'task-3',
      owner: 'runtime-A',
      runtimeKind: 'test',
    });

    await expect(
      leaseManager.renewLease('task-3', 'runtime-B')
    ).rejects.toThrow('lease_conflict');
  });

  it('owner can renew their own lease', async () => {
    await taskStore.createTask({
      taskId: 'task-4',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    const original = await leaseManager.acquireLease({
      taskId: 'task-4',
      owner: 'runtime-A',
      durationMs: 60_000,
      runtimeKind: 'test',
    });

    const renewed = await leaseManager.renewLease('task-4', 'runtime-A', 120_000);
    expect(renewed.leaseExpiresAt).not.toBe(original.leaseExpiresAt);
    expect(new Date(renewed.leaseExpiresAt!) > new Date(original.leaseExpiresAt!)).toBe(true);
  });

  it('concurrent acquireLease from two runtimes — only one succeeds', async () => {
    const connA = new SqliteConnection(tmpdir);
    const connB = new SqliteConnection(tmpdir);
    const storeA = new SqliteTaskStore(connA);
    const storeB = new SqliteTaskStore(connB);
    const runStoreA = new SqliteRunStore(connA);
    const runStoreB = new SqliteRunStore(connB);
    const managerA = new DefaultLeaseManager(storeA, runStoreA, connA);
    const managerB = new DefaultLeaseManager(storeB, runStoreB, connB);

    await storeA.createTask({
      taskId: 'task-5',
      taskKind: 'test',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    await managerA.acquireLease({
      taskId: 'task-5',
      owner: 'runtime-A',
      runtimeKind: 'test',
    });

    await expect(
      managerB.acquireLease({
        taskId: 'task-5',
        owner: 'runtime-B',
        runtimeKind: 'test',
      })
    ).rejects.toThrow('lease_conflict');

    connA.close();
    connB.close();
  });
});
