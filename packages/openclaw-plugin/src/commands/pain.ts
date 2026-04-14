import { resetFriction, getSession } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import type { EmpathyEventStats } from '../types/event-types.js';

/**
 * Creates a visual progress bar (e.g., [██████░░░░])
 */
function createProgressBar(value: number, max: number, length = 10): string {
    const filledLength = Math.round((value / max) * length);
    const emptyLength = length - filledLength;
    return `[${'█'.repeat(filledLength)}${'░'.repeat(emptyLength)}]`;
}

/**
 * Creates a mini bar for daily trends
 */
function createMiniBar(count: number, max: number, length = 6): string {
    const filledLength = Math.round((count / max) * length);
    return '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
}

/**
 * Format empathy stats for display
 */
function formatEmpathyCard(stats: EmpathyEventStats, range: string, isZh: boolean): string {
    if (stats.totalEvents === 0 && stats.dedupedCount === 0) {
        return isZh
            ? `🫀 **情绪事件统计** (${range})\n   暂无数据`
            : `🫀 **Empathy Events** (${range})\n   No data available`;
    }

    const lines: string[] = [];
    lines.push(isZh ? `🫀 **情绪事件统计** (${range})` : `🫀 **Empathy Events** (${range})`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Total events
    const totalLabel = isZh ? '📊 总事件' : '📊 Total Events';
    lines.push(`${totalLabel}: ${stats.totalEvents} 次`);
    lines.push(`   ├─ 😟 mild: ${stats.bySeverity.mild} 次 (${stats.scoreBySeverity.mild}分)`);
    lines.push(`   ├─ 😠 moderate: ${stats.bySeverity.moderate} 次 (${stats.scoreBySeverity.moderate}分)`);
    lines.push(`   └─ 😡 severe: ${stats.bySeverity.severe} 次 (${stats.scoreBySeverity.severe}分)`);
    lines.push('');

    // Dedupe hit rate
    const dedupeRate = (stats.dedupeHitRate * 100).toFixed(0);
    const dedupeLabel = isZh ? '🔄 去重命中率' : '🔄 Dedupe Hit Rate';
    lines.push(`${dedupeLabel}: ${dedupeRate}% (${stats.dedupedCount}/${stats.totalEvents + stats.dedupedCount})`);
    if (stats.dedupedCount > 0) {
        lines.push(isZh ? '   ↳ 避免了重复惩罚' : '   ↳ Prevented duplicate penalties');
    }
    lines.push('');

    // Rollback info
    if (stats.rollbackCount > 0) {
        const rollbackLabel = isZh ? '↩️ 已回滚' : '↩️ Rolled Back';
        lines.push(`${rollbackLabel}: ${stats.rollbackCount} 次 (${stats.rolledBackScore}分)`);
        lines.push('');
    }

    // Daily trend
    if (stats.dailyTrend.length > 1) {
        const trendLabel = isZh ? '📈 趋势 (按天)' : '📈 Trend (by day)';
        lines.push(`${trendLabel}:`);
        const maxCount = Math.max(...stats.dailyTrend.map(d => d.count), 1);
        for (const day of stats.dailyTrend) {
            const bar = createMiniBar(day.count, maxCount, 6);
            const dateStr = day.date.slice(5); // MM-DD
            lines.push(`   ${dateStr}: ${bar} ${day.count}次`);
        }
    }

    // Detection mode distribution
    if (stats.byDetectionMode.structured > 0 || stats.byDetectionMode.legacy_tag > 0) {
        lines.push('');
        const modeLabel = isZh ? '🔍 检测模式' : '🔍 Detection Mode';
        lines.push(`${modeLabel}: 结构化 ${stats.byDetectionMode.structured} | 标签 ${stats.byDetectionMode.legacy_tag}`);
    }

    return lines.join('\n');
}

/**
 * Handles the /pd-status command
 */
export function handlePainCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const lang = (ctx.config?.language as string) || 'en';
    const isZh = lang === 'zh';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: sessionId injected by OpenClaw plugin framework - type not available in PluginCommandContext
    const {sessionId} = (ctx as any);

    const args = (ctx.args || '').trim();

    // Handle empathy subcommand
    if (args.startsWith('empathy')) {
         
         
        return handleEmpathySubcommand(wctx, args, sessionId, isZh);
    }

    if (args === 'reset') {
        if (sessionId) {
            resetFriction(sessionId);
            return { text: isZh ? `✅ 当前会话的 GFI 阻力已强制归零。` : `✅ GFI for current session reset to 0.` };
        }
        return { text: isZh ? `❌ 无法识别当前会话。` : `❌ Session ID not found. Use /pd-status reset in a chat session.` };
    }

    if (args === 'data') {
        const stats = wctx.trajectory.getDataStats();
        return {
            text: isZh
                ? `轨迹数据状态\n- 数据库: ${stats.dbPath}\n- 助手轮次: ${stats.assistantTurns}\n- 用户轮次: ${stats.userTurns}\n- 工具调用: ${stats.toolCalls}\n- 痛感事件: ${stats.painEvents}\n- 待审核样本: ${stats.pendingSamples}\n- 已通过样本: ${stats.approvedSamples}\n- Blob 字节数: ${stats.blobBytes}\n- 最近写入: ${stats.lastIngestAt ?? 'none'}`
                : `Trajectory Data Status\n- DB: ${stats.dbPath}\n- assistant turns: ${stats.assistantTurns}\n- user turns: ${stats.userTurns}\n- tool calls: ${stats.toolCalls}\n- pain events: ${stats.painEvents}\n- pending samples: ${stats.pendingSamples}\n- approved samples: ${stats.approvedSamples}\n- blob bytes: ${stats.blobBytes}\n- last ingest: ${stats.lastIngestAt ?? 'none'}`
        };
    }

    // Default: Show status
    const session = sessionId ? getSession(sessionId) : undefined;
    const gfi = session ? session.currentGfi : 0;
    const {dictionary} = wctx;
    const stats = dictionary.getStats();
    
    const gfiBar = createProgressBar(gfi, 100, 15);
    
    // Determine Mental Mode (aligned with prompt.ts logic)
     
    const mentalMode = isZh
        ? gfi >= 70 ? '🚑 救赎模式 (HUMBLE_RECOVERY)'
        : gfi >= 40 ? '🤝 安抚模式 (CONCILIATORY)'
        : '⚡ 高效模式 (EFFICIENT)'
        : gfi >= 70 ? '🚑 HUMBLE_RECOVERY'
        : gfi >= 40 ? '🤝 CONCILIATORY'
        : '⚡ EFFICIENT';
    
    // Determine health status based on GFI
     
     
    let healthLabel: string;
    let suggestionText = '';

    if (isZh) {
        if (gfi > 80) {
            healthLabel = '极度疲劳 🔴';
            suggestionText = `
💡 **建议 (系统检测到您当前遇到较大阻力)**:
   1. 执行 \`/pd-status reset\` 清零疲劳值。
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
   1. Run \`/pd-status reset\` to clear friction.
   2. Ask the AI to use the \`deep_reflect\` tool.
   4. Consider starting a new session with \`/clear\`.`;
        }
        else if (gfi > 50) healthLabel = 'High Friction 🟡';
        else if (gfi > 20) healthLabel = 'Minor Issues 🟢';
        else healthLabel = 'Healthy 🟢';
    }

    // Get session empathy stats for inline display
    const sessionEmpathy = sessionId ? wctx.eventLog.getEmpathyStats('session', sessionId) : null;
    let empathyInline = '';
    if (sessionEmpathy && sessionEmpathy.totalEvents > 0) {
        empathyInline = isZh
            ? `\n🫀 **情绪事件 (当前会话)**: ${sessionEmpathy.totalEvents} 次 (${sessionEmpathy.totalPenaltyScore}分)`
            : `\n🫀 **Empathy Events (Session)**: ${sessionEmpathy.totalEvents} (${sessionEmpathy.totalPenaltyScore}pts)`;
    }

    if (isZh) {
        let text = `📊 **Principles Disciple - 系统健康度监控**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💊 **当前疲劳指数 (GFI)**: ${gfiBar} ${gfi}/100\n`;
        text += `🧠 **当前心智模式**: ${mentalMode}\n`;
        text += `   ↳ 状态诊断: ${healthLabel}\n`;
        text += empathyInline;
        text += `\n\n🧠 **痛苦进化词典**: 已吸收 ${stats.totalRules} 条规则\n`;
        text += `   ↳ 累计帮您拦截了 ${stats.totalHits} 次无效操作\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (suggestionText) {
            text += suggestionText;
        } else {
            text += `*💡 提示: 使用 \`/pd-status empathy\` 查看详细情绪事件统计。*`;
        }
        return { text };
    } else {
        let text = `📊 **Principles Disciple - System Health Monitor**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💊 **Current Friction (GFI)**: ${gfiBar} ${gfi}/100\n`;
        text += `🧠 **Current Mental Mode**: ${mentalMode}\n`;
        text += `   ↳ Diagnosis: ${healthLabel}\n`;
        text += empathyInline;
        text += `\n\n🧠 **Evolution Dictionary**: ${stats.totalRules} active rules\n`;
        text += `   ↳ Successfully blocked ${stats.totalHits} invalid operations\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (suggestionText) {
            text += suggestionText;
        } else {
            text += `*💡 Hint: Use \`/pd-status empathy\` to view detailed empathy event statistics.*`;
        }
        return { text };
    }
}

