import { describe, it, expect, vi } from 'vitest';
import plugin from '../src/index';
import type { PluginCommandDefinition } from '../src/openclaw-sdk.js';

describe('OpenClaw Plugin Scaffolding', () => {
  it('should export a valid register function', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.register).toBe('function');
  });
});

describe('Command Registration', () => {
  function createMockApi() {
    const registeredCommands: PluginCommandDefinition[] = [];
    return {
      registeredCommands,
      api: {
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
      } as any,
    };
  }

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

    const ctx = {
      args: 'test pain reason',
      config: { workspaceDir: '/mock', language: 'en' },
      sessionId: 'session-123',
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

    const ctx = {
      args: 'test pain reason',
      config: { language: 'en' },
    };

    const result = await pdPain!.handler(ctx);
    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });
});
