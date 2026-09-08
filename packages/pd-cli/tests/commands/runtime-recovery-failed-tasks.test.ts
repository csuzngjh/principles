import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDetectFailedTasks = vi.hoisted(() => vi.fn());
const mockRecoverFailedTask = vi.hoisted(() => vi.fn());
const mockServiceClose = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  // Keep the real kind guards (isPeerRunnerKind / isDiagnosticianStageKind):
  // the per-kind execution guidance under test must exercise the actual
  // classification, not a test-local reimplementation. Only the I/O-bearing
  // service factory is replaced.
  const actual = await importOriginal<typeof import('@principles/core/runtime-v2')>();
  return {
    ...actual,
    createRecoverySweepService: vi.fn().mockResolvedValue({
      service: {
        detectFailedTasks: mockDetectFailedTasks,
        recoverFailedTask: mockRecoverFailedTask,
      },
      close: mockServiceClose,
    }),
  };
});

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
        inputRef: null,
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

  // ── PRI-674 review P2: per-kind execution guidance ────────────────────────
  // Guidance must name commands that actually support the task kind:
  // internalization → run-once; diagnostician parent / diag_* stage → diagnose run.

  describe('per-kind execution nextAction (review P2)', () => {
    it('diagnostician parent task points at pd diagnose run', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'diagnosis_pain-001', taskKind: 'diagnostician', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: 'pain-001' },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const nextAction: string = output.tasks[0].nextAction;
      expect(nextAction).toContain('pd diagnose run --task-id diagnosis_pain-001');
      expect(nextAction).not.toContain('internalization run-once');
      // Summary must not claim a single internalization command executes everything
      expect(output.nextAction).toContain('pd diagnose run');
      expect(output.nextAction).not.toContain('run-once to execute recovered tasks');
    });

    it('diag_* stage task resolves parent from inputRef linkage', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'diag_rootcause-diagnosis_pain-001', taskKind: 'diag_rootcause', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: 'diagnosis_pain-001' },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const nextAction: string = output.tasks[0].nextAction;
      expect(nextAction).toContain('diagnosis_pain-001');
      expect(nextAction).toContain('pd diagnose run --task-id diagnosis_pain-001');
      expect(nextAction).not.toContain('run-once');
    });

    it('diag_* stage task falls back to diag_<stage>-<parent> ID convention when inputRef is null', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'diag_router-diagnosis_pain-007', taskKind: 'diag_router', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: null },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const nextAction: string = output.tasks[0].nextAction;
      expect(nextAction).toContain('diagnosis_pain-007');
      expect(nextAction).toContain('pd diagnose run --task-id diagnosis_pain-007');
    });

    it('diag_* stage task with no inputRef and non-conventional ID reports unresolved parent instead of a guessed command', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'weird-stage-id', taskKind: 'diag_distiller', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: null },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const nextAction: string = output.tasks[0].nextAction;
      expect(nextAction).toContain('could not be resolved');
      expect(nextAction).toContain('pd diagnose status --task-id weird-stage-id');
      expect(nextAction).not.toContain('pd diagnose run --task-id');
      expect(nextAction).not.toContain('run-once');
    });

    it('internalization task points at run-once with its runner kind', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'pi-task-1', taskKind: 'scribe', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: null },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      const nextAction: string = output.tasks[0].nextAction;
      expect(nextAction).toContain('pd runtime internalization run-once --runner scribe');
      expect(nextAction).not.toContain('pd diagnose run');
    });

    it('mixed recovery summary splits guidance per executor instead of one command for all', async () => {
      mockDetectFailedTasks.mockResolvedValue([
        { taskId: 'diagnosis_pain-001', taskKind: 'diagnostician', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: 'pain-001' },
        { taskId: 'diag_rootcause-diagnosis_pain-001', taskKind: 'diag_rootcause', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: 'diagnosis_pain-001' },
        { taskId: 'pi-task-1', taskKind: 'dreamer', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: null },
        { taskId: 'pi-task-2', taskKind: 'rollout_reviewer', attemptCount: 1, maxAttempts: 3, isExhausted: false, status: 'failed', inputRef: null },
      ]);

      await handleRuntimeRecoveryFailedTasks({ workspace: '/fake/workspace', confirm: true, json: true });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.recoveredCount).toBe(4);
      const summary: string = output.nextAction;
      expect(summary).toContain('diagnostician parent task(s) (diagnosis_pain-001)');
      expect(summary).toContain('pd diagnose run --task-id <taskId>');
      expect(summary).toContain('diag_* stage task(s)');
      expect(summary).toContain('internalization task(s) (pi-task-1, pi-task-2)');
      expect(summary).toContain('run-once --runner <kind>');
      // No stale single-command claim
      expect(summary).not.toContain('Run pd runtime internalization run-once to execute recovered tasks');
    });

    it('guidance matches real command registrations (help wiring contract)', async () => {
      // cli-7-test-wiring: the commands we recommend must actually be
      // registered with the flags we name. Check the built CLI's help.
      const { execFileSync } = await import('node:child_process');
      const { getBuiltPdCliPath } = await import('../helpers/pd-cli-path.js');
      const cliPath = getBuiltPdCliPath();

      const diagnoseHelp = execFileSync('node', [cliPath, 'diagnose', 'run', '--help'], { encoding: 'utf8' });
      expect(diagnoseHelp).toContain('--task-id');
      expect(diagnoseHelp).toContain('--workspace');

      const runOnceHelp = execFileSync('node', [cliPath, 'runtime', 'internalization', 'run-once', '--help'], { encoding: 'utf8' });
      expect(runOnceHelp).toContain('--runner');
      // run-once must NOT advertise diagnostician support: the supported list
      // comes from SUPPORTED_RUNNERS (peer runners only)
      expect(runOnceHelp).toMatch(/dreamer/);
      expect(runOnceHelp).not.toMatch(/diag_|diagnostician/);
    });
  });
});
