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

    if (args === 'trust-reset') {
        wctx.trust.resetTrust();
        const newScore = wctx.trust.getScore();
        return { text: isZh ? `✅ 智能体信任分已重置为初始值 (${newScore})。` : `✅ Agent trust score has been reset to initial value (${newScore}).` };
    }

    // Default: Show status
    const session = sessionId ? getSession(sessionId) : undefined;
    const gfi = session ? session.currentGfi : 0;
    const dictionary = wctx.dictionary;
    const stats = dictionary.getStats();
    
    const trust = wctx.trust;
    const trustScore = trust.getScore();
    const trustStage = trust.getStage();

    const gfiBar = createProgressBar(gfi, 100, 15);
    const trustBar = createProgressBar(trustScore, 100, 15);
    
    // Determine health status based on GFI
    let healthLabel = 'Healthy';
    let suggestionText = '';

    if (isZh) {
        if (gfi > 80 || trustStage === 1) {
            healthLabel = gfi > 80 ? '极度疲劳 🔴' : '信任破产 🔴';
            suggestionText = `
💡 **建议 (系统检测到您当前遇到较大阻力)**:
   1. 执行 \`/pd-status reset\` 清零疲劳值。
   2. 执行 \`/pd-status trust-reset\` 重置信任分。
   3. 让 AI 调用 \`deep_reflect\` 工具进行深度反思。
   4. 如果当前上下文太乱，考虑使用 \`/clear\` 开启新会话。`;
        }
        else if (gfi > 50) healthLabel = '遇到阻力 🟡';
        else if (gfi > 20) healthLabel = '轻微受挫 🟢';
        else healthLabel = '运转良好 🟢';
    } else {
        if (gfi > 80 || trustStage === 1) {
            healthLabel = gfi > 80 ? 'Critical 🔴' : 'Trust Bankruptcy 🔴';
            suggestionText = `
💡 **Suggestion (High friction or low trust detected)**:
   1. Run \`/pd-status reset\` to clear friction.
   2. Run \`/pd-status trust-reset\` to reset trust score.
   3. Ask the AI to use the \`deep_reflect\` tool.
   4. Consider starting a new session with \`/clear\`.`;
        }
        else if (gfi > 50) healthLabel = 'High Friction 🟡';
        else if (gfi > 20) healthLabel = 'Minor Issues 🟢';
        else healthLabel = 'Healthy 🟢';
    }

    if (isZh) {
        let text = `📊 **Principles Disciple - 系统健康度监控**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💊 **当前疲劳指数 (GFI)**: ${gfiBar} ${gfi}/100\n`;
        text += `💰 **当前信任积分 (Trust)**: ${trustBar} ${trustScore}/100 (Stage ${trustStage})\n`;
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
        text += `💰 **Current Trust Score**: ${trustBar} ${trustScore}/100 (Stage ${trustStage})\n`;
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
