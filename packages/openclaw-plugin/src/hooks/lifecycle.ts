import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { buildPainFlag, writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { PD_DIRS } from '../core/paths.js';
import {
  extractWorkingMemory,
  mergeWorkingMemory,
} from '../core/focus-history.js';
import type { PluginHookBeforeResetEvent, PluginHookBeforeCompactionEvent, PluginHookAfterCompactionEvent, PluginHookAgentContext } from '../openclaw-sdk.js';

export async function handleBeforeReset(
  event: PluginHookBeforeResetEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir || !event.messages || event.messages.length === 0) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // Auto-summarise pain points before the session is cleared
  const painPoints = event.messages.filter((msg) => {
    const m = msg as Record<string, unknown>;
    return (
      m.role === 'assistant' &&
      typeof m.content === 'string' &&
      (m.content.includes('error') || m.content.includes('fail') || m.content.includes('blocked'))
    );
  });

  if (painPoints.length > 0) {
    const memoryPath = wctx.resolve('MEMORY_MD');
    const summary =
      `\n## [${new Date().toISOString()}] Session Reset Summary (Reason: ${event.reason ?? 'Manual'})\n` +
      `- Encountered ${painPoints.length} potential pain point(s) during this session.\n` +
      `- Action: Consider running /reflection to solidify these into principles.\n`;
    try {
      fs.appendFileSync(memoryPath, summary, 'utf8');
    } catch (_e) {
      ctx.logger?.error?.(`[PD:Lifecycle] Failed to write session reset summary: ${String(_e)}`);
    }
  }
}

interface JsonlMessage {
  role?: string;
  content?: string | { type?: string; text?: string }[];
  usage?: { outputText?: string }; 
  openclawAbort?: { aborted: boolean; origin: string; runId: string };
  __openclaw?: { truncated: boolean; reason: string };
}

