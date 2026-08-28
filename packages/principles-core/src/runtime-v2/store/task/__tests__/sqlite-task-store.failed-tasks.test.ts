/**
 * SqliteTaskStore failed-task observability tests (Task 8).
 *
 * Covers listFailedTasks / getFailedTaskDetail / countFailedTasks:
 * - status filtering (failed / needs_human_review vs succeeded)
 * - kind filter
 * - since filter (derived from runs.started_at)
 * - limit / offset pagination
 * - sort order (lastAttemptAt DESC)
 * - painId extraction from diagnostic_json
 * - getFailedTaskDetail run history + null pendingAgentDraft
 * - countFailedTasks matches listFailedTasks length
 *
 * Uses a real in-memory SqliteConnection (tmpdir) for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';
import { SqliteRunStore } from '../../run/sqlite-run-store.js';
import type { TaskRecord } from '../../../task-status.js';
import type { RunRecord } from '../../run/run-store.js';

function makeTaskInput(
  overrides: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>> = {},
): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
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
    diagnosticJson: overrides.diagnosticJson,
  };
}

function makeRunInput(
  overrides: Partial<Omit<RunRecord, 'createdAt' | 'updatedAt'>> = {},
): Omit<RunRecord, 'createdAt' | 'updatedAt'> {
  return {
    runId: overrides.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    taskId: overrides.taskId ?? 'task-unknown',
    runtimeKind: overrides.runtimeKind ?? 'test-double',
    executionStatus: overrides.executionStatus ?? 'failed',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    attemptNumber: overrides.attemptNumber ?? 1,
    endedAt: overrides.endedAt,
    reason: overrides.reason,
    outputRef: overrides.outputRef,
    inputPayload: overrides.inputPayload,
    outputPayload: overrides.outputPayload,
    errorCategory: overrides.errorCategory,
  };
}

describe('SqliteTaskStore failed-task observability', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-failed-test-${process.pid}-${Date.now()}`);

  let connection: SqliteConnection;
  let store: SqliteTaskStore;
  let runStore: SqliteRunStore;

  beforeEach(() => {
    const testDir = path.join(tmpDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    connection = new SqliteConnection(testDir);
    store = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
  });

  afterEach(() => {
    connection.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  // ── listFailedTasks: status filtering ──────────────────────────────────────

  describe('listFailedTasks — status filtering', () => {
    it('returns only failed and needs_human_review tasks (excludes succeeded)', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-failed', status: 'failed', lastError: 'runtime_unavailable' }));
      await store.createTask(makeTaskInput({ taskId: 't-review', status: 'needs_human_review' }));
      await store.createTask(makeTaskInput({ taskId: 't-ok', status: 'succeeded' }));

      const results = await store.listFailedTasks();
      const ids = results.map((r) => r.taskId);
      expect(ids).toContain('t-failed');
      expect(ids).toContain('t-review');
      expect(ids).not.toContain('t-ok');
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no failed tasks exist', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-ok', status: 'succeeded' }));
      const results = await store.listFailedTasks();
      expect(results).toEqual([]);
    });

    it('each summary has correct status type (failed or needs_human_review)', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-f1', status: 'failed' }));
      await store.createTask(makeTaskInput({ taskId: 't-r1', status: 'needs_human_review' }));
      const results = await store.listFailedTasks();
      for (const r of results) {
        expect(r.status === 'failed' || r.status === 'needs_human_review').toBe(true);
      }
    });
  });

  // ── listFailedTasks: kind filter ───────────────────────────────────────────

  describe('listFailedTasks — kind filter', () => {
    it('filters by taskKind', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-d1', status: 'failed', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 't-d2', status: 'failed', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 't-s1', status: 'failed', taskKind: 'scribe' }));

      const diags = await store.listFailedTasks({ kind: 'diagnostician' });
      const ids = diags.map((r) => r.taskId);
      expect(ids).toContain('t-d1');
      expect(ids).toContain('t-d2');
      expect(ids).not.toContain('t-s1');
      expect(diags).toHaveLength(2);
    });

    it('returns all failed tasks when kind is undefined', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-a', status: 'failed', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 't-b', status: 'failed', taskKind: 'scribe' }));
      const results = await store.listFailedTasks();
      expect(results).toHaveLength(2);
    });
  });

  // ── listFailedTasks: since filter ──────────────────────────────────────────

  describe('listFailedTasks — since filter', () => {
    it('filters by lastAttemptAt >= since (derived from runs.started_at)', async () => {
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
      const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

      // Task with an old run
      await store.createTask(makeTaskInput({ taskId: 't-old', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 't-old', startedAt: oldTime }));

      // Task with a recent run
      await store.createTask(makeTaskInput({ taskId: 't-recent', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 't-recent', startedAt: recentTime }));

      // since = 5 days ago → only 't-recent' should be included
      const sinceMs = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const results = await store.listFailedTasks({ since: sinceMs });
      const ids = results.map((r) => r.taskId);
      expect(ids).toContain('t-recent');
      expect(ids).not.toContain('t-old');
    });

    it('excludes tasks with no runs when since is specified', async () => {
      // Task with no runs
      await store.createTask(makeTaskInput({ taskId: 't-no-runs', status: 'failed' }));
      // Task with a recent run
      await store.createTask(makeTaskInput({ taskId: 't-with-run', status: 'failed' }));
      await runStore.createRun(
        makeRunInput({ taskId: 't-with-run', startedAt: new Date().toISOString() }),
      );

      const sinceMs = Date.now() - 60 * 1000; // 1 minute ago
      const results = await store.listFailedTasks({ since: sinceMs });
      const ids = results.map((r) => r.taskId);
      expect(ids).toContain('t-with-run');
      expect(ids).not.toContain('t-no-runs');
    });

    it('includes tasks with no runs when since is not specified', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-no-runs', status: 'failed' }));
      const results = await store.listFailedTasks();
      const ids = results.map((r) => r.taskId);
      expect(ids).toContain('t-no-runs');
    });
  });

  // ── listFailedTasks: limit / offset pagination ─────────────────────────────

  describe('listFailedTasks — pagination', () => {
    it('applies limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createTask(makeTaskInput({ taskId: `t-page-${i}`, status: 'failed' }));
      }
      const results = await store.listFailedTasks({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('applies offset for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createTask(makeTaskInput({ taskId: `t-page-${i}`, status: 'failed' }));
      }
      const page1 = await store.listFailedTasks({ limit: 2, offset: 0 });
      const page2 = await store.listFailedTasks({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      const p1Ids = page1.map((r) => r.taskId);
      const p2Ids = page2.map((r) => r.taskId);
      // No overlap between pages
      for (const id of p1Ids) {
        expect(p2Ids).not.toContain(id);
      }
    });

    it('returns empty for offset beyond result count', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-only', status: 'failed' }));
      const results = await store.listFailedTasks({ limit: 10, offset: 10 });
      expect(results).toEqual([]);
    });
  });

  // ── listFailedTasks: sort order ────────────────────────────────────────────

  describe('listFailedTasks — sort order', () => {
    it('sorts by lastAttemptAt DESC (most recent first)', async () => {
      const t1 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
      const t2 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      const t3 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

      await store.createTask(makeTaskInput({ taskId: 't-oldest', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 't-oldest', startedAt: t1 }));

      await store.createTask(makeTaskInput({ taskId: 't-newest', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 't-newest', startedAt: t2 }));

      await store.createTask(makeTaskInput({ taskId: 't-middle', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 't-middle', startedAt: t3 }));

      const results = await store.listFailedTasks();
      expect(results).toHaveLength(3);
      // Most recent first
      const [newest, middle, oldest] = results;
      if (!newest || !middle || !oldest) {
        throw new Error('expected 3 results');
      }
      expect(newest.taskId).toBe('t-newest');
      expect(middle.taskId).toBe('t-middle');
      expect(oldest.taskId).toBe('t-oldest');
    });

    it('tasks with no runs (NULL lastAttemptAt) sort last', async () => {
      // Task with a run
      await store.createTask(makeTaskInput({ taskId: 't-with-run', status: 'failed' }));
      await runStore.createRun(
        makeRunInput({ taskId: 't-with-run', startedAt: new Date().toISOString() }),
      );
      // Task without runs
      await store.createTask(makeTaskInput({ taskId: 't-no-run', status: 'failed' }));

      const results = await store.listFailedTasks();
      expect(results).toHaveLength(2);
      // Task with run comes first (non-NULL lastAttemptAt sorts before NULL in DESC)
      const [withRun, noRun] = results;
      if (!withRun || !noRun) {
        throw new Error('expected 2 results');
      }
      expect(withRun.taskId).toBe('t-with-run');
      expect(withRun.lastAttemptAt).not.toBeNull();
      expect(noRun.taskId).toBe('t-no-run');
      expect(noRun.lastAttemptAt).toBeNull();
    });
  });

  // ── listFailedTasks: painId extraction ─────────────────────────────────────

  describe('listFailedTasks — painId extraction', () => {
    it('extracts painId from diagnostic_json.sourcePainId', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 't-with-pain',
          status: 'failed',
          diagnosticJson: JSON.stringify({ sourcePainId: 'pain-abc-123', other: 'data' }),
        }),
      );
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-with-pain');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.painId).toBe('pain-abc-123');
    });

    it('returns null painId when diagnostic_json has no sourcePainId', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 't-no-pain-field',
          status: 'failed',
          diagnosticJson: JSON.stringify({ otherField: 'value' }),
        }),
      );
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-no-pain-field');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.painId).toBeNull();
    });

    it('returns null painId when diagnostic_json is not set', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-no-diag', status: 'failed' }));
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-no-diag');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.painId).toBeNull();
    });

    it('returns null painId when sourcePainId is not a string (graceful degradation)', async () => {
      // diagnostic_json is valid JSON (passes the session-id-hint expression
      // index), but sourcePainId is a number, not a string.
      await store.createTask(
        makeTaskInput({
          taskId: 't-bad-pain-type',
          status: 'failed',
          diagnosticJson: JSON.stringify({ sourcePainId: 123 }),
        }),
      );
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-bad-pain-type');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.painId).toBeNull();
    });

    it('returns null painId when diagnostic_json is a JSON array (not an object)', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 't-array-json',
          status: 'failed',
          diagnosticJson: JSON.stringify([1, 2, 3]),
        }),
      );
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-array-json');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.painId).toBeNull();
    });
  });

  // ── listFailedTasks: field correctness ─────────────────────────────────────

  describe('listFailedTasks — field correctness', () => {
    it('returns correct lastError (PDErrorCategory), attemptCount and maxAttempts', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 't-fields',
          status: 'failed',
          lastError: 'capability_missing',
          attemptCount: 3,
          maxAttempts: 3,
        }),
      );
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-fields');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.lastError).toBe('capability_missing');
      expect(found.attemptCount).toBe(3);
      // maxAttempts must round-trip so consumers can detect exhaustion
      // (attemptCount >= maxAttempts) without a per-row detail fetch
      expect(found.maxAttempts).toBe(3);
      expect(found.taskKind).toBe('diagnostician');
      expect(found.createdAt).toBeTruthy();
    });

    it('returns null lastError when not set', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-no-err', status: 'failed' }));
      const results = await store.listFailedTasks();
      const found = results.find((r) => r.taskId === 't-no-err');
      expect(found).toBeDefined();
      if (!found) return;
      expect(found.lastError).toBeNull();
    });
  });

  // ── getFailedTaskDetail ────────────────────────────────────────────────────

  describe('getFailedTaskDetail', () => {
    it('returns task + runs (DESC) + lastError + null pendingAgentDraft', async () => {
      await store.createTask(
        makeTaskInput({
          taskId: 't-detail',
          status: 'failed',
          lastError: 'input_invalid',
          attemptCount: 2,
        }),
      );
      // Create two runs with different started_at
      const oldRun = await runStore.createRun(
        makeRunInput({
          taskId: 't-detail',
          runId: 'run-old',
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          attemptNumber: 1,
        }),
      );
      const newRun = await runStore.createRun(
        makeRunInput({
          taskId: 't-detail',
          runId: 'run-new',
          startedAt: new Date().toISOString(),
          attemptNumber: 2,
        }),
      );
      void oldRun;
      void newRun;

      const detail = await store.getFailedTaskDetail('t-detail');
      expect(detail).not.toBeNull();
      if (!detail) return;

      expect(detail.task.taskId).toBe('t-detail');
      expect(detail.task.status).toBe('failed');
      expect(detail.lastError).toBe('input_invalid');
      expect(detail.pendingAgentDraft).toBeNull();
      // Runs sorted DESC (most recent first)
      expect(detail.runs).toHaveLength(2);
      const [latestRun, earlierRun] = detail.runs;
      if (!latestRun || !earlierRun) {
        throw new Error('expected 2 runs');
      }
      expect(latestRun.runId).toBe('run-new');
      expect(earlierRun.runId).toBe('run-old');
    });

    it('returns task with empty runs array when no runs exist', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-no-runs-detail', status: 'failed' }));
      const detail = await store.getFailedTaskDetail('t-no-runs-detail');
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(detail.runs).toEqual([]);
      expect(detail.task.taskId).toBe('t-no-runs-detail');
    });

    it('returns null for non-existent taskId', async () => {
      const detail = await store.getFailedTaskDetail('does-not-exist');
      expect(detail).toBeNull();
    });

    it('returns null for a succeeded task (wrong status)', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-succeeded', status: 'succeeded' }));
      const detail = await store.getFailedTaskDetail('t-succeeded');
      expect(detail).toBeNull();
    });

    it('returns null for a pending task (wrong status)', async () => {
      await store.createTask(makeTaskInput({ taskId: 't-pending', status: 'pending' }));
      const detail = await store.getFailedTaskDetail('t-pending');
      expect(detail).toBeNull();
    });

    it('returns detail for needs_human_review status', async () => {
      await store.createTask(
        makeTaskInput({ taskId: 't-review-detail', status: 'needs_human_review' }),
      );
      const detail = await store.getFailedTaskDetail('t-review-detail');
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(detail.task.status).toBe('needs_human_review');
    });
  });

  // ── countFailedTasks ───────────────────────────────────────────────────────

  describe('countFailedTasks', () => {
    it('counts all failed + needs_human_review tasks', async () => {
      await store.createTask(makeTaskInput({ taskId: 'c-1', status: 'failed' }));
      await store.createTask(makeTaskInput({ taskId: 'c-2', status: 'needs_human_review' }));
      await store.createTask(makeTaskInput({ taskId: 'c-3', status: 'succeeded' }));
      await store.createTask(makeTaskInput({ taskId: 'c-4', status: 'pending' }));

      const count = await store.countFailedTasks();
      expect(count).toBe(2);
    });

    it('counts zero when no failed tasks', async () => {
      await store.createTask(makeTaskInput({ taskId: 'c-ok', status: 'succeeded' }));
      const count = await store.countFailedTasks();
      expect(count).toBe(0);
    });

    it('counts with kind filter', async () => {
      await store.createTask(makeTaskInput({ taskId: 'c-d1', status: 'failed', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 'c-d2', status: 'failed', taskKind: 'diagnostician' }));
      await store.createTask(makeTaskInput({ taskId: 'c-s1', status: 'failed', taskKind: 'scribe' }));

      const diagCount = await store.countFailedTasks({ kind: 'diagnostician' });
      expect(diagCount).toBe(2);
    });

    it('counts with since filter', async () => {
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

      await store.createTask(makeTaskInput({ taskId: 'c-old', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 'c-old', startedAt: oldTime }));

      await store.createTask(makeTaskInput({ taskId: 'c-recent', status: 'failed' }));
      await runStore.createRun(makeRunInput({ taskId: 'c-recent', startedAt: recentTime }));

      const sinceMs = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const count = await store.countFailedTasks({ since: sinceMs });
      expect(count).toBe(1);
    });

    it('count matches listFailedTasks length', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createTask(makeTaskInput({ taskId: `c-match-${i}`, status: 'failed' }));
      }
      const list = await store.listFailedTasks();
      const count = await store.countFailedTasks();
      expect(count).toBe(list.length);
    });
  });
});
