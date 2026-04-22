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
import { SqliteTaskStore } from './sqlite-task-store.js';
import type { TaskRecord, PDTaskStatus } from '../task-status.js';

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
      const result = await store.updateTask('test-task-update', {
        status: 'leased',
        leaseOwner: 'agent-1',
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      expect(result.status).toBe('leased');
      expect(result.leaseOwner).toBe('agent-1');
      expect(result.leaseExpiresAt).toBeTruthy();
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
      expect(page1[0]!.taskId).not.toBe(page2[0]!.taskId);
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
});
