/**
 * SqliteTaskStore integration tests.
 *
 * Uses an in-memory SQLite tmpdir for isolation. Each test gets a fresh
 * database via a unique workspace directory that is cleaned up after the test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './task/sqlite-task-store.js';
import type { TaskRecord } from '../task-status.js';

function makeTaskInput(overrides: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
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
  const tmpDir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
   
  let connection: SqliteConnection;
  let store: SqliteTaskStore;
   

  beforeEach(() => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    connection = new SqliteConnection(testDir);
    store = new SqliteTaskStore(connection);
  });

  afterEach(() => {
    connection.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('createTask', () => {
    it('creates a task and returns it with timestamps', async () => {
      const input = makeTaskInput({ taskId: 'test-task-1' });
      const result = await store.createTask(input);
      expect(result.taskId).toBe('test-task-1');
      expect(result.taskKind).toBe('diagnostician');
      expect(result.status).toBe('pending');
      expect(result.attemptCount).toBe(0);
      expect(result.maxAttempts).toBe(3);
      expect(result.createdAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
    });

    it('rejects duplicate taskId', async () => {
      const input = makeTaskInput({ taskId: 'test-task-dup' });
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
      const input = makeTaskInput({ taskId: 'test-task-get' });
      await store.createTask(input);
      const result = await store.getTask('test-task-get');
      expect(result?.taskId).toBe('test-task-get');
      expect(result?.taskKind).toBe('diagnostician');
    });
  });

  describe('updateTask', () => {
    it('updates task fields', async () => {
      await store.createTask(makeTaskInput({ taskId: 'test-task-update' }));
      const expiresAt = new Date(Date.now() + 300_000).toISOString();

      // SPEC §5.3: entering 'leased' requires a fresh lease_generation, which
      // only the lease manager mints. A bare updateTask must be refused by the
      // DB trigger rather than silently claiming an unowned lease.
      await expect(store.updateTask('test-task-update', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: expiresAt,
      })).rejects.toThrow(/lease acquisition requires a new lease_generation/);

      // Mint the lease the way acquisition does, then update fields on the row.
      connection.getDb().prepare(
        "UPDATE tasks SET status = 'leased', lease_owner = ?, lease_expires_at = ?, lease_generation = COALESCE(lease_generation, 0) + 1 WHERE task_id = ?",
      ).run('agent-1', expiresAt, 'test-task-update');

      const result = await store.updateTask('test-task-update', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: expiresAt,
        attemptCount: 1,
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-1');
      expect(result.leaseExpiresAt).toBeTruthy();
      expect(result.leaseGeneration).toBe(1);
      expect(result.attemptCount).toBe(1);
    });

    it('throws for non-existent task', async () => {
      await expect(
        store.updateTask('non-existent', { status: 'leased' }),
      ).rejects.toThrow();
    });

    it('can update attemptCount', async () => {
      await store.createTask(makeTaskInput({ taskId: 'test-task-attempts' }));
      const result = await store.updateTask('test-task-attempts', { attemptCount: 2 });
      expect(result.attemptCount).toBe(2);
    });

    it('can clear lease fields by passing null', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 'test-task-clear-lease',
          status: 'leased',
          leaseOwner: 'agent-1',
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      const result = await store.updateTask('test-task-clear-lease', {
        status: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(result.status).toBe('pending');
      expect(result.leaseOwner).toBeUndefined();
      expect(result.leaseExpiresAt).toBeUndefined();
    });
  });

  describe('listTasks', () => {
    it('returns all tasks when no filter', async () => {
      await store.createTask(makeTaskInput({ taskId: 'list-1' }));
      await store.createTask(makeTaskInput({ taskId: 'list-2' }));
      const results = await store.listTasks();
      const ids = results.map(t => t.taskId);
      expect(ids).toContain('list-1');
      expect(ids).toContain('list-2');
    });

    it('filters by status', async () => {
      await store.createTask(makeTaskInput({ taskId: 'filter-1', status: 'pending' }));
      await store.createTask(makeTaskInput({ taskId: 'filter-2', status: 'leased' }));
      const leased = await store.listTasks({ status: 'leased' });
      expect(leased.every(t => t.status === 'leased')).toBe(true);
      expect(leased.map(t => t.taskId)).toContain('filter-2');
    });

    it('filters by taskKind', async () => {
      await store.createTask(makeTaskInput({ taskId: 'kind-1', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 'kind-2', taskKind: 'principle_candidate_intake' }));
      const diagnosticians = await store.listTasks({ taskKind: 'diagnostician' });
      expect(diagnosticians.every(t => t.taskKind === 'diagnostician')).toBe(true);
    });

    it('applies limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createTask(makeTaskInput({ taskId: `limit-${i}` }));
      }
      const page1 = await store.listTasks({ limit: 2, offset: 0 });
      const page2 = await store.listTasks({ limit: 2, offset: 2 });
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      const [p1] = page1;
      const [p2] = page2;
      if (!p1 || !p2) return;
      expect(p1.taskId).not.toBe(p2.taskId);
    });
  });

  describe('deleteTask', () => {
    it('deletes existing task and returns true', async () => {
      await store.createTask(makeTaskInput({ taskId: 'delete-1' }));
      const deleted = await store.deleteTask('delete-1');
      expect(deleted).toBe(true);
      expect(await store.getTask('delete-1')).toBeNull();
    });

    it('returns false for non-existent task', async () => {
      const deleted = await store.deleteTask('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('write transaction admission', () => {
    async function runIndependentWriteAcrossOuterRollback(write: () => Promise<unknown>): Promise<void> {
      let markStarted!: () => void;
      let releaseTx!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseTx = resolve; });
      const tx = store.withWriteTransaction(async () => {
        markStarted();
        await release;
        throw new Error('force outer rollback');
      });
      const txFailure = expect(tx).rejects.toThrow('force outer rollback');
      await started;
      const observedWrite = write().then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      releaseTx();
      await txFailure;
      expect(await observedWrite).toBe('fulfilled');
    }

    it('does not roll back an independent updateTask invoked during a failed transaction', async () => {
      await store.createTask(makeTaskInput({ taskId: 'independent-update' }));
      await runIndependentWriteAcrossOuterRollback(() => store.updateTask('independent-update', { attemptCount: 7 }));
      expect((await store.getTask('independent-update'))?.attemptCount).toBe(7);
    });

    it('does not roll back independent create/delete/CAS writes invoked during a failed transaction', async () => {
      await store.createTask(makeTaskInput({ taskId: 'independent-delete' }));
      await store.createTask(makeTaskInput({ taskId: 'independent-cas' }));

      await runIndependentWriteAcrossOuterRollback(async () => {
        await store.createTask(makeTaskInput({ taskId: 'independent-created' }));
      });
      expect(await store.getTask('independent-created')).not.toBeNull();

      await runIndependentWriteAcrossOuterRollback(async () => {
        await store.deleteTask('independent-delete');
      });
      expect(await store.getTask('independent-delete')).toBeNull();

      await runIndependentWriteAcrossOuterRollback(async () => {
        await store.updateTaskIfDiagnosticJsonUnchanged('independent-cas', null, { diagnosticJson: '{"v":1}' });
      });
      expect((await store.getTask('independent-cas'))?.diagnosticJson).toBe('{"v":1}');
    });

    it('nested same-owner writes join the outer transaction and roll back with it', async () => {
      await store.createTask(makeTaskInput({ taskId: 'owner-outer' }));
      await store.createTask(makeTaskInput({ taskId: 'owner-inner' }));

      await expect(store.withWriteTransaction(async () => {
        await store.updateTask('owner-outer', { attemptCount: 1 });
        await store.withWriteTransaction(async () => {
          await store.updateTask('owner-inner', { attemptCount: 1 });
        });
        throw new Error('force owner rollback');
      })).rejects.toThrow('force owner rollback');

      expect((await store.getTask('owner-outer'))?.attemptCount).toBe(0);
      expect((await store.getTask('owner-inner'))?.attemptCount).toBe(0);
    });
  });
});
