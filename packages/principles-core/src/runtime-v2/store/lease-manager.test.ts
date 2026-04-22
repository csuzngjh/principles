/**
 * DefaultLeaseManager integration tests.
 *
 * Uses an in-memory SQLite tmpdir for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { DefaultLeaseManager } from './lease-manager.js';
import type { TaskRecord } from '../task-status.js';

function makeTaskInput(taskId: string, overrides: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
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
  const tmpDir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
  let conn: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;
  let leaseManager: DefaultLeaseManager;

  beforeEach(() => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    conn = new SqliteConnection(testDir);
    taskStore = new SqliteTaskStore(conn);
    runStore = new SqliteRunStore(conn);
    leaseManager = new DefaultLeaseManager(taskStore, runStore, conn);
  });

  afterEach(() => {
    conn.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('acquireLease', () => {
    it('acquires lease on pending task', async () => {
      await taskStore.createTask(makeTaskInput('lease-task-1'));
      const result = await leaseManager.acquireLease({
        taskId: 'lease-task-1',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-1');
      expect(result.leaseExpiresAt).toBeTruthy();
    });

    it('acquires lease on retry_wait task', async () => {
      await taskStore.createTask(makeTaskInput('lease-task-retry', { status: 'retry_wait' }));
      const result = await leaseManager.acquireLease({
        taskId: 'lease-task-retry',
        owner: 'agent-2',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-2');
    });

    it('throws when task not found', async () => {
      await expect(
        leaseManager.acquireLease({
          taskId: 'non-existent',
          owner: 'agent-1',
          durationMs: 60_000,
          runtimeKind: 'openclaw',
        }),
      ).rejects.toThrow();
    });

    it('throws when task already leased', async () => {
      await taskStore.createTask(makeTaskInput('lease-task-2'));
      await leaseManager.acquireLease({
        taskId: 'lease-task-2',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      await expect(
        leaseManager.acquireLease({
          taskId: 'lease-task-2',
          owner: 'agent-2',
          durationMs: 60_000,
          runtimeKind: 'openclaw',
        }),
      ).rejects.toThrow();
    });

    it('throws when task is succeeded', async () => {
      await taskStore.createTask(makeTaskInput('lease-task-succeeded', { status: 'succeeded' }));
      await expect(
        leaseManager.acquireLease({
          taskId: 'lease-task-succeeded',
          owner: 'agent-1',
          durationMs: 60_000,
          runtimeKind: 'openclaw',
        }),
      ).rejects.toThrow();
    });

    it('creates a run record with executionStatus running', async () => {
      await taskStore.createTask(makeTaskInput('lease-with-run'));
      await leaseManager.acquireLease({
        taskId: 'lease-with-run',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      const runs = await runStore.listRunsByTask('lease-with-run');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.executionStatus).toBe('running');
      expect(runs[0]!.attemptNumber).toBe(1);
    });

    it('increments attempt number on re-lease', async () => {
      await taskStore.createTask(makeTaskInput('lease-retry-count'));
      await leaseManager.acquireLease({
        taskId: 'lease-retry-count',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      // simulate work then release
      await leaseManager.releaseLease('lease-retry-count', 'agent-1');
      await leaseManager.acquireLease({
        taskId: 'lease-retry-count',
        owner: 'agent-2',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      const runs = await runStore.listRunsByTask('lease-retry-count');
      expect(runs).toHaveLength(2);
      expect(runs[1]!.attemptNumber).toBe(2);
    });
  });

  describe('releaseLease', () => {
    it('releases lease for correct owner', async () => {
      await taskStore.createTask(makeTaskInput('release-task-1'));
      await leaseManager.acquireLease({
        taskId: 'release-task-1',
        owner: 'agent-release',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      const result = await leaseManager.releaseLease('release-task-1', 'agent-release');
      expect(result.status).toBe('pending');
      expect(result.leaseOwner).toBeUndefined();
      expect(result.leaseExpiresAt).toBeUndefined();
    });

    it('throws when not owner', async () => {
      await taskStore.createTask(makeTaskInput('release-task-2'));
      await leaseManager.acquireLease({
        taskId: 'release-task-2',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      await expect(
        leaseManager.releaseLease('release-task-2', 'wrong-owner'),
      ).rejects.toThrow();
    });

    it('throws when task not found', async () => {
      await expect(
        leaseManager.releaseLease('non-existent', 'agent-1'),
      ).rejects.toThrow();
    });
  });

  describe('renewLease', () => {
    it('extends lease for correct owner', async () => {
      await taskStore.createTask(makeTaskInput('renew-task-1'));
      await leaseManager.acquireLease({
        taskId: 'renew-task-1',
        owner: 'agent-renew',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      const result = await leaseManager.renewLease('renew-task-1', 'agent-renew', 120_000);
      expect(result.leaseExpiresAt).toBeTruthy();
      // New expiry should be approximately 120s from now
      const expiry = new Date(result.leaseExpiresAt!).getTime();
      const now = Date.now();
      expect(expiry - now).toBeGreaterThan(100_000);
    });

    it('throws when not owner', async () => {
      await taskStore.createTask(makeTaskInput('renew-task-2'));
      await leaseManager.acquireLease({
        taskId: 'renew-task-2',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      await expect(
        leaseManager.renewLease('renew-task-2', 'wrong-owner'),
      ).rejects.toThrow();
    });

    it('throws when task not leased', async () => {
      await taskStore.createTask(makeTaskInput('renew-task-3'));
      await expect(
        leaseManager.renewLease('renew-task-3', 'agent-1'),
      ).rejects.toThrow();
    });
  });

  describe('isLeaseExpired', () => {
    it('returns false for non-leased task', () => {
      const task = makeTaskInput('expire-task-1') as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(false);
    });

    it('returns false for leased task with future expiry', () => {
      const task = makeTaskInput('expire-task-2', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }) as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(false);
    });

    it('returns true for leased task with past expiry', () => {
      const task = makeTaskInput('expire-task-3', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }) as TaskRecord;
      expect(leaseManager.isLeaseExpired(task)).toBe(true);
    });
  });

  describe('forceExpire', () => {
    it('clears lease without owner check', async () => {
      await taskStore.createTask(makeTaskInput('force-task-1'));
      await leaseManager.acquireLease({
        taskId: 'force-task-1',
        owner: 'agent-1',
        durationMs: 60_000,
        runtimeKind: 'openclaw',
      });
      const result = await leaseManager.forceExpire('force-task-1');
      expect(result.status).toBe('pending');
      expect(result.leaseOwner).toBeUndefined();
    });
  });
});
