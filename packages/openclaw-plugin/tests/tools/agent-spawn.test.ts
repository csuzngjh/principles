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

describe('createAgentSpawnTool', () => {
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
      waitForRun: vi.fn().mockResolvedValue({ status: 'ok' }),
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

  describe('execute', () => {
    // Helper to create tool and extract text result
    const executeTool = async (rawParams: Record<string, unknown>) => {
      const { createAgentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      const tool = createAgentSpawnTool(mockApi as OpenClawPluginApi);
      const result = await tool.execute('test-call-id', rawParams);
      return result.content[0]?.text || '';
    };

    it('should return a clear error when agentType is missing', async () => {
      const result = await executeTool({ task: 'Do something' });

      expect(result).toContain('缺少 agentType');
      expect(result).toContain('diagnostician');
      expect(mockSubagentRuntime.run).not.toHaveBeenCalled();
    });

    it('should return error for unknown agent type', async () => {
      const result = await executeTool({ agentType: 'unknown', task: 'Do something' });

      expect(result).toContain('未知的智能体类型');
      expect(result).toContain('diagnostician');
    });

    it('should reject tasks that look like peer-session communication misuse', async () => {
      const result = await executeTool({
        agentType: 'explorer',
        task: 'Send a message to another session using sessionKey abc-123'
      });

      expect(result).toContain('reserved for Principles Disciple internal workers');
      expect(result).toContain('sessions_send');
      expect(result).toContain('sessions_spawn');
      expect(mockSubagentRuntime.run).not.toHaveBeenCalled();
    });

    it('should return error when subagent runtime is not available', async () => {
      const apiWithoutRuntime = {
        ...mockApi,
        runtime: undefined,
      } as unknown as OpenClawPluginApi;

      const { createAgentSpawnTool } = await import('../../src/tools/agent-spawn.js');
      const tool = createAgentSpawnTool(apiWithoutRuntime);
      const result = await tool.execute('test-call-id', { agentType: 'explorer', task: 'Find files' });

      expect(result.content[0]?.text).toContain('Subagent runtime');
    });

    it('should spawn subagent with correct parameters', async () => {
      await executeTool({ agentType: 'explorer', task: 'Search for configuration files' });

      expect(mockSubagentRuntime.run).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Search for configuration files',
          deliver: false,
          lane: 'subagent',
        })
      );
    });

    it('should return success message on completion', async () => {
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'ok' });
      mockSubagentRuntime.getSessionMessages.mockResolvedValue({
        assistantTexts: ['Found 5 configuration files'],
      });

      const result = await executeTool({ agentType: 'explorer', task: 'Find config files' });

      expect(result).toContain('Explorer');
      expect(result).toContain('Found 5 configuration files');
    });

    it('should support async background mode without waiting for completion', async () => {
      const result = await executeTool({
        agentType: 'diagnostician',
        task: 'Analyze root cause',
        runInBackground: true
      });

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
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'timeout' });

      const result = await executeTool({ agentType: 'explorer', task: 'Complex task' });

      expect(result).toContain('Explorer');
    });

    it('should handle error status', async () => {
      mockSubagentRuntime.waitForRun.mockResolvedValue({
        status: 'error',
        error: 'Something went wrong',
      });

      const result = await executeTool({ agentType: 'explorer', task: 'Task that fails' });

      expect(result).toContain('Explorer');
      expect(result).toContain('Something went wrong');
    });

    it('should handle empty output', async () => {
      mockSubagentRuntime.waitForRun.mockResolvedValue({ status: 'ok' });
      mockSubagentRuntime.getSessionMessages.mockResolvedValue({
        assistantTexts: [],
      });

      const result = await executeTool({ agentType: 'explorer', task: 'Task with no output' });

      expect(result).toContain('Explorer');
    });

    it('should cleanup session after completion', async () => {
      await executeTool({ agentType: 'explorer', task: 'Task' });

      expect(mockSubagentRuntime.deleteSession).toHaveBeenCalled();
    });

    it('should support snake_case parameter names (agent_type, run_in_background)', async () => {
      // Test that snake_case parameters work as aliases
      const result = await executeTool({
        agent_type: 'diagnostician',  // snake_case instead of camelCase
        task: 'Analyze root cause',
        run_in_background: true
      });

      expect(mockSubagentRuntime.run).toHaveBeenCalled();
      expect(result).toContain('Diagnostician');
    });

    it('should support legacy async parameter as alias for runInBackground', async () => {
      const result = await executeTool({
        agentType: 'diagnostician',
        task: 'Analyze root cause',
        async: true,
      });

      expect(mockSubagentRuntime.run).toHaveBeenCalled();
      expect(mockSubagentRuntime.waitForRun).not.toHaveBeenCalled();
      expect(result).toContain('Diagnostician');
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
