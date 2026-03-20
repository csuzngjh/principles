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

const INTERNAL_AGENT_USAGE_GUIDANCE =
  'pd_run_worker is only for Principles Disciple internal workers. ' +
  'Use agents_list / sessions_list / sessions_spawn / sessions_send for peer agents or cross-session communication.';

function buildInternalAgentUsageMessage(availableAgents: string[]): string {
  return [
    'pd_run_worker is reserved for Principles Disciple internal workers.',
    `Allowed internal roles: ${availableAgents.join(', ')}`,
    'Use `agents_list` to discover peer agent ids.',
    'Use `sessions_spawn` to create or orchestrate another session.',
    'Use `sessions_list` to inspect running sessions.',
    'Use `sessions_send` to talk to another existing session.',
  ].join('\n');
}

function looksLikeSessionOrPeerCoordinationTask(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return false;

  const explicitMarkers = [
    'sessions_send',
    'sessions_spawn',
    'sessions_list',
    'agents_list',
    'sessionkey',
    'session key',
    'sessionid',
    'session id',
    'agentid',
    'agent id',
    'other session',
    'another session',
    'peer agent',
    'other agent',
    'another agent',
    'same-level agent',
    'same level agent',
    'cross-session',
    'cross session',
    'send a message to',
    'message another session',
    'talk to another session',
    '同级智能体',
    '另一个智能体',
    '其他智能体',
    '另一个会话',
    '其他会话',
    '跨会话',
    '给另一个会话发消息',
  ];

  return explicitMarkers.some((marker) => normalized.includes(marker));
}

/**
 * Helper to read string parameter from rawParams
 * Supports both camelCase and snake_case parameter names
 */
function readStringParam(rawParams: Record<string, unknown>, key: string): string | undefined {
  const value = rawParams[key];
  if (typeof value === 'string') return value.trim() || undefined;
  
  // Try snake_case alias
  const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  const snakeValue = rawParams[snakeKey];
  if (typeof snakeValue === 'string') return snakeValue.trim() || undefined;
  
  return undefined;
}

/**
 * Helper to read boolean parameter from rawParams
 * Supports both camelCase and snake_case parameter names
 */
function readBooleanParam(rawParams: Record<string, unknown>, key: string): boolean | undefined {
  const value = rawParams[key];
  if (typeof value === 'boolean') return value;
  
  // Try snake_case alias
  const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  const snakeValue = rawParams[snakeKey];
  if (typeof snakeValue === 'boolean') return snakeValue;
  
  return undefined;
}

/**
 * Create Agent Spawn Tool
 * 
 * Uses factory pattern to capture `api` in closure, following OpenClaw plugin SDK conventions.
 * The execute signature must be: async (_toolCallId: string, rawParams: Record<string, unknown>)
 */
