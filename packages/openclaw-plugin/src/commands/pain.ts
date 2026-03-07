import { DictionaryService } from '../core/dictionary-service.js';
import { getSession, resetFriction } from '../core/session-tracker.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import * as path from 'path';

/**
 * Handles the /pain status or /pain reset command to report or manage the current state of the Digital Nerve System.
 */
export function handlePainCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    const stateDir = (ctx.config?.stateDir as string) || path.join(workspaceDir, 'memory', '.state');
    const args = (ctx.args || '').trim();
    const sessionId = (ctx as any).sessionId;

    if (args === 'reset') {
        if (sessionId) {
            resetFriction(sessionId);
            return { text: `✅ GFI for current session reset to 0.` };
        }
        return { text: `⚠️ No active session to reset.` };
    }
    
    const dictionary = DictionaryService.get(stateDir);
    const session = sessionId ? getSession(sessionId) : undefined;
    
    let report = `# 🦷 Principles Disciple — Digital Nerve System Status\n\n`;
    
    // 1. GFI Status (Track A)
    report += `### Track A: Empirical Friction (GFI)\n`;
    if (session) {
        const gfi = session.currentGfi || 0;
        const status = gfi >= 80 ? '🔴' : (gfi >= 40 ? '🟡' : '🟢');
        report += `- **Current GFI**: ${status} **${gfi.toFixed(1)}** / 100\n`;
        report += `- **Consecutive Errors**: ${session.consecutiveErrors}\n\n`;
    } else {
        report += `*No active session data found.*\n\n`;
    }
    
    // 2. Dictionary Stats (Track B)
    report += `### Track B: Semantic Pain Dictionary\n`;
    const rules = dictionary.getAllRules();
    
    if (Object.keys(rules).length === 0) {
        report += `*No rules found in dictionary.*\n`;
    } else {
        report += `| Rule ID | Severity | Hits | Status |\n|---|---|---|---|\n`;
        for (const [id, rule] of Object.entries(rules)) {
            const statusIcon = rule.status === 'active' ? '✅' : '💤';
            report += `| ${id} | ${rule.severity} | ${rule.hits} | ${statusIcon} ${rule.status} |\n`;
        }
    }
    
    return { text: report };
}
