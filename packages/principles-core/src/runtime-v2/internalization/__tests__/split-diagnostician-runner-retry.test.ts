/**
 * ERR-067 fix: SplitDiagnosticianRunner retry chain tests.
 *
 * Verifies that when a sub-runner returns `retried`, the orchestrator
 * waits for backoff and re-runs the stage instead of treating it as failure.
 *
 * ERR entries considered:
 *   - ERR-067: Orchestrator treats `retried` status as failure
 *   - ERR-009: Required fields must fail loud
 *   - ERR-015: Retry/repair loops must distinguish current/next/recorded state
 */
import { describe, it, expect, vi } from 'vitest';
import type { PeerRunnerResult } from '../../runner/peer-runner-types.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import { SplitDiagnosticianRunner } from '../split-diagnostician-runner.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { TaskRecord } from '../../task-status.js';
import type { RetryPolicy } from '../../store/lifecycle/retry-policy.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PARENT_TASK_ID = 'diagnosis_pain-err067';
const STAGE_A_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
const STAGE_B_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;
const STAGE_C_TASK_ID = `diag_router-${PARENT_TASK_ID}`;

function makeTask(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    inputRef: PARENT_TASK_ID,
    diagnosticJson: '{}',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSucceededResult<T>(taskId: string): PeerRunnerResult<T> {
  return { status: 'succeeded', taskId, attemptCount: 1 };
}

function makeRetriedResult<T>(taskId: string, failureReason: string): PeerRunnerResult<T> {
  return { status: 'retried', taskId, errorCategory: 'output_invalid', failureReason, attemptCount: 1 };
}

function makeFailedResult<T>(taskId: string, failureReason: string): PeerRunnerResult<T> {
  return { status: 'failed', taskId, errorCategory: 'output_invalid', failureReason, attemptCount: 3 };
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMockStateManager(tasks: Record<string, TaskRecord> = {}) {
  return {
    getTask: vi.fn().mockImplementation((id: string) => {
      return Promise.resolve(tasks[id] ?? null);
    }),
    createTask: vi.fn().mockImplementation((record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => {
      const task: TaskRecord = {
        ...record,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks[record.taskId] = task;
      return Promise.resolve(task);
    }),
    updateTask: vi.fn().mockImplementation((taskId: string, patch: Partial<TaskRecord>) => {
      if (tasks[taskId]) {
        Object.assign(tasks[taskId], patch);
      }
      return Promise.resolve(true);
    }),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({
      shouldRetry: () => true,
      calculateBackoff: () => 10, // 10ms for fast tests
      markRetryWait: vi.fn().mockResolvedValue({ taskId: '', errorCategory: 'output_invalid' }),
      markFailed: vi.fn().mockResolvedValue({ taskId: '', errorCategory: 'output_invalid' }),
    } satisfies RetryPolicy),
    getRunsByTask: vi.fn().mockResolvedValue([]),
    acquireLease: vi.fn().mockImplementation((params: { taskId: string }) => {
      const task = tasks[params.taskId];
      return task ? Promise.resolve(task) : Promise.resolve(undefined);
    }),
  };
}

function makeMockRunner<T>() {
  return {
    run: vi.fn().mockResolvedValue(makeSucceededResult<T>('')),
  };
}

function makeMockCommitter() {
  return {
    commit: vi.fn().mockResolvedValue({ commitId: 'commit-1', artifactId: 'art-1' } as const),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ERR-067: SplitDiagnosticianRunner retry chain', () => {
  it('should retry Stage A when sub-runner returns retried, then succeed', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const distillerRunner = makeMockRunner<DiagDistillerOutputV1>();
    const routerRunner = makeMockRunner<DiagnosticianOutputV1>();

    // Stage A: first call returns retried, second call succeeds
    rootCauseRunner.run
      .mockResolvedValueOnce(makeRetriedResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID, 'Schema validation failed'))
      .mockResolvedValueOnce(makeSucceededResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: distillerRunner as never,
      routerRunner: routerRunner as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(rootCauseRunner.run).toHaveBeenCalledTimes(2);
  });

  it('should retry Stage A multiple times, then fail after max attempts', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();

    // Stage A: always returns retried (simulates persistent schema failure)
    rootCauseRunner.run.mockResolvedValue(
      makeRetriedResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID, 'Schema validation failed'),
    );

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    expect(rootCauseRunner.run.mock.calls.length).toBeGreaterThan(1);
  });

  it('should NOT reset attemptCount when transitioning retry_wait task to pending', async () => {
    const tasks: Record<string, TaskRecord> = {
      [STAGE_A_TASK_ID]: makeTask(STAGE_A_TASK_ID, {
        status: 'retry_wait',
        attemptCount: 2,
        lastError: 'output_invalid',
      }),
    };
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();

    rootCauseRunner.run.mockResolvedValue(makeSucceededResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    await runner.run(PARENT_TASK_ID);

    // Verify updateTask was called WITHOUT attemptCount: 0
    const updateCalls = stateManager.updateTask.mock.calls;
    const stageAUpdate = updateCalls.find((c: unknown[]) => c[0] === STAGE_A_TASK_ID);
    if (stageAUpdate) {
      const patch = stageAUpdate[1] as Partial<TaskRecord>;
      expect(patch).not.toHaveProperty('attemptCount', 0);
    }
  });

  it('should retry Stage B when sub-runner returns retried', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const distillerRunner = makeMockRunner<DiagDistillerOutputV1>();
    const routerRunner = makeMockRunner<DiagnosticianOutputV1>();

    // Stage A: succeeds immediately
    rootCauseRunner.run.mockResolvedValue(makeSucceededResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID));

    // Stage B: first call retried, second call succeeds
    distillerRunner.run
      .mockResolvedValueOnce(makeRetriedResult<DiagDistillerOutputV1>(STAGE_B_TASK_ID, 'Schema validation failed'))
      .mockResolvedValueOnce(makeSucceededResult<DiagDistillerOutputV1>(STAGE_B_TASK_ID));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: distillerRunner as never,
      routerRunner: routerRunner as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(distillerRunner.run).toHaveBeenCalledTimes(2);
  });

  it('should retry Stage C when sub-runner returns retried', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const distillerRunner = makeMockRunner<DiagDistillerOutputV1>();
    const routerRunner = makeMockRunner<DiagnosticianOutputV1>();

    // Stages A and B: succeed immediately
    rootCauseRunner.run.mockResolvedValue(makeSucceededResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID));
    distillerRunner.run.mockResolvedValue(makeSucceededResult<DiagDistillerOutputV1>(STAGE_B_TASK_ID));

    // Stage C: first call retried, second call succeeds
    routerRunner.run
      .mockResolvedValueOnce(makeRetriedResult<DiagnosticianOutputV1>(STAGE_C_TASK_ID, 'Schema validation failed'))
      .mockResolvedValueOnce(makeSucceededResult<DiagnosticianOutputV1>(STAGE_C_TASK_ID));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: distillerRunner as never,
      routerRunner: routerRunner as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(routerRunner.run).toHaveBeenCalledTimes(2);
  });

  it('should return failed when sub-runner returns failed (not retried)', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();

    // Stage A: returns failed (not retried) — should not retry
    rootCauseRunner.run.mockResolvedValue(
      makeFailedResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID, 'Max attempts exceeded'),
    );

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    expect(rootCauseRunner.run).toHaveBeenCalledTimes(1);
  });
});

