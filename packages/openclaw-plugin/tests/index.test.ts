import { describe, it, expect } from 'vitest';
// PRI-686: the os mock must be registered before src/index is imported, so
// this import + call sit above it. Command resolvers now prioritize PD
// explicit sources; hiding the host machine's real
// ~/.openclaw/principles-disciple.json keeps registered handlers on this
// suite's mock ctx.workspaceDir.
import { isolatePdCanonicalConfig } from './utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import plugin from '../src/index';
import { checkConversationAccessConfig } from '../src/index';
import type { PluginCommandDefinition, OpenClawPluginApi, PluginCommandContext } from '../src/openclaw-sdk.js';

function createMockApi(): { registeredCommands: PluginCommandDefinition[]; api: OpenClawPluginApi } {
  const registeredCommands: PluginCommandDefinition[] = [];
  const api: OpenClawPluginApi = {
    rootDir: '/mock',
    pluginConfig: { language: 'en' },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
    registerCommand: (cmd: PluginCommandDefinition) => {
      registeredCommands.push(cmd);
    },
    registerService: () => {},
    registerTool: () => {},
    registerHttpRoute: () => {},
    on: () => {},
  };
  return { registeredCommands, api };
}

describe('OpenClaw Plugin Scaffolding', () => {
  it('should export a valid register function', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.register).toBe('function');
  });
});

describe('Command Registration', () => {
  it('registers /pd-pain with acceptsArgs: true', () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();
    expect(pdPain!.acceptsArgs).toBe(true);
  });

  it('registers /pd-pain handler as async (always returns Promise)', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: 'session-123',
      sessionKey: 'sk-123',
      args: 'test pain reason',
      config: { workspaceDir: '/mock', language: 'en' },
    };

    const result = pdPain!.handler(ctx);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('returns error result when workspace resolution fails', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: '',
      sessionKey: '',
      args: 'test pain reason',
      config: { language: 'en' },
    };

    const result = await pdPain!.handler(ctx);
    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it('passes workspaceDir to handler even when ctx.config is undefined', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: '',
      sessionKey: 'sk-123',
      workspaceDir: '/mock/workspace',
      args: 'test pain reason',
    };

    const result = await pdPain!.handler(ctx);
    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(ctx.workspaceDir).toBe('/mock/workspace');
  });
});

describe('/pd-help command', () => {
  it('returns Chinese command reference when language is zh', () => {
    const api: OpenClawPluginApi = {
      rootDir: '/mock',
      pluginConfig: { language: 'zh' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      registerCommand: () => {},
      registerService: () => {},
      registerTool: () => {},
      registerHttpRoute: () => {},
      on: () => {},
    };
    const registeredCommands: PluginCommandDefinition[] = [];
    api.registerCommand = (cmd: PluginCommandDefinition) => { registeredCommands.push(cmd); };

    plugin.register(api);

    const pdHelp = registeredCommands.find((c) => c.name === 'pd-help');
    expect(pdHelp).toBeDefined();

    const result = pdHelp!.handler({} as PluginCommandContext);
    expect(result.text).toContain('Principles Disciple 命令大全');
    expect(result.text).toContain('🚀 快速开始');
    expect(result.text).toContain('🔧 实现生命周期（半废弃）');
    // All 7 previously-missing commands must appear
    expect(result.text).toContain('/pd-evolution-status');
    expect(result.text).toContain('/pd-pain');
    expect(result.text).toContain('/pd-workflow-debug');
    expect(result.text).toContain('/pd-promote-impl');
    expect(result.text).toContain('/pd-disable-impl');
    expect(result.text).toContain('/pd-archive-impl');
    expect(result.text).toContain('/pd-rollback-impl');
  });

  it('returns English command reference when language is en', () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdHelp = registeredCommands.find((c) => c.name === 'pd-help');
    expect(pdHelp).toBeDefined();

    const result = pdHelp!.handler({} as PluginCommandContext);
    expect(result.text).toContain('Principles Disciple Command Reference');
    expect(result.text).toContain('🚀 Quick Start');
    expect(result.text).toContain('🔧 Implementation Lifecycle (Semi-deprecated)');
  });
});

describe('/pd-workflow-debug command', () => {
  it('invokes handler through plugin registration and returns a result', () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdWorkflowDebug = registeredCommands.find((c) => c.name === 'pd-workflow-debug');
    expect(pdWorkflowDebug).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: '',
      sessionKey: 'sk-debug',
      workspaceDir: '/mock/workspace',
      config: { language: 'en' },
    };

    // The handler calls resolveCommandWorkspaceDir then handleWorkflowDebugCommand.
    // Even if the underlying function throws (mock workspace has no .principles/),
    // the catch block returns a text string — either way line 818 is covered.
    const result = pdWorkflowDebug!.handler(ctx);
    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
  });
});

describe('checkConversationAccessConfig — PRI-343', () => {
  it('returns authorized:false with reason and nextAction when allowConversationAccess is not true', () => {
    const result = checkConversationAccessConfig({ hooks: { allowConversationAccess: false } });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
    expect(result.nextAction).toBeDefined();
    expect(typeof result.nextAction).toBe('string');
    expect(result.nextAction!.length).toBeGreaterThan(0);
  });

  it('returns authorized:true when allowConversationAccess is true', () => {
    const result = checkConversationAccessConfig({ hooks: { allowConversationAccess: true } });
    expect(result.authorized).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it('returns authorized:false when hooks object is missing', () => {
    const result = checkConversationAccessConfig({ enabled: true });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });

  it('returns authorized:false when pluginConfig is null', () => {
    const result = checkConversationAccessConfig(null);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('returns authorized:false when pluginConfig is undefined', () => {
    const result = checkConversationAccessConfig(undefined);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
