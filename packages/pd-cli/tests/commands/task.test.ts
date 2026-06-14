import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTask = vi.hoisted(() => vi.fn());
const mockGetRunsByTask = vi.hoisted(() => vi.fn());
const mockInitialize = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@principles/core')>();
  return {
    ...original,
    RuntimeStateManager: vi.fn().mockImplementation(function() {
      return {
        initialize: mockInitialize,
        getTask: mockGetTask,
        getRunsByTask: mockGetRunsByTask,
        close: mockClose,
      };
    }),
  };
});

import { handleTaskShow } from '../../src/commands/task.js';
import { MalformedRunError } from '@principles/core';

describe('pd task show command handler', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockGetTask.mockResolvedValue({
      taskId: 'task-123',
      taskKind: 'dreamer',
      status: 'failed',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    mockGetRunsByTask.mockResolvedValue([
      {
        runId: 'run-1',
        executionStatus: 'failed',
        attemptNumber: 1,
        startedAt: Date.now(),
      },
    ]);
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('happy path JSON mode prints task and runs, exit code 0', async () => {
    await handleTaskShow({ id: 'task-123', json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      task: { taskId: 'task-123' },
      runs: [{ runId: 'run-1' }],
    });
    expect(process.exitCode).toBe(0);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('task not found JSON mode prints ok: false and exits with non-zero code', async () => {
    mockGetTask.mockResolvedValue(null);

    await handleTaskShow({ id: 'nonexistent-task', json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Task not found'),
      nextAction: expect.any(String),
    });
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('degraded JSON mode prints ok: false, lists degraded runs, and sets exitCode to 1', async () => {
    const malformedError = new MalformedRunError('Malformed schema', [
      {
        runId: 'run-valid',
        executionStatus: 'succeeded',
        attemptNumber: 1,
        startedAt: Date.now(),
      } as any,
    ], [
      {
        runId: 'run-bad',
        error: 'runtimeKind missing',
        rawRow: {},
      },
    ]);

    mockGetRunsByTask.mockRejectedValue(malformedError);

    await handleTaskShow({ id: 'task-123', json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: false,
      task: { taskId: 'task-123' },
      runs: [{ runId: 'run-valid' }],
      degradedRuns: [{ runId: 'run-bad', error: 'runtimeKind missing' }],
      reason: expect.stringContaining('Malformed schema'),
      nextAction: expect.stringContaining('integrity-repair'),
    });
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('degraded text mode prints warning and sets exitCode to 1', async () => {
    const malformedError = new MalformedRunError('Malformed schema', [
      {
        runId: 'run-valid',
        executionStatus: 'succeeded',
        attemptNumber: 1,
        startedAt: Date.now(),
      } as any,
    ], [
      {
        runId: 'run-bad',
        error: 'runtimeKind missing',
        rawRow: {},
      },
    ]);

    mockGetRunsByTask.mockRejectedValue(malformedError);

    await handleTaskShow({ id: 'task-123', json: false });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Task: task-123'));
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
