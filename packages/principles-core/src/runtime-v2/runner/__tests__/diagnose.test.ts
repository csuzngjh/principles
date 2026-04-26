/**
 * CLI diagnose module tests.
 *
 * Tests 3 scenarios:
 *   1. run() delegates to DiagnosticianRunner.run() and returns RunnerResult
 *   2. status() returns key TaskRecord fields (taskId, status, attemptCount, maxAttempts, lastError)
 *   3. status() returns null when task does not exist
 */
import { describe, it, expect, vi } from 'vitest';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { DiagnosticianRunner } from '../diagnostician-runner.js';
import type { RunnerResult } from '../runner-result.js';
import type { TaskRecord } from '../../task-status.js';
import { run, status } from '../../cli/diagnose.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-cli-001',
    taskKind: 'diagnostician',
    status: 'succeeded',
    createdAt: '2026-04-23T00:00:00Z',
    updatedAt: '2026-04-23T00:00:00Z',
    attemptCount: 2,
    maxAttempts: 3,
    lastError: undefined,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('cli/diagnose', () => {
  // 1. run() delegates to runner.run()
  it('run() delegates to DiagnosticianRunner.run() and returns RunnerResult', async () => {
    const TASK_ID = 'task-run-001';
    const mockRunnerResult: RunnerResult = {
      status: 'succeeded',
      taskId: TASK_ID,
      contextHash: 'hash123',
      attemptCount: 1,
    };

    const runMock = vi.fn<(taskId: string) => Promise<RunnerResult>>().mockResolvedValue(mockRunnerResult);
    const mockRunner = { run: runMock } as unknown as DiagnosticianRunner;

    const mockStateManager = {} as unknown as RuntimeStateManager;

    const result = await run({ taskId: TASK_ID, runner: mockRunner, stateManager: mockStateManager });

    expect(result).toBe(mockRunnerResult);
    expect(runMock).toHaveBeenCalledWith(TASK_ID);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  // 2. status() returns key TaskRecord fields
  it('status() returns taskId, status, attemptCount, maxAttempts, lastError from TaskRecord', async () => {
    const TASK_ID = 'task-status-001';
    const taskRecord = makeTaskRecord({
      taskId: TASK_ID,
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 5,
      lastError: 'execution_failed',
    });

    const getTaskMock = vi.fn<() => Promise<TaskRecord | null>>().mockResolvedValue(taskRecord);
    const mockStateManager = { getTask: getTaskMock } as unknown as RuntimeStateManager;

    const _mockRunner = {} as unknown as DiagnosticianRunner;

    const result = await status({ taskId: TASK_ID, stateManager: mockStateManager });

    expect(result).toEqual({
      taskId: TASK_ID,
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 5,
      lastError: 'execution_failed',
      commitId: null,
      artifactId: null,
      candidateCount: null,
    });
    expect(getTaskMock).toHaveBeenCalledWith(TASK_ID);
  });

  // 3. status() returns null when task not found
  it('status() returns null when task does not exist', async () => {
    const TASK_ID = 'task-nonexistent';

    const getTaskMock = vi.fn<() => Promise<TaskRecord | null>>().mockResolvedValue(null);
    const mockStateManager = { getTask: getTaskMock } as unknown as RuntimeStateManager;

    const _mockRunner = {} as unknown as DiagnosticianRunner;

    const result = await status({ taskId: TASK_ID, stateManager: mockStateManager });

    expect(result).toBeNull();
    expect(getTaskMock).toHaveBeenCalledWith(TASK_ID);
  });
});
