import { resetFriction, getSession } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import type { EmpathyEventStats } from '../types/event-types.js';
import type { EvolutionLoopEvent } from '../core/evolution-types.js';
import { computeHash } from '../utils/hashing.js';
import { PainToPrincipleService, PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from '../core/pd-config-loader.js';
import { createIntentDocReader, resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { acquireTrajectoryEvidence } from '../hooks/trajectory-evidence.js';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';

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
 * Extended context interface that includes sessionId injected by the plugin framework.
 * PluginCommandContext does not include sessionId in its type definition.
 */
interface SessionAwareCommandContext extends PluginCommandContext {
  sessionId: string;
}

/**
 * Handles the /pd-status command
 */
export function handlePainCommand(ctx: PluginCommandContext): PluginCommandResult {
    const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'pain');
    
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const lang = (ctx.config?.language as string) || 'en';
    const isZh = lang === 'zh';
    const { sessionId } = ctx as SessionAwareCommandContext;

    const args = normalizeCommandArgs(ctx.args).trim();

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
   2. 如果当前上下文太乱，考虑使用 \`/clear\` 开启新会话。`;
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
   2. Ask the AI to reflect deeply before continuing.
   3. Consider starting a new session with \`/clear\`.`;
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
        } else if (stats.totalRules === 0 && stats.totalHits === 0) {
            // Fix-14 (P1-DESIGN-2): Empty-state onboarding guidance for fresh installs.
            // Merges Fix-13's welcome message here instead of injecting into the
            // before_prompt_build hook (avoids MVP-Core behavior change).
            text += `\n🦞 **欢迎使用 Principles Disciple!**\n\n`;
            text += `当前是全新工作区，还没有痛觉信号 —— 这是正常的。\n\n`;
            text += `**下一步**:\n`;
            text += `1. 让 Agent 工作，当它犯错时运行 \`/pd-pain <描述问题>\`\n`;
            text += `2. 或运行演示: \`pd demo first-principle\`\n`;
            text += `3. 配置 LLM runtime profile: \`pd console open --workspace "<path>"\`\n\n`;
            text += `审批通过的原则会出现在这里。`;
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
        } else if (stats.totalRules === 0 && stats.totalHits === 0) {
            // Fix-14 (P1-DESIGN-2): Empty-state onboarding guidance for fresh installs.
            // Merges Fix-13's welcome message here instead of injecting into the
            // before_prompt_build hook (avoids MVP-Core behavior change).
            text += `\n🦞 **Welcome to Principles Disciple!**\n\n`;
            text += `This is a fresh workspace with no pain signals yet — that's expected.\n\n`;
            text += `**Next steps**:\n`;
            text += `1. Let your agent work and run \`/pd-pain <description>\` when it makes a mistake\n`;
            text += `2. Or run the demo: \`pd demo first-principle\`\n`;
            text += `3. Configure LLM runtime profile: \`pd console open --workspace "<path>"\`\n\n`;
            text += `Approved principles will appear here once activated.`;
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

export async function handlePainReportCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'pain-report');
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';
  const { sessionId } = ctx as SessionAwareCommandContext;
  const args = normalizeCommandArgs(ctx.args).trim();

  if (!args) {
    return {
      text: isZh
        ? '❌ 请提供 pain reason。用法: `/pd-pain <描述你遇到的问题>`'
        : '❌ Please provide a pain reason. Usage: `/pd-pain <describe the issue you encountered>`',
    };
  }

  if (!sessionId || sessionId === 'unknown') {
    return {
      text: isZh
        ? '❌ 无法获取当前会话 ID。请在 OpenClaw 对话会话中使用此命令。'
        : '❌ Session ID not available. Please use this command in an OpenClaw chat session.',
    };
  }

  const painId = `manual_${Date.now()}_${computeHash(sessionId).slice(0, 8)}`;

  // PRI-642 Scope A (SPEC §7.2): acquire validated evidence from the trusted
  // command-context session. Missing/empty evidence is surfaced explicitly —
  // it is never replaced by a placeholder entry.
  const evidenceAcquisition = acquireTrajectoryEvidence(wctx, sessionId);
  const evidence: PainEvidenceEntry[] = evidenceAcquisition.status === 'available'
    ? evidenceAcquisition.entries
    : [];
  const evidenceDegradation = evidenceAcquisition.status === 'unavailable'
    ? {
        reasonCode: evidenceAcquisition.reasonCode,
        detail: evidenceAcquisition.detail,
      }
    : null;

  const painData = {
    painId,
    painType: 'user_frustration' as const,
    source: 'manual',
    reason: args,
    score: 90,
    sessionId,
    agentId: 'openclaw-host',
    provenance: 'host_context_bound' as const,
    hostKind: 'openclaw' as const,
    evidence,
  };

  try {
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: wctx.stateDir });
    // PRI-306: Load .pd/config.yaml for config-driven runtime binding
    const configResult = loadPdConfigForPlugin(wctx.workspaceDir);
    const service = new PainToPrincipleService({
      workspaceDir: wctx.workspaceDir,
      stateDir: wctx.stateDir,
      ledgerAdapter,
      owner: 'openclaw-plugin',
      autoIntakeEnabled: true,
      effectiveConfig: configResult.effective,
      getEnvVar: (name: string) => process.env[name],
      intentDocReader: createIntentDocReader(wctx.workspaceDir, resolveIntentLang(wctx.workspaceDir)),
    });

    const result = await service.recordPain({
      painId: painData.painId,
      painType: painData.painType,
      source: painData.source,
      reason: painData.reason,
      score: painData.score,
      sessionId: painData.sessionId,
      agentId: painData.agentId,
      provenance: painData.provenance,
      hostKind: painData.hostKind,
      evidence: painData.evidence,
      recordObservability: true,
    });

    if (result.status === 'succeeded') {
      wctx.evolutionReducer.emitSync({
        ts: new Date().toISOString(),
        type: 'pain_detected',
        data: painData,
      } as EvolutionLoopEvent);

      // PRI-642: honest evidence disclosure. With unavailable evidence the
      // report stays bound to the real session, but the Owner must see that
      // the diagnosis lacks trajectory evidence and admission may gate
      // candidates — never a false "context-bound success" claim (SPEC §8.2).
      const evidenceNote = evidenceDegradation
        ? (isZh
          ? `\n\n⚠️ **会话轨迹证据不可用** (${evidenceDegradation.reasonCode}: ${evidenceDegradation.detail})。诊断将缺少轨迹证据，候选可能被 admission gate 拦截。`
          : `\n\n⚠️ **Session trajectory evidence unavailable** (${evidenceDegradation.reasonCode}: ${evidenceDegradation.detail}). The diagnosis will lack trajectory evidence; candidates may be blocked by the admission gate.`)
        : (isZh
          ? `\n📎 **Evidence**: ${evidence.length} 条轨迹证据`
          : `\n📎 **Evidence**: ${evidence.length} trajectory evidence entries`);

      return {
        text: isZh
          ? `✅ Pain 已记录 (context-bound)\n\n📋 **Pain ID**: ${painId}\n📝 **Reason**: ${args}\n🔗 **Provenance**: host_context_bound\n📌 **Session**: ${sessionId}${evidenceNote}`
          : `✅ Pain recorded (context-bound)\n\n📋 **Pain ID**: ${painId}\n📝 **Reason**: ${args}\n🔗 **Provenance**: host_context_bound\n📌 **Session**: ${sessionId}${evidenceNote}`,
      };
    }

    if (result.status === 'retried') {
      const errorInfo = result.failureCategory
        ? (isZh ? `\n⚠️ **错误类别**: ${result.failureCategory}` : `\n⚠️ **Error category**: ${result.failureCategory}`)
        : '';
      const messageInfo = result.message
        ? (isZh ? `\n📝 **详情**: ${result.message}` : `\n📝 **Detail**: ${result.message}`)
        : '';
      return {
        text: isZh
          ? `✅ Pain 已记录，诊断任务已进入重试\n\n📋 **Pain ID**: ${result.painId}\n🔧 **Task ID**: ${result.taskId}${errorInfo}${messageInfo}\n\n诊断任务将在后台自动重试。使用 \`/pd-status\` 查看任务状态。`
          : `✅ Pain recorded, diagnosis task entered retry\n\n📋 **Pain ID**: ${result.painId}\n🔧 **Task ID**: ${result.taskId}${errorInfo}${messageInfo}\n\nThe diagnosis task will retry automatically in the background. Use \`/pd-status\` to check task status.`,
      };
    }

    // status === 'failed' | 'skipped' | 'degraded' — pain was NOT accepted
    const reasonInfo = result.failureCategory
      ? (isZh ? `\n⚠️ **原因**: ${result.failureCategory}` : `\n⚠️ **Reason**: ${result.failureCategory}`)
      : '';
    const messageInfo = result.message
      ? (isZh ? `\n📝 **详情**: ${result.message}` : `\n📝 **Detail**: ${result.message}`)
      : '';
    return {
      text: isZh
        ? `❌ Pain 记录未成功 (status: ${result.status})${reasonInfo}${messageInfo}\n\n请检查系统日志或使用 \`/pd-status\` 查看状态。`
        : `❌ Pain recording not accepted (status: ${result.status})${reasonInfo}${messageInfo}\n\nCheck system logs or use \`/pd-status\` for status.`,
    };
  } catch (err) {
    return {
      text: isZh
        ? `❌ Pain 记录失败: ${String(err)}。请检查系统日志或重试。`
        : `❌ Failed to record pain: ${String(err)}. Check system logs or try again.`,
    };
  }
}
