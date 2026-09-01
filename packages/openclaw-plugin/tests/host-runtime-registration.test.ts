import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import type { OpenClawPluginApi } from '../src/openclaw-sdk.js';

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
const handleBeforeToolCall = vi.fn();
const handleAfterToolCall = vi.fn();
const prepareOrdinaryAfterToolCallForSharedRuntime = vi.fn(() => ({}));
const handleSharedPainEvidenceResult = vi.fn();
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
vi.mock('../src/hooks/prompt.js', () => ({ handleBeforePromptBuild }));
vi.mock('../src/hooks/gate.js', () => ({ handleBeforeToolCall }));
vi.mock('../src/hooks/pain.js', () => ({ handleAfterToolCall, prepareOrdinaryAfterToolCallForSharedRuntime, handleSharedPainEvidenceResult }));
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
vi.mock('../src/core/workspace-guidance-migrator.js', () => ({ migrateStaleWorkspaceGuidance: vi.fn() }));
vi.mock('../src/core/init.js', () => ({ ensureWorkspaceTemplates: vi.fn() }));
vi.mock('../src/core/system-logger.js', () => ({ SystemLogger: { log: vi.fn() } }));
vi.mock('../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => ({ eventLog: { recordHookExecution: vi.fn() } })),
  },
}));
vi.mock('../src/service/evolution-worker.js', () => ({ EvolutionWorkerService: { start: vi.fn() } }));
vi.mock('../src/service/correction-observer-service.js', () => ({ CorrectionObserverService: { start: vi.fn() } }));
vi.mock('../src/service/internalization-auto-consumer-service.js', () => ({ InternalizationAutoConsumerService: { start: vi.fn() } }));

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
    handleBeforeToolCall.mockReset();
    handleAfterToolCall.mockReset();
    prepareOrdinaryAfterToolCallForSharedRuntime.mockClear();
    handleSharedPainEvidenceResult.mockClear();
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
    if (hookName === 'before_tool_call') handleBeforeToolCall.mockReturnValue(nativeResult);

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
      expect(prepareOrdinaryAfterToolCallForSharedRuntime).toHaveBeenCalledOnce();
      expect(handleSharedPainEvidenceResult).toHaveBeenCalledOnce();
      expect(handleAfterToolCall).not.toHaveBeenCalled();
    }
    if (hookName === 'before_tool_call') expect(handleBeforeToolCall).not.toHaveBeenCalled();
    expect(result).toEqual(nativeResult);
  });

  it('keeps the observable legacy route when abstraction_layer_v1 is explicitly false', async () => {
    sharedEnabled.value = false;
    const legacyResult = { skipToolCall: true, reason: 'legacy deny' };
    handleBeforeToolCall.mockReturnValue(legacyResult);
    const { api, hooks, info } = createApi();
    plugin.register(api);

    const result = hooks.get('before_tool_call')?.(
      { toolName: 'write_file', params: { path: 'x' } },
      { workspaceDir: 'D:/workspace', sessionId: 'session-1' },
    );

    expect(result).toEqual(legacyResult);
    expect(result).not.toBeInstanceOf(Promise);
    expect(dispatch).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('abstraction_layer_v1_disabled'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('openclaw_legacy'));
  });
});
