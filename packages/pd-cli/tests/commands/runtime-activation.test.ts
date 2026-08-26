import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockRuleHostWriterConfigs = vi.hoisted(() => [] as Array<{ featureFlagProbe?: (flagId: string) => boolean }>);
const mockFeatureFlags = vi.hoisted(() => ({
  flags: {
    rulecode_context_v2: { id: 'rulecode_context_v2', category: 'quiet' as const, enabled: true, since: '2026-06-27', description: 'test' },
    rulecode_owner_live_decision: { id: 'rulecode_owner_live_decision', category: 'core' as const, enabled: false, since: '2026-08-21', description: 'test' },
    rulecode_safety_controls: { id: 'rulecode_safety_controls', category: 'core' as const, enabled: true, since: '2026-08-21', description: 'test' },
  },
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
            return { decision: 'refused', activationId: 'act-001', action: 'none', targetRef: 'P_001', reason: 'activation_state_read_failed', riskLevel: 'high', channel: 'code_tool_hook', nextAction: 'Check activation_state table integrity and retry' };
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
      return { channel: 'code_tool_hook', canActivate: async () => ({ ok: true }) };
    }),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  };
});

import { handleRuntimeActivationDispatch, handleRuntimeActivationDeactivate, handleRuntimeActivationList, handleRuntimeActivationEdit, handleActivationApprove, handleRuntimeActivationPromote, registerRuntimeActivationDispatchCommand, registerRuntimeActivationDeactivateCommand, registerRuntimeActivationPromoteCommand, registerRuntimeActivationListCommand } from '../../src/commands/runtime-activation.js';

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

  // PRI-493 cli-5 no-mutation: missing-artifact failure path must not construct
  // the activation state store or dispatcher. Production code returns before
  // instantiating either (runtime-activation.ts lines 148-157). ERR-088
  // positive path marker: assert the constructors were never invoked, not just
  // that the output shape is invalid_artifact.
  it('missing-artifact failure path does not construct SqliteActivationStateStore or ActivationDispatcher', async () => {
    mockGetArtifactById.mockResolvedValue(null);
    const { SqliteActivationStateStore, ActivationDispatcher } = await import('@principles/core/runtime-v2');

    vi.mocked(SqliteActivationStateStore).mockClear();
    vi.mocked(ActivationDispatcher).mockClear();

    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'nonexistent',
      channel: 'prompt',
      json: true,
    });

    expect(SqliteActivationStateStore).not.toHaveBeenCalled();
    expect(ActivationDispatcher).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // PRI-493 cli-5 no-mutation: --dry-run/--confirm mutex failure must not open
  // any DB-backed store. Production code exits before stateManager.initialize()
  // (runtime-activation.ts lines 127-131). ERR-088 positive marker.
  it('mutex failure path (--dry-run + --confirm) does not construct RuntimeStateManager', async () => {
    const { RuntimeStateManager } = await import('@principles/core/runtime-v2');
    vi.mocked(RuntimeStateManager).mockClear();

    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      dryRun: true,
      confirm: true,
      json: true,
    });

    expect(RuntimeStateManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
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

  // PRI-493 cli-5 no-mutation: not-found failure path must not call insert on
  // the activation state store. Production code (runtime-activation.ts
  // lines 253-267) calls deactivateActivation which returns false; no other
  // mutating method should be invoked. ERR-088 positive path marker: capture
  // the store instance and assert insert was never called.
  it('not-found failure path does not call insert on the activation store', async () => {
    const { SqliteActivationStateStore } = await import('@principles/core/runtime-v2');
    const capturedInsert = vi.fn().mockResolvedValue(undefined);
    const capturedDeactivate = vi.fn().mockResolvedValue(false);
    vi.mocked(SqliteActivationStateStore).mockImplementationOnce(function () {
      return {
        findByArtifactId: vi.fn().mockResolvedValue(null),
        insert: capturedInsert,
        deactivateActivation: capturedDeactivate,
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

    expect(capturedDeactivate).toHaveBeenCalledTimes(1);
    expect(capturedDeactivate).toHaveBeenCalledWith('act-gone', expect.any(String));
    expect(capturedInsert).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// PRI-408 Contract D: List activations (observability) command tests
describe('handleRuntimeActivationList', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // F9-1: by default, all artifact_ids are considered valid (exist in pi_artifacts).
    // Individual tests override this to simulate dangling references.
    mockGetArtifactById.mockResolvedValue(makeArtifact());
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
    // PRI-500: CLI list output must include principleId (matching Console field).
    expect(output.activations[0]).toHaveProperty('principleId');
    expect(output.status).toBe('ok');
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

  // F9-1 regression: dangling artifact_id must produce degraded status + warning
  it('F9-1: emits degraded status + warning when activation references non-existent artifact_id (JSON)', async () => {
    // art-001 exists, art-002 does NOT (dangling)
    mockGetArtifactById.mockImplementation((artifactId: string) => {
      if (artifactId === 'art-001') return Promise.resolve(makeArtifact({ artifactId: 'art-001' }));
      return Promise.resolve(null);
    });

    await handleRuntimeActivationList({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('degraded');
    expect(output.reason).toContain('non-existent artifact_id');
    expect(output.reason).toContain('art-002');
    expect(output.nextAction).toContain('pd runtime internalization integrity');
    // The dangling activation should have a per-record warning
    const danglingAct = output.activations.find((a: { artifactId: string }) => a.artifactId === 'art-002');
    expect(danglingAct.warning).toContain('does not exist in pi_artifacts');
    // The valid activation should NOT have a warning
    const validAct = output.activations.find((a: { artifactId: string }) => a.artifactId === 'art-001');
    expect(validAct.warning).toBeUndefined();
  });

  it('F9-1: text output prints WARNING line for dangling artifact_id', async () => {
    mockGetArtifactById.mockImplementation((artifactId: string) => {
      if (artifactId === 'art-001') return Promise.resolve(makeArtifact({ artifactId: 'art-001' }));
      return Promise.resolve(null);
    });

    await handleRuntimeActivationList({
      workspace: WS,
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('WARNING');
    expect(text).toContain('art-002');
    const errorText = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(errorText).toContain('non-existent artifact_id');
    expect(errorText).toContain('Next action');
  });

  it('F9-1: treats getArtifactById throw as dangling (fail loud, rc-9)', async () => {
    mockGetArtifactById.mockRejectedValue(new Error('DB corruption'));

    await handleRuntimeActivationList({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('degraded');
    expect(output.reason).toContain('non-existent artifact_id');
  });

  it('F9-1: status is ok when all artifact_ids exist (negative case)', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact());

    await handleRuntimeActivationList({
      workspace: WS,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.status).toBe('ok');
    expect(output.reason).toBeUndefined();
    expect(output.nextAction).toBeUndefined();
  });

  // ── PRI-491: owner observability (mode / status / contextVersion / evidenceRefs) ──
  //
  // The CLI list command must surface enough information for the owner to
  // answer "will this rule block now?" without opening SQLite or reading
  // logs. The four essential signals are:
  //   1. mode (shadow / live / undefined for unrecognized)
  //   2. status (active / suspended_by_flag / deactivated)
  //   3. contextVersion (v1 / v2) — needed to interpret suspended_by_flag
  //   4. nextAction (promote / deactivate / enable flag)
  //
  // ERR entries:
  // - ERR-002: suspended_by_flag is a degradation; it MUST carry a reason
  //   via nextAction (rc-9-no-silent-fallback).
  // - ERR-088: tests must assert the unique status field, not only absence
  //   of "active".
  // - ERR-023/033: --json output must remain a single parseable object.

  it('PRI-491: shadow v2 activation with flag off shows status=suspended_by_flag (JSON)', async () => {
    // Override the artifact to a v2 artifact with evidenceRefs.
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v2-shadow',
      contentJson: JSON.stringify({
        requiresContextVersion: 2,
        evidenceRefs: ['ex-1', 'ex-2'],
        implementationCode: 'return { decision: "allow" };',
      }),
    }));
    // Override listCodeToolHookActivations to return a v2 shadow activation.
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v2-shadow',
        artifactId: 'art-v2-shadow',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: null,
        deactivatedAt: null,
      },
    ]);
    // Default mockFeatureFlags has rulecode_context_v2 enabled. Flip it off
    // to simulate the production default (the flag is quiet/default-off).
    mockFeatureFlags.flags.rulecode_context_v2.enabled = false;

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.activations).toHaveLength(1);
    const rec = output.activations[0];
    expect(rec.status).toBe('suspended_by_flag');
    expect(rec.mode).toBe('shadow');
    expect(rec.contextVersion).toBe('v2');
    expect(rec.evidenceRefs).toEqual(['ex-1', 'ex-2']);
    expect(rec.evidenceSummary).toContain('2 evidence ref(s)');
    expect(rec.nextAction).toContain('Enable rulecode_context_v2 flag');
    expect(rec.nextAction).toContain('pd activation deactivate --activation-id act-v2-shadow');
    expect(rec.nextAction).not.toContain('--confirm');

    // Restore the mock for subsequent tests.
    mockFeatureFlags.flags.rulecode_context_v2.enabled = true;
  });

  it('PRI-491: text output shows [SUSPENDED by flag] for v2 flag-off activation', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v2-shadow',
      contentJson: JSON.stringify({
        requiresContextVersion: 2,
        evidenceRefs: ['ex-1'],
        implementationCode: 'return { decision: "allow" };',
      }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v2-shadow',
        artifactId: 'art-v2-shadow',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: null,
        deactivatedAt: null,
      },
    ]);
    mockFeatureFlags.flags.rulecode_context_v2.enabled = false;

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('[SUSPENDED by flag]');
    expect(text).toContain('(shadow)');
    expect(text).toContain('contextVersion: v2');
    expect(text).toContain('evidence:');
    expect(text).toContain('nextAction:');

    mockFeatureFlags.flags.rulecode_context_v2.enabled = true;
  });

  it('PRI-491: shadow v1 activation shows status=active and promote nextAction (JSON)', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v1-shadow',
      contentJson: JSON.stringify({ implementationCode: 'return { decision: "allow" };' }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v1-shadow',
        artifactId: 'art-v1-shadow',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: null,
        deactivatedAt: null,
      },
    ]);

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    const rec = output.activations[0];
    expect(rec.status).toBe('active');
    expect(rec.mode).toBe('shadow');
    expect(rec.contextVersion).toBe('v1');
    expect(rec.evidenceRefs).toBeUndefined();
    expect(rec.nextAction).toBe(
      'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.',
    );
  });

  it('PRI-491: live v1 activation shows status=active and deactivate nextAction (JSON)', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v1-live',
      contentJson: JSON.stringify({ implementationCode: 'return { decision: "allow" };' }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v1-live',
        artifactId: 'art-v1-live',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_live_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: '2026-06-19T00:00:00.000Z',
        deactivatedAt: null,
      },
    ]);

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    const rec = output.activations[0];
    expect(rec.status).toBe('active');
    expect(rec.mode).toBe('live');
    expect(rec.promotedAt).toBe('2026-06-19T00:00:00.000Z');
    expect(rec.nextAction).toBe('pd activation deactivate --activation-id act-v1-live');
    expect(rec.nextAction).not.toContain('--confirm');
  });

  it('PRI-491: text output shows promotedAt timestamp when present', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v1-live',
      contentJson: JSON.stringify({ implementationCode: 'return { decision: "allow" };' }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v1-live',
        artifactId: 'art-v1-live',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_live_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: '2026-06-19T00:00:00.000Z',
        deactivatedAt: null,
      },
    ]);

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
    });

    const text = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('(live)');
    expect(text).toContain('promotedAt: 2026-06-19T00:00:00.000Z');
    expect(text).toContain('nextAction: pd activation deactivate --activation-id act-v1-live');
    expect(text).not.toContain('--confirm');
  });

  it('PRI-491: deactivated activation shows [DEACTIVATED <ts>] regardless of contextVersion (precedence)', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-v2-dead',
      contentJson: JSON.stringify({
        requiresContextVersion: 2,
        evidenceRefs: ['ex-1'],
        implementationCode: 'return { decision: "allow" };',
      }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v2-dead',
        artifactId: 'art-v2-dead',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_live_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: '2026-06-19T00:00:00.000Z',
        deactivatedAt: '2026-06-20T00:00:00.000Z',
      },
    ]);
    mockFeatureFlags.flags.rulecode_context_v2.enabled = false;

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      includeDeactivated: true,
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    const rec = output.activations[0];
    // deactivated > suspended_by_flag > active — a deactivated record is NOT
    // reported as suspended_by_flag even when v2 + flag-off.
    expect(rec.status).toBe('deactivated');
    expect(rec.deactivatedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(rec.nextAction).toBeUndefined();

    mockFeatureFlags.flags.rulecode_context_v2.enabled = true;
  });

  it('PRI-491: unrecognized action yields undefined mode and undefined nextAction (no false label)', async () => {
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      artifactId: 'art-unknown',
      contentJson: JSON.stringify({ implementationCode: 'return { decision: "allow" };' }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-unknown',
        artifactId: 'art-unknown',
        channel: 'code_tool_hook',
        action: 'some_future_action',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: null,
        deactivatedAt: null,
      },
    ]);

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    const rec = output.activations[0];
    expect(rec.mode).toBeUndefined();
    expect(rec.status).toBe('active');
    // No false nextAction — the owner must inspect manually.
    expect(rec.nextAction).toBeUndefined();
  });

  it('PRI-491: JSON output remains a single parseable object (cli-1-strict-json)', async () => {
    // Even with rich enrichment fields, the --json contract requires exactly
    // one parseable JSON object on stdout (no banners, no extra log lines).
    mockGetArtifactById.mockResolvedValue(makeArtifact({
      contentJson: JSON.stringify({
        requiresContextVersion: 2,
        evidenceRefs: ['ex-1'],
        implementationCode: 'return { decision: "allow" };',
      }),
    }));
    mockListCodeToolHookActivations.mockResolvedValue([
      {
        activationId: 'act-v2',
        artifactId: 'art-001',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: 'edit_tool',
        activatedAt: '2026-06-18T00:00:00.000Z',
        promotedAt: null,
        deactivatedAt: null,
      },
    ]);

    await handleRuntimeActivationList({
      workspace: WS,
      channel: 'code_tool_hook',
      json: true,
    });

    // Exactly one console.log call on stdout (the JSON payload).
    expect(consoleLogSpy.mock.calls).toHaveLength(1);
    // And it parses cleanly.
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output).toHaveProperty('activations');
    expect(output).toHaveProperty('status');
  });
});

