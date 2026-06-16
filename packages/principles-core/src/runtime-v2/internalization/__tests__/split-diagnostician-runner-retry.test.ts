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