// ── Bug-N fix: parent task lease acquisition ─────────────────────────────────
//
// Bug-N: SplitDiagnosticianRunner marked parent task succeeded but had no
// corresponding run record (8 diagnosis_manual_* tasks hit this in production).
// Fix: call acquireLease on the parent task at the start of run() so the
// runs table has a record to update when markTaskSucceeded is called.
//
// ERR entries considered:
//   - ERR-009/ERR-010: fail loud on missing required state — lease failure must surface, not silently skip
//   - ERR-015/ERR-018/ERR-019: stale loop state — without lease, markTaskSucceeded silently no-ops on runs
//   - ERR-002: silent degradation — lease_conflict must be observable, not swallowed

describe('Bug-N: SplitDiagnosticianRunner parent task lease acquisition', () => {
  it('should call acquireLease on parent task at the start of run()', async () => {
    const tasks: Record<string, TaskRecord> = {
      [PARENT_TASK_ID]: makeTask(PARENT_TASK_ID, { taskKind: 'diagnostician', status: 'pending' }),
    };
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const distillerRunner = makeMockRunner<DiagDistillerOutputV1>();
    const routerRunner = makeMockRunner<DiagnosticianOutputV1>();

    rootCauseRunner.run.mockResolvedValue(makeSucceededResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID));
    distillerRunner.run.mockResolvedValue(makeSucceededResult<DiagDistillerOutputV1>(STAGE_B_TASK_ID));
    routerRunner.run.mockResolvedValue(makeSucceededResult<DiagnosticianOutputV1>(STAGE_C_TASK_ID));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: distillerRunner as never,
      routerRunner: routerRunner as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('succeeded');
    // Bug-N core assertion: acquireLease must be called with the parent task ID
    expect(stateManager.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: PARENT_TASK_ID,
        owner: 'split-diagnostician-orchestrator',
        runtimeKind: 'openclaw',
      }),
    );
    // markTaskSucceeded must be called for the parent task
    expect(stateManager.markTaskSucceeded).toHaveBeenCalledWith(PARENT_TASK_ID, expect.any(String));
  });

  it('should return failed with lease_conflict when parent task is already leased', async () => {
    const tasks: Record<string, TaskRecord> = {
      [PARENT_TASK_ID]: makeTask(PARENT_TASK_ID, { taskKind: 'diagnostician', status: 'leased' }),
    };
    const stateManager = makeMockStateManager(tasks);
    // Override acquireLease to throw lease_conflict (matches real DefaultLeaseManager behavior)
    stateManager.acquireLease = vi.fn().mockRejectedValue(
      new PDRuntimeError('lease_conflict', `Task ${PARENT_TASK_ID} is leased, expected pending/retry_wait`),
    );

    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(result.failureReason).toContain(PARENT_TASK_ID);
    // Sub-runners must NOT be called when lease acquisition fails (non-mutating)
    expect(rootCauseRunner.run).not.toHaveBeenCalled();
    // Mutation methods must NOT be called for lease_conflict
    expect(stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('should return failed with execution_failed when acquireLease throws non-lease error', async () => {
    const tasks: Record<string, TaskRecord> = {};
    const stateManager = makeMockStateManager(tasks);
    // Override acquireLease to throw storage_unavailable (task doesn't exist)
    stateManager.acquireLease = vi.fn().mockRejectedValue(
      new PDRuntimeError('storage_unavailable', `Task not found: ${PARENT_TASK_ID}`),
    );

    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('execution_failed');
    expect(result.failureReason).toContain('storage_unavailable');
    // Sub-runners must NOT be called
    expect(rootCauseRunner.run).not.toHaveBeenCalled();
  });

  it('should propagate sub-stage failure correctly even with parent lease acquired', async () => {
    // Regression: ensure acquireLease change does not affect error propagation
    const tasks: Record<string, TaskRecord> = {
      [PARENT_TASK_ID]: makeTask(PARENT_TASK_ID, { taskKind: 'diagnostician', status: 'pending' }),
    };
    const stateManager = makeMockStateManager(tasks);
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();

    // Stage A fails — should propagate as parent failure
    rootCauseRunner.run.mockResolvedValue(
      makeFailedResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID, 'Stage A failed'),
    );

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result.status).toBe('failed');
    // Parent task must be marked failed (via failParent helper)
    expect(stateManager.markTaskFailed).toHaveBeenCalledWith(PARENT_TASK_ID, expect.any(String));
  });
});

