import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { computePainScore, writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { PD_DIRS } from '../core/paths.js';
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
      // Non-critical
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
  const workspaceDir = ctx.workspaceDir;

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
      } catch (e) { }
    }
  } finally {
    try {
      rl.close();
      fileStream.destroy();
    } catch (_e) { }
  }

  if (painPoints.length > 0) {
    const dateStr = new Date().toISOString().split('T')[0];
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
        writePainFlag(workspaceDir, {
          source: 'intercept_extraction',
          score: '100',
          time: new Date().toISOString(),
          reason: 'Hard intercept detected in session history compaction.',
          is_risky: 'true',
          trigger_text_preview: painPoints.find(p => p.includes('[FATAL INTERCEPT]'))?.substring(0, 150) || 'Fatal intercept'
        });
      }
    } catch (err) { }
  }
}

export async function handleBeforeCompaction(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const dateStr = new Date().toISOString().split('T')[0];
  const checkpointPath = path.join(ctx.workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
  const log =
    `\n## [${new Date().toISOString()}] Pre-Compaction Checkpoint\n` +
    `- Compacting session with ${event.messageCount} messages.\n` +
    `- Ensuring critical state is flushed to disk.\n`;

  try {
    const dir = path.dirname(checkpointPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (_e) { }

  if (event.sessionFile) {
    await extractPainFromSessionFile(event.sessionFile, ctx);
  }
}

export async function handleAfterCompaction(
  event: PluginHookAfterCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const dateStr = new Date().toISOString().split('T')[0];
  const checkpointPath = path.join(ctx.workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
  const log =
    `- Post-Compaction Complete. Reduced active context to ${event.messageCount} messages.\n`;

  try {
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (_e) { }
}
