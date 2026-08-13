import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import type { OpenClawPluginApi } from '../src/openclaw-sdk.js';

const dispatch = vi.fn<(event: HostEvent, next: (event: HostEvent) => Promise<HostEventResult>) => Promise<HostEventResult>>(
  (event, next) => next(event),
);
const createHostRuntime = vi.fn();
const handleBeforePromptBuild = vi.fn();
const handleBeforeToolCall = vi.fn();
const handleAfterToolCall = vi.fn();
const sharedEnabled = vi.hoisted(() => ({ value: true }));

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  createHostRuntime.mockImplementation((options) => {
    const runtime = actual.createHostRuntime(options);
    return { ...runtime, dispatch: (event: HostEvent) => dispatch(event, runtime.dispatch) };
  });
  return { ...actual, createHostRuntime };
});
vi.mock('../src/hooks/prompt.js', () => ({ handleBeforePromptBuild }));
vi.mock('../src/hooks/gate.js', () => ({ handleBeforeToolCall }));
vi.mock('../src/hooks/pain.js', () => ({ handleAfterToolCall }));
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
    config: {},
    logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    registerCommand: vi.fn(), registerService: vi.fn(), registerTool: vi.fn(), registerHttpRoute: vi.fn(),
    on: (name, handler) => { hooks.set(name, handler); },
  };
  return { api, hooks, info };
}

describe('PRI-523 OpenClaw production registration uses shared host runtime', () => {
  beforeEach(() => {
    dispatch.mockReset();
    dispatch.mockImplementation((event, next) => next(event));
    createHostRuntime.mockClear();
    handleBeforePromptBuild.mockReset();
    handleBeforeToolCall.mockReset();
    handleAfterToolCall.mockReset();
    sharedEnabled.value = true;
  });

  it.each([
    ['before_prompt_build', { prompt: 'hello', messages: [] }, { prependContext: 'shared prompt' }],
    ['before_tool_call', { toolName: 'write_file', params: { path: 'x' } }, { skipToolCall: true, reason: 'shared deny' }],
    ['after_tool_call', { toolName: 'write_file', result: 'ok' }, undefined],
  ] as const)('routes %s through the shared runtime and preserves the native result/side effect', async (hookName, nativeEvent, nativeResult) => {
    const { api, hooks } = createApi();
    plugin.register(api);
    const hook = hooks.get(hookName);
    expect(hook).toBeDefined();
    if (hookName === 'before_prompt_build') handleBeforePromptBuild.mockResolvedValue(nativeResult);
    if (hookName === 'before_tool_call') handleBeforeToolCall.mockReturnValue(nativeResult);

    const result = await hook?.(nativeEvent, {
      workspaceDir: 'D:/workspace', sessionId: 'session-1', agentId: 'agent-1', trigger: 'user',
    });

    expect(createHostRuntime).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: hookName, source: `openclaw:${hookName}` }),
      expect.any(Function),
    );
    if (hookName === 'after_tool_call') expect(handleAfterToolCall).toHaveBeenCalledOnce();
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
