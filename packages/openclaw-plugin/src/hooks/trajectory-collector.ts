/**
 * Trajectory Collector - 行为进化引擎 Phase 0 数据收集
 * 
 * 收集工具调用和 LLM 输出到 memory/trajectories/ 目录
 * 用于分析工具使用模式、识别原则应用案例、评估行为质量
 */

import * as fs from 'fs';
import * as path from 'path';
import type { 
  PluginHookAfterToolCallEvent, 
  PluginHookToolContext, 
  PluginHookLlmOutputEvent, 
  PluginHookAgentContext,
  PluginHookBeforeMessageWriteEvent
} from '../openclaw-sdk.js';

const TRAJECTORY_DIR = 'memory/trajectories/';

/**
 * 确保轨迹目录存在
 */
function ensureTrajectoryDir(workspaceDir: string): string {
  const dir = path.join(workspaceDir, TRAJECTORY_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取今日轨迹文件名
 */
function getTodayFilename(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-${String(now.getUTCDate()).padStart(2, '0')}.jsonl`;
}

/**
 * 写入轨迹记录（JSON Lines 格式）
 */
function writeTrajectoryRecord(workspaceDir: string, record: object): void {
  const dir = ensureTrajectoryDir(workspaceDir);
  const filepath = path.join(dir, getTodayFilename());
  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(filepath, line, 'utf8');
  } catch (err) {
    // Silently fail - trajectory collection should not block main functionality
  }
}

/**
 * 工具调用完成后的处理
 * 记录：工具名、参数、结果、错误、执行时间
 */
export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string }
): void {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return;

  // 脱敏处理：移除敏感参数
  const sanitizedParams = sanitizeParams(event.params);

  writeTrajectoryRecord(workspaceDir, {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId || 'unknown',
    toolName: event.toolName,
    params: sanitizedParams,
    result: event.result ? String(event.result).slice(0, 500) : null,
    error: event.error || null,
    durationMs: event.durationMs,
    success: !event.error,
    runId: event.runId || null,
    toolCallId: event.toolCallId || null
  });
}

/**
 * LLM 输出处理
 * 记录：provider、model、输出长度、token 使用量
 */
export function handleLlmOutput(
  event: PluginHookLlmOutputEvent,
  ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return;

  const totalTextLength = event.assistantTexts?.reduce((sum, text) => sum + (text?.length || 0), 0) || 0;

  writeTrajectoryRecord(workspaceDir, {
    type: 'llm_output',
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId || 'unknown',
    provider: event.provider,
    model: event.model,
    textLength: totalTextLength,
    outputCount: event.assistantTexts?.length || 0,
    usage: event.usage || null
  });
}

/**
 * 消息写入前的处理
 * 记录：用户/助手消息内容
 */
export function handleBeforeMessageWrite(
  event: PluginHookBeforeMessageWriteEvent,
  ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) return;

  const msg = event.message;
  if (!msg || !msg.role) return;

  // 只记录 user 和 assistant 消息
  if (msg.role !== 'user' && msg.role !== 'assistant') return;

  // 提取文本内容
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }

  writeTrajectoryRecord(workspaceDir, {
    type: 'message',
    timestamp: new Date().toISOString(),
    sessionId: event.sessionKey || 'unknown',
    role: msg.role,
    contentLength: content.length,
    contentPreview: content.slice(0, 200),
    agentId: event.agentId || null
  });
}

/**
 * 脱敏处理：移除敏感参数
 */
function sanitizeParams(params: Record<string, any>): Record<string, any> {
  if (!params) return {};
  
  const sensitiveKeys = [
    'password', 'token', 'api_key', 'secret', 'credential',
    'authorization', 'cookie', 'session', 'key'
  ];
  
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 1000) {
      sanitized[key] = value.slice(0, 1000) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 轨迹汇总统计（供 cron 任务调用）
 */
export function computeTrajectoryStats(workspaceDir: string): object {
  const dir = ensureTrajectoryDir(workspaceDir);
  const todayFile = path.join(dir, getTodayFilename());
  
  if (!fs.existsSync(todayFile)) {
    return { date: getTodayFilename(), totalRecords: 0, toolCalls: 0, llmOutputs: 0, messages: 0 };
  }

  const content = fs.readFileSync(todayFile, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());
  
  const toolCalls = lines.filter(line => {
    try { return JSON.parse(line).type === 'tool_call'; } catch { return false; }
  }).length;
  
  const llmOutputs = lines.filter(line => {
    try { return JSON.parse(line).type === 'llm_output'; } catch { return false; }
  }).length;
  
  const messages = lines.filter(line => {
    try { return JSON.parse(line).type === 'message'; } catch { return false; }
  }).length;

  return {
    date: getTodayFilename(),
    totalRecords: lines.length,
    toolCalls,
    llmOutputs,
    messages,
    generatedAt: new Date().toISOString()
  };
}