export function createAgentSpawnTool(api: OpenClawPluginApi) {
  return {
    name: 'pd_run_worker',
    description: `启动指定类型的子智能体执行任务。

可用的智能体类型:
- explorer: 快速收集证据（文件、日志、复现步骤）
- diagnostician: 根因分析（verb/adjective + 5Whys）
- auditor: 演演审计（axiom/system/via-negativa）
- planner: 制定电影剧本计划
- implementer: 按计划执行代码修改
- reviewer: 代码审查（正确性、安全性、可维护性）
- reporter: 最终汇报（技术细节转管理报告）

示例调用: pd_run_worker(agentType="diagnostician", task="分析 Pain 7386ccfb 的根因")`,

    parameters: Type.Object({
      agentType: Type.String({
        description:
          '【必填】智能体类型，必须是以下之一: explorer, diagnostician, auditor, planner, implementer, reviewer, reporter',
      }),
      task: Type.String({
        description: '【必填】任务描述，告诉智能体要做什么',
      }),
      runInBackground: Type.Optional(Type.Boolean({
        description: '【可选】是否后台运行。true=立即返回不等待结果，false=等待执行完成。默认 false',
      })),
    }),

    /**
     * Execution logic for the agent spawn tool
     * 
     * OpenClaw tool execute signature:
     * - First parameter: _toolCallId (string) - the tool call ID
     * - Second parameter: rawParams (Record<string, unknown>) - the actual parameters
     * - Third parameter (optional): signal (AbortSignal) - for cancellation
     */
    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>
    ): Promise<{ content: Array<{ type: string; text: string }> }> {
      const agentType = readStringParam(rawParams, 'agentType') || '';
      const task = readStringParam(rawParams, 'task') || '';
      const runAsync = readBooleanParam(rawParams, 'runInBackground') === true;
      const availableInternalAgents = listAvailableAgents();

      api.logger?.info?.(`[PD:AgentSpawn] Received rawParams: ${JSON.stringify(rawParams)}`);

      if (!agentType) {
        api.logger?.warn?.(`[PD:AgentSpawn] Missing or invalid agentType: ${JSON.stringify(rawParams)}`);
        return {
          content: [{
            type: 'text',
            text: `❌ 缺少 agentType 参数。请按以下格式调用:

pd_run_worker(
  agentType="diagnostician",  // 必填: explorer, diagnostician, auditor, planner, implementer, reviewer, reporter
  task="分析问题的根因"        // 必填: 任务描述
)

可用的智能体类型: ${availableInternalAgents.join(', ')}`
          }]
        };
      }

      if (!task) {
        api.logger?.warn?.(`[PD:AgentSpawn] Missing task parameter: ${JSON.stringify(rawParams)}`);
        return {
          content: [{
            type: 'text',
            text: `❌ 缺少 task 参数。请提供任务描述，例如:

pd_run_worker(
  agentType="${agentType || 'diagnostician'}",
  task="分析 Pain xxx 的根因"
)`
          }]
        };
      }

      if (looksLikeSessionOrPeerCoordinationTask(task)) {
        api.logger?.warn?.(`[PD:AgentSpawn] Rejected likely peer/session misuse for task: ${task}`);
        return {
          content: [{
            type: 'text',
            text: buildInternalAgentUsageMessage(availableInternalAgents)
          }]
        };
      }

      if (!availableInternalAgents.includes(agentType)) {
        return {
          content: [{
            type: 'text',
            text: `❌ 未知的智能体类型: "${agentType}"

可用的智能体类型: ${availableInternalAgents.join(', ')}

示例: pd_run_worker(agentType="diagnostician", task="分析问题根因")`
          }]
        };
      }

      // Load agent definition
      const agentDef = loadAgentDefinition(agentType);
      if (!agentDef) {
        return {
          content: [{
            type: 'text',
            text: `❌ 无法加载智能体定义: ${agentType}`
          }]
        };
      }

      // Check subagent runtime availability
      const subagentRuntime = api.runtime?.subagent;
      if (!subagentRuntime) {
        return {
          content: [{
            type: 'text',
            text: `❌ Subagent runtime 不可用。请确保 OpenClaw Gateway 正在运行。`
          }]
        };
      }

      // Build session key
      const sessionKey = `agent:${agentType}:${randomUUID()}`;

      // Build system prompt
      const extraSystemPrompt = buildSubagentSystemPrompt(agentDef, task);

      const startTime = Date.now();

      try {
        // Run subagent
        await subagentRuntime.run({
          sessionKey,
          message: task,
          extraSystemPrompt,
          lane: 'subagent',
          deliver: false, // Critical: don't send directly to external channels
          idempotencyKey: randomUUID(),
        });

        if (runAsync) {
          const duration = Date.now() - startTime;
          return {
            content: [{
              type: 'text',
              text: `✅ 已在后台启动 **${agentDef.name}** (${(duration / 1000).toFixed(1)}s)。它不会阻塞当前对话。`
            }]
          };
        }

        // Wait for completion (with configurable timeout to prevent indefinite block)
        const timeoutMs = (api as any).config?.get?.('intervals.task_timeout_ms') || (30 * 60 * 1000);
        const result: SubagentWaitResult = await subagentRuntime.waitForRun({
          runId: sessionKey,
          timeoutMs,
        });

        const duration = Date.now() - startTime;

        // Handle timeout
        if (result.status === 'timeout') {
          return {
            content: [{
              type: 'text',
              text: `⚠️ 智能体 **${agentDef.name}** 执行超时 (${(duration / 1000).toFixed(1)}s)。

建议：
- 简化任务描述
- 分解为多个子任务
- 检查任务是否需要更多上下文`
            }]
          };
        }

        // Handle error
        if (result.status === 'error') {
          return {
            content: [{
              type: 'text',
              text: `❌ 智能体 **${agentDef.name}** 执行失败: ${result.error || '未知错误'}`
            }]
          };
        }

        // Get results
        const messages = await subagentRuntime.getSessionMessages({ sessionKey });
        const output = extractAssistantText(messages);

        if (!output || output.trim() === '') {
          return {
            content: [{
              type: 'text',
              text: `⚠️ 智能体 **${agentDef.name}** 执行完成，但没有返回输出。`
            }]
          };
        }

        // Return formatted result
        return {
          content: [{
            type: 'text',
            text: `✅ **${agentDef.name}** 执行完成 (${(duration / 1000).toFixed(1)}s)

---

${output}`
          }]
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text',
            text: `❌ 智能体 **${agentDef.name}** 执行异常: ${errorMsg}`
          }]
        };
      } finally {
        // Cleanup session (P1 fix: log failures instead of silent swallow)
        if (!runAsync) {
          try {
            await subagentRuntime.deleteSession({ sessionKey });
          } catch (cleanupErr) {
            const cleanupErrMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            api.logger?.error?.(`[PD:AgentSpawn] Failed to cleanup session ${sessionKey}: ${cleanupErrMsg}`);
          }
        }
      }
    },
  };
}

// Legacy export for backward compatibility with internal code
// This is the "unconfigured" tool that needs to be created via createAgentSpawnTool()
export const agentSpawnTool = {
  name: 'pd_run_worker',
  description: `启动指定类型的子智能体执行任务。

可用的智能体类型:
- explorer: 快速收集证据（文件、日志、复现步骤）
- diagnostician: 根因分析（verb/adjective + 5Whys）
- auditor: 演演审计（axiom/system/via-negativa）
- planner: 制定电影剧本计划
- implementer: 按计划执行代码修改
- reviewer: 代码审查（正确性、安全性、可维护性）
- reporter: 最终汇报（技术细节转管理报告）

示例调用: pd_run_worker(agentType="diagnostician", task="分析 Pain 7386ccfb 的根因")`,
  parameters: Type.Object({
    agentType: Type.String({
      description:
        '【必填】智能体类型，必须是以下之一: explorer, diagnostician, auditor, planner, implementer, reviewer, reporter',
    }),
    task: Type.String({
      description: '【必填】任务描述，告诉智能体要做什么',
    }),
    runInBackground: Type.Optional(Type.Boolean({
      description: '【可选】是否后台运行。true=立即返回不等待结果，false=等待执行完成。默认 false',
    })),
  }),
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
  const tool = createAgentSpawnTool(api);

  for (const { type, task } of agents) {
    const result = await tool.execute('', { agentType: type, task });
    const text = result.content[0]?.text || '';
    results.set(type, text);
    onProgress?.(type, text);
  }

  return results;
}