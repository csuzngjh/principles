/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * SqliteTrajectoryLocator comprehensive test suite.
 *
 * Tests all 6 locate modes (painId, taskId, runId, timeRange,
 * sessionId+workspace, executionStatus) plus not-found edge cases
 * and query echo verification.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteTrajectoryLocator } from './sqlite-trajectory-locator.js';
import type { TrajectoryLocateQuery } from '../context-payload.js';
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

interface RunInputOptions {
  taskId: string;
  attemptNumber?: number;
  startedAt?: string;
  status?: RunExecutionStatus;
}

function makeRunInput(options: RunInputOptions): Omit<RunRecord, 'createdAt' | 'updatedAt'> {
  const now = options.startedAt ?? new Date().toISOString();
  const attempt = options.attemptNumber ?? 1;
  return {
    runId: `run_${options.taskId}_${attempt}`,
    taskId: options.taskId,
    runtimeKind: 'openclaw' as const,
    executionStatus: options.status ?? ('queued' as RunExecutionStatus),
    startedAt: now,
    attemptNumber: attempt,
    
    
  };
}

interface TestFixture {
  conn: SqliteConnection;
  taskStore: SqliteTaskStore;
  runStore: SqliteRunStore;
  locator: SqliteTrajectoryLocator;
}

/** Helper to safely extract the first candidate or fail the test. */
function firstCandidate(result: { candidates: { trajectoryRef: string; confidence: number; reasons: string[]; sourceTypes?: string[] }[] }) {
  const [candidate] = result.candidates;
  expect(candidate).toBeDefined();
  return candidate;
}

