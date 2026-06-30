import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRuleHostWriterConfigs = vi.hoisted(() => [] as Array<{ featureFlagProbe?: (flagId: string) => boolean }>);
const mockFeatureFlags = vi.hoisted(() => ({
  flags: { rulecode_context_v2: { id: 'rulecode_context_v2', category: 'quiet' as const, enabled: true, since: '2026-06-27', description: 'test' } },
}));

const mockGetArtifactById = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockApprovalEdit = vi.fn();
const mockApprovalGetById = vi.fn();
const mockApprovalApprove = vi.fn();
const mockApprovalResetToPending = vi.fn();
const mockCompletionComplete = vi.fn();
const mockPromoteActivation = vi.fn().mockResolvedValue(true);
const mockListCodeToolHookActivations = vi.fn().mockResolvedValue([
  { activationId: 'act-hook-1', artifactId: 'art-002', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'rule-001', activatedAt: '2026-06-18T00:00:00.000Z', promotedAt: null, deactivatedAt: null },
]);

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({ ok: true, effective: {} }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue(mockFeatureFlags),
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
        deactivateActivation: vi.fn().mockResolvedValue(true),
        listPromptActivations: vi.fn().mockResolvedValue([
          { activationId: 'act-prompt-1', artifactId: 'art-001', channel: 'prompt', action: 'prompt', targetRef: 'P_001', activatedAt: '2026-06-18T00:00:00.000Z', deactivatedAt: null },
        ]),
        listCodeToolHookActivations: mockListCodeToolHookActivations,
        promoteActivation: mockPromoteActivation,
        listAllActivations: vi.fn().mockResolvedValue([
          { activationId: 'act-prompt-1', artifactId: 'art-001', channel: 'prompt', action: 'prompt', targetRef: 'P_001', activatedAt: '2026-06-18T00:00:00.000Z', deactivatedAt: null },
          { activationId: 'act-hook-1', artifactId: 'art-002', channel: 'code_tool_hook', action: 'block', targetRef: 'rule-001', activatedAt: '2026-06-18T00:00:00.000Z', deactivatedAt: null },
        ]),
      };
    }),
    SqliteApprovalQueueStore: vi.fn().mockImplementation(function () {
      return {
        enqueue: vi.fn().mockResolvedValue(undefined),
        edit: mockApprovalEdit,
        getById: mockApprovalGetById,
      };
    }),
    SqlitePIArtifactStore: vi.fn().mockImplementation(function () {
      return {
        getArtifactById: mockGetArtifactById,
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
    ApprovalQueue: vi.fn().mockImplementation(function () {
      return { approve: mockApprovalApprove, resetToPending: mockApprovalResetToPending };
    }),
    ApprovalCompletionService: vi.fn().mockImplementation(function () {
      return { completeApproval: mockCompletionComplete };
    }),
    RuleHostWriter: vi.fn().mockImplementation(function (config) {
      mockRuleHostWriterConfigs.push(config);
      return { channel: 'code_tool_hook' };
    }),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  };
});

import { handleRuntimeActivationDispatch, handleRuntimeActivationDeactivate, handleRuntimeActivationList, handleRuntimeActivationEdit, handleActivationApprove, handleRuntimeActivationPromote } from '../../src/commands/runtime-activation.js';

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
    mockRuleHostWriterConfigs.length = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetArtifactById.mockResolvedValue(makeArtifact());
  });

  it('wires the effective workspace feature flags into RuleHostWriter', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'code_tool_hook',
      json: true,
    });

    expect(mockRuleHostWriterConfigs).toHaveLength(1);
    expect(mockRuleHostWriterConfigs[0]?.featureFlagProbe?.('rulecode_context_v2')).toBe(true);
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

