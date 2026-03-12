/**
 * Agent Spawn Tool
 * 
 * Provides a tool for spawning subagents with predefined agent definitions.
 * Uses the low-level OpenClaw Subagent API.
 */

import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi, SubagentWaitResult } from '../openclaw-sdk.js';
import { loadAgentDefinition, listAvailableAgents } from '../core/agent-loader.js';

/**
 * Extract assistant text from session messages
 */
function extractAssistantText(messages: unknown): string {
  if (!messages || typeof messages !== 'object') return '';

  const m = messages as {
    assistantTexts?: string[];
    messages?: Array<{ role?: string; content?: string | Array<{ type: string; text?: string }> }>;
  };

  // Try assistantTexts helper first
  if (m.assistantTexts && Array.isArray(m.assistantTexts)) {
    return m.assistantTexts.join('\n');
  }

  // Fall back to parsing messages array
  if (m.messages && Array.isArray(m.messages)) {
    // Find the last assistant message
    for (let i = m.messages.length - 1; i >= 0; i--) {
      const msg = m.messages[i];
      if (msg.role === 'assistant' && msg.content) {
        if (typeof msg.content === 'string') {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string);
          if (textParts.length > 0) {
            return textParts.join('\n');
          }
        }
      }
    }
  }

  return '';
}

/**
 * Build the full system prompt for a subagent
 * Combines the agent definition with any context-specific additions
 */
function buildSubagentSystemPrompt(
  agentDef: { name: string; description: string; systemPrompt: string },
  _task: string
): string {
  // The systemPrompt from the agent definition is the main content
  // It will be appended to OpenClaw's minimal subagent prompt
  return agentDef.systemPrompt;
}

/**
 * Agent Spawn Tool definition
 */
export const agentSpawnTool = {
  name: 'pd_spawn_agent',
  description: `启动指定类型的子智能体执行任务。

可用的智能体类型:
- explorer: 快速收集证据（文件、日志、复现步骤）
- diagnostician: 根因分析（verb/adjective + 5Whys）
- auditor: 演绎审计（axiom/system/via-negativa）
- planner: 制定电影剧本计划
- implementer: 按计划执行代码修改
- reviewer: 代码审查（正确性、安全性、可维护性）
- reporter: 最终汇报（技术细节转管理报告）`,

  parameters: Type.Object({
    agentType: Type.String({
      description:
        '智能体类型: explorer, diagnostician, auditor, planner, implementer, reviewer, reporter',
    }),
    task: Type.String({
      description: '任务描述，详细说明子智能体需要完成的工作',
    }),
  }),

  /**
   * Execution logic for the agent spawn tool
   */
  async execute(
    params: { agentType: string; task: string },
    api: OpenClawPluginApi,
    _workspaceDir?: string
  ): Promise<string> {
    const { agentType, task } = params;

    // 1. Validate agent type
    const availableAgents = listAvailableAgents();
    if (!availableAgents.includes(agentType)) {
      return `❌ 未找到智能体定义: "${agentType}"。

可用的智能体: ${availableAgents.join(', ')}`;
    }

    // 2. Load agent definition
    const agentDef = loadAgentDefinition(agentType);
    if (!agentDef) {
      return `❌ 无法加载智能体定义: ${agentType}`;
    }

    // 3. Check subagent runtime availability
    const subagentRuntime = api.runtime?.subagent;
    if (!subagentRuntime) {
      return `❌ Subagent runtime 不可用。请确保 OpenClaw Gateway 正在运行。`;
    }

    // 4. Build session key
    const sessionKey = `agent:${agentType}:${randomUUID()}`;

    // 5. Build system prompt
    const extraSystemPrompt = buildSubagentSystemPrompt(agentDef, task);

    const startTime = Date.now();

    try {
      // 6. Run subagent
      await subagentRuntime.run({
        sessionKey,
        message: task,
        extraSystemPrompt,
        lane: 'subagent',
        deliver: false, // Critical: don't send directly to external channels
        idempotencyKey: randomUUID(),
      });

      // 7. Wait for completion
      const result: SubagentWaitResult = await subagentRuntime.waitForRun({
        runId: sessionKey,
      });

      const duration = Date.now() - startTime;

      // 8. Handle timeout
      if (result.status === 'timeout') {
        return `⚠️ 智能体 **${agentDef.name}** 执行超时 (${(duration / 1000).toFixed(1)}s)。

建议：
- 简化任务描述
- 分解为多个子任务
- 检查任务是否需要更多上下文`;
      }

      // 9. Handle error
      if (result.status === 'error') {
        return `❌ 智能体 **${agentDef.name}** 执行失败: ${result.error || '未知错误'}`;
      }

      // 10. Get results
      const messages = await subagentRuntime.getSessionMessages({ sessionKey });
      const output = extractAssistantText(messages);

      if (!output || output.trim() === '') {
        return `⚠️ 智能体 **${agentDef.name}** 执行完成，但没有返回输出。`;
      }

      // 11. Return formatted result
      return `✅ **${agentDef.name}** 执行完成 (${(duration / 1000).toFixed(1)}s)

---

${output}`;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return `❌ 智能体 **${agentDef.name}** 执行异常: ${errorMsg}`;
    } finally {
      // 12. Cleanup session
      try {
        await subagentRuntime.deleteSession({ sessionKey });
      } catch {
        // Ignore cleanup errors
      }
    }
  },
};

/**
 * Batch spawn multiple agents in sequence
 * Useful for evolution workflow
 */
export async function spawnAgentSequence(
  agents: Array<{ type: string; task: string }>,
  api: OpenClawPluginApi,
  onProgress?: (agent: string, result: string) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const { type, task } of agents) {
    const result = await agentSpawnTool.execute({ agentType: type, task }, api);
    results.set(type, result);
    onProgress?.(type, result);
  }

  return results;
}
