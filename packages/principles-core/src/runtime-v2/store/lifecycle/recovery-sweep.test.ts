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
  /* eslint-disable @typescript-eslint/init-declarations */
  let conn: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let leaseManager: DefaultLeaseManager;
  let retryPolicy: DefaultRetryPolicy;
  let recoverySweep: DefaultRecoverySweep;
  /* eslint-enable @typescript-eslint/init-declarations */

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
      if (!result) return;
      expect(result.newStatus).toBe('retry_wait');
      expect(result.wasLeaseExpired).toBe(true);
      const updated = await taskStore.getTask('retry-task');
      if (!updated) return;
      expect(updated.status).toBe('retry_wait');
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
      if (!result) return;
      expect(result.newStatus).toBe('failed');
      expect(result.wasLeaseExpired).toBe(true);
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
      if (!updated) return;
      expect(updated.leaseOwner).toBeUndefined();
      expect(updated.leaseExpiresAt).toBeTruthy();
      expect(updated.status).toBe('retry_wait');
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

  describe('dirty workspace handling', () => {
    it('stalled attempt leaves dirty workspace -> no automatic retry is scheduled', async () => {
      // Simulate a task that stalled with dirty workspace (lastError = workspace_dirty)
      await taskStore.createTask(makeTaskInput('dirty-stalled-task', {
        attemptCount: 1,
        maxAttempts: 3,
        lastError: 'workspace_dirty',
      }));
      await taskStore.updateTask('dirty-stalled-task', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        diagnosticJson: JSON.stringify({
          workspaceDir: 'D:/code/test-workspace',
          dirtyFiles: [
            'packages/pd-cli/src/commands/runtime-canary.ts',
            'packages/pd-cli/tests/commands/runtime-canary.test.ts',
          ],
        }),
      });

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
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        diagnosticJson: JSON.stringify({ workspaceDir: 'D:/code/test-workspace' }),
      });

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
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        diagnosticJson: JSON.stringify({
          workspaceDir: 'D:/code/test-workspace',
          dirtyFiles: ['some/file.ts'],
        }),
      });

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
