import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInitialize = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockGetCandidate = vi.hoisted(() => vi.fn());
const mockGetTask = vi.hoisted(() => vi.fn());
const mockCreateTask = vi.hoisted(() => vi.fn());
const mockUpdateTaskDiagnosticJson = vi.hoisted(() => vi.fn());
const mockAll = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn((workspace?: string) => workspace ?? '/fake/workspace'),
}));

vi.mock('../../src/principle-tree-ledger-adapter.js', () => ({
  PrincipleTreeLedgerAdapter: vi.fn(),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  RuntimeStateManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockInitialize,
      close: mockClose,
      getCandidate: mockGetCandidate,
      getTask: mockGetTask,
      createTask: mockCreateTask,
      updateTaskDiagnosticJson: mockUpdateTaskDiagnosticJson,
      connection: {
        getDb: () => ({
          prepare: () => ({ all: mockAll, get: vi.fn(), run: vi.fn() }),
        }),
      },
    };
  }),
  SqliteConnection: vi.fn(),
  candidateList: vi.fn(),
  candidateShow: vi.fn(),
  CandidateIntakeService: vi.fn(),
  CandidateIntakeError: class CandidateIntakeError extends Error {},
  loadLedger: vi.fn(),
  getLedgerFilePathPublic: vi.fn(),
  decideInternalizationRoute: vi.fn(() => ({
    ready: true,
    route: 'principle-ledger',
    reason: 'ready',
    missingFields: [],
    nextAction: 'internalize',
  })),
  createPITaskDiagnosticJson: vi.fn(() => JSON.stringify({ pi_metadata: { channel: 'prompt' } })),
  createRemediationResult: vi.fn((input) => ({
    mode: input.mode,
    status: input.status ?? (input.mode === 'dry_run'
      ? (input.actions?.length > 0 ? 'would_change' : 'no_op')
      : (input.repairedCount > 0 ? 'changed' : 'no_op')),
    safeToConfirm: input.safeToConfirm ?? false,
    repairedCount: input.repairedCount ?? 0,
    skippedCount: input.skippedCount ?? 0,
    actions: input.actions ?? [],
    warnings: input.warnings ?? [],
  })),
  remediationAction: vi.fn((input) => input),
}));

import { handleCandidateInternalizationBackfill } from '../../src/commands/candidate.js';

describe('pd candidate internalization backfill remediation contract', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockAll.mockReturnValue([{ candidate_id: 'cand-1' }]);
    mockGetCandidate.mockResolvedValue({
      candidateId: 'cand-1',
      description: 'candidate',
      sourceRecommendationJson: JSON.stringify({ kind: 'principle', description: 'candidate' }),
    });
    mockGetTask.mockResolvedValue(null);
    mockCreateTask.mockResolvedValue({ taskId: 'dreamer-cand-1-prompt' });
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('dry-run JSON uses shared remediation contract and does not create tasks', async () => {
    await handleCandidateInternalizationBackfill({ workspace: '/fake/workspace', dryRun: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      mode: 'dry_run',
      status: 'would_change',
      safeToConfirm: true,
      repairedCount: 0,
    });
    expect(output.actions[0]).toMatchObject({ action: 'would_create_dreamer_task', targetId: 'cand-1' });
    expect(output.details.missingDreamerTask).toBe(1);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('confirm JSON reports changed after creating missing dreamer task', async () => {
    await handleCandidateInternalizationBackfill({ workspace: '/fake/workspace', confirm: true, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.mode).toBe('confirm');
    expect(output.status).toBe('changed');
    expect(output.repairedCount).toBe(1);
    expect(mockCreateTask).toHaveBeenCalled();
  });

  it('rejects --dry-run and --confirm together before writing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit:${code}`); });

    await expect(
      handleCandidateInternalizationBackfill({ workspace: '/fake/workspace', dryRun: true, confirm: true, json: true }),
    ).rejects.toThrow('process.exit:1');

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
    exitSpy.mockRestore();
  });
});