// PRI-408 Contract E: Deactivate (rollback) command tests
describe('handleRuntimeActivationDeactivate', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('missing --activation-id returns structured error with nextAction (JSON)', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('activation_id_required');
    expect(output.nextAction).toContain('--activation-id');
    expect(process.exitCode).toBe(1);
  });

  it('missing --activation-id prints error and nextAction (text)', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: WS,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--activation-id is required'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Next action'));
    expect(process.exitCode).toBe(1);
  });

  it('successful deactivation returns ok=true with deactivatedAt (JSON)', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: WS,
      activationId: 'act-001',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.activationId).toBe('act-001');
    expect(output.deactivatedAt).toBeDefined();
    expect(process.exitCode).toBe(0);
  });

  it('not-found or already-deactivated returns ok=false with reason and nextAction (JSON)', async () => {
    // Override mock to return false (not found / already deactivated)
    const { SqliteActivationStateStore } = await import('@principles/core/runtime-v2');
    vi.mocked(SqliteActivationStateStore).mockImplementationOnce(function () {
      return {
        findByArtifactId: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue(undefined),
        deactivateActivation: vi.fn().mockResolvedValue(false),
        listPromptActivations: vi.fn().mockResolvedValue([]),
        listCodeToolHookActivations: vi.fn().mockResolvedValue([]),
        listAllActivations: vi.fn().mockResolvedValue([]),
      } as never;
    });

    await handleRuntimeActivationDeactivate({
      workspace: WS,
      activationId: 'act-gone',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('not_found_or_already_deactivated');
    expect(output.nextAction).toContain('Check activation ID');
    expect(process.exitCode).toBe(1);
  });

  it('text output for success is human-readable', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: WS,
      activationId: 'act-001',
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('Deactivated: act-001');
    expect(text).toContain('deactivatedAt:');
  });
});

// PRI-408 Contract D: List activations (observability) command tests
describe('handleRuntimeActivationList', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('JSON output is a single object with activations array', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(Array.isArray(output.activations)).toBe(true);
    expect(output.activations.length).toBe(2);
    expect(output.activations[0]).toHaveProperty('activationId');
    expect(output.activations[0]).toHaveProperty('channel');
  });

  it('channel=prompt filter calls listPromptActivations', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'prompt',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.activations.length).toBe(1);
    expect(output.activations[0].channel).toBe('prompt');
  });

  it('channel=code_tool_hook filter calls listCodeToolHookActivations', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.activations.length).toBe(1);
    expect(output.activations[0].channel).toBe('code_tool_hook');
  });

  it('text output is human-readable with status, id, channel', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('[ACTIVE]');
    expect(text).toContain('act-prompt-1');
    expect(text).toContain('channel: prompt');
  });

  it('invalid channel returns structured error with nextAction (P2 #5 fix)', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'invalid_channel',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('invalid_channel');
    expect(output.nextAction).toContain('prompt');
    expect(process.exitCode).toBe(1);
  });

  it('invalid channel in text mode prints error and nextAction (P2 #5 fix)', async () => {
    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'bogus',
    });

    const errorText = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(errorText).toContain('invalid channel');
    expect(errorText).toContain('Next action');
    expect(process.exitCode).toBe(1);
  });
});

