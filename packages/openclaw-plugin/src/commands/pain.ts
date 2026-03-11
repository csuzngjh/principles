import { trackFriction, resetFriction, getSession } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * Handles the /pd-status command (aliased from /pain in logic)
 */
export function handlePainCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const lang = (ctx.config?.language as string) || 'en';
    const isZh = lang === 'zh';
    const sessionId = (ctx as any).sessionId;

    const args = (ctx.args || '').trim();

    if (args === 'reset') {
        if (sessionId) {
            resetFriction(sessionId);
            return { text: isZh ? `✅ 当前会话的 GFI 阻力已重置为 0。` : `✅ GFI for current session reset to 0.` };
        }
        return { text: isZh ? `❌ 无法识别当前会话。` : `❌ Session ID not found. Use /pd-status reset in a chat session.` };
    }

    // Default: Show status
    const session = sessionId ? getSession(sessionId) : undefined;
    const gfi = session ? session.currentGfi : 0;
    const dictionary = wctx.dictionary;
    const stats = dictionary.getStats();

    let text = isZh ? `🛡️ **数字神经系统状态**\n` : `🛡️ **Digital Nerve System Status**\n`;
    text += `──────────────────────────────\n`;
    text += isZh ? `**当前 GFI 摩擦指数**: ${gfi}/100\n` : `**Current GFI Index**: ${gfi}/100\n`;
    text += isZh ? `**痛苦词典规则数**: ${stats.totalRules}\n` : `**Pain Dictionary Rules**: ${stats.totalRules}\n`;
    text += isZh ? `**累计触发次数**: ${stats.totalHits}\n` : `**Total Hits**: ${stats.totalHits}\n`;
    text += `──────────────────────────────\n`;
    text += isZh 
        ? `*使用 \`/pd-status reset\` 重置当前会话阻力。*` 
        : `*Use \`/pd-status reset\` to reset current session friction.*`;

    return { text };
}