/** Create a fresh test fixture with isolated tmp directory and DB. */
function createFixture(): TestFixture {
  const testDir = path.join(
    os.tmpdir(),
    `pd-test-locator-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  const conn = new SqliteConnection(testDir);
  return {
    conn,
    taskStore: new SqliteTaskStore(conn),
    runStore: new SqliteRunStore(conn),
    locator: new SqliteTrajectoryLocator(conn),
  };
}

describe('SqliteTrajectoryLocator', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    }
    tmpDirs.length = 0;
  });

  describe('locate by painId', () => {
    it('returns single candidate with confidence 1.0 for exact match', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-pain-1'));
      await runStore.createRun(makeRunInput({ taskId: 'task-pain-1', attemptNumber: 1 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-pain-1', attemptNumber: 2 }));

      const result = await locator.locate({ painId: 'run_task-pain-1_1' });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-pain-1');
      expect(candidate!.confidence).toBe(1.0);
      expect(candidate!.reasons).toContain('exact_match_on_run_id');
      expect(candidate!.sourceTypes).toContain('runs_table');
    });

    it('returns empty candidates when painId not found', async () => {
      const { locator } = createFixture();
      const result = await locator.locate({ painId: 'nonexistent-pain' });

      expect(result.candidates).toEqual([]);
      expect(result.query.painId).toBe('nonexistent-pain');
    });
  });

  describe('locate by taskId', () => {
    it('returns trajectory with all runs for task', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-direct-1'));
      await runStore.createRun(makeRunInput({ taskId: 'task-direct-1', attemptNumber: 1 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-direct-1', attemptNumber: 2 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-direct-1', attemptNumber: 3 }));

      const result = await locator.locate({ taskId: 'task-direct-1' });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-direct-1');
      expect(candidate!.confidence).toBe(1.0);
      expect(candidate!.reasons).toContain('task_id_lookup');
    });

    it('returns empty candidates when taskId not found', async () => {
      const { locator } = createFixture();
      const result = await locator.locate({ taskId: 'nonexistent-task' });

      expect(result.candidates).toEqual([]);
    });
  });

  describe('locate by runId', () => {
    it('finds containing trajectory via runId->taskId', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-runid-1'));
      await runStore.createRun(makeRunInput({ taskId: 'task-runid-1', attemptNumber: 1 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-runid-1', attemptNumber: 2 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-runid-1', attemptNumber: 3 }));

      // Query by the second run -- should return trajectory for the whole task
      const result = await locator.locate({ runId: 'run_task-runid-1_2' });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-runid-1');
      expect(candidate!.confidence).toBe(0.95);
      expect(candidate!.reasons).toContain('run_id_to_task_id');
    });

    it('returns empty candidates when runId not found', async () => {
      const { locator } = createFixture();
      const result = await locator.locate({ runId: 'nonexistent-run' });

      expect(result.candidates).toEqual([]);
    });
  });

  describe('locate by timeRange', () => {
    const timeA = '2026-04-20T10:00:00.000Z';
    const timeB = '2026-04-21T10:00:00.000Z';
    const timeC = '2026-04-22T10:00:00.000Z';

    it('returns candidates for runs within date range', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-time-in'));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-in', attemptNumber: 1, startedAt: timeA }));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-in', attemptNumber: 2, startedAt: timeB }));

      await taskStore.createTask(makeTaskInput('task-time-out'));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-out', attemptNumber: 1, startedAt: timeC }));

      const result = await locator.locate({
        timeRange: { start: timeA, end: timeB },
      });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-time-in');
      expect(candidate!.confidence).toBe(0.7);
      expect(candidate!.reasons).toContain('date_range_match');
    });

    it('groups multiple runs for same task into single candidate', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-time-multi'));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-multi', attemptNumber: 1, startedAt: timeA }));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-multi', attemptNumber: 2, startedAt: timeB }));

      const result = await locator.locate({
        timeRange: { start: timeA, end: timeB },
      });

      // Same task, two runs -- single candidate
      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-time-multi');
    });

    it('returns empty candidates when no runs in range', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-time-none'));
      await runStore.createRun(makeRunInput({ taskId: 'task-time-none', attemptNumber: 1, startedAt: timeC }));

      const result = await locator.locate({
        timeRange: { start: timeA, end: timeB },
      });

      expect(result.candidates).toEqual([]);
    });
  });

  describe('locate by sessionId (workspace-scoped)', () => {
    it('returns candidates with confidence 0.5', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-session-1'));
      await runStore.createRun(makeRunInput({ taskId: 'task-session-1', attemptNumber: 1 }));

      await taskStore.createTask(makeTaskInput('task-session-2'));
      await runStore.createRun(makeRunInput({ taskId: 'task-session-2', attemptNumber: 1 }));

      const result = await locator.locate({
        sessionId: 'session-abc',
        workspace: '/path/to/workspace',
      });

      expect(result.candidates.length).toBe(2);
      // Both should have low confidence since sessionId is not a real column
      for (const candidate of result.candidates) {
        expect(candidate.confidence).toBe(0.5);
        expect(candidate.reasons).toContain('session_hint_workspace_scoped');
      }
    });
  });

  describe('locate by executionStatus (stretch)', () => {
    it('returns candidates filtered by status', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-status-ok'));
      await runStore.createRun(makeRunInput({ taskId: 'task-status-ok', attemptNumber: 1, status: 'succeeded' }));

      await taskStore.createTask(makeTaskInput('task-status-fail'));
      await runStore.createRun(makeRunInput({ taskId: 'task-status-fail', attemptNumber: 1, status: 'failed' }));

      const result = await locator.locate({ executionStatus: 'failed' });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-status-fail');
      expect(candidate!.confidence).toBe(0.8);
      expect(candidate!.reasons).toContain('status_filter');
    });

    it('returns empty candidates when no runs match status', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-status-only-ok'));
      await runStore.createRun(makeRunInput({ taskId: 'task-status-only-ok', attemptNumber: 1, status: 'succeeded' }));

      const result = await locator.locate({ executionStatus: 'failed' });

      expect(result.candidates).toEqual([]);
    });
  });

  describe('locate with no matching criteria', () => {
    it('returns empty candidates when query has no supported fields', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-no-criteria'));
      await runStore.createRun(makeRunInput({ taskId: 'task-no-criteria', attemptNumber: 1 }));

      // Only workspace set -- no routing criteria matched
      const result = await locator.locate({ workspace: '/some/path' });

      expect(result.candidates).toEqual([]);
    });

    it('returns empty candidates for empty query', async () => {
      const { locator } = createFixture();
      const result = await locator.locate({});

      expect(result.candidates).toEqual([]);
    });
  });

  describe('query echo', () => {
    it('echoes back original query in result', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-echo'));
      await runStore.createRun(makeRunInput({ taskId: 'task-echo', attemptNumber: 1 }));

      const query: TrajectoryLocateQuery = {
        taskId: 'task-echo',
        workspace: '/test',
      };
      const result = await locator.locate(query);

      expect(result.query).toEqual(query);
    });

    it('echoes back query even when no results found', async () => {
      const { locator } = createFixture();
      const query: TrajectoryLocateQuery = { painId: 'nonexistent' };
      const result = await locator.locate(query);

      expect(result.query).toEqual(query);
      expect(result.candidates).toEqual([]);
    });
  });

  describe('multi-run task returns single trajectoryRef', () => {
    it('groups all runs for a task into one candidate', async () => {
      const { taskStore, runStore, locator } = createFixture();
      await taskStore.createTask(makeTaskInput('task-multi-ref'));
      await runStore.createRun(makeRunInput({ taskId: 'task-multi-ref', attemptNumber: 1 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-multi-ref', attemptNumber: 2 }));
      await runStore.createRun(makeRunInput({ taskId: 'task-multi-ref', attemptNumber: 3 }));

      const result = await locator.locate({ taskId: 'task-multi-ref' });

      expect(result.candidates.length).toBe(1);
      const candidate = firstCandidate(result);
      expect(candidate!.trajectoryRef).toBe('task-multi-ref');
    });
  });
});
