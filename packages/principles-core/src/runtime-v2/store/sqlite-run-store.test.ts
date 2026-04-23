/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * SqliteRunStore integration tests.
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
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';

function makeTaskInput(taskId: string) {
  return {
    taskId,
    taskKind: 'diagnostician' as const,
    status: 'pending' as const,
    attemptCount: 0,
    maxAttempts: 3,
  };
}

function makeRunInput(taskId: string, attemptNumber = 1): Omit<RunRecord, 'createdAt' | 'updatedAt'> {
  const now = new Date().toISOString();
  return {
    runId: `run_${taskId}_${attemptNumber}`,
    taskId,
    runtimeKind: 'openclaw' as const,
    executionStatus: 'queued' as RunExecutionStatus,
    startedAt: now,
    attemptNumber,
    
    
  };
}

describe('SqliteRunStore', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-test-${process.pid}-${Date.now()}`);
  let conn: SqliteConnection;
  let taskStore: SqliteTaskStore;
  let runStore: SqliteRunStore;

  beforeEach(() => {
    const testDir = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    conn = new SqliteConnection(testDir);
    taskStore = new SqliteTaskStore(conn);
    runStore = new SqliteRunStore(conn);
  });

  afterEach(() => {
    conn.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('createRun', () => {
    it('creates a run record and returns it', async () => {
      const taskId = 'task-run-create';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      const result = await runStore.createRun(run);
      expect(result.runId).toBe(`run_${taskId}_1`);
      expect(result.taskId).toBe(taskId);
      expect(result.attemptNumber).toBe(1);
      expect(result.executionStatus).toBe('queued');
    });

    it('rejects duplicate runId', async () => {
      const taskId = 'task-run-dup';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      await runStore.createRun(run);
      await expect(runStore.createRun(run)).rejects.toThrow();
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const result = await runStore.getRun('non-existent');
      expect(result).toBeNull();
    });

    it('returns created run', async () => {
      const taskId = 'task-run-get';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = makeRunInput(taskId, 1);
      await runStore.createRun(run);
      const result = await runStore.getRun(`run_${taskId}_1`);
      expect(result?.runId).toBe(`run_${taskId}_1`);
      expect(result?.taskId).toBe(taskId);
    });
  });

  describe('listRunsByTask', () => {
    it('returns all runs for a task ordered by started_at', async () => {
      const taskId = 'task-runs-list';
      await taskStore.createTask(makeTaskInput(taskId));
      await runStore.createRun(makeRunInput(taskId, 1));
      await runStore.createRun(makeRunInput(taskId, 2));
      const results = await runStore.listRunsByTask(taskId);
      expect(results.length).toBe(2);
      expect(results[0]!.attemptNumber).toBe(1);
      expect(results[1]!.attemptNumber).toBe(2);
    });

    it('returns empty array for task with no runs', async () => {
      const taskId = 'task-no-runs';
      await taskStore.createTask(makeTaskInput(taskId));
      const results = await runStore.listRunsByTask(taskId);
      expect(results).toEqual([]);
    });
  });

  describe('updateRun', () => {
    it('updates run endedAt and reason', async () => {
      const taskId = 'task-run-update';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const endedAt = new Date().toISOString();
      const result = await runStore.updateRun(run.runId, {
        endedAt,
        reason: 'completed successfully',
      });
      expect(result.endedAt).toBe(endedAt);
      expect(result.reason).toBe('completed successfully');
    });

    it('throws for non-existent run', async () => {
      await expect(
        runStore.updateRun('non-existent', { reason: 'test' }),
      ).rejects.toThrow();
    });

    it('can set errorCategory', async () => {
      const taskId = 'task-run-reason';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const result = await runStore.updateRun(run.runId, {
        reason: 'Agent stalled',
        errorCategory: 'timeout',
      });
      expect(result.reason).toBe('Agent stalled');
      expect(result.errorCategory).toBe('timeout');
    });
  });

  describe('deleteRun', () => {
    it('deletes existing run and returns true', async () => {
      const taskId = 'task-run-delete';
      await taskStore.createTask(makeTaskInput(taskId));
      const run = await runStore.createRun(makeRunInput(taskId, 1));
      const deleted = await runStore.deleteRun(run.runId);
      expect(deleted).toBe(true);
      expect(await runStore.getRun(run.runId)).toBeNull();
    });

    it('returns false for non-existent run', async () => {
      const deleted = await runStore.deleteRun('non-existent');
      expect(deleted).toBe(false);
    });
  });
});
