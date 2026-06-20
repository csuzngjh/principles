import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mockInitialize = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockGetCandidate = vi.hoisted(() => vi.fn());
const mockGetTask = vi.hoisted(() => vi.fn());
const mockCreateTask = vi.hoisted(() => vi.fn());
const mockUpdateTaskDiagnosticJson = vi.hoisted(() => vi.fn());
const mockPrepareAll = vi.hoisted(() => vi.fn());
const mockPrepareRun = vi.hoisted(() => vi.fn());
const mockRuntimeStateManagerOpts = vi.hoisted(() => vi.fn());
const mockIntake = vi.hoisted(() => vi.fn());
const mockExistsForCandidate = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn((workspace?: string) => workspace ?? '/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () {
      return {
        intake: mockIntake,
        existsForCandidate: mockExistsForCandidate,
      };
    }),
    RuntimeStateManager: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
      mockRuntimeStateManagerOpts(opts);
      return {
        initialize: mockInitialize,
        close: mockClose,
        getCandidate: mockGetCandidate,
        getTask: mockGetTask,
        createTask: mockCreateTask,
        updateTaskDiagnosticJson: mockUpdateTaskDiagnosticJson,
        connection: {
          getDb: () => ({
            prepare: (sql: string) => ({ all: () => mockPrepareAll(sql), get: vi.fn(), run: () => mockPrepareRun(sql) }),
          }),
        },
      };
    }),
    CandidateIntakeService: vi.fn().mockImplementation(function () {
      return { intake: mockIntake };
    }),
    CandidateIntakeError: class CandidateIntakeError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'CandidateIntakeError';
      }
    },
    decideInternalizationRoute: vi.fn(() => ({
      ready: true,
      route: 'principle-ledger',
      reason: 'ready',
      missingFields: [],
      nextAction: 'internalize',
    })),
    computeBridgeDecision: vi.fn(() => ({
      decision: 'seeded',
      taskId: 'dreamer-cand-1-prompt',
      channel: 'prompt',
    })),
    buildDreamerTaskSeed: vi.fn(() => ({
      taskId: 'dreamer-cand-1-prompt',
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: '{}',
    })),
    createRemediationResult: vi.fn((input: { mode: string; status?: string; safeToConfirm?: boolean; repairedCount?: number; skippedCount?: number; actions?: unknown[]; warnings?: unknown[] }) => ({
      mode: input.mode,
      status: input.status ?? (input.mode === 'dry_run'
        ? ((input.actions?.length ?? 0) > 0 ? 'would_change' : 'no_op')
        : ((input.repairedCount ?? 0) > 0 ? 'changed' : 'no_op')),
      safeToConfirm: input.safeToConfirm ?? false,
      repairedCount: input.repairedCount ?? 0,
      skippedCount: input.skippedCount ?? 0,
      actions: input.actions ?? [],
      warnings: input.warnings ?? [],
    })),
    remediationAction: vi.fn((input: unknown) => input),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  };
});

import { handleCandidateInternalizationBackfill } from '../../src/commands/candidate.js';

function createBackfillTestProgram(): Command {
  const program = new Command();
  program.exitOverride();

  const candidateCmd = program.command('candidate');
  const internalizationCmd = candidateCmd.command('internalization');

  internalizationCmd
    .command('backfill')
    .description('Backfill dreamer tasks for consumed candidates')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Report only, no modifications (default)')
    .option('--confirm', 'Actually create missing dreamer tasks')
    .option('--include-pending', 'Include pending candidates (intake first, then seed dreamer)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      await handleCandidateInternalizationBackfill({
        workspace: opts.workspace,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
        includePending: opts.includePending,
        json: opts.json,
      });
    });

  return program;
}

const WS = '/fake/workspace';