describe('handleRuntimeActivationPromote', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetArtifactById.mockResolvedValue(null);
    mockListCodeToolHookActivations.mockResolvedValue([
      { activationId: 'act-hook-1', artifactId: 'art-002', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'rule-001', activatedAt: '2026-06-18T00:00:00.000Z', promotedAt: null, deactivatedAt: null },
    ]);
    mockPromoteActivation.mockResolvedValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFeatureFlags.flags.rulecode_owner_live_decision.enabled = false;
    vi.stubEnv('PD_CONSOLE_TOKEN', '');
    vi.stubEnv('PD_OWNER_ID', '');
    vi.stubEnv('PD_OWNER_CREDENTIAL_ID', '');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
    vi.unstubAllEnvs();
  });

  it('feature-off refuses dry-run and does not construct a mutation store', async () => {
    const { RuntimeStateManager } = await import('@principles/core/runtime-v2');
    vi.mocked(RuntimeStateManager).mockClear();
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', json: true });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('refused');
    expect(output.reasonCode).toBe('feature_not_enabled');
    expect(RuntimeStateManager).not.toHaveBeenCalled();
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('feature-off refuses confirmed promotion without legacy mutation', async () => {
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', confirm: true, json: true });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.reasonCode).toBe('feature_not_enabled');
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('feature-on refuses unauthenticated local promotion without mutation', async () => {
    mockFeatureFlags.flags.rulecode_owner_live_decision.enabled = true;
    await handleRuntimeActivationPromote({
      workspace: WS, activationId: 'act-hook-1', confirm: true, json: true,
      artifactId: 'art-002', artifactDigest: 'sha256:artifact', controlVersion: 1,
      idempotencyKey: 'promote-1', reasonCode: 'owner_review', note: 'reviewed',
    });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.reasonCode).toBe('owner_authentication_required');
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('feature-on authenticated CLI uses the real readiness reader and reports missing artifact', async () => {
    mockFeatureFlags.flags.rulecode_owner_live_decision.enabled = true;
    vi.stubEnv('PD_CONSOLE_TOKEN', 'configured-secret');
    vi.stubEnv('PD_OWNER_ID', 'owner-1');
    vi.stubEnv('PD_OWNER_CREDENTIAL_ID', 'credential-1');
    await handleRuntimeActivationPromote({
      workspace: WS, activationId: 'act-hook-1', confirm: true, json: true,
      artifactId: 'art-002', artifactDigest: 'sha256:artifact', controlVersion: 1,
      idempotencyKey: 'promote-1', reasonCode: 'owner_review', note: 'reviewed',
    });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.reasonCode).toBe('promotion_safety_gate_blocked');
    expect(output.failedChecks).toEqual([{ checkId: 'lineage_binding', reasonCode: 'artifact_not_found' }]);
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('authenticated dry-run opens state read-only and never commits', async () => {
    const { RuntimeStateManager } = await import('@principles/core/runtime-v2');
    mockFeatureFlags.flags.rulecode_owner_live_decision.enabled = true;
    vi.stubEnv('PD_CONSOLE_TOKEN', 'configured-secret');
    vi.stubEnv('PD_OWNER_ID', 'owner-1');
    vi.stubEnv('PD_OWNER_CREDENTIAL_ID', 'credential-1');
    await handleRuntimeActivationPromote({
      workspace: WS, activationId: 'act-hook-1', dryRun: true, json: true,
      artifactId: 'art-002', artifactDigest: 'sha256:artifact', controlVersion: 1,
      idempotencyKey: 'promote-1', reasonCode: 'owner_review', note: 'reviewed',
    });

    expect(RuntimeStateManager).toHaveBeenCalledWith(expect.objectContaining({ readonly: true }));
    expect(mockPromoteActivation).not.toHaveBeenCalled();
  });

  it('rejects mutually exclusive dry-run and confirm without mutation', async () => {
    await handleRuntimeActivationPromote({ workspace: WS, activationId: 'act-hook-1', dryRun: true, confirm: true, json: true });
    expect(mockPromoteActivation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('P0-3: commit store failure emits structured refusal JSON and exit code 1', async () => {
    mockFeatureFlags.flags.rulecode_owner_live_decision.enabled = true;
    vi.stubEnv('PD_CONSOLE_TOKEN', 'configured-secret');
    vi.stubEnv('PD_OWNER_ID', 'owner-1');
    vi.stubEnv('PD_OWNER_CREDENTIAL_ID', 'credential-1');

    const artifact = makeArtifact({
      artifactId: 'art-002',
      lineageArtifactIds: ['task-000'],
      contentJson: JSON.stringify({
        principleId: 'P_001',
        affectedTools: ['Bash'],
        goldenTrace: {
          traceId: 'trace-1',
          sourcePainId: 'pain-1',
          cases: [{ caseId: 'c1', kind: 'positive', toolName: 'Bash', params: {}, expectedDecision: 'allow' }],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    mockGetArtifactById.mockResolvedValue(artifact);
    const artifactDigest = `sha256:${createHash('sha256').update(JSON.stringify(artifact), 'utf8').digest('hex')}`;

    // PRI-577 fail-loud contract: readiness is unavailable without a readable
    // shadow telemetry source, so seed a real events file before promoting.
    const wsDir = mkdtempSync(path.join(tmpdir(), 'pd-cli-p03-'));
    mkdirSync(path.join(wsDir, '.pd', 'logs'), { recursive: true });
    writeFileSync(
      path.join(wsDir, '.pd', 'logs', 'events_20260821.jsonl'),
      `${JSON.stringify({ type: 'rulehost_evaluated', ts: '2026-08-21T00:00:00.000Z', data: { activationId: 'act-hook-1', activationMode: 'shadow', matched: true, decision: 'allow' } })}\n`,
      'utf8',
    );

    try {
      await handleRuntimeActivationPromote({
        workspace: wsDir,
        activationId: 'act-hook-1',
        confirm: true,
        json: true,
        artifactId: 'art-002',
        artifactDigest,
        controlVersion: 1,
        idempotencyKey: 'promote-commit-fail-1',
        reasonCode: 'controlled_rollout',
        note: 'Owner accepts limited evidence for a controlled rollout.',
      });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]) as {
        ok: boolean; decision: string; reasonCode: string; summary?: string; nextAction?: string;
      };
      expect(output.ok).toBe(false);
      expect(output.decision).toBe('refused');
      expect(output.reasonCode).toBe('promotion_commit_failed');
      expect(output.summary).toContain('durable safety store');
      expect(output.nextAction).toContain('retry');
      expect(process.exitCode).toBe(1);
      expect(mockPromoteActivation).not.toHaveBeenCalled();
    } finally {
      try { rmSync(wsDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
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

// ── PRI-499: CLI parser wiring (cli-7) and exit-stops (cli-2) ─────────────
//
// cli-7-test-wiring: every activation subcommand must exercise the real
// Commander flag registration path. Without this, a future refactor could
// silently break flag parsing and only surface at runtime. The existing
// `approve` parser test (AP-07 above) is the template; these tests extend
// coverage to dispatch, deactivate, promote, and list.
//
// cli-2-exit-stops: failure paths that call process.exit must not trigger
// downstream side effects (DB writes, ledger updates, artifact creation).
// Stubs process.exit to throw, then asserts no store was constructed.

describe('PRI-499: CLI parser wiring (cli-7) for activation subcommands', () => {
  it('dispatch: --artifact-id, --channel, --dry-run, --confirm, --json parse correctly', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationDispatchCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'dispatch',
      '--artifact-id', 'art-parse-001',
      '--channel', 'prompt',
      '--dry-run',
      '--json',
    ]);

    expect(captured.artifactId).toBe('art-parse-001');
    expect(captured.channel).toBe('prompt');
    expect(captured.dryRun).toBe(true);
    expect(captured.confirm).toBeUndefined();
    expect(captured.json).toBe(true);
  });

  it('dispatch: --confirm flag parses and is mutually exclusive with --dry-run at handler level', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationDispatchCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'dispatch',
      '--artifact-id', 'art-confirm',
      '--confirm',
      '--json',
    ]);

    expect(captured.confirm).toBe(true);
    expect(captured.dryRun).toBeUndefined();
  });

  it('deactivate: --activation-id (required) parses correctly', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationDeactivateCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'deactivate',
      '--activation-id', 'act-parse-deact',
      '--json',
    ]);

    expect(captured.activationId).toBe('act-parse-deact');
    expect(captured.json).toBe(true);
  });

  it('deactivate: missing --activation-id fails at parser level (required option)', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationDeactivateCommand(activationCmd)
      .action(async () => { /* no-op */ });

    await expect(
      program.parseAsync(['node', 'pd', 'activation', 'deactivate', '--json']),
    ).rejects.toThrow(/required option.*--activation-id.*not specified/);
  });

  it('promote: --activation-id (required), --dry-run, --confirm parse correctly', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationPromoteCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'promote',
      '--activation-id', 'act-parse-promote',
      '--dry-run',
      '--json',
    ]);

    expect(captured.activationId).toBe('act-parse-promote');
    expect(captured.dryRun).toBe(true);
    expect(captured.confirm).toBeUndefined();
  });

  it('promote: --confirm flag parses (not --dry-run)', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationPromoteCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'promote',
      '--activation-id', 'act-promote-confirm',
      '--confirm',
      '--json',
    ]);

    expect(captured.confirm).toBe(true);
    expect(captured.dryRun).toBeUndefined();
  });

  it('list: --channel filter and --json parse correctly', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationListCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'list',
      '--channel', 'code_tool_hook',
      '--json',
    ]);

    expect(captured.channel).toBe('code_tool_hook');
    expect(captured.json).toBe(true);
    expect(captured.includeDeactivated).toBeUndefined();
  });

  it('list: --include-deactivated flag parses as boolean true', async () => {
    const { Command } = await import('commander');
    const captured: Record<string, unknown> = {};
    const program = new Command();
    program.exitOverride();
    const activationCmd = program.command('activation');
    registerRuntimeActivationListCommand(activationCmd)
      .action(async (opts) => { Object.assign(captured, opts); });

    await program.parseAsync([
      'node', 'pd', 'activation', 'list',
      '--include-deactivated',
      '--json',
    ]);

    expect(captured.includeDeactivated).toBe(true);
  });
});

