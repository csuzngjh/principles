import * as fs from 'fs';
import * as path from 'path';
import { serializeKvLines } from '../utils/io';

export async function handleBeforeReset(
  event: { sessionFile?: string; messages?: any[]; reason?: string },
  ctx: { workspaceDir?: string }
): Promise<void> {
  if (!ctx.workspaceDir || !event.messages || event.messages.length === 0) {
    return;
  }

  // Auto-summarize pain points before the session is cleared
  const painPoints = event.messages.filter(msg => 
    msg.role === 'assistant' && 
    (msg.content.includes('error') || msg.content.includes('fail') || msg.content.includes('blocked'))
  );

  if (painPoints.length > 0) {
    const memoryPath = path.join(ctx.workspaceDir, 'docs', 'MEMORY.md');
    const summary = `\n## [${new Date().toISOString()}] Session Reset Summary (Reason: ${event.reason || 'Manual'})\n` +
      `- Encountered ${painPoints.length} potential pain points during this session.\n` +
      `- Action: Consider running /reflection to solidify these into principles.\n`;
    
    try {
      fs.appendFileSync(memoryPath, summary, 'utf8');
    } catch (e) {
      // Ignore write errors
    }
  }
}

export async function handleBeforeCompaction(
  event: { messageCount: number; messages?: any[] },
  ctx: { workspaceDir?: string }
): Promise<void> {
  if (!ctx.workspaceDir) return;

  const checkpointPath = path.join(ctx.workspaceDir, 'docs', 'CHECKPOINT.md');
  const log = `\n## [${new Date().toISOString()}] Pre-Compaction Checkpoint\n` +
    `- Compacting session with ${event.messageCount} messages.\n` +
    `- Ensuring critical state is flushed to disk.\n`;

  try {
    fs.appendFileSync(checkpointPath, log, 'utf8');
  } catch (e) {
    // Ignore write errors
  }
}
