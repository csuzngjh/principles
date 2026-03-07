import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { PluginHookBeforeResetEvent, PluginHookBeforeCompactionEvent, PluginHookAgentContext } from '../openclaw-sdk.js';

export async function handleBeforeReset(
  event: PluginHookBeforeResetEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir || !event.messages || event.messages.length === 0) {
    return;
  }

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
    const memoryPath = path.join(ctx.workspaceDir, 'MEMORY.md');
    const summary =
      `\n## [${new Date().toISOString()}] Session Reset Summary (Reason: ${event.reason ?? 'Manual'})\n` +
      `- Encountered ${painPoints.length} potential pain point(s) during this session.\n` +
      `- Action: Consider running /reflection to solidify these into principles.\n`;
    try {
      fs.appendFileSync(memoryPath, summary, 'utf8');
    } catch (_e) {
      // Non-critical — workspace may not have docs/ yet
    }
  }
}

interface JsonlMessage {
  role?: string;
  content?: string | { type?: string; text?: string }[];
  usage?: { outputText?: string }; // Occasionally in some outputs
}

async function extractPainFromSessionFile(sessionFile: string, workspaceDir: string): Promise<void> {
  const painPoints: string[] = [];

  if (!fs.existsSync(sessionFile)) return;

  const fileStream = fs.createReadStream(sessionFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  // Extract all AI responses that indicate pain/looping before they get compressed away
  for await (const line of rl) {
    try {
      const msg: JsonlMessage = JSON.parse(line);
      if (msg.role === 'assistant') {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        } else if (msg.usage && msg.usage.outputText) {
          text = msg.usage.outputText;
        }

        if (!text) continue;
        const lower = text.toLowerCase();

        // Simple heuristic for consolidated pain extraction
        if (lower.includes('i\'m sorry, but i\'m still getting') ||
          lower.includes('i apologize for the confusion') ||
          lower.includes('this is taking longer than expected') ||
          lower.includes('it seems i cannot')) {
          painPoints.push(text.substring(0, 150) + '...');
        }
      }
    } catch (e) {
      // Ignore JSON parse errors for corrupted lines
    }
  }

  if (painPoints.length > 0) {
    const dateStr = new Date().toISOString().split('T')[0];
    const dailyLogPath = path.join(workspaceDir, 'memory', `${dateStr}.md`);
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

      // V1.3.0: Also write to semantic pain memory for L3 retrieval
      const semanticPath = path.join(workspaceDir, 'memory', 'pain', 'confusion_samples.md');
      const semanticDir = path.dirname(semanticPath);
      if (!fs.existsSync(semanticDir)) fs.mkdirSync(semanticDir, { recursive: true });
      
      let semanticEntry = `\n### Sample ${timestamp}\n- Source: compaction\n\n\`\`\`\n${painPoints.join('\n---\n')}\n\`\`\`\n`;
      fs.appendFileSync(semanticPath, semanticEntry, 'utf8');
    } catch (_e) {
      // Non-critical
    }
  }
}

export async function handleBeforeCompaction(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const dateStr = new Date().toISOString().split('T')[0];
  const checkpointPath = path.join(ctx.workspaceDir, 'memory', `${dateStr}.md`);
  const log =
    `\n## [${new Date().toISOString()}] Pre-Compaction Checkpoint\n` +
    `- Compacting session with ${event.messageCount} messages.\n` +
    `- Ensuring critical state is flushed to disk.\n`;

  try {
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (_e) {
    // Non-critical — skip silently
  }

  // New: Extract pain from session transcript before memory loss
  if (event.sessionFile) {
    await extractPainFromSessionFile(event.sessionFile, ctx.workspaceDir);
  }
}

