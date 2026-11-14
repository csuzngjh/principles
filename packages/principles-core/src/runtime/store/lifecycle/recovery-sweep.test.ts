/**
 * DefaultRecoverySweep integration tests.
 *
 * Uses an in-memory SQLite tmpdir for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from '../sqlite-connection.js';
import { SqliteTaskStore } from '../task/sqlite-task-store.js';
import { DefaultLeaseManager } from './lease-manager.js';
import { DefaultRetryPolicy } from './retry-policy.js';
import { DefaultRecoverySweep } from './recovery-sweep.js';
import type { TaskRecord } from '../../task-status.js';

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

  /** Lease fixtures must mint a generation, like a real acquisition. */
  function seedLease(taskId: string, owner: string, expiresAt: string): void {
    conn.getDb().prepare(
      "UPDATE tasks SET status = 'leased', lease_owner = ?, lease_expires_at = ?, lease_generation = COALESCE(lease_generation, 0) + 1 WHERE task_id = ?",
    ).run(owner, expiresAt, taskId);
  }


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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    leaseManager = new DefaultLeaseManager(taskStore, runStore, conn);
    retryPolicy = new DefaultRetryPolicy({
      baseDelayMs: 30_000,
      maxDelayMs: 60_000,
      multiplier: 2,
    });
    recoverySweep = new DefaultRecoverySweep(taskStore, leaseManager, retryPolicy, conn);
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
      seedLease('expired-task', 'agent-1', new Date(Date.now() - 1000).toISOString());
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
      seedLease('retry-task', 'agent-1', new Date(Date.now() - 1000).toISOString());
      const result = await recoverySweep.recoverTask('retry-task');
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.newStatus).toBe('retry_wait');
      expect(result.wasLeaseExpired).toBe(true);
      const updated = await taskStore.getTask('retry-task');
      if (!updated) return;
      expect(updated.status).toBe('retry_wait');
    });

    it('recovers to failed when maxAttempts exceeded', async () => {
      await taskStore.createTask(makeTaskInput('fail-task', { attemptCount: 3, maxAttempts: 3 }));
      seedLease('fail-task', 'agent-1', new Date(Date.now() - 1000).toISOString());
      const result = await recoverySweep.recoverTask('fail-task');
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.newStatus).toBe('failed');
      expect(result.wasLeaseExpired).toBe(true);
    });

    it('clears leaseOwner and sets retry_wait expiry on recovery', async () => {
      await taskStore.createTask(makeTaskInput('clear-lease-task', { attemptCount: 1, maxAttempts: 3 }));
      seedLease('clear-lease-task', 'agent-1', new Date(Date.now() - 1000).toISOString());
      await recoverySweep.recoverTask('clear-lease-task');
      const updated = await taskStore.getTask('clear-lease-task');
      if (!updated) return;
      expect(updated.leaseOwner).toBeUndefined();
      expect(updated.leaseExpiresAt).toBeTruthy();
      expect(updated.status).toBe('retry_wait');
    });

    // SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.4
    it('does not reclaim a lease renewed between detection and recovery (heartbeat wins)', async () => {
      // SPEC §5.3: a renewal may only extend a LIVE lease, so the heartbeat
      // must renew before expiry. Recovery re-checks the persisted expiry under
      // the write lock; a renewed (still live) lease is never reclaimed.
      await taskStore.createTask(makeTaskInput('renewed-task', {
        status: 'leased',
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
      }));
      const acquired = { taskId: 'renewed-task', owner: 'worker-a', leaseGeneration: 1 };
      conn.getDb().prepare('UPDATE tasks SET lease_generation = 1 WHERE task_id = ?').run('renewed-task');

      // The worker's heartbeat renews the lease before the sweep writes.
      await leaseManager.renewLease(acquired, 60_000);

      const result = await recoverySweep.recoverTask('renewed-task');
      expect(result).toBeNull();

      const updated = await taskStore.getTask('renewed-task');
      expect(updated?.status).toBe('leased');
      expect(updated?.leaseOwner).toBe('worker-a');
    });

    it('refuses to revive an expired lease through renewal', async () => {
      await taskStore.createTask(makeTaskInput('expired-renew-task', {
        status: 'leased',
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }));

      conn.getDb().prepare('UPDATE tasks SET lease_generation = 1 WHERE task_id = ?').run('expired-renew-task');
      await expect(
        leaseManager.renewLease({ taskId: 'expired-renew-task', owner: 'worker-a', leaseGeneration: 1 }, 60_000),
      ).rejects.toMatchObject({ category: 'lease_conflict' });

      const updated = await taskStore.getTask('expired-renew-task');
      expect(updated?.status).toBe('leased');
      expect(updated?.leaseExpiresAt).toBe(new Date(updated?.leaseExpiresAt ?? 0).toISOString());
      expect(new Date(updated?.leaseExpiresAt ?? 0).getTime()).toBeLessThan(Date.now());
    });

    it('never reclaims a lease acquired by a new owner after forced expiry', async () => {
      await taskStore.createTask(makeTaskInput('takeover-task', {
        status: 'leased',
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }));
      await leaseManager.forceExpire('takeover-task');
      await leaseManager.acquireLease({
        taskId: 'takeover-task',
        owner: 'worker-b',
        runtimeKind: 'pi-ai',
        durationMs: 60_000,
      });

      const result = await recoverySweep.recoverTask('takeover-task');
      expect(result).toBeNull();

      const updated = await taskStore.getTask('takeover-task');
      expect(updated?.status).toBe('leased');
      expect(updated?.leaseOwner).toBe('worker-b');
    });
  });

  describe('recoverAll', () => {
    it('recovers all expired tasks', async () => {
      await taskStore.createTask(makeTaskInput('multi-expire-1'));
      seedLease('multi-expire-1', 'agent-1', new Date(Date.now() - 1000).toISOString());
      await taskStore.createTask(makeTaskInput('multi-expire-2'));
      seedLease('multi-expire-2', 'agent-2', new Date(Date.now() - 1000).toISOString());
      const { recovered, errors } = await recoverySweep.recoverAll();
      expect(recovered).toBe(2);
      expect(errors).toEqual([]);
    });

    it('handles mixed expired and non-expired tasks', async () => {
      await taskStore.createTask(makeTaskInput('mixed-expired'));
      seedLease('mixed-expired', 'agent-1', new Date(Date.now() - 1000).toISOString());
      await taskStore.createTask(makeTaskInput('mixed-active'));
      seedLease('mixed-active', 'agent-2', new Date(Date.now() + 60_000).toISOString());
      const { recovered, errors } = await recoverySweep.recoverAll();
      expect(recovered).toBe(1);
      expect(errors).toEqual([]);
    });

    it('is idempotent', async () => {
      await taskStore.createTask(makeTaskInput('idempotent-task'));
      seedLease('idempotent-task', 'agent-1', new Date(Date.now() - 1000).toISOString());
      const first = await recoverySweep.recoverAll();
      const second = await recoverySweep.recoverAll();
      expect(first.recovered).toBe(1);
      expect(second.recovered).toBe(0);
    });
  });

  describe('dirty workspace handling', () => {
    it('stalled attempt leaves dirty workspace -> no automatic retry is scheduled', async () => {
      // Simulate a task that stalled with dirty workspace (lastError = workspace_dirty)
      await taskStore.createTask(makeTaskInput('dirty-stalled-task', {
        attemptCount: 1,
        maxAttempts: 3,
        lastError: 'workspace_dirty',
      }));
      await taskStore.updateTask('dirty-stalled-task', {
        diagnosticJson: JSON.stringify({
          workspaceDir: 'D:/code/test-workspace',
          dirtyFiles: [
            'packages/pd-cli/src/commands/runtime-canary.ts',
            'packages/pd-cli/tests/commands/runtime-canary.test.ts',
          ],
        }),
      });
      seedLease('dirty-stalled-task', 'agent-1', new Date(Date.now() - 1000).toISOString());

      // Recovery should NOT schedule a retry — task should go to needs_human_review
      const result = await recoverySweep.recoverTask('dirty-stalled-task');

      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.newStatus).toBe('needs_human_review');
      expect(result.wasLeaseExpired).toBe(true);

      const updated = await taskStore.getTask('dirty-stalled-task');
      if (!updated) return;
      expect(updated.status).toBe('needs_human_review');
      expect(updated.leaseOwner).toBeUndefined();
      expect(updated.leaseExpiresAt).toBeUndefined();
    });

    it('clean stalled attempt (no workspace_dirty) -> follows existing retry behavior', async () => {
      // A task that stalled without a dirty workspace should still go to retry_wait
      await taskStore.createTask(makeTaskInput('clean-stalled-task', {
        attemptCount: 1,
        maxAttempts: 3,
        lastError: 'timeout',
      }));
      await taskStore.updateTask('clean-stalled-task', {
        diagnosticJson: JSON.stringify({ workspaceDir: 'D:/code/test-workspace' }),
      });
      seedLease('clean-stalled-task', 'agent-1', new Date(Date.now() - 1000).toISOString());

      const result = await recoverySweep.recoverTask('clean-stalled-task');

      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.newStatus).toBe('retry_wait');
      const updated = await taskStore.getTask('clean-stalled-task');
      if (!updated) return;
      expect(updated.status).toBe('retry_wait');
    });

    it('dirty workspace with maxAttempts exceeded -> goes to failed not retry_wait', async () => {
      await taskStore.createTask(makeTaskInput('dirty-max-task', {
        attemptCount: 3,
        maxAttempts: 3,
        lastError: 'workspace_dirty',
      }));
      await taskStore.updateTask('dirty-max-task', {
        diagnosticJson: JSON.stringify({
          workspaceDir: 'D:/code/test-workspace',
          dirtyFiles: ['some/file.ts'],
        }),
      });
      seedLease('dirty-max-task', 'agent-1', new Date(Date.now() - 1000).toISOString());

      const result = await recoverySweep.recoverTask('dirty-max-task');

      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.newStatus).toBe('failed');
    });

    it('needs_human_review task is not recovered by recoverAll (idempotent)', async () => {
      // A task already in needs_human_review should not be touched
      await taskStore.createTask(makeTaskInput('already-review-task', {
        attemptCount: 2,
        maxAttempts: 3,
        status: 'needs_human_review',
        lastError: 'workspace_dirty',
      }));
      await taskStore.updateTask('already-review-task', {
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      const result = await recoverySweep.recoverTask('already-review-task');

      // Non-leased or non-expired tasks return null
      expect(result).toBeNull();

      // Task should remain in needs_human_review
      const updated = await taskStore.getTask('already-review-task');
      if (!updated) return;
      expect(updated.status).toBe('needs_human_review');
    });
  });
});