export async function extractPainFromSessionFile(sessionFile: string, ctx: PluginHookAgentContext): Promise<void> {
  const painPoints: string[] = [];
  const {workspaceDir} = ctx;

  if (!workspaceDir) return;

  const wctx = WorkspaceContext.fromHookContext(ctx);

  if (!fs.existsSync(sessionFile)) {
    if (ctx.logger?.debug) ctx.logger.debug(`[Pain Extractor] Session file not found: ${sessionFile}`);
    return;
  }

  if (ctx.logger) ctx.logger.info(`[Pain Extractor] Scanning session transcript for pain signals: ${sessionFile}`);

  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      try {
        if (!line.trim()) continue;
        const msg: JsonlMessage = JSON.parse(line);
        if (msg.role !== 'assistant') continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(c => c && c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('\n');
        } else if (msg.usage && msg.usage.outputText) {
          text = msg.usage.outputText;
        }

        if (!text) continue;

        if (msg.openclawAbort?.aborted) {
          const runIdSafe = msg.openclawAbort?.runId || 'unknown';
          if (ctx.logger) ctx.logger.info(`[Pain Extractor] Detected hard-abort snapshot (runId: ${runIdSafe})`);
          painPoints.push(`[FATAL INTERCEPT] 动作被沙箱防御机制强制击落。大模型被击落前的思考流 (未遂动机): ${text.substring(0, 250)}...`);
          continue;
        }

        if (msg.__openclaw?.truncated && msg.__openclaw?.reason === 'oversized') {
          if (ctx.logger) ctx.logger.info(`[Pain Extractor] Detected oversized data truncation placeholder`);
          painPoints.push(`[COGNITIVE OVERLOAD] 大模型尝试读取极大体积的输入，已被底层守护程序抹除/折叠防爆。请反思是否读取了不当的文件或日志: ${text.substring(0, 150)}...`);
          continue;
        }

        const lower = text.toLowerCase();
        if (lower.includes('i\'m sorry, but i\'m still getting') ||
          lower.includes('i apologize for the confusion') ||
          lower.includes('this is taking longer than expected')) {
          if (ctx.logger?.debug) ctx.logger.debug(`[Pain Extractor] Detected semantic confusion string.`);
          painPoints.push(`[SEMANTIC CONFUSION] ${text.substring(0, 150)}...`);
        }
      } catch (e) {
        ctx.logger?.error?.(`[PD:Lifecycle] Error parsing message: ${String(e)}`);
      }
    }
  } finally {
    try {
      rl.close();
      fileStream.destroy();
    } catch (_e) { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: intentionally unused - cleanup errors ignored
      // Ignore cleanup errors
    }
  }

  if (painPoints.length > 0) {
    const [dateStr] = new Date().toISOString().split('T');
    const dailyLogPath = path.join(workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
    const timestamp = new Date().toISOString();
    
    let entry = `\n## [${timestamp}] Consolidated Pain (Pre-Compaction)\n\n`;
    entry += `### Pain Signals extracted from session transcript\n`;
    painPoints.slice(-5).forEach((p, idx) => {
      entry += `- [Signal ${idx + 1}] ${p.replace(/\n/g, ' ')}\n`;
    });
    entry += `\n### Diagnosis (Pending)\n- Run /evolve-task to diagnose. Deep dive using memory_search if needed.\n`;

    try {
      const dir = path.dirname(dailyLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(dailyLogPath, entry, 'utf8');

      const semanticPath = wctx.resolve('SEMANTIC_PAIN');
      const semanticDir = path.dirname(semanticPath);
      if (!fs.existsSync(semanticDir)) fs.mkdirSync(semanticDir, { recursive: true });

      let semanticEntry = `\n### Sample ${timestamp}\n- Source: compaction\n\n\`\`\`\n${painPoints.join('\n---\n')}\n\`\`\`\n`;
      fs.appendFileSync(semanticPath, semanticEntry, 'utf8');

      const hasFatal = painPoints.some(p => p.includes('[FATAL INTERCEPT]'));
      if (hasFatal) {
        writePainFlag(workspaceDir, buildPainFlag({
          source: 'intercept_extraction',
          score: '100',
          reason: 'Hard intercept detected in session history compaction.',
          is_risky: true,
          trigger_text_preview: painPoints.find(p => p.includes('[FATAL INTERCEPT]'))?.substring(0, 150) || 'Fatal intercept',
          session_id: ctx.sessionId || '',
          agent_id: ctx.agentId || '',
        }));
      }
    } catch (err) {
      ctx.logger?.error?.(`[PD:Lifecycle] Failed to write pain signals: ${String(err)}`);
    }
  }
}

export async function handleBeforeCompaction(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const wctx = WorkspaceContext.fromHookContext(ctx);
  const [dateStr] = new Date().toISOString().split('T');
  const checkpointPath = path.join(ctx.workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
  const log =
    `\n## [${new Date().toISOString()}] Pre-Compaction Checkpoint\n` +
    `- Compacting session with ${event.messageCount} messages.\n` +
    `- Ensuring critical state is flushed to disk.\n`;

  try {
    const dir = path.dirname(checkpointPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (_e) {
    ctx.logger?.error?.(`[PD:Lifecycle] Failed to write pre-compaction checkpoint: ${String(_e)}`);
  }

  // 提取工作记忆（从 sessionFile）
  if (event.sessionFile) {
    await extractPainFromSessionFile(event.sessionFile, ctx);

    // 新增：提取并保存工作记忆
     
    await extractAndSaveWorkingMemory(event.sessionFile, ctx, wctx);
  }
}

/**
 * 从会话文件提取工作记忆并保存到 CURRENT_FOCUS.md
 */
async function extractAndSaveWorkingMemory(
  sessionFile: string,
  ctx: PluginHookAgentContext,
  wctx: WorkspaceContext
): Promise<void> {
  if (!fs.existsSync(sessionFile)) {
    if (ctx.logger?.debug) ctx.logger.debug(`[WorkingMemory] Session file not found: ${sessionFile}`);
    return;
  }

  const messages: JsonlMessage[] = [];
  let lineCount = 0;
  const MAX_LINES = 1000; // 限制处理的行数，避免内存问题
  
  // 读取会话文件
  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      if (lineCount >= MAX_LINES) break;
      if (!line.trim()) continue;
      lineCount++;
      try {
        const msg: JsonlMessage = JSON.parse(line);
        messages.push(msg);
      } catch {
        // 忽略解析错误
      }
    }
  } finally {
    try {
      rl.close();
      fileStream.destroy();
    } catch {
      // 忽略清理错误
    }
  }

  if (messages.length === 0) {
    if (ctx.logger?.debug) ctx.logger.debug(`[WorkingMemory] No messages found in session file`);
    return;
  }

  // 提取工作记忆
  const snapshot = extractWorkingMemory(messages, ctx.workspaceDir);
  
  // 检查是否有有效内容
  if (snapshot.artifacts.length === 0 && 
      snapshot.activeProblems.length === 0 && 
      snapshot.nextActions.length === 0) {
    if (ctx.logger?.debug) ctx.logger.debug(`[WorkingMemory] No working memory to preserve`);
    return;
  }

  // 读取并更新 CURRENT_FOCUS.md
  const focusPath = wctx.resolve('CURRENT_FOCUS');
  
  try {
    let content = '';
    if (fs.existsSync(focusPath)) {
      content = fs.readFileSync(focusPath, 'utf-8');
      
      // 备份原文件（防止损坏）
      const backupPath = `${focusPath}.wm-backup`;
      fs.copyFileSync(focusPath, backupPath);
    }
    
    // 合并工作记忆
    const updatedContent = mergeWorkingMemory(content, snapshot);
    
    // 确保目录存在
    const focusDir = path.dirname(focusPath);
    if (!fs.existsSync(focusDir)) {
      fs.mkdirSync(focusDir, { recursive: true });
    }
    
    // 写入文件
    fs.writeFileSync(focusPath, updatedContent, 'utf-8');
    
    if (ctx.logger) {
      ctx.logger.info(`[WorkingMemory] Preserved ${snapshot.artifacts.length} artifacts, ` +
        `${snapshot.activeProblems.length} problems, ` +
        `${snapshot.nextActions.length} next actions to CURRENT_FOCUS.md`);
    }
  } catch (err) {
    ctx.logger?.error?.(`[PD:Lifecycle] Failed to save working memory: ${String(err)}`);
    
    // 尝试恢复备份
    const backupPath = `${focusPath}.wm-backup`;
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, focusPath);
        if (ctx.logger) ctx.logger.warn(`[WorkingMemory] Restored from backup after failure`);
      } catch {
        // 忽略恢复错误
      }
    }
  }
}

export async function handleAfterCompaction(
  event: PluginHookAfterCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const [dateStrPost] = new Date().toISOString().split('T');
  const checkpointPath = path.join(ctx.workspaceDir, PD_DIRS.MEMORY, `${dateStrPost}.md`);
  const log =
    `- Post-Compaction Complete. Reduced active context to ${event.messageCount} messages.\n`;

  try {
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (_e) {
    ctx.logger?.error?.(`[PD:Lifecycle] Failed to write post-compaction checkpoint: ${String(_e)}`);
  }
}