function setupDefaultMocks(): void {
  mockInitialize.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockPrepareAll.mockImplementation((sql: string) => {
    if (sql.includes("'consumed'")) return [{ candidate_id: 'cand-consumed-1' }];
    if (sql.includes("'pending'")) return [];
    return [];
  });
  mockPrepareRun.mockReturnValue({ changes: 1 });
  mockGetCandidate.mockImplementation((id: string) =>
    Promise.resolve({
      candidateId: id,
      taskId: `diag-task-${id}`,
      description: `candidate ${id}`,
      sourceRecommendationJson: JSON.stringify({ kind: 'principle', description: `candidate ${id}` }),
    }),
  );
  // PRI-435: getTask must return a diagnostician task with sourcePainId when called
  // with candidate.taskId (diag-task-*), and null for dreamer task lookups.
  mockGetTask.mockImplementation((taskId: string) => {
    if (taskId.startsWith('diag-task-')) {
      return Promise.resolve({
        taskId,
        taskKind: 'diagnostician',
        status: 'completed',
        diagnosticJson: JSON.stringify({ sourcePainId: `pain-${taskId}` }),
      });
    }
    // Dreamer task lookup → null (no existing dreamer task)
    return Promise.resolve(null);
  });
  mockCreateTask.mockImplementation((input: { taskId: string }) =>
    Promise.resolve({ taskId: input.taskId }),
  );
  mockIntake.mockResolvedValue({ id: 'ledger-entry-1' });
  mockExistsForCandidate.mockReturnValue(null);
}

