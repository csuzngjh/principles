import { trackFriction, resetFriction, getSession } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * Creates a visual progress bar (e.g., [██████░░░░])
 */
function createProgressBar(value: number, max: number, length: number = 10): string {
    const filledLength = Math.round((value / max) * length);
    const emptyLength = length - filledLength;
    return `[${'█'.repeat(filledLength)}${'░'.repeat(emptyLength)}]`;
}

/**
 * Handles the /pd-status command
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
            return { text: isZh ? `✅ 当前会话的 GFI 阻力已强制归零。` : `✅ GFI for current session reset to 0.` };
        }
        return { text: isZh ? `❌ 无法识别当前会话。` : `❌ Session ID not found. Use /pd-status reset in a chat session.` };
    }

    // Default: Show status
    const session = sessionId ? getSession(sessionId) : undefined;
    const gfi = session ? session.currentGfi : 0;
    const dictionary = wctx.dictionary;
    const stats = dictionary.getStats();

    const gfiBar = createProgressBar(gfi, 100, 15);
    
    // Determine health status based on GFI
    let healthLabel = 'Healthy';
    let suggestionText = '';

    if (isZh) {
        if (gfi > 80) {
            healthLabel = '极度疲劳 🔴';
            suggestionText = `
💡 **建议 (系统检测到您当前遇到较大阻力)**:
   1. 执行 \`/pd-status reset\` 清零疲劳值，让 AI 重新尝试。
   2. 让 AI 调用 \`deep_reflect\` 工具进行深度反思。
   3. 如果当前上下文太乱，考虑使用 \`/clear\` 开启新会话。`;
        }
        else if (gfi > 50) healthLabel = '遇到阻力 🟡';
        else if (gfi > 20) healthLabel = '轻微受挫 🟢';
        else healthLabel = '运转良好 🟢';
    } else {
        if (gfi > 80) {
            healthLabel = 'Critical 🔴';
            suggestionText = `
💡 **Suggestion (High friction detected)**:
   1. Run \`/pd-status reset\` to clear friction and restart.
   2. Ask the AI to use the \`deep_reflect\` tool.
   3. Consider starting a new session with \`/clear\`.`;
        }
        else if (gfi > 50) healthLabel = 'High Friction 🟡';
        else if (gfi > 20) healthLabel = 'Minor Issues 🟢';
        else healthLabel = 'Healthy 🟢';
    }

    if (isZh) {
        let text = `📊 **Principles Disciple - 系统健康度监控**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💊 **当前疲劳指数 (GFI)**: ${gfiBar} ${gfi}/100\n`;
        text += `   ↳ 状态诊断: ${healthLabel}\n\n`;
        text += `🧠 **痛苦进化词典**: 已吸收 ${stats.totalRules} 条规则\n`;
        text += `   ↳ 累计帮您拦截了 ${stats.totalHits} 次无效操作\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (suggestionText) {
            text += suggestionText;
        } else {
            text += `*💡 提示: 如果 AI 陷入死循环，您可以使用 \`/pd-status reset\` 来强制清零疲劳值。*`;
        }
        return { text };
    } else {
        let text = `📊 **Principles Disciple - System Health Monitor**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💊 **Current Friction (GFI)**: ${gfiBar} ${gfi}/100\n`;
        text += `   ↳ Diagnosis: ${healthLabel}\n\n`;
        text += `🧠 **Evolution Dictionary**: ${stats.totalRules} active rules\n`;
        text += `   ↳ Successfully blocked ${stats.totalHits} invalid operations\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (suggestionText) {
            text += suggestionText;
        } else {
            text += `*💡 Hint: If the AI is stuck in a loop, use \`/pd-status reset\` to clear friction and restart.*`;
        }
        return { text };
    }
}
