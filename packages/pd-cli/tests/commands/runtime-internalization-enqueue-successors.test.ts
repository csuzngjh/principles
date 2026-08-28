import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mockListTasks = vi.hoisted(() => vi.fn());
const mockGetTask = vi.hoisted(() => vi.fn());
const mockCommitNextTaskProposal = vi.hoisted(() => vi.fn());
const mockProposeNextTask = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInitialize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRuntimeStateManagerOpts = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

// PRI-612: spread the real barrel exports so pure constants consumed by the
// command (PD_TASK_STATUSES) stay authentic; only the stateful classes are
// mocked. Previously a bare factory mock left new barrel exports undefined
// at runtime (ERR-083 vi.mock variant — 19 tests failed on CI).
vi.mock('@principles/core/runtime-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@principles/core/runtime-v2')>()),
  RuntimeStateManager: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    mockRuntimeStateManagerOpts(opts);
    return {
      initialize: mockInitialize,
      close: mockClose,
      listTasks: mockListTasks,
      getTask: mockGetTask,
    };
  }),
  InternalizationOrchestrator: vi.fn().mockImplementation(function () {
    return {
      commitNextTaskProposal: mockCommitNextTaskProposal,
      proposeNextTask: mockProposeNextTask,
    };
  }),
  isPeerRunnerKind: vi.fn().mockImplementation((k: string) =>
    ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'].includes(k),
  ),
  hydratePITaskRecord: vi.fn().mockImplementation((task: Record<string, unknown>) => {
    if (typeof task.diagnosticJson !== 'string' || task.diagnosticJson.length === 0) return null;
    try {
      const meta = JSON.parse(task.diagnosticJson);
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
      return {
        taskId: task.taskId,
        taskKind: task.taskKind,
        status: task.status,
        attemptCount: task.attemptCount ?? 0,
        dependencyTaskIds: meta.dependencyTaskIds ?? [],
        channel: meta.channel ?? 'prompt',
        timeoutMs: meta.timeoutMs ?? 300_000,
        inputArtifactRefs: meta.inputArtifactRefs ?? [],
        outputArtifactRefs: meta.outputArtifactRefs ?? [],
        parentTaskId: meta.parentTaskId ?? null,
        correlationId: meta.correlationId ?? null,
      };
    } catch {
      return null;
    }
  }),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

import { handleRuntimeInternalizationEnqueueSuccessors } from '../../src/commands/runtime-internalization-enqueue-successors.js';

const WS = '/fake/workspace';

function mockDryRunListTasks(succeededTasks: ReturnType<typeof makeSucceededTask>[], successorTasks: ReturnType<typeof makeSucceededTask>[] = []) {
  mockListTasks
    .mockResolvedValueOnce(succeededTasks)
    .mockResolvedValueOnce(successorTasks)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
}

function makePIMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dependencyTaskIds: [],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    parentTaskId: null,
    correlationId: null,
    ...overrides,
  });
}

function makeSucceededTask(taskId: string, taskKind: string, metaOverrides: Record<string, unknown> = {}) {
  return {
    taskId,
    taskKind,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    inputRef: undefined,
    resultRef: `ref-${taskId}`,
    lastError: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    diagnosticJson: makePIMetadata(metaOverrides),
  };
}

function makeMalformedTask(taskId: string, taskKind: string) {
  return {
    taskId,
    taskKind,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    inputRef: undefined,
    resultRef: `ref-${taskId}`,
    lastError: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    diagnosticJson: 'not-valid-json{{{',
  };
}

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride();

  const internalizationCmd = program.command('internalization');

  internalizationCmd
    .command('enqueue-successors')
    .description('Enqueue successor tasks for succeeded internalization tasks missing successors')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Report only, no modifications (default)')
    .option('--confirm', 'Actually create successor tasks')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeInternalizationEnqueueSuccessors({
        workspace: opts.workspace,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
        json: opts.json,
      });
    });

  return program;
}

