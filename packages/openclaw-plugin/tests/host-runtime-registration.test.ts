import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import type { OpenClawPluginApi } from '../src/openclaw-sdk.js';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';

// PRI-523: the after_tool_call route drives the real production pain-evidence
// kernel, which short-circuits (and skips the enrichment provider) when the
// workspace lacks a canonical trajectory.db. The registration test asserts
// that the enrichment provider and onAfterToolResult side-effect are wired
// through the shared runtime, so we provision a real temporary workspace
// with a schema-compatible trajectory.db for the after_tool_call case only.
const workspaces: string[] = [];
// PRI-640: hook workspace resolution gives Priority-1 PD explicit sources (env
// + ~/.openclaw PD config) precedence over the hook context, so a machine-level
// config can silently redirect this test into a real workspace whose trajectory
// schema lags this branch. Pin PD_WORKSPACE_DIR to the fixture so the test is
// hermetic on every machine; restored in afterEach.
const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

function workspaceWithTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-runtime-reg-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
  process.env.PD_WORKSPACE_DIR = workspaceDir;
  return workspaceDir;
}

const dispatch = vi.fn<(event: HostEvent, next: (event: HostEvent) => Promise<HostEventResult>) => Promise<HostEventResult>>(
  (event, next) => next(event),
);
const createProductionHostRuntime = vi.fn();
const handleBeforePromptBuild = vi.fn();
const handleSharedRuleHostResult = vi.fn();
const handleAfterToolCall = vi.fn();
const prepareOrdinaryAfterToolCallForSharedRuntime = vi.fn(() => ({ eventId: 'openclaw:registered-1' }));
const sharedEnabled = vi.hoisted(() => ({ value: true }));
const ensureConversationAccessInConfig = vi.hoisted(() => vi.fn(() => false));

vi.mock('../src/core/config-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config-health.js')>();
  return { ...actual, ensureConversationAccessInConfig };
});

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  createProductionHostRuntime.mockImplementation((options) => {
    const runtime = actual.createProductionHostRuntime(options);
    return { ...runtime, dispatch: (event: HostEvent) => dispatch(event, runtime.dispatch) };
  });
  return { ...actual, createProductionHostRuntime };
});
vi.mock('../src/hooks/prompt.js', () => ({ handleBeforePromptBuild, beginAdaptivePromptInvocation: vi.fn(() => 'test-shared-invocation') }));
vi.mock('../src/hooks/gate.js', () => ({ handleSharedRuleHostResult }));
vi.mock('../src/hooks/pain.js', () => ({ handleAfterToolCall, prepareOrdinaryAfterToolCallForSharedRuntime }));
vi.mock('../src/core/pd-config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/pd-config-loader.js')>();
  return {
    ...actual,
    loadFeatureFlagFromConfig: vi.fn((_workspaceDir: string, flagId: string) => ({
      enabled: flagId === 'abstraction_layer_v1' && sharedEnabled.value, source: 'user_config',
    })),
  };
});
vi.mock('../src/core/migration.js', () => ({ migrateDirectoryStructure: vi.fn() }));
// workspace-guidance-migrator mock removed (PRI-776): the module was deleted.
vi.mock('../src/core/init.js', () => ({ ensureWorkspaceTemplates: vi.fn() }));
vi.mock('../src/core/system-logger.js', () => ({ SystemLogger: { log: vi.fn() } }));
vi.mock('../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => ({ eventLog: { recordHookExecution: vi.fn() } })),
  },
}));
vi.mock('../src/service/correction-observer-service.js', () => ({ CorrectionObserverService: { start: vi.fn() } }));
vi.mock('../src/service/internalization-auto-consumer-service.js', () => ({ InternalizationAutoConsumerService: { start: vi.fn() }, persistOpenClawToolDeclaration: vi.fn() }));

const { default: plugin } = await import('../src/index.js');

type Hook = (...args: unknown[]) => unknown;

