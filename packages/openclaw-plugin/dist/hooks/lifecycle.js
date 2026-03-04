import * as fs from 'fs';
import * as path from 'path';
export async function handleBeforeReset(event, ctx) {
    if (!ctx.workspaceDir || !event.messages || event.messages.length === 0) {
        return;
    }
    // Auto-summarise pain points before the session is cleared
    const painPoints = event.messages.filter((msg) => {
        const m = msg;
        return (m.role === 'assistant' &&
            typeof m.content === 'string' &&
            (m.content.includes('error') || m.content.includes('fail') || m.content.includes('blocked')));
    });
    if (painPoints.length > 0) {
        const memoryPath = path.join(ctx.workspaceDir, 'docs', 'MEMORY.md');
        const summary = `\n## [${new Date().toISOString()}] Session Reset Summary (Reason: ${event.reason ?? 'Manual'})\n` +
            `- Encountered ${painPoints.length} potential pain point(s) during this session.\n` +
            `- Action: Consider running /reflection to solidify these into principles.\n`;
        try {
            fs.appendFileSync(memoryPath, summary, 'utf8');
        }
        catch (_e) {
            // Non-critical — workspace may not have docs/ yet
        }
    }
}
export async function handleBeforeCompaction(event, ctx) {
    if (!ctx.workspaceDir)
        return;
    const checkpointPath = path.join(ctx.workspaceDir, 'docs', 'CHECKPOINT.md');
    const log = `\n## [${new Date().toISOString()}] Pre-Compaction Checkpoint\n` +
        `- Compacting session with ${event.messageCount} messages.\n` +
        `- Ensuring critical state is flushed to disk.\n`;
    try {
        fs.appendFileSync(checkpointPath, log, 'utf8');
    }
    catch (_e) {
        // Non-critical — skip silently
    }
}
