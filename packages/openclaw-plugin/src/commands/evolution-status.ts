import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import { normalizeLanguage } from '../i18n/commands.js';
import { RuntimeSummaryService } from '../service/runtime-summary-service.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

function formatAge(ageSeconds: number | null, lang: 'en' | 'zh'): string {
  if (ageSeconds === null) {
    return lang === 'zh' ? '--' : '--';
  }

  if (ageSeconds < 60) {
    return lang === 'zh' ? `${ageSeconds} 秒` : `${ageSeconds}s`;
  }

  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) {
    return lang === 'zh' ? `${minutes} 分钟` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return lang === 'zh' ? `${hours} 小时` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return lang === 'zh' ? `${days} 天` : `${days}d`;
}

function formatNumber(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatStage(value: number | null): string {
  return value === null ? '--' : String(value);
}

function formatSources(
  sources: Array<{ source: string; score?: number }>,
  lang: 'en' | 'zh'
): string {
  if (sources.length === 0) {
    return lang === 'zh' ? '--' : '--';
  }

  return sources
    .map((source) =>
      source.score === undefined
        ? source.source
        : `${source.source}(${formatNumber(source.score)})`
    )
    .join(', ');
}

function buildEnglishOutput(
  workspaceDir: string,
  sessionId: string | null,
  warnings: string[],
  stats: ReturnType<EvolutionReducerImpl['getStats']>,
  summary: ReturnType<typeof RuntimeSummaryService.getSummary>
): string {
  const lines: string[] = [
    'Evolution Status',
    '================',
    '',
    'Control Plane',
    `- Legacy Trust: ${formatNumber(summary.legacyTrust.score)}/100 (stage ${formatStage(summary.legacyTrust.stage)}, legacy/frozen, ${summary.legacyTrust.rewardPolicy})`,
    `- Session GFI: current ${formatNumber(summary.gfi.current)}, peak ${formatNumber(summary.gfi.peak)} (${summary.gfi.dataQuality})`,
    `- GFI Sources: ${formatSources(summary.gfi.sources, 'en')}`,
    `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? ` (${summary.pain.activeFlagSource})` : ''}`,
    `- Last Pain Signal: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
    `- Gate Events: blocks ${formatNumber(summary.gate.recentBlocks)}, bypasses ${formatNumber(summary.gate.recentBypasses)} (${summary.gate.dataQuality})`,
    '',
    'Evolution',
    `- Queue: pending ${summary.evolution.queue.pending}, in_progress ${summary.evolution.queue.inProgress}, completed ${summary.evolution.queue.completed} (${summary.evolution.dataQuality})`,
    `- Directive: ${summary.evolution.directive.exists ? 'present' : 'missing'}, active ${summary.evolution.directive.active === null ? '--' : summary.evolution.directive.active ? 'yes' : 'no'}, age ${formatAge(summary.evolution.directive.ageSeconds, 'en')}`,
    `- Directive Task: ${summary.evolution.directive.taskPreview ?? '--'}`,
    '',
    'Principles',
    `- candidate principles: ${stats.candidateCount}`,
    `- probation principles: ${stats.probationCount}`,
    `- active principles: ${stats.activeCount}`,
    `- deprecated principles: ${stats.deprecatedCount}`,
    `- last promoted: ${stats.lastPromotedAt ?? 'none'}`,
    '',
    'Metadata',
    `- workspace: ${workspaceDir}`,
    `- session: ${sessionId ?? '--'} (${summary.metadata.selectedSessionReason})`,
    `- generatedAt: ${summary.metadata.generatedAt}`,
  ];

  if (warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

function buildChineseOutput(
  workspaceDir: string,
  sessionId: string | null,
  warnings: string[],
  stats: ReturnType<EvolutionReducerImpl['getStats']>,
  summary: ReturnType<typeof RuntimeSummaryService.getSummary>
): string {
  const lines: string[] = [
    'Evolution 状态',
    '================',
    '',
    '控制面',
    `- Legacy Trust: ${formatNumber(summary.legacyTrust.score)}/100（Stage ${formatStage(summary.legacyTrust.stage)}，legacy/frozen，${summary.legacyTrust.rewardPolicy}）`,
    `- 会话 GFI: 当前 ${formatNumber(summary.gfi.current)}，峰值 ${formatNumber(summary.gfi.peak)}（${summary.gfi.dataQuality}）`,
    `- GFI 来源: ${formatSources(summary.gfi.sources, 'zh')}`,
    `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? `（${summary.pain.activeFlagSource}）` : ''}`,
    `- 最近 Pain 信号: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
    `- Gate 事件: block ${formatNumber(summary.gate.recentBlocks)}，bypass ${formatNumber(summary.gate.recentBypasses)}（${summary.gate.dataQuality}）`,
    '',
    '进化状态',
    `- 队列: pending ${summary.evolution.queue.pending}，in_progress ${summary.evolution.queue.inProgress}，completed ${summary.evolution.queue.completed}（${summary.evolution.dataQuality}）`,
    `- Directive: ${summary.evolution.directive.exists ? 'present' : 'missing'}，active ${summary.evolution.directive.active === null ? '--' : summary.evolution.directive.active ? 'yes' : 'no'}，age ${formatAge(summary.evolution.directive.ageSeconds, 'zh')}`,
    `- Directive 任务: ${summary.evolution.directive.taskPreview ?? '--'}`,
    '',
    '原则统计',
    `- 候选原则: ${stats.candidateCount}`,
    `- 观察期原则: ${stats.probationCount}`,
    `- 生效原则: ${stats.activeCount}`,
    `- 已废弃原则: ${stats.deprecatedCount}`,
    `- 最近晋升: ${stats.lastPromotedAt ?? '无'}`,
    '',
    '元数据',
    `- 工作区: ${workspaceDir}`,
    `- Session: ${sessionId ?? '--'}（${summary.metadata.selectedSessionReason}）`,
    `- 生成时间: ${summary.metadata.generatedAt}`,
  ];

  if (warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

export function handleEvolutionStatusCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const sessionId = (ctx as { sessionId?: string | null }).sessionId ?? null;
  const reducer = new EvolutionReducerImpl({ workspaceDir });
  const stats = reducer.getStats();
  const summary = RuntimeSummaryService.getSummary(workspaceDir, { sessionId });
  const rawLang = (ctx.config?.language as string) || 'en';
  const lang = normalizeLanguage(rawLang);
  const warnings = summary.metadata.warnings.slice(0, 12);

  if (lang === 'zh') {
    return {
      text: buildChineseOutput(workspaceDir, summary.metadata.sessionId, warnings, stats, summary),
    };
  }

  return {
    text: buildEnglishOutput(workspaceDir, summary.metadata.sessionId, warnings, stats, summary),
  };
}
