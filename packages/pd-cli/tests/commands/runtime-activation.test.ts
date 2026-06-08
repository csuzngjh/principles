import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetArtifactById = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: mockClose,
        piArtifactStore: {
          getArtifactById: mockGetArtifactById,
        },
        connection: {
          getDb: () => ({
            prepare: () => ({
              get: () => undefined,
              all: () => [],
            }),
          }),
        },
      };
    }),
    SqliteActivationStateStore: vi.fn().mockImplementation(function () {
      return {
        findByArtifactId: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue(undefined),
      };
    }),
    SqliteApprovalQueueStore: vi.fn().mockImplementation(function () {
      return {
        enqueue: vi.fn().mockResolvedValue(undefined),
      };
    }),
    ActivationDispatcher: vi.fn().mockImplementation(function () {
      return {
        dispatch: vi.fn(async (args) => {
          if (args.confirm) {
            return { decision: 'activated', activationId: 'act-001', action: 'prompt', targetRef: 'P_001' };
          }
          if (args.channel === 'code_tool_hook') {
            return { decision: 'refused', activationId: 'act-001', action: 'none', targetRef: 'P_001', reason: 'activation_state_read_failed', riskLevel: 'high', channel: 'code_tool_hook' };
          }
          return { decision: 'would_activate', activationId: 'act-001', action: 'prompt', targetRef: 'P_001' };
        }),
      };
    }),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  };
});

import { handleRuntimeActivationDispatch } from '../../src/commands/runtime-activation.js';

const WS = '/fake/workspace';

function makeArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: 'art-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-001',
    sourcePrincipleId: 'P_001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'P_001', text: 'Test', review: { decision: 'approve_rollout' } }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('handleRuntimeActivationDispatch', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetArtifactById.mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('JSON output contains activationId, decision, reason, targetRef', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output).toHaveProperty('decision');
    expect(output).toHaveProperty('activationId');
    expect(output).toHaveProperty('action');
    expect(output).toHaveProperty('targetRef');
  });

  it('dry-run outputs would_activate', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      dryRun: true,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_activate');
  });

  it('confirm outputs activated', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      confirm: true,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('activated');
  });

  it('high-risk channel returns refused', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('refused');
    expect(process.exitCode).toBe(1);
  });

  it('missing artifact returns invalid_artifact', async () => {
    mockGetArtifactById.mockResolvedValue(null);

    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'nonexistent',
      channel: 'prompt',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('invalid_artifact');
    expect(process.exitCode).toBe(1);
  });

  it('--dry-run and --confirm are mutually exclusive', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      dryRun: true,
      confirm: true,
      json: true,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: --dry-run and --confirm are mutually exclusive');
    expect(process.exitCode).toBe(1);
  });

  it('default is dry-run (would_activate)', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_activate');
  });

  it('text output is human-readable', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
    });

    const text = consoleLogSpy.mock.calls[0][0];
    expect(text).toContain('Activation:');
    expect(text).toContain('would_activate');
  });
});
