/**
 * Trajectory Collector - message write trajectory recording
 *
 * Records message data to memory/trajectories/ JSONL files.
 * PRI-347 removed tool_call and llm_output JSONL writers (no consumers).
 * PRI-346 will repurpose handleBeforeMessageWrite for SQLite collection.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  PluginHookAgentContext,
  PluginHookBeforeMessageWriteEvent
} from '../openclaw-sdk.js';
import { MAX_STRING_LENGTH } from '../config/defaults/runtime.js';

const TRAJECTORY_DIR = 'memory/trajectories/';

// 敏感字段匹配正则
const SENSITIVE_KEY_PATTERN = /password|token|authorization|secret|api[_-]?key|credential|cookie|session/i;

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
 * 消息写入前的处理
 * 记录：用户/助手消息内容
 *
 * PRI-346 will repurpose this to write to SQLite instead of JSONL.
 */
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
