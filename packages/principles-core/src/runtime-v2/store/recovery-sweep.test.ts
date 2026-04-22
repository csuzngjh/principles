/**
 * DefaultRecoverySweep integration tests.
 *
 * Uses an in-memory SQLite tmpdir for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { DefaultLeaseManager } from './lease-manager.js';
import { DefaultRetryPolicy } from './retry-policy.js';
import { DefaultRecoverySweep } from './recovery-sweep.js';
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

describe('DefaultRecoverySweep', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
  let conn: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let leaseManager: DefaultLeaseManager;
  let retryPolicy: DefaultRetryPolicy;
  let recoverySweep: DefaultRecoverySweep;

  beforeEach(() => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    conn = new SqliteConnection(testDir);
    taskStore = new SqliteTaskStore(conn);
    // LeaseManager needs a runStore; we pass a minimal mock
    const runStore = {
      createRun: async () => { throw new Error('not implemented'); },
      getRun: async () => null,
      updateRun: async () => { throw new Error('not implemented'); },
      listRunsByTask: async () => [],
      deleteRun: async () => false,
    } as any;
    leaseManager = new DefaultLeaseManager(taskStore, runStore, conn);
    retryPolicy = new DefaultRetryPolicy({
      baseDelayMs: 30_000,
      maxDelayMs: 60_000,
      multiplier: 2,
    });
    recoverySweep = new DefaultRecoverySweep(taskStore, leaseManager, retryPolicy);
  });

  afterEach(() => {
    conn.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('detectExpiredLeases', () => {
    it('returns empty when no tasks exist', async () => {
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toEqual([]);
    });

    it('returns empty when no expired leases', async () => {
      await taskStore.createTask(makeTaskInput('no-expire'));
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toEqual([]);
    });

    it('returns empty for active lease (future expiry)', async () => {
      await taskStore.createTask(makeTaskInput('active-lease', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toEqual([]);
    });

    it('detects expired lease', async () => {
      await taskStore.createTask(makeTaskInput('expired-task'));
      await taskStore.updateTask('expired-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).toContain('expired-task');
    });

    it('does not detect non-leased tasks as expired', async () => {
      await taskStore.createTask(makeTaskInput('pending-task', { status: 'pending' }));
      await taskStore.createTask(makeTaskInput('failed-task', { status: 'failed' }));
      const result = await recoverySweep.detectExpiredLeases();
      expect(result).not.toContain('pending-task');
      expect(result).not.toContain('failed-task');
    });
  });

  describe('recoverTask', () => {
    it('returns null for non-existent task', async () => {
      const result = await recoverySweep.recoverTask('non-existent');
      expect(result).toBeNull();
    });

    it('returns null for non-leased task', async () => {
      await taskStore.createTask(makeTaskInput('not-leased'));
      const result = await recoverySweep.recoverTask('not-leased');
      expect(result).toBeNull();
    });

    it('returns null for non-expired lease', async () => {
      await taskStore.createTask(makeTaskInput('not-expired', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const result = await recoverySweep.recoverTask('not-expired');
      expect(result).toBeNull();
    });

    it('recovers expired lease to retry_wait when attempts remain', async () => {
      await taskStore.createTask(makeTaskInput('retry-task', { attemptCount: 1, maxAttempts: 3 }));
      await taskStore.updateTask('retry-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const result = await recoverySweep.recoverTask('retry-task');
      expect(result).not.toBeNull();
      expect(result!.newStatus).toBe('retry_wait');
      expect(result!.wasLeaseExpired).toBe(true);
      // Verify task was actually updated
      const updated = await taskStore.getTask('retry-task');
      expect(updated!.status).toBe('retry_wait');
    });

    it('recovers to failed when maxAttempts exceeded', async () => {
      await taskStore.createTask(makeTaskInput('fail-task', { attemptCount: 3, maxAttempts: 3 }));
      await taskStore.updateTask('fail-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const result = await recoverySweep.recoverTask('fail-task');
      expect(result).not.toBeNull();
      expect(result!.newStatus).toBe('failed');
      expect(result!.wasLeaseExpired).toBe(true);
    });

    it('clears leaseOwner and sets retry_wait expiry on recovery', async () => {
      await taskStore.createTask(makeTaskInput('clear-lease-task', { attemptCount: 1, maxAttempts: 3 }));
      await taskStore.updateTask('clear-lease-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await recoverySweep.recoverTask('clear-lease-task');
      const updated = await taskStore.getTask('clear-lease-task');
      expect(updated!.leaseOwner).toBeUndefined();
      // retry_wait state has a backoff expiry, not undefined
      expect(updated!.leaseExpiresAt).toBeTruthy();
      expect(updated!.status).toBe('retry_wait');
    });
  });

  describe('recoverAll', () => {
    it('recovers all expired tasks', async () => {
      await taskStore.createTask(makeTaskInput('multi-expire-1'));
      await taskStore.updateTask('multi-expire-1', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await taskStore.createTask(makeTaskInput('multi-expire-2'));
      await taskStore.updateTask('multi-expire-2', {
        status: 'leased',
        leaseOwner: 'agent-2',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const { recovered, errors } = await recoverySweep.recoverAll();
      expect(recovered).toBe(2);
      expect(errors).toEqual([]);
    });

    it('handles mixed expired and non-expired tasks', async () => {
      await taskStore.createTask(makeTaskInput('mixed-expired'));
      await taskStore.updateTask('mixed-expired', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await taskStore.createTask(makeTaskInput('mixed-active'));
      await taskStore.updateTask('mixed-active', {
        status: 'leased',
        leaseOwner: 'agent-2',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const { recovered, errors } = await recoverySweep.recoverAll();
      expect(recovered).toBe(1);
      expect(errors).toEqual([]);
    });

    it('is idempotent', async () => {
      await taskStore.createTask(makeTaskInput('idempotent-task'));
      await taskStore.updateTask('idempotent-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const first = await recoverySweep.recoverAll();
      const second = await recoverySweep.recoverAll();
      expect(first.recovered).toBe(1);
      expect(second.recovered).toBe(0);
    });
  });
});