/**
 * Handle /pd-status empathy subcommand
 */
 
     
function handleEmpathySubcommand(
    wctx: WorkspaceContext,
    args: string,
    sessionId: string | undefined,
    isZh: boolean
): PluginCommandResult {
    // Parse range argument
    let range: 'today' | 'week' | 'session' = 'today';
    if (args.includes('--week') || args.includes('-w')) {
        range = 'week';
    } else if (args.includes('--session') || args.includes('-s')) {
        range = 'session';
    } else if (args.includes('--today') || args.includes('-t')) {
        range = 'today';
    }

    // Validate session range
    if (range === 'session' && !sessionId) {
        return {
            text: isZh
                ? `❌ 无法获取会话统计，请在聊天会话中使用此命令。`
                : `❌ Session not found. Use this command in a chat session.`
        };
    }

    const stats = wctx.eventLog.getEmpathyStats(range, sessionId);
    const rangeLabel = isZh
        ? { today: '今天', week: '最近 7 天', session: '当前会话' }[range]
        : { today: 'Today', week: 'Last 7 Days', session: 'Current Session' }[range];

    let text = formatEmpathyCard(stats, rangeLabel, isZh);

    // Add usage hint
    if (range === 'today') {
        text += isZh
            ? `\n\n*💡 使用 \`/pd-status empathy --week\` 查看周统计，\`--session\` 查看会话统计。*`
            : `\n\n*💡 Use \`/pd-status empathy --week\` for weekly stats, \`--session\` for session stats.*`;
    }

    return { text };
}