describe('handleRuntimeInternalizationEnqueueSuccessors', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('succeeded dreamer with artifact and no philosopher successor: dry-run reports would_create_successor', async () => {
    const dreamerTask = makeSucceededTask('dreamer-001', 'dreamer');
    mockDryRunListTasks([dreamerTask]);
    mockProposeNextTask.mockResolvedValue({
      decision: 'proposal_created',
      taskId: 'dreamer-001',
      taskKind: 'dreamer',
      proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-001'], inputArtifactRefs: [], parentTaskId: 'dreamer-001', correlationId: 'corr-001' },
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, confirm: false, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('dry_run');
    expect(output.dryRun).toBe(true);
    expect(output.scannedCount).toBe(1);
    expect(output.actions).toHaveLength(1);
    expect(output.actions[0].taskId).toBe('dreamer-001');
    expect(output.actions[0].taskKind).toBe('dreamer');
    expect(output.actions[0].decision).toBe('would_create_successor');
    expect(output.actions[0].successorKind).toBe('philosopher');
  });

  it('confirm creates exactly one philosopher successor', async () => {
    const dreamerTask = makeSucceededTask('dreamer-002', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-002',
      successorTaskId: 'philosopher-dreamer-002-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('confirmed');
    expect(output.dryRun).toBe(false);
    expect(output.createdCount).toBe(1);
    expect(output.actions[0].decision).toBe('successor_created');
    expect(output.actions[0].successorTaskId).toBe('philosopher-dreamer-002-prompt');
    expect(output.actions[0].successorKind).toBe('philosopher');
    expect(mockCommitNextTaskProposal).toHaveBeenCalledWith('dreamer-002');
  });

  it('repeated confirm returns successor_exists, no duplicate task', async () => {
    const dreamerTask = makeSucceededTask('dreamer-003', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_exists',
      sourceTaskId: 'dreamer-003',
      successorTaskId: 'philosopher-dreamer-003-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.existingCount).toBe(1);
    expect(output.createdCount).toBe(0);
    expect(output.actions[0].decision).toBe('successor_exists');
    expect(output.actions[0].successorTaskId).toBe('philosopher-dreamer-003-prompt');
  });


  it('succeeded task with malformed metadata is skipped with reason; no successor created', async () => {
    const malformedTask = makeMalformedTask('malformed-001', 'dreamer');
    mockListTasks.mockResolvedValue([malformedTask]);

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.skippedCount).toBe(1);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].taskId).toBe('malformed-001');
    expect(output.actions[0].reason).toBeDefined();
    expect(output.actions[0].nextAction).toBeDefined();
    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('failed/retry_wait/leased tasks are not processed — only succeeded returned by listTasks', async () => {
    const succeededTask = makeSucceededTask('dreamer-ok', 'dreamer');
    mockListTasks.mockResolvedValue([succeededTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-ok',
      successorTaskId: 'philosopher-dreamer-ok-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.scannedCount).toBe(1);
    expect(output.actions).toHaveLength(1);
    expect(output.actions[0].taskId).toBe('dreamer-ok');
    expect(mockCommitNextTaskProposal).toHaveBeenCalledTimes(1);
    expect(mockCommitNextTaskProposal).toHaveBeenCalledWith('dreamer-ok');
  });

  it('DB/storage unavailable fails closed', async () => {
    mockInitialize.mockRejectedValue(new Error('Cannot open database'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.scannedCount).toBe(0);
    expect(output.actions).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('listTasks throws: fails closed with structured error', async () => {
    mockListTasks.mockRejectedValue(new Error('Database locked'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(process.exitCode).toBe(1);
  });

  it('default mode is dry-run', async () => {
    const dreamerTask = makeSucceededTask('dreamer-default', 'dreamer');
    mockDryRunListTasks([dreamerTask]);
    mockProposeNextTask.mockResolvedValue({
      decision: 'proposal_created',
      taskId: 'dreamer-default',
      taskKind: 'dreamer',
      proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-default'], inputArtifactRefs: [], parentTaskId: 'dreamer-default', correlationId: 'corr-default' },
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('dry_run');
    expect(output.dryRun).toBe(true);
    expect(output.actions[0].decision).toBe('would_create_successor');
  });

  it('--confirm performs writes', async () => {
    const dreamerTask = makeSucceededTask('dreamer-confirm', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-confirm',
      successorTaskId: 'philosopher-dreamer-confirm-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('confirmed');
    expect(output.dryRun).toBe(false);
    expect(output.actions[0].decision).toBe('successor_created');
  });

  it('--dry-run --confirm is rejected with exitCode 1 and no writes, JSON mode emits structured error with reason/nextAction', async () => {
    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('refused');
    expect(output.error).toContain('mutually exclusive');
    expect(output.reason).toContain('flag_conflict');
    expect(output.nextAction).toBeDefined();
    expect(process.exitCode).toBe(1);

    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('--json emits parseable JSON only', async () => {
    const dreamerTask = makeSucceededTask('dreamer-json', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-json',
      successorTaskId: 'philosopher-dreamer-json-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const rawOutput = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('confirmed');
  });

  it('text output is human-readable and includes counts', async () => {
    const dreamerTask = makeSucceededTask('dreamer-text', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-text',
      successorTaskId: 'philosopher-dreamer-text-prompt',
      successorKind: 'philosopher',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('Enqueue Successors');
    expect(text).toContain('scanned');
    expect(text).toContain('created');
  });

  it('commitNextTaskProposal returns source_not_succeeded: skipped with reason', async () => {
    const dreamerTask = makeSucceededTask('dreamer-not-succ', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'source_not_succeeded',
      taskId: 'dreamer-not-succ',
      status: 'failed',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('source_not_succeeded');
  });

  it('commitNextTaskProposal returns task_not_found: skipped with reason', async () => {
    const dreamerTask = makeSucceededTask('dreamer-not-found', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'task_not_found',
      taskId: 'dreamer-not-found',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('task_not_found');
  });

  it('commitNextTaskProposal returns invalid_task_metadata: skipped with reason', async () => {
    const dreamerTask = makeSucceededTask('dreamer-invalid-meta', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockResolvedValue({
      decision: 'invalid_task_metadata',
      taskId: 'dreamer-invalid-meta',
      reason: 'Failed to hydrate PITaskRecord from diagnosticJson',
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('invalid_task_metadata');
  });

  it('multiple succeeded tasks: processes each independently', async () => {
    const dreamer1 = makeSucceededTask('dreamer-multi-1', 'dreamer');
    const dreamer2 = makeSucceededTask('dreamer-multi-2', 'dreamer');
    const philosopher1 = makeSucceededTask('philosopher-multi-1', 'philosopher');
    mockListTasks.mockResolvedValue([dreamer1, dreamer2, philosopher1]);

    mockCommitNextTaskProposal
      .mockResolvedValueOnce({
        decision: 'successor_created',
        sourceTaskId: 'dreamer-multi-1',
        successorTaskId: 'philosopher-dreamer-multi-1-prompt',
        successorKind: 'philosopher',
      })
      .mockResolvedValueOnce({
        decision: 'successor_exists',
        sourceTaskId: 'dreamer-multi-2',
        successorTaskId: 'philosopher-dreamer-multi-2-prompt',
        successorKind: 'philosopher',
      })
      .mockResolvedValueOnce({
        decision: 'successor_created',
        sourceTaskId: 'philosopher-multi-1',
        successorTaskId: 'scribe-philosopher-multi-1-prompt',
        successorKind: 'scribe',
      });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.scannedCount).toBe(3);
    expect(output.createdCount).toBe(2);
    expect(output.existingCount).toBe(1);
    expect(output.actions).toHaveLength(3);
    expect(mockCommitNextTaskProposal).toHaveBeenCalledTimes(3);
  });

  it('non-PI task kinds (diagnostician) are not processed', async () => {
    const diagTask = {
      taskId: 'diag-001',
      taskKind: 'diagnostician',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: '{}',
    };
    mockListTasks.mockResolvedValue([diagTask]);

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.scannedCount).toBe(0);
    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('dry-run does not call commitNextTaskProposal', async () => {
    const dreamerTask = makeSucceededTask('dreamer-dry', 'dreamer');
    mockDryRunListTasks([dreamerTask]);
    mockProposeNextTask.mockResolvedValue({
      decision: 'proposal_created',
      taskId: 'dreamer-dry',
      taskKind: 'dreamer',
      proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-dry'], inputArtifactRefs: [], parentTaskId: 'dreamer-dry', correlationId: 'corr-dry' },
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('workspace does not exist: fails closed', async () => {
    mockInitialize.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: '/nonexistent/path', confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(process.exitCode).toBe(1);
  });

  it('confirm path commitNextTaskProposal throws: skipped with reason', async () => {
    const dreamerTask = makeSucceededTask('dreamer-commit-err', 'dreamer');
    mockListTasks.mockResolvedValue([dreamerTask]);
    mockCommitNextTaskProposal.mockRejectedValue(new Error('Database locked during commit'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('commit_failed');
    expect(output.actions[0].nextAction).toBeDefined();
    expect(output.skippedCount).toBe(1);
  });


  it('successor index build failure: fails closed with structured error', async () => {
    const dreamerTask = makeSucceededTask('dreamer-index-err', 'dreamer');
    mockListTasks
      .mockResolvedValueOnce([dreamerTask])
      .mockRejectedValueOnce(new Error('Database locked during index build'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.reason).toContain('successor_index_failed');
    expect(output.nextAction).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it('dry-run with existing successor: reports successor_exists', async () => {
    const dreamerTask = makeSucceededTask('dreamer-existing-succ', 'dreamer');
    const philosopherPending = makeSucceededTask('philosopher-dreamer-existing-succ-prompt', 'philosopher', { parentTaskId: 'dreamer-existing-succ', channel: 'prompt' });
    philosopherPending.status = 'pending';
    mockDryRunListTasks([dreamerTask], [philosopherPending]);
    mockProposeNextTask.mockResolvedValue({
      decision: 'proposal_created',
      taskId: 'dreamer-existing-succ',
      taskKind: 'dreamer',
      proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-existing-succ'], inputArtifactRefs: [], parentTaskId: 'dreamer-existing-succ', correlationId: 'corr-existing' },
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('successor_exists');
    expect(output.actions[0].successorTaskId).toBe('philosopher-dreamer-existing-succ-prompt');
    expect(output.existingCount).toBe(1);
    expect(output.createdCount).toBe(0);
  });

  it('dry-run proposeNextTask throws: skipped with reason', async () => {
    const dreamerTask = makeSucceededTask('dreamer-propose-err', 'dreamer');
    mockListTasks.mockResolvedValueOnce([dreamerTask]);
    mockProposeNextTask.mockRejectedValue(new Error('Orchestrator internal error'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('propose_failed');
    expect(output.actions[0].nextAction).toBeDefined();
    expect(output.skippedCount).toBe(1);
  });

  it('failed JSON output includes reason and nextAction', async () => {
    mockInitialize.mockRejectedValue(new Error('Cannot open database'));

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.reason).toContain('storage_init_failed');
    expect(output.nextAction).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it('--confirm workspace resolve failure reports dryRun=false', async () => {
    const { resolveWorkspaceDir } = await import('../../src/resolve-workspace.js');
    vi.mocked(resolveWorkspaceDir).mockImplementationOnce(() => { throw new Error('No workspace found'); });

    await handleRuntimeInternalizationEnqueueSuccessors({ confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.dryRun).toBe(false);
    expect(output.reason).toContain('workspace_resolve_failed');
    expect(output.nextAction).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  it('dry-run existing successor with malformed metadata: skipped, not would_create_successor', async () => {
    const dreamerTask = makeSucceededTask('dreamer-malformed-succ', 'dreamer');
    const malformedSuccessor = {
      taskId: 'philosopher-dreamer-malformed-succ-prompt',
      taskKind: 'philosopher',
      status: 'pending' as const,
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: undefined,
      resultRef: undefined,
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      diagnosticJson: 'not-valid-json{{{',
    };
    mockDryRunListTasks([dreamerTask], [malformedSuccessor]);
    mockProposeNextTask.mockResolvedValue({
      decision: 'proposal_created',
      taskId: 'dreamer-malformed-succ',
      taskKind: 'dreamer',
      proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-malformed-succ'], inputArtifactRefs: [], parentTaskId: 'dreamer-malformed-succ', correlationId: 'corr-malformed' },
    });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('successor_exists_with_malformed_metadata');
    expect(output.actions[0].nextAction).toContain('integrity-repair');
    expect(output.skippedCount).toBe(1);
    expect(output.createdCount).toBe(0);
  });

  it('dedupe scan is not N×full-table per source task (buildSuccessorIndex called once)', async () => {
    const dreamer1 = makeSucceededTask('dreamer-dedup-1', 'dreamer');
    const dreamer2 = makeSucceededTask('dreamer-dedup-2', 'dreamer');
    mockDryRunListTasks([dreamer1, dreamer2]);
    mockProposeNextTask
      .mockResolvedValueOnce({
        decision: 'proposal_created',
        taskId: 'dreamer-dedup-1',
        taskKind: 'dreamer',
        proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-dedup-1'], inputArtifactRefs: [], parentTaskId: 'dreamer-dedup-1', correlationId: 'corr-1' },
      })
      .mockResolvedValueOnce({
        decision: 'proposal_created',
        taskId: 'dreamer-dedup-2',
        taskKind: 'dreamer',
        proposal: { taskKind: 'philosopher', channel: 'prompt', dependencyTaskIds: ['dreamer-dedup-2'], inputArtifactRefs: [], parentTaskId: 'dreamer-dedup-2', correlationId: 'corr-2' },
      });

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, dryRun: true, json: true });

    expect(mockListTasks.mock.calls.length).toBe(7);
    const allCalls = mockListTasks.mock.calls.map(c => c[0]?.status);
    const succeededCalls = allCalls.filter(s => s === 'succeeded').length;
    expect(succeededCalls).toBe(2);
  });

  it('diagnosticJson non-string returns null, no throw', async () => {
    const taskWithNonStringDiag = {
      taskId: 'task-nonstring-diag',
      taskKind: 'dreamer',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      inputRef: undefined,
      resultRef: 'ref-nonstring',
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      diagnosticJson: 42,
    };
    mockListTasks.mockResolvedValue([taskWithNonStringDiag]);

    await handleRuntimeInternalizationEnqueueSuccessors({ workspace: WS, confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.scannedCount).toBe(1);
    expect(output.skippedCount).toBe(1);
    expect(output.actions[0].decision).toBe('skipped');
    expect(output.actions[0].reason).toContain('Failed to hydrate');
    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('resolveWorkspaceDir throws: fails closed with structured error', async () => {
    const { resolveWorkspaceDir } = await import('../../src/resolve-workspace.js');
    vi.mocked(resolveWorkspaceDir).mockImplementationOnce(() => { throw new Error('No workspace found'); });

    await handleRuntimeInternalizationEnqueueSuccessors({ json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.error).toContain('Failed to resolve workspace');
    expect(process.exitCode).toBe(1);
  });
});

describe('Commander wiring for enqueue-successors', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTasks.mockResolvedValue([]);
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('no flags → dry-run mode (confirm=undefined, dryRun=undefined)', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--json']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.dryRun).toBe(true);
    expect(output.status).toBe('dry_run');
  });

  it('--confirm alone → confirm mode', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--confirm', '--json']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.dryRun).toBe(false);
    expect(output.status).toBe('confirmed');
  });

  it('--dry-run alone → dry-run mode', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--dry-run', '--json']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.dryRun).toBe(true);
    expect(output.status).toBe('dry_run');
  });

  it('--dry-run --confirm together → rejected with exitCode 1', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--dry-run', '--confirm', '--json']);

    expect(process.exitCode).toBe(1);
    expect(mockCommitNextTaskProposal).not.toHaveBeenCalled();
  });

  it('--json flag produces parseable output', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--json']);

    const rawOutput = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toBeDefined();
  });

  it('no flags -> RuntimeStateManager readonly=true (dry-run default)', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: true }),
    );
  });

  it('--dry-run -> RuntimeStateManager readonly=true', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--dry-run', '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: true }),
    );
  });

  it('--confirm -> RuntimeStateManager readonly=false', async () => {
    mockListTasks.mockResolvedValue([]);
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'internalization', 'enqueue-successors', '--workspace', WS, '--confirm', '--json']);

    expect(mockRuntimeStateManagerOpts).toHaveBeenCalledWith(
      expect.objectContaining({ readonly: false }),
    );
  });
});