describe('pd candidate internalization backfill', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('default (no --include-pending) only processes consumed candidates', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [{ candidate_id: 'cand-consumed-1' }];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.totalConsumed).toBe(1);
    expect(output.details.totalPending).toBe(0);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0].candidateId).toBe('cand-consumed-1');
  });

  it('--include-pending --dry-run discovers pending candidates but zero mutation', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.totalConsumed).toBe(0);
    expect(output.details.totalPending).toBe(1);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-pending-1',
      status: 'would_intake_and_create',
      statusBefore: 'pending',
      statusAfter: 'pending',
      intakeDecision: 'would_intake',
      seedDecision: 'would_seed',
    });
    expect(mockIntake).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('--include-pending --confirm: pending -> intake -> seed dreamer', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.intakeSucceeded).toBe(1);
    expect(output.details.created).toBe(1);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-pending-1',
      status: 'created',
      statusBefore: 'pending',
      statusAfter: 'consumed',
      intakeDecision: 'intake_succeeded',
      seedDecision: 'seeded',
    });
    expect(mockIntake).toHaveBeenCalledWith('cand-pending-1');
    expect(mockCreateTask).toHaveBeenCalled();
  });

  it('intake failure: no seed, no fake consumed, returns reason/nextAction', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });
    mockIntake.mockRejectedValue(new Error('Artifact not found for candidate'));

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.intakeFailed).toBe(1);
    expect(output.details.created).toBe(0);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-pending-1',
      status: 'intake_failed',
      statusBefore: 'pending',
      statusAfter: 'pending',
      intakeDecision: 'intake_failed',
      seedDecision: 'skipped',
      nextAction: 'Fix intake issue and re-run backfill',
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('duplicate confirm: no duplicate dreamer task (idempotent)', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });
    // PRI-435: getTask returns diagnostician task for diag-task-* lookups,
    // and dreamer task for dreamer-cand-* lookups (testing idempotency).
    mockGetTask.mockImplementation((taskId: string) => {
      if (taskId.startsWith('diag-task-')) {
        return Promise.resolve({
          taskId,
          taskKind: 'diagnostician',
          status: 'completed',
          diagnosticJson: JSON.stringify({ sourcePainId: `pain-${taskId}` }),
        });
      }
      // Dreamer task already exists → idempotency check
      return Promise.resolve({ taskId: 'dreamer-cand-pending-1-prompt' });
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.intakeSucceeded).toBe(1);
    expect(output.details.alreadyHaveTask).toBe(1);
    expect(output.details.created).toBe(0);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-pending-1',
      status: 'intake_succeeded_existing_task',
      intakeDecision: 'intake_succeeded',
      seedDecision: 'existing',
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('guarded transition: status update fails when candidate is not pending', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });
    mockPrepareRun.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE')) return { changes: 0 };
      return { changes: 1 };
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.details.intakeFailed).toBe(1);
    expect(output.details.created).toBe(0);
    expect(output.details.results).toHaveLength(1);
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-pending-1',
      statusBefore: 'pending',
      statusAfter: 'pending',
      intakeDecision: 'intake_failed',
      seedDecision: 'skipped',
    });
    expect(output.details.results[0].reason).toContain('Guarded transition failed');
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('consumed candidate original behavior regression unchanged', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [{ candidate_id: 'cand-consumed-1' }];
      return [];
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      mode: 'dry_run',
      status: 'would_change',
      safeToConfirm: true,
      repairedCount: 0,
    });
    expect(output.details.results[0]).toMatchObject({
      candidateId: 'cand-consumed-1',
      status: 'would_create',
      intakeDecision: 'not_needed',
      seedDecision: 'would_seed',
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('rejects --dry-run and --confirm together before writing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit:${code}`); });

    await expect(
      handleCandidateInternalizationBackfill({ workspace: WS, dryRun: true, confirm: true, json: true }),
    ).rejects.toThrow('process.exit:1');

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
    exitSpy.mockRestore();
  });

  it('--json output is single parseable object with required fields per candidate', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [{ candidate_id: 'cand-consumed-1' }];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });

    await handleCandidateInternalizationBackfill({ workspace: WS, includePending: true, dryRun: true, json: true });

    const rawOutput = consoleLogSpy.mock.calls[0][0] as string;
    const output = JSON.parse(rawOutput);
    expect(output).toBeDefined();

    for (const result of output.details.results) {
      expect(result).toHaveProperty('candidateId');
      expect(result).toHaveProperty('statusBefore');
      expect(result).toHaveProperty('statusAfter');
      expect(result).toHaveProperty('intakeDecision');
      expect(result).toHaveProperty('seedDecision');
    }
  });

  it('exit path: process.exit(1) after flag conflict does not continue to mutation', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit:${code}`); });

    await expect(
      handleCandidateInternalizationBackfill({ workspace: WS, dryRun: true, confirm: true }),
    ).rejects.toThrow('process.exit:1');

    expect(mockIntake).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('Commander wiring for backfill --include-pending', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [];
      return [];
    });
    mockGetCandidate.mockImplementation((id: string) =>
      Promise.resolve({
        candidateId: id,
        taskId: `diag-task-${id}`,
        description: `candidate ${id}`,
        sourceRecommendationJson: JSON.stringify({ kind: 'principle', description: `candidate ${id}` }),
      }),
    );
    // PRI-435: getTask returns diagnostician task with sourcePainId for diag-task-* lookups,
    // null for dreamer task lookups (no existing dreamer task).
    mockGetTask.mockImplementation((taskId: string) => {
      if (taskId.startsWith('diag-task-')) {
        return Promise.resolve({
          taskId,
          taskKind: 'diagnostician',
          status: 'completed',
          diagnosticJson: JSON.stringify({ sourcePainId: `pain-${taskId}` }),
        });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('no flags -> dry-run mode, includePending undefined', async () => {
    const program = createBackfillTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--json']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.details.mode).toBe('dry-run');
    expect(output.details.totalPending).toBe(0);
  });

  it('--include-pending -> includePending=true', async () => {
    mockPrepareAll.mockImplementation((sql: string) => {
      if (sql.includes("'consumed'")) return [];
      if (sql.includes("'pending'")) return [{ candidate_id: 'cand-pending-1' }];
      return [];
    });
    mockGetCandidate.mockResolvedValue({
      candidateId: 'cand-pending-1',
      description: 'test',
      sourceRecommendationJson: JSON.stringify({ kind: 'principle', description: 'test' }),
    });

    const program = createBackfillTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--include-pending', '--dry-run', '--json']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.details.totalPending).toBe(1);
  });

  it('--dry-run -> RuntimeStateManager readonly=true', async () => {
    const program = createBackfillTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--dry-run', '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: true }),
    );
  });

  it('--confirm -> RuntimeStateManager readonly=false', async () => {
    const program = createBackfillTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--confirm', '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: false }),
    );
  });

  it('--dry-run --confirm together -> rejected', async () => {
    const program = createBackfillTestProgram();
    try {
      await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--dry-run', '--confirm', '--json']);
    } catch {
      // process.exit throws via exitOverride or handler throws
    }

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockIntake).not.toHaveBeenCalled();
  });

  it('no flags -> RuntimeStateManager readonly=true (dry-run default)', async () => {
    const program = createBackfillTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'internalization', 'backfill', '--workspace', WS, '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: true }),
    );
  });
});