function createApi(): { api: OpenClawPluginApi; hooks: Map<string, Hook>; info: ReturnType<typeof vi.fn> } {
  const hooks = new Map<string, Hook>();
  const info = vi.fn();
  const api: OpenClawPluginApi = {
    id: 'principles-disciple',
    rootDir: '/plugin',
    pluginConfig: { language: 'en' },
    config: {
      plugins: {
        entries: {
          'principles-disciple': { hooks: { allowConversationAccess: true } },
        },
      },
    },
    logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    registerCommand: vi.fn(), registerService: vi.fn(), registerTool: vi.fn(), registerHttpRoute: vi.fn(),
    on: (name, handler) => { hooks.set(name, handler); },
  };
  return { api, hooks, info };
}

describe('PRI-523 OpenClaw production registration uses shared host runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dispatch.mockReset();
    dispatch.mockImplementation((event, next) => next(event));
    createProductionHostRuntime.mockClear();
    handleBeforePromptBuild.mockReset();
    handleSharedRuleHostResult.mockReset();
    handleAfterToolCall.mockReset();
    prepareOrdinaryAfterToolCallForSharedRuntime.mockClear();
    sharedEnabled.value = true;
    ensureConversationAccessInConfig.mockClear();
  });

  afterEach(() => {
    if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
    else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const workspaceDir of workspaces.splice(0)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  it('does not schedule a delayed write to the real OpenClaw home config', async () => {
    const { api } = createApi();
    plugin.register(api);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(ensureConversationAccessInConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['before_prompt_build', { prompt: 'hello', messages: [] }, { prependContext: 'shared prompt' }],
    ['before_tool_call', { toolName: 'write_file', params: { path: 'x' } }, undefined],
    ['after_tool_call', { toolName: 'write_file', result: 'ok' }, undefined],
  ] as const)('routes %s through the shared runtime and preserves the native result/side effect', async (hookName, nativeEvent, nativeResult) => {
    const { api, hooks } = createApi();
    plugin.register(api);
    const hook = hooks.get(hookName);
    expect(hook).toBeDefined();
    if (hookName === 'before_prompt_build') handleBeforePromptBuild.mockResolvedValue(nativeResult);

    // after_tool_call exercises the real production pain-evidence kernel, which
    // requires a schema-compatible trajectory.db to reach the enrichment provider
    // and onAfterToolResult side-effect. before_prompt_build / before_tool_call
    // do not touch the database, so they keep the synthetic workspace path.
    const workspaceDir = hookName === 'after_tool_call' ? workspaceWithTrajectory() : 'D:/workspace';

    const result = await hook?.(nativeEvent, {
      workspaceDir, sessionId: 'session-1', agentId: 'agent-1', trigger: 'user',
    });

    expect(createProductionHostRuntime).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: hookName, source: `openclaw:${hookName}` }),
      expect.any(Function),
    );
    if (hookName === 'after_tool_call') {
      // Phase A: the shared kernel records tool evidence only; the legacy
      // admission continuation is retired entirely.
      expect(prepareOrdinaryAfterToolCallForSharedRuntime).toHaveBeenCalledOnce();
      expect(handleAfterToolCall).not.toHaveBeenCalled();
    }
    // PR-1: `handleBeforeToolCall` is retired (no production wiring). The
    // equivalent registration fact — moved one layer up, to the adapter the
    // shared runtime actually calls — is that the assembled shared adapter
    // received the gate result for this dispatch.
    if (hookName === 'before_tool_call') expect(handleSharedRuleHostResult).toHaveBeenCalledOnce();

    expect(result).toEqual(nativeResult);
  });

  it('a stale abstraction_layer_v1=true/false in user config cannot revive the retired legacy route', async () => {
    // PRI-1137: the flag is a gone tombstone. Even an explicit enabled:true
    // (and certainly false) must not route ordinary hooks to plugin-local code.
    sharedEnabled.value = false;
    const { api, hooks } = createApi();
    plugin.register(api);

    await hooks.get('before_tool_call')?.(
      { toolName: 'write_file', params: { path: 'x' } },
      { workspaceDir: 'D:/workspace', sessionId: 'session-1' },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'before_tool_call', source: 'openclaw:before_tool_call' }),
      expect.any(Function),
    );
    // The flag cannot revive the retired route: the dispatch went through the
    // shared runtime and the shared adapter (not plugin-local legacy code)
    // consumed the result.
    expect(handleSharedRuleHostResult).toHaveBeenCalledOnce();
  });

  it('forwards an explicit scoped adaptive mapping through the shared prompt dispatch and leaves unconfigured Native unchanged', async () => {
    const { api, hooks } = createApi();
    const workspaceDir = workspaceWithTrajectory();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES ('artifact-target', 'principle', 'task-target', 'P_TARGET', '[]', 'validated', ?, ?, ?)
      `).run(JSON.stringify({ principleId: 'P_TARGET', text: 'Shared provider target principle.' }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'activation-target', idempotencyKey: 'target::prompt', artifactId: 'artifact-target',
        channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_TARGET', activatedAt: now, deactivatedAt: null,
      });
      connection.getDb().prepare(`
        INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
        VALUES ('approval-target', 'artifact-target', 'prompt', 'low', 'approved', 1, ?, ?, 'owner-1')
      `).run(now, now);
    } finally {
      connection.close();
    }
    Object.assign(api, {
      pluginConfig: {
        language: 'en',
        adaptiveActivation: {
          enabled: true,
          workspaceDir,
          artifactId: 'artifact-target',
          activationId: 'activation-target',
          softTimeoutMs: 1_000,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    let sharedPrompt: unknown;
    handleBeforePromptBuild.mockImplementation(async (_event, _context, prompt) => {
      sharedPrompt = prompt;
      return undefined;
    });
    plugin.register(api);
    await hooks.get('before_prompt_build')?.({
      prompt: '[PD-AA:delivery-review:v1]\nReview this delivery.',
      currentUserMessage: '[PD-AA:delivery-review:v1]\nReview this delivery.',
      currentUserMessageId: 'native-message-1',
      messages: [],
    }, { workspaceDir, sessionId: 'session-1', agentId: 'agent-1', trigger: 'user' });
    expect(sharedPrompt).toMatchObject({
      adaptivePacking: { status: 'target_present', targetActivationId: 'activation-target' },
    });

    const unconfigured = createApi();
    let nativePrompt: unknown;
    handleBeforePromptBuild.mockImplementationOnce(async (_event, _context, prompt) => {
      nativePrompt = prompt;
      return undefined;
    });
    plugin.register(unconfigured.api);
    await unconfigured.hooks.get('before_prompt_build')?.({ prompt: 'ordinary user input', messages: [] }, {
      workspaceDir, sessionId: 'session-2', agentId: 'agent-1', trigger: 'user',
    });
    expect(nativePrompt).not.toHaveProperty('adaptivePacking');
  });

  it('PRI-819: surfaces a shared-runtime dispatch failure observably instead of crashing the hook', async () => {
    const { api, hooks } = createApi();
    plugin.register(api);
    const workspaceDir = workspaceWithTrajectory();
    dispatch.mockRejectedValueOnce(new Error('kernel dispatch exploded (PRI-819)'));

    await expect(hooks.get('after_tool_call')?.(
      { toolName: 'write_file', result: 'ok' },
      { workspaceDir, sessionId: 'session-1', agentId: 'agent-1', trigger: 'user' },
    )).resolves.toBeUndefined();

    // rc-9: the degradation must be observable — structured hook-execution
    // error row (via WorkspaceContext.eventLog, mocked here) plus a log line
    // that names the live signal-collector path, not the retired agent.
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[PD:SignalCollector]'),
    );
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('kernel dispatch exploded (PRI-819)'),
    );
  });
});
