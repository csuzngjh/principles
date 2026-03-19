/**
 * Tests for Agent Spawn Tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenClawPluginApi } from '../../src/openclaw-sdk.js';

// Mock agent-loader
vi.mock('../../src/core/agent-loader.js', () => ({
  loadAgentDefinition: vi.fn(),
  listAvailableAgents: vi.fn(() => ['explorer', 'diagnostician', 'auditor']),
}));

describe('agentSpawnTool', () => {
  let mockApi: Partial<OpenClawPluginApi>;
  let mockSubagentRuntime: {
    run: ReturnType<typeof vi.fn>;
    waitForRun: ReturnType<typeof vi.fn>;
    getSessionMessages: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockSubagentRuntime = {
      run: vi.fn().mockResolvedValue(undefined),
      waitForRun: vi.fn().mockResolvedValue({ status: 'completed' }),
      getSessionMessages: vi.fn().mockResolvedValue({
        assistantTexts: ['Task completed successfully'],
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    mockApi = {
      runtime: {
        subagent: mockSubagentRuntime,
      } as OpenClawPluginApi['runtime'],
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      } as OpenClawPluginApi['logger'],
    } as Partial<OpenClawPluginApi>;

    // Reset the mock for agent-loader
    const { loadAgentDefinition, listAvailableAgents } = await import('../../src/core/agent-loader.js');
    vi.mocked(loadAgentDefinition).mockImplementation((name: string) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      description: `Test ${name} agent`,
      systemPrompt: `You are the ${name} agent.`,
    }));
    vi.mocked(listAvailableAgents).mockReturnValue(['explorer', 'diagnostician', 'auditor']);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('handler', () => {

    it('should return a clear error when agentType is missing', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');

      const result = await agentSpawnTool.execute(
        { task: 'Do something' } as any,
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Invalid agentType');
      expect(result).toContain('sessions_spawn');
      expect(mockSubagentRuntime.run).not.toHaveBeenCalled();
    });

    it('should return error for unknown agent type', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      const result = await agentSpawnTool.execute(
        { agentType: 'unknown', task: 'Do something' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Unknown internal worker role');
      expect(result).toContain('sessions_send');
    });

    it('should reject tasks that look like peer-session communication misuse', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Send a message to another session using sessionKey abc-123' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('reserved for Principles Disciple internal workers');
      expect(result).toContain('sessions_send');
      expect(result).toContain('sessions_spawn');
      expect(mockSubagentRuntime.run).not.toHaveBeenCalled();
    });
    it('should return error when subagent runtime is not available', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      const apiWithoutRuntime = {
        ...mockApi,
        runtime: undefined,
      } as unknown as OpenClawPluginApi;

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Find files' },
        apiWithoutRuntime
      );

      expect(result).toContain('Subagent runtime');
    });

    it('should spawn subagent with correct parameters', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Search for configuration files' },
        mockApi as OpenClawPluginApi
      );

      expect(mockSubagentRuntime.run).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Search for configuration files',
          deliver: false,
          lane: 'subagent',
        })
      );
    });

    it('should return success message on completion', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'completed' });
      mockSubagentRuntime.getSessionMessages.mockResolvedValue({
        assistantTexts: ['Found 5 configuration files'],
      });

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Find config files' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Explorer');
      expect(result).toContain('Found 5 configuration files');
    });

    it('should support async background mode without waiting for completion', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');

      const result = await agentSpawnTool.execute(
        { agentType: 'diagnostician', task: 'Analyze root cause', runInBackground: true },
        mockApi as OpenClawPluginApi
      );

      expect(mockSubagentRuntime.run).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Analyze root cause',
          deliver: false,
        })
      );
      expect(mockSubagentRuntime.waitForRun).not.toHaveBeenCalled();
      expect(mockSubagentRuntime.deleteSession).not.toHaveBeenCalled();
      expect(result).toContain('Diagnostician');
    });

    it('should handle timeout', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'timeout' });

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Complex task' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Explorer');
    });

    it('should handle error status', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      mockSubagentRuntime.waitForRun.mockResolvedValue({
        status: 'error',
        error: 'Something went wrong',
      });

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Task that fails' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Explorer');
      expect(result).toContain('Something went wrong');
    });

    it('should handle empty output', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'completed' });
      mockSubagentRuntime.getSessionMessages.mockResolvedValue({
        assistantTexts: [],
      });

      const result = await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Task with no output' },
        mockApi as OpenClawPluginApi
      );

      expect(result).toContain('Explorer');
    });

    it('should cleanup session after completion', async () => {
      const { agentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      
      await agentSpawnTool.execute(
        { agentType: 'explorer', task: 'Task' },
        mockApi as OpenClawPluginApi
      );

      expect(mockSubagentRuntime.deleteSession).toHaveBeenCalled();
    });
  });

  describe('spawnAgentSequence', () => {
    it('should spawn agents in sequence', async () => {
      const { spawnAgentSequence } = await import('../../src/tools/agent-spawn.js');
      
      const progressCallback = vi.fn();

      const agents = [
        { type: 'explorer', task: 'Find evidence' },
        { type: 'diagnostician', task: 'Analyze cause' },
      ];

      const results = await spawnAgentSequence(
        agents,
        mockApi as OpenClawPluginApi,
        progressCallback
      );

      expect(results.size).toBe(2);
      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(mockSubagentRuntime.run).toHaveBeenCalledTimes(2);
    });
  });
});
