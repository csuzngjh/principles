import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
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
async function extractPainFromSessionFile(sessionFile, workspaceDir) {
    const painPoints = [];
    if (!fs.existsSync(sessionFile))
        return;
    const fileStream = fs.createReadStream(sessionFile);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });
    // Extract all AI responses that indicate pain/looping before they get compressed away
    for await (const line of rl) {
        try {
            const msg = JSON.parse(line);
            if (msg.role === 'assistant') {
                let text = '';
                if (typeof msg.content === 'string') {
                    text = msg.content;
                }
                else if (Array.isArray(msg.content)) {
                    text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
                }
                else if (msg.usage && msg.usage.outputText) {
                    text = msg.usage.outputText;
                }
                if (!text)
                    continue;
                const lower = text.toLowerCase();
                // Simple heuristic for consolidated pain extraction
                if (lower.includes('i\'m sorry, but i\'m still getting') ||
                    lower.includes('i apologize for the confusion') ||
                    lower.includes('this is taking longer than expected') ||
                    lower.includes('it seems i cannot')) {
                    painPoints.push(text.substring(0, 150) + '...');
                }
            }
        }
        catch (e) {
            // Ignore JSON parse errors for corrupted lines
        }
    }
    if (painPoints.length > 0) {
        const issueLogPath = path.join(workspaceDir, 'docs', 'ISSUE_LOG.md');
        const timestamp = new Date().toISOString();
        let entry = `\n## [${timestamp}] Consolidated Pain (Pre-Compaction)\n\n`;
        entry += `### Pain Signals extracted from session transcript\n`;
        painPoints.slice(-5).forEach((p, idx) => {
            entry += `- [Signal ${idx + 1}] ${p.replace(/\n/g, ' ')}\n`;
        });
        entry += `\n### Diagnosis (Pending)\n- Run /evolve-task to diagnose.\n`;
        try {
            const dir = path.dirname(issueLogPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(issueLogPath, entry, 'utf8');
        }
        catch (_e) {
            // Non-critical
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
    // New: Extract pain from session transcript before memory loss
    if (event.sessionFile) {
        await extractPainFromSessionFile(event.sessionFile, ctx.workspaceDir);
    }
}
