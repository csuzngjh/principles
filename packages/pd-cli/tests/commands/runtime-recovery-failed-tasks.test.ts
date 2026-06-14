import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDetectFailedTasks = vi.hoisted(() => vi.fn());
const mockRecoverFailedTask = vi.hoisted(() => vi.fn());
const mockServiceClose = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  createRecoverySweepService: vi.fn().mockResolvedValue({
    service: {
      detectFailedTasks: mockDetectFailedTasks,
      recoverFailedTask: mockRecoverFailedTask,
    },
    close: mockServiceClose,
  }),
}));

import { handleRuntimeRecoveryFailedTasks } from '../../src/commands/runtime-recovery-failed-tasks.js';

describe('pd runtime recovery failed-tasks command contract', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectFailedTasks.mockResolvedValue([]);
    mockRecoverFailedTask.mockResolvedValue({
      taskId: 'task-1',
      previousStatus: 'failed',
      newStatus: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      forceApplied: false,
    });
    mockServiceClose.mockResolvedValue(undefined);
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('dry-run JSON does not recover tasks and lists them as would_recover', async () => {
    mockDetectFailedTasks.mockResolvedValue([
      {
        taskId: 'task-1',
        taskKind: 'dreamer',
        attemptCount: 1,
        maxAttempts: 3,
        isExhausted: false,
        status: 'failed',
      },
    ]);

    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: true,
      mode: 'dry_run',
      recoveredCount: 1,
      skippedCount: 0,
    });
    expect(output.tasks[0]).toMatchObject({
      taskId: 'task-1',
      action: 'would_recover',
      reason: expect.stringContaining('attempts remain'),
    });
    expect(mockRecoverFailedTask).not.toHaveBeenCalled();
    expect(mockServiceClose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1); // exitCode 1 on dry-run when tasks are found
  });

  it('confirm JSON reports recovered tasks and mutates state', async () => {
    mockDetectFailedTasks.mockResolvedValue([
      {
        taskId: 'task-1',
        taskKind: 'dreamer',
        attemptCount: 1,
        maxAttempts: 3,
        isExhausted: false,
        status: 'failed',
      },
    ]);

    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: true,
      mode: 'confirm',
      recoveredCount: 1,
      skippedCount: 0,
    });
    expect(output.tasks[0]).toMatchObject({
      taskId: 'task-1',
      action: 'recovered',
    });
    expect(mockRecoverFailedTask).toHaveBeenCalledWith('task-1', undefined);
    expect(mockServiceClose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it('dry-run JSON skips exhausted tasks without force', async () => {
    mockDetectFailedTasks.mockResolvedValue([
      {
        taskId: 'task-exhausted',
        taskKind: 'dreamer',
        attemptCount: 3,
        maxAttempts: 3,
        isExhausted: true,
        status: 'failed',
      },
    ]);

    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: true,
      mode: 'dry_run',
      recoveredCount: 0,
      skippedCount: 1,
    });
    expect(output.tasks[0]).toMatchObject({
      taskId: 'task-exhausted',
      action: 'skipped',
      reason: expect.stringContaining('exhausted max attempts'),
    });
    expect(mockRecoverFailedTask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0); // exitCode 0 since recoveredCount is 0
  });

  it('confirm with force recovers exhausted tasks', async () => {
    mockDetectFailedTasks.mockResolvedValue([
      {
        taskId: 'task-exhausted',
        taskKind: 'dreamer',
        attemptCount: 3,
        maxAttempts: 3,
        isExhausted: true,
        status: 'failed',
      },
    ]);

    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, force: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: true,
      mode: 'confirm',
      recoveredCount: 1,
      skippedCount: 0,
    });
    expect(mockRecoverFailedTask).toHaveBeenCalledWith('task-exhausted', true);
  });

  it('rejects mutual exclusion of dry-run and confirm in JSON mode', async () => {
    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', dryRun: true, confirm: true, json: true });

    expect(mockRecoverFailedTask).not.toHaveBeenCalled();
    expect(mockServiceClose).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: false,
      reason: expect.stringContaining('mutually exclusive'),
    });
  });

  it('confirm JSON handles concurrent task modification gracefully (null result)', async () => {
    mockDetectFailedTasks.mockResolvedValue([
      {
        taskId: 'task-concurrent',
        taskKind: 'dreamer',
        attemptCount: 1,
        maxAttempts: 3,
        isExhausted: false,
        status: 'failed',
      },
    ]);
    mockRecoverFailedTask.mockResolvedValue(null);

    await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      ok: true,
      mode: 'confirm',
      recoveredCount: 0,
      skippedCount: 1,
    });
    expect(output.tasks[0]).toMatchObject({
      taskId: 'task-concurrent',
      action: 'skipped',
      reason: expect.stringContaining('no longer failed or concurrently modified'),
    });
  });
});
