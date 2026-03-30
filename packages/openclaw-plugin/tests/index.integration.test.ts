import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from '../src/index';
import * as fs from 'fs';

vi.mock('fs');

describe('Plugin Integration', () => {
  let mockApi: any;
  let registeredHooks: Map<string, Function>;
  let registeredServices: any[];
  let registeredCommands: any[];
  let registeredRoutes: any[];

  beforeEach(() => {
    registeredHooks = new Map();
    registeredServices = [];
    registeredCommands = [];
    registeredRoutes = [];

    mockApi = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      pluginConfig: { language: 'en' },
      resolvePath: vi.fn((p: string) => `/resolved/${p}`),
      on: vi.fn((hookName: string, handler: Function) => {
        registeredHooks.set(hookName, handler);
      }),
      registerService: vi.fn((service: any) => {
        registeredServices.push(service);
      }),
      registerCommand: vi.fn((command: any) => {
        registeredCommands.push(command);
      }),
      registerHttpRoute: vi.fn((route: any) => {
        registeredRoutes.push(route);
      }),
      registerTool: vi.fn(),
    };

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('register()', () => {
    it('should NOT call resolvePath(".") during register', () => {
      plugin.register(mockApi);

      // 关键：register 不应该调用 resolvePath('.')
      // 因为它会返回进程工作目录，而不是配置的 workspace
      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });

    it('should register all required hooks', () => {
      plugin.register(mockApi);

      const expectedHooks = [
        'before_prompt_build',
        'before_tool_call',
        'after_tool_call',
        'before_reset',
        'before_compaction',
        'llm_output',
        'subagent_spawning',
        'subagent_ended',
      ];

      for (const hook of expectedHooks) {
        expect(registeredHooks.has(hook)).toBe(true);
      }
    });

    it('registers the Principles Console HTTP route', () => {
      plugin.register(mockApi);

      expect(registeredRoutes).toHaveLength(1);
      expect(registeredRoutes[0]).toEqual(expect.objectContaining({
        path: '/plugins/principles',
        auth: 'plugin',
        match: 'prefix',
        handler: expect.any(Function),
      }));
    });

    it('should use ctx.workspaceDir from hook context, not from register', async () => {
      plugin.register(mockApi);

      const handler = registeredHooks.get('before_prompt_build');
      expect(handler).toBeDefined();

      // 模拟正确的 workspaceDir 来自 context
      const mockCtx = {
        workspaceDir: '/correct/workspace/from/config',
        sessionKey: 'test-session',
        trigger: 'user',
      };

      // 调用 handler
      await handler({ prompt: 'test', messages: [] }, mockCtx);

      // 验证没有使用 resolvePath 的返回值
      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });

    it('should register EvolutionWorker service', () => {
      plugin.register(mockApi);

      const serviceIds = registeredServices.map((service) => service.id);
      expect(serviceIds).toContain('principles-evolution-worker');
      expect(serviceIds).toContain('principles-disciple-trajectory');
    });

    it('should register all slash commands', () => {
      plugin.register(mockApi);

      const commandNames = registeredCommands.map(c => c.name);
      const expectedCommands = [
        'pd-init',
        'pd-okr',
        'pd-evolve',
        'pd-bootstrap',
        'pd-research',
        'pd-thinking',
        'pd-status',
        'pd-daily',
        'pd-grooming',
        'pd-help'
      ];
      for (const cmd of expectedCommands) {
        expect(commandNames).toContain(cmd);
      }
    });
  });

  describe('workspaceDir source verification', () => {
    it('before_tool_call should use ctx.workspaceDir', () => {
      plugin.register(mockApi);

      const handler = registeredHooks.get('before_tool_call');
      const mockCtx = { workspaceDir: '/workspace/from/context' };

      // 调用 handler（不会 block）
      handler({ tool: 'write', params: {} }, mockCtx);

      // 关键：不应该调用 resolvePath
      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });

    it('after_tool_call should use ctx.workspaceDir', () => {
      plugin.register(mockApi);

      const handler = registeredHooks.get('after_tool_call');
      const mockCtx = { workspaceDir: '/workspace/from/context' };

      handler({ tool: 'write', result: { success: true } }, mockCtx);

      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });

    it('llm_output should use ctx.workspaceDir', () => {
      plugin.register(mockApi);

      const handler = registeredHooks.get('llm_output');
      const mockCtx = { workspaceDir: '/workspace/from/context' };

      handler({ assistantTexts: ['test'] }, mockCtx);

      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });
  });
});