// ── Terminal-state persistence must fail loud ─────────────────────────────
//
// ERR entries considered:
//   - ERR-002: never silently degrade when a required state transition fails
//   - ERR-015/ERR-018/ERR-019: report the current terminal-state failure, not
//     the earlier stage result, so callers do not mistake a leased task for a
//     completed one
//   - ERR-025: exercise the runner's RuntimeStateManager boundary directly
//   - ERR-088: assert the specific storage failure rather than only `failed`

describe('SplitDiagnosticianRunner terminal-state persistence', () => {
  it('reports storage_unavailable when it cannot persist a failed parent terminal state', async () => {
    const tasks: Record<string, TaskRecord> = {
      [PARENT_TASK_ID]: makeTask(PARENT_TASK_ID, { taskKind: 'diagnostician', status: 'pending' }),
    };
    const stateManager = makeMockStateManager(tasks);
    stateManager.markTaskFailed = vi.fn().mockRejectedValue(new Error('database write failed'));
    const rootCauseRunner = makeMockRunner<DiagRootCauseOutputV1>();
    rootCauseRunner.run.mockResolvedValue(
      makeFailedResult<DiagRootCauseOutputV1>(STAGE_A_TASK_ID, 'Root-cause output was invalid'),
    );

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: rootCauseRunner as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result).toMatchObject({
      status: 'failed',
      taskId: PARENT_TASK_ID,
      errorCategory: 'storage_unavailable',
    });
    expect(result.failureReason).toContain('failed to persist parent task failure');
    // ERR-088: assert the injected persistence error is surfaced, not just a
    // generic banner — a future refactor that drops the persist error message
    // must fail this test.
    expect(result.failureReason).toContain('database write failed');
    // ERR-015/ERR-088: the original stage outcome must be preserved in the
    // reason so operators can see why the stage failed AND why it stuck.
    expect(result.failureReason).toContain('Root-cause output was invalid');
    expect(result.failureReason).toContain('Original stage outcome: output_invalid');
  });

  it('does not report success when it cannot persist a succeeded parent terminal state', async () => {
    const tasks: Record<string, TaskRecord> = {
      [PARENT_TASK_ID]: makeTask(PARENT_TASK_ID, { taskKind: 'diagnostician', status: 'pending' }),
    };
    const stateManager = makeMockStateManager(tasks);
    stateManager.markTaskSucceeded = vi.fn().mockRejectedValue(new Error('database write failed'));

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner: makeMockRunner<DiagRootCauseOutputV1>() as never,
      distillerRunner: makeMockRunner<DiagDistillerOutputV1>() as never,
      routerRunner: makeMockRunner<DiagnosticianOutputV1>() as never,
      stateManager: stateManager as never,
      committer: makeMockCommitter(),
      perStageTimeoutMs: 30_000,
    });

    const result = await runner.run(PARENT_TASK_ID);

    expect(result).toMatchObject({
      status: 'failed',
      taskId: PARENT_TASK_ID,
      errorCategory: 'storage_unavailable',
    });
    expect(result.failureReason).toContain('failed to persist parent task success');
    // ERR-088: assert the injected persistence error is surfaced.
    expect(result.failureReason).toContain('database write failed');
  });
});