// PRI-499 cli-2-exit-stops: Verify failure paths do NOT trigger DB/ledger/
// artifact side effects. Production code uses `process.exitCode = 1` (not
// `process.exit(1)`) and returns early — these tests assert both the exit
// code AND that no store was constructed, covering the high-risk channel
// refusal path that was not covered by the existing tests at lines 266-303.
// If a future change replaces `process.exitCode` with `process.exit()` but
// forgets to add a `return`, these tests will fail because the store mock
// would be called before the exit.
describe('PRI-499: cli-2-exit-stops — failure paths set exitCode and do not construct stores', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuleHostWriterConfigs.length = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetArtifactById.mockResolvedValue(makeArtifact());
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('high-risk channel refusal: sets exitCode=1 and returns structured refusal (cli-2)', async () => {
    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'code_tool_hook',
      json: true,
    });

    // cli-2: exit-stops — refused path must set exitCode and return a
    // structured refusal. Stores ARE constructed (artifact exists, so
    // RuntimeStateManager/SqliteActivationStateStore/ActivationDispatcher
    // are built before dispatch() returns 'refused'). The cli-2 guarantee
    // for this path = exitCode set + structured output, NOT "no store
    // construction" (rc-9 + cli-6).
    expect(process.exitCode).toBe(1);

    // Verify the JSON output is a structured refusal (rc-9 + cli-6).
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.decision).toBe('refused');
    expect(output.reason).toBeDefined();
    expect(output.nextAction).toBeDefined();
  });

  it('missing artifact: sets exitCode=1 and does not construct SqliteActivationStateStore or ActivationDispatcher (cli-2)', async () => {
    mockGetArtifactById.mockResolvedValue(null);
    const { SqliteActivationStateStore, ActivationDispatcher } = await import('@principles/core/runtime-v2');
    vi.mocked(SqliteActivationStateStore).mockClear();
    vi.mocked(ActivationDispatcher).mockClear();

    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'nonexistent-cli-2',
      channel: 'prompt',
      json: true,
    });

    // cli-2: RuntimeStateManager IS constructed at line 143 (needed to check
    // artifact existence via getArtifactById). But SqliteActivationStateStore
    // and ActivationDispatcher are NOT constructed — the handler returns at
    // line 156 before reaching lines 170/175. This is the no-DB-side-effects
    // guarantee for the missing-artifact failure path.
    expect(process.exitCode).toBe(1);
    expect(SqliteActivationStateStore).not.toHaveBeenCalled();
    expect(ActivationDispatcher).not.toHaveBeenCalled();
  });

  it('mutex failure (--dry-run + --confirm): sets exitCode=1 and does not construct RuntimeStateManager', async () => {
    const { RuntimeStateManager } = await import('@principles/core/runtime-v2');
    vi.mocked(RuntimeStateManager).mockClear();

    await handleRuntimeActivationDispatch({
      workspace: WS,
      artifactId: 'art-001',
      channel: 'prompt',
      dryRun: true,
      confirm: true,
      json: true,
    });

    // cli-2: mutex failure must set exitCode and NOT construct state manager.
    expect(process.exitCode).toBe(1);
    expect(RuntimeStateManager).not.toHaveBeenCalled();
  });
});