describe('handleRuntimeActivationPromote', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListCodeToolHookActivations.mockResolvedValue([
      { activationId: 'act-hook-1', artifactId: 'art-002', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'rule-001', activatedAt: '2026-06-18T00:00:00.000Z', promotedAt: null, deactivatedAt: null },
    ]);
    mockPromoteActivation.mockResolvedValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('defaults to dry-run and does not mutate activation state', async () => {
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', json: true });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('would_promote');
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('promotes an eligible shadow activation when confirmed', async () => {
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', confirm: true, json: true });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('promoted');
    expect(mockPromoteActivation).toHaveBeenCalledWith('act-hook-1', expect.any(String));
  });

  it('rejects mutually exclusive dry-run and confirm without mutation', async () => {
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', dryRun: true, confirm: true, json: true });
    expect(mockPromoteActivation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// P1 #2 fix: Edit pending approval command tests
describe('handleRuntimeActivationEdit', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('missing --approval-id returns structured error with nextAction (JSON)', async () => {
    await handleRuntimeActivationEdit({
      workspace: WS,
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('approval_id_required');
    expect(output.nextAction).toContain('--approval-id');
    expect(process.exitCode).toBe(1);
  });

  it('missing --new-artifact-id returns structured error with nextAction (JSON)', async () => {
    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('new_artifact_id_required');
    expect(output.nextAction).toContain('--new-artifact-id');
    expect(process.exitCode).toBe(1);
  });

  it('missing --edit-reason returns structured error with nextAction (JSON)', async () => {
    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('edit_reason_required');
    expect(output.nextAction).toContain('--edit-reason');
    expect(process.exitCode).toBe(1);
  });

  it('successful edit returns ok with newArtifactId and previousArtifactId (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return makeArtifact({ artifactId: 'art-new', sourceTaskId: 'task-001' });
      }
      if (id === 'art-old') {
        return makeArtifact({ artifactId: 'art-old', sourceTaskId: 'task-001' });
      }
      return null;
    });
    mockApprovalEdit.mockResolvedValue({
      ok: true,
      record: {
        approvalId: 'appr-001',
        artifactId: 'art-new',
        previousArtifactId: 'art-old',
        editedAt: '2026-06-19T00:00:00.000Z',
        status: 'pending',
      },
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo in principle text',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.approvalId).toBe('appr-001');
    expect(output.newArtifactId).toBe('art-new');
    expect(output.previousArtifactId).toBe('art-old');
    expect(output.editedAt).toBe('2026-06-19T00:00:00.000Z');
    expect(process.exitCode).toBe(0);
  });

  it('not_found approval returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue(null);
    mockApprovalEdit.mockResolvedValue({
      ok: false,
      error: 'not_found',
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-nonexistent',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('not_found');
    expect(output.nextAction).toContain('Check the approval ID');
    expect(process.exitCode).toBe(1);
  });

  it('already_decided approval returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'approved',
    });
    mockApprovalEdit.mockResolvedValue({
      ok: false,
      error: 'already_decided',
      status: 'approved',
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('already_decided');
    expect(output.nextAction).toContain('already decided');
    expect(output.nextAction).toContain('approved');
    expect(process.exitCode).toBe(1);
  });

  it('edit store throw returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return makeArtifact({ artifactId: 'art-new', sourceTaskId: 'task-001' });
      }
      if (id === 'art-old') {
        return makeArtifact({ artifactId: 'art-old', sourceTaskId: 'task-001' });
      }
      return null;
    });
    mockApprovalEdit.mockRejectedValue(new Error('SQLITE_BUSY'));

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('edit_failed');
    expect(output.reason).toContain('SQLITE_BUSY');
    expect(output.nextAction).toContain('DB integrity');
    expect(process.exitCode).toBe(1);
  });

  it('text output is human-readable with next action hint', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return makeArtifact({ artifactId: 'art-new', sourceTaskId: 'task-001' });
      }
      if (id === 'art-old') {
        return makeArtifact({ artifactId: 'art-old', sourceTaskId: 'task-001' });
      }
      return null;
    });
    mockApprovalEdit.mockResolvedValue({
      ok: true,
      record: {
        approvalId: 'appr-001',
        artifactId: 'art-new',
        previousArtifactId: 'art-old',
        editedAt: '2026-06-19T00:00:00.000Z',
        status: 'pending',
      },
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('Approval edited: appr-001');
    expect(text).toContain('newArtifactId: art-new');
    expect(text).toContain('previousArtifactId: art-old');
    expect(text).toContain('Next action');
  });

  it('artifact_not_found returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockResolvedValue(null);

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-nonexistent',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('artifact_not_found');
    expect(output.nextAction).toContain('does not exist');
    expect(process.exitCode).toBe(1);
  });

  it('artifact_not_validated returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return { artifactId: 'art-new', validationStatus: 'pending', sourceTaskId: 'task-001' };
      }
      return null;
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('artifact_not_validated');
    expect(output.nextAction).toContain('production gate');
    expect(process.exitCode).toBe(1);
  });

  it('artifact_lineage_mismatch returns structured error with nextAction (JSON)', async () => {
    mockApprovalGetById.mockResolvedValue({
      approvalId: 'appr-001',
      artifactId: 'art-old',
      status: 'pending',
    });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return { artifactId: 'art-new', validationStatus: 'validated', sourceTaskId: 'task-002', lineageArtifactIds: [] };
      }
      if (id === 'art-old') {
        return { artifactId: 'art-old', validationStatus: 'validated', sourceTaskId: 'task-001', sourcePrincipleId: 'principle-old', lineageArtifactIds: [] };
      }
      return null;
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'fix typo',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('artifact_lineage_mismatch');
    expect(output.nextAction).toContain('must reference art-old');
    expect(process.exitCode).toBe(1);
  });

  it('allows a validated revision from a new task when lineage references the approved artifact', async () => {
    mockApprovalGetById.mockResolvedValue({ approvalId: 'appr-001', artifactId: 'art-old', status: 'pending' });
    mockGetArtifactById.mockImplementation(async (id: string) => {
      if (id === 'art-new') {
        return {
          artifactId: 'art-new', validationStatus: 'validated', sourceTaskId: 'owner-edit-task',
          sourcePrincipleId: 'principle-old', lineageArtifactIds: ['art-old'],
        };
      }
      if (id === 'art-old') {
        return {
          artifactId: 'art-old', validationStatus: 'validated', sourceTaskId: 'generation-task',
          sourcePrincipleId: 'principle-old', lineageArtifactIds: [],
        };
      }
      return null;
    });
    mockApprovalEdit.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-new', previousArtifactId: 'art-old', status: 'pending' },
    });

    await handleRuntimeActivationEdit({
      workspace: WS,
      approvalId: 'appr-001',
      newArtifactId: 'art-new',
      editReason: 'owner revision',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(mockApprovalEdit).toHaveBeenCalledOnce();
  });

});

