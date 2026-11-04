import { getSession } from '../core/session-tracker.js';
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
import { ingressDecisionForPluginPain } from '../hooks/pain-ingress-adapter.js';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';

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

    if (args === 'data') {
        const stats = wctx.trajectory.getDataStats();
        return {
            text: isZh
                ? `轨迹数据状态\n- 数据库: ${stats.dbPath}\n- 助手轮次: ${stats.assistantTurns}\n- 用户轮次: ${stats.userTurns}\n- 工具调用: ${stats.toolCalls}\n- 痛感事件: ${stats.painEvents}\n- 待审核样本: ${stats.pendingSamples}\n- 已通过样本: ${stats.approvedSamples}\n- Blob 字节数: ${stats.blobBytes}\n- 最近写入: ${stats.lastIngestAt ?? 'none'}`
                : `Trajectory Data Status\n- DB: ${stats.dbPath}\n- assistant turns: ${stats.assistantTurns}\n- user turns: ${stats.userTurns}\n- tool calls: ${stats.toolCalls}\n- pain events: ${stats.painEvents}\n- pending samples: ${stats.pendingSamples}\n- approved samples: ${stats.approvedSamples}\n- blob bytes: ${stats.blobBytes}\n- last ingest: ${stats.lastIngestAt ?? 'none'}`
        };
    }

    // Default: source-backed status (GFI-COMPLETE-REMOVAL-001, SPEC §4.5).
    // The friction score, mental mode and fatigue rating are intentionally
    // gone. Every number below has a real producer; none of it is synthesized.
    const session = sessionId ? getSession(sessionId) : undefined;
    const {dictionary} = wctx;
    const stats = dictionary.getStats();

    const today = new Date().toISOString().split('T')[0] ?? '';
    const daily = wctx.eventLog.getDailyStats(today);
    const toolCalls = daily.tools;
    const hooks = daily.hooks;
    const evolution = daily.evolution;
    const trajectory = wctx.trajectory.getDataStats();

    // Get session empathy stats for inline display
    const sessionEmpathy = sessionId ? wctx.eventLog.getEmpathyStats('session', sessionId) : null;
    let empathyInline = '';
    if (sessionEmpathy && sessionEmpathy.totalEvents > 0) {
        empathyInline = isZh
            ? `\n🫀 **情绪事件 (当前会话)**: ${sessionEmpathy.totalEvents} 次 (${sessionEmpathy.totalPenaltyScore}分)`
            : `\n🫀 **Empathy Events (Session)**: ${sessionEmpathy.totalEvents} (${sessionEmpathy.totalPenaltyScore}pts)`;
    }

    const isEmptyWorkspace = stats.totalRules === 0 && stats.totalHits === 0;

    if (isZh) {
        let text = `📊 **Principles Disciple - 系统状态**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `🧭 **当前会话**: ${sessionId || '未识别'}\n`;
        text += `   ├─ LLM 轮次: ${session?.llmTurns ?? 0}\n`;
        text += `   ├─ 注入原则: ${session?.injectedPrincipleIds?.length ?? 0} 条\n`;
        text += `   ├─ 自动纠正: ${session?.receiptAutoCorrects ?? 0} 次\n`;
        text += `   └─ Gate 拦截: ${session?.blockedAttempts ?? 0} 次\n`;
        text += empathyInline;
        text += `\n📅 **今日 (${today})**\n`;
        text += `   ├─ 工具调用: ${toolCalls.total} 次 (成功 ${toolCalls.success} / 失败 ${toolCalls.failure})\n`;
        text += `   ├─ Hook 执行: ${hooks.total} 次 (成功 ${hooks.success} / 失败 ${hooks.failure})\n`;
        text += `   └─ RuleHost: 评估 ${evolution.rulehostEvaluated} · 拦截 ${evolution.rulehostBlocked} · 自动纠正 ${evolution.rulehostAutoCorrectApplied}\n`;
        text += `\n🗄 **轨迹库**: 工具调用 ${trajectory.toolCalls} · 痛感事件 ${trajectory.painEvents} (用 \`/pd-status data\` 查看详情)\n`;
        text += `\n🧠 **痛苦进化词典**: 已吸收 ${stats.totalRules} 条规则\n`;
        text += `   ↳ 累计规则命中 ${stats.totalHits} 次 (命中不等于拦截)\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        if (isEmptyWorkspace) {
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
        let text = `📊 **Principles Disciple - System Status**\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `🧭 **Session**: ${sessionId || 'unknown'}\n`;
        text += `   ├─ LLM turns: ${session?.llmTurns ?? 0}\n`;
        text += `   ├─ Injected principles: ${session?.injectedPrincipleIds?.length ?? 0}\n`;
        text += `   ├─ Auto-corrects: ${session?.receiptAutoCorrects ?? 0}\n`;
        text += `   └─ Gate blocks: ${session?.blockedAttempts ?? 0}\n`;
        text += empathyInline;
        text += `\n📅 **Today (${today})**\n`;
        text += `   ├─ Tool calls: ${toolCalls.total} (success ${toolCalls.success} / failure ${toolCalls.failure})\n`;
        text += `   ├─ Hook runs: ${hooks.total} (success ${hooks.success} / failure ${hooks.failure})\n`;
        text += `   └─ RuleHost: evaluated ${evolution.rulehostEvaluated} · blocked ${evolution.rulehostBlocked} · auto-corrected ${evolution.rulehostAutoCorrectApplied}\n`;
        text += `\n🗄 **Trajectory DB**: ${trajectory.toolCalls} tool calls · ${trajectory.painEvents} pain events (use \`/pd-status data\` for details)\n`;
        text += `\n🧠 **Evolution Dictionary**: ${stats.totalRules} active rules\n`;
        text += `   ↳ ${stats.totalHits} cumulative rule hits (a hit is not a block)\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        if (isEmptyWorkspace) {
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
  // PRI-686: wire the divergence warning into the real command chain — the
  // ctx may carry a logger per the SDK convention (hook adapter supplies it);
  // without it a PD-explicit vs OpenClaw-context split would be silent (rc-9).
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'pain-report', ctx.logger);
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

  // PRI-642 Scope B: route through the shared ingress so provenance,
  // evidence classification and the persisted painIngress.v1 facts are
  // derived in ONE place for every emitter (SPEC §8.3, §9).
  const decision = ingressDecisionForPluginPain({
    wctx,
    painId,
    painType: 'user_frustration',
    source: 'manual',
    reason: args,
    score: 90,
    sessionId,
  });
  if (decision.action === 'refuse') {
    return {
      text: isZh
        ? `❌ Pain 报告被拒绝 (${decision.reasonCode})。${decision.nextAction}`
        : `❌ Pain report refused (${decision.reasonCode}). ${decision.nextAction}`,
    };
  }
  const evidence: PainEvidenceEntry[] = decision.legacy.evidence;
  const evidenceDegradation = decision.action === 'degrade'
    ? { reasonCode: decision.reasonCode, detail: decision.warning }
    : null;

  const painData = {
    painId,
    painType: 'user_frustration' as const,
    source: 'manual',
    reason: args,
    score: 90,
    sessionId,
    agentId: 'openclaw-host',
    provenance: decision.legacy.provenance,
    hostKind: decision.legacy.hostKind,
    evidence,
    painIngress: decision.legacy.painIngress,
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
      painIngress: painData.painIngress,
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
    // PRI-686 Fix A: when trajectory evidence was unavailable at ingress
    // (e.g. empty_trajectory), surface WHY here — otherwise the Owner sees
    // only "all_candidates_gated:...=needs_evidence" with no way to
    // self-diagnose the evidence gap (rc-9: silent degradation).
    const evidenceCauseInfo = evidenceDegradation
      ? (isZh
        ? `\n🔍 **证据不可用**: ${evidenceDegradation.reasonCode}${evidenceDegradation.detail ? ` — ${evidenceDegradation.detail}` : ''}`
        : `\n🔍 **Evidence unavailable**: ${evidenceDegradation.reasonCode}${evidenceDegradation.detail ? ` — ${evidenceDegradation.detail}` : ''}`)
      : '';
    return {
      text: isZh
        ? `❌ Pain 记录未成功 (status: ${result.status})${reasonInfo}${messageInfo}${evidenceCauseInfo}\n\n请检查系统日志或使用 \`/pd-status\` 查看状态。`
        : `❌ Pain recording not accepted (status: ${result.status})${reasonInfo}${messageInfo}${evidenceCauseInfo}\n\nCheck system logs or use \`/pd-status\` for status.`,
    };
  } catch (err) {
    return {
      text: isZh
        ? `❌ Pain 记录失败: ${String(err)}。请检查系统日志或重试。`
        : `❌ Failed to record pain: ${String(err)}. Check system logs or try again.`,
    };
  }
}
