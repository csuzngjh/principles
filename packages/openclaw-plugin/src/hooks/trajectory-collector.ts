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

// 敏感字段匹配正则
const SENSITIVE_KEY_PATTERN = /password|token|authorization|secret|api[_-]?key|credential|cookie|session/i;

// 最大字符串长度
const MAX_STRING_LENGTH = 1000;
const MAX_RESULT_LENGTH = 500;

/**
 * 递归脱敏处理：遍历对象/数组，移除敏感字段值
 */
function scrubSensitive(obj: unknown, depth = 0): unknown {
  // 防止无限递归
  if (depth > 10) return '[MAX_DEPTH]';
  
  // 处理 null/undefined
  if (obj == null) return obj;
  
  // 处理基本类型
  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && obj.length > MAX_STRING_LENGTH) {
      return obj.slice(0, MAX_STRING_LENGTH) + '...[truncated]';
    }
    return obj;
  }
  
  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => scrubSensitive(item, depth + 1));
  }
  
  // 处理对象
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = scrubSensitive(value, depth + 1);
    }
  }
  return result;
}

/**
 * 异步写入队列 - 确保有序、非阻塞写入
 */
class AsyncWriteQueue {
  private readonly queue: (() => Promise<void>)[] = [];
  private processing = false;
  
  async enqueue(task: () => Promise<void>): Promise<void> {
    this.queue.push(task);
    if (!this.processing) {
      this.processNext();
    }
  }
  
  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }
    
    this.processing = true;
    const task = this.queue.shift();

    if (!task) {
      this.processing = false;
      return;
    }

    try {
      await task();
    } catch {
      // Silently fail - trajectory collection should not block main functionality
    }
    
    // 处理下一个任务
    this.processNext();
  }
}

// 全局写入队列实例
const writeQueue = new AsyncWriteQueue();

// 目录缓存（避免重复检查）
const dirCache = new Map<string, boolean>();

/**
 * 确保轨迹目录存在（异步）
 */
async function ensureTrajectoryDirAsync(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, TRAJECTORY_DIR);
  
  if (dirCache.get(dir)) {
    return dir;
  }
  
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    dirCache.set(dir, true);
  } catch {
    // 目录可能已存在，忽略错误
    dirCache.set(dir, true);
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
 * 写入轨迹记录（JSON Lines 格式）- 异步版本
 */
function writeTrajectoryRecord(workspaceDir: string, record: object): void {
  const line = JSON.stringify(record) + '\n';
  
  writeQueue.enqueue(async () => {
    const dir = await ensureTrajectoryDirAsync(workspaceDir);
    const filepath = path.join(dir, getTodayFilename());
    await fs.promises.appendFile(filepath, line, 'utf8');
  });
}

/**
 * 工具调用完成后的处理
 * 记录：工具名、参数、结果、错误、执行时间
 */
export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string }
): void {
  const {workspaceDir} = ctx;
  if (!workspaceDir) return;

  // 递归脱敏处理所有字段
  const sanitizedParams = scrubSensitive(event.params);
  const sanitizedResult = event.result == null 
    ? null 
    : String(scrubSensitive(event.result)).slice(0, MAX_RESULT_LENGTH);
  const sanitizedError = event.error == null 
    ? null 
    : String(scrubSensitive(event.error));

  writeTrajectoryRecord(workspaceDir, {
    type: 'tool_call',
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId || 'unknown',
    toolName: event.toolName,
    params: sanitizedParams,
    result: sanitizedResult,
    error: sanitizedError,
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
  const {workspaceDir} = ctx;
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
    usage: event.usage ? scrubSensitive(event.usage) : null
  });
}

/**
 * 消息写入前的处理
 * 记录：用户/助手消息内容
 */
    // eslint-disable-next-line complexity -- complexity 11, slightly over threshold
export function handleBeforeMessageWrite(
  event: PluginHookBeforeMessageWriteEvent,
  ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
  const {workspaceDir} = ctx;
  if (!workspaceDir) return;

  const msg = event.message;
  if (!msg || !msg.role) return;

  // 只记录 user 和 assistant 消息
  if (msg.role !== 'user' && msg.role !== 'assistant') return;

  // 提取文本内容
  let content = '';
  if (typeof msg.content === 'string') {
     
    // Reason: msg.content is string | ContentPart[]; destructuring would require renaming in the else branch
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
      .map((part: unknown) => (part as { text: string }).text)
      .join('\n');
  }

  // 脱敏处理内容预览
  const sanitizedPreview = scrubSensitive(content.slice(0, 200));

  writeTrajectoryRecord(workspaceDir, {
    type: 'message',
    timestamp: new Date().toISOString(),
    sessionId: event.sessionKey || 'unknown',
    role: msg.role,
    contentLength: content.length,
    contentPreview: typeof sanitizedPreview === 'string' ? sanitizedPreview : '[sanitized]',
    agentId: event.agentId || null
  });
}

/**
 * 脱敏处理：移除敏感参数（保留旧函数签名以兼容）
 * @deprecated 使用 scrubSensitive 替代
 */
/**
 * 轨迹汇总统计（供 cron 任务调用）
 */
export function computeTrajectoryStats(workspaceDir: string): object {
  const dir = path.join(workspaceDir, TRAJECTORY_DIR);
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