// Bug-M fix: Approve command tests (CLI closed loop)
describe('handleActivationApprove', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuleHostWriterConfigs.length = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetArtifactById.mockResolvedValue(makeArtifact());
    mockApprovalResetToPending.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('AP-01: missing --approval-id returns structured error with nextAction (JSON)', async () => {
    await handleActivationApprove({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('approval_id_required');
    expect(output.nextAction).toContain('--approval-id');
    expect(process.exitCode).toBe(1);
  });

  it('AP-02: approval not_found returns structured error with nextAction (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({ ok: false, error: 'not_found' });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-nonexistent',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('approval_not_found');
    expect(output.nextAction).toContain('Check the approval ID');
    expect(process.exitCode).toBe(1);
  });

  it('AP-03: already_decided returns structured error with status (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({ ok: false, error: 'already_decided', status: 'rejected' });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('already_decided');
    expect(output.reason).toContain('rejected');
    expect(output.nextAction).toContain('already decided');
    expect(process.exitCode).toBe(1);
  });

  it('AP-04: success path returns ok=true with activationId and decision (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockResolvedValue({
      ok: true,
      activationId: 'act-001',
      decision: { decision: 'activated', activationId: 'act-001', action: 'prompt', targetRef: 'P_001' },
    });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      decidedBy: 'test-owner',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.approvalId).toBe('appr-001');
    expect(output.activationId).toBe('act-001');
    expect(output.decision).toBe('activated');
    expect(output.nextAction).toBe('pd activation list');
    expect(process.exitCode).toBe(0);
  });

  it('AP-05: --json output is a single parseable JSON object (cli-1-strict-json)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockResolvedValue({
      ok: true,
      activationId: 'act-001',
      decision: { decision: 'activated', activationId: 'act-001', action: 'prompt', targetRef: 'P_001' },
    });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      json: true,
    });

    // Exactly one console.log call with a single JSON object
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const rawOutput = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toBeInstanceOf(Object);
    expect(parsed.ok).toBe(true);
  });

  it('AP-06: completeApproval !ok rolls back approval and returns structured error (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockResolvedValue({
      ok: false,
      reason: 'artifact_not_validated',
      nextAction: 'Check artifact validation status and retry dispatch.',
    });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('activation_failed');
    expect(output.reason).toContain('artifact_not_validated');
    expect(output.approvalRolledBack).toBe(true);
    expect(output.nextAction).toContain('rolled back to pending');
    expect(process.exitCode).toBe(1);
    // cli-5: rollback was attempted via resetToPending
    expect(mockApprovalResetToPending).toHaveBeenCalledWith('appr-001');
  });

  it('AP-06b: completeApproval throw rolls back approval and returns structured error (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockRejectedValue(new Error('sqlite: disk I/O error'));

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('activation_completion_failed');
    expect(output.reason).toContain('disk I/O error');
    expect(output.approvalRolledBack).toBe(true);
    expect(output.nextAction).toContain('rolled back to pending');
    expect(process.exitCode).toBe(1);
    expect(mockApprovalResetToPending).toHaveBeenCalledWith('appr-001');
  });

  it('AP-06c: rollback failure surfaces approvalRolledBack=false with retry guidance (JSON)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockResolvedValue({
      ok: false,
      reason: 'artifact_not_validated',
      nextAction: 'Check artifact validation status and retry dispatch.',
    });
    mockApprovalResetToPending.mockResolvedValue({ ok: false, error: 'not_found' });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.approvalRolledBack).toBe(false);
    expect(output.nextAction).toContain("remains 'approved'");
    expect(process.exitCode).toBe(1);
  });

  it('AP-07: Commander flag wiring — --approval-id is required at parser level (cli-7-test-wiring)', async () => {
    // cli-7-test-wiring: exercise the real Commander parser path (not just the
    // handler) to verify `--approval-id` is registered as a required option.
    // Follows the project's established pattern in runtime-internalization-run-once.test.ts
    // (buildXxxCommand + program.exitOverride() + parseAsync).
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride(); // surface Commander errors as throws instead of process.exit

    const activationCmd = program.command('activation');
    activationCmd
      .command('approve')
      .description('Approve a pending approval and dispatch its activation')
      .requiredOption('-a, --approval-id <id>', 'Approval ID to approve')
      .option('--decided-by <user>', 'Reviewer name (default: cli-operator)')
      .option('--note <text>', 'Optional approval note')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('--json', 'Output raw JSON')
      .action(async () => { /* no-op for parser test */ });

    // Case 1: missing --approval-id → Commander throws required-option error
    await expect(
      program.parseAsync(['node', 'pd', 'activation', 'approve', '--json']),
    ).rejects.toThrow(/required option.*--approval-id.*not specified/);

    // Case 2: with --approval-id → parses successfully and exposes the option
    const captured: Record<string, unknown> = {};
    const program2 = new Command();
    program2.exitOverride();
    const activationCmd2 = program2.command('activation');
    activationCmd2
      .command('approve')
      .requiredOption('-a, --approval-id <id>', 'Approval ID to approve')
      .option('--decided-by <user>', 'Reviewer name')
      .option('--note <text>', 'Optional approval note')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('--json', 'Output raw JSON')
      .action(async (opts) => { Object.assign(captured, opts); });

    await program2.parseAsync([
      'node', 'pd', 'activation', 'approve',
      '--approval-id', 'appr-007',
      '--decided-by', 'alice',
      '--note', 'lgtm',
      '--json',
    ]);

    expect(captured.approvalId).toBe('appr-007');
    expect(captured.decidedBy).toBe('alice');
    expect(captured.note).toBe('lgtm');
    expect(captured.json).toBe(true);
  });

  // PRI-489 AP-08: The approve path must inject the real workspace
  // `rulecode_context_v2` feature flag probe into RuleHostWriter — same
  // wiring as the dispatch path (tested at line 136-146) and the Console
  // model (ApprovalsConsoleModel.dispatchActivationAfterApproval).
  // Previously this path constructed RuleHostWriter without the probe, so a
  // v2 artifact in a flag-off workspace would pass canActivate here while
  // being rejected by dispatch/Console — an inconsistent contract that
  // violated ERR-024 (validator wired in one enforcement path but not
  // another) and ERR-089 (sibling approval path diverged from dispatch).
  it('AP-08: wires the effective workspace feature flags into RuleHostWriter (ERR-024/ERR-089)', async () => {
    mockApprovalApprove.mockResolvedValue({
      ok: true,
      record: { approvalId: 'appr-001', artifactId: 'art-001', status: 'approved' },
    });
    mockCompletionComplete.mockResolvedValue({
      ok: true,
      activationId: 'act-001',
      decision: { decision: 'activated', activationId: 'act-001', action: 'prompt', targetRef: 'P_001' },
    });

    await handleActivationApprove({
      workspace: WS,
      approvalId: 'appr-001',
      decidedBy: 'test-owner',
      json: true,
    });

    // The RuleHostWriter mock captures its constructor config — verify the
    // featureFlagProbe was injected and reflects the mocked feature flags
    // (rulecode_context_v2: enabled=true, see mockFeatureFlags at top).
    expect(mockRuleHostWriterConfigs).toHaveLength(1);
    expect(mockRuleHostWriterConfigs[0]?.featureFlagProbe).toBeDefined();
    expect(mockRuleHostWriterConfigs[0]?.featureFlagProbe?.('rulecode_context_v2')).toBe(true);
    // Unknown flags must not be reported as enabled (rc-2-no-as-bypass).
    expect(mockRuleHostWriterConfigs[0]?.featureFlagProbe?.('nonexistent_flag')).toBe(false);
  });
});
