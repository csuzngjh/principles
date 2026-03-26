import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import { normalizeLanguage } from '../i18n/commands.js';
import { RuntimeSummaryService } from '../service/runtime-summary-service.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

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
  sources: Array<{ source: string; score?: number }>
): string {
  if (sources.length === 0) {
    return '--';
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
    `- Runtime Trust Truth: score ${formatNumber(summary.runtime.currentTrustScore)}, classification ${summary.runtime.workspaceState.trustClassification}, frozen ${summary.runtime.workspaceState.frozen === null ? '--' : String(summary.runtime.workspaceState.frozen)}`,
    `- Session GFI: current ${formatNumber(summary.gfi.current)}, peak ${formatNumber(summary.gfi.peak)} (${summary.gfi.dataQuality})`,
    `- GFI Sources: ${formatSources(summary.gfi.sources)}`,
    `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? ` (${summary.pain.activeFlagSource})` : ''}`,
    `- Last Pain Signal: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
    `- Gate Events: blocks ${formatNumber(summary.gate.recentBlocks)}, bypasses ${formatNumber(summary.gate.recentBypasses)} (${summary.gate.dataQuality})`,
    '',
    'Evolution',
    `- Queue: pending ${summary.evolution.queue.pending}, in_progress ${summary.evolution.queue.inProgress}, completed ${summary.evolution.queue.completed} (${summary.evolution.dataQuality})`,
    `- Legacy Directive File: ${summary.phase3.legacyDirectiveFilePresent ? 'present' : 'missing'} (compatibility-only display artifact)`,
    `- Note: Legacy directive file is NOT a truth source for Phase 3 eligibility. Queue is the only authoritative execution truth source.`,
    `- Active Evolution Task: ${summary.evolution.directive.taskPreview ?? '--'}`,
    `- Phase 3: ready ${summary.phase3.phase3ShadowEligible ? 'yes' : 'no'}, queueTruthReady ${summary.phase3.queueTruthReady ? 'yes' : 'no'}, trustInputReady ${summary.phase3.trustInputReady ? 'yes' : 'no'}, eligible ${summary.phase3.evolutionEligible}, reference_only ${summary.phase3.evolutionReferenceOnly}, rejected ${summary.phase3.evolutionRejected}${summary.phase3.evolutionReferenceOnlyReasons.length > 0 ? ` (reference ${summary.phase3.evolutionReferenceOnlyReasons.slice(0, 2).join(', ')})` : ''}${summary.phase3.evolutionRejectedReasons.length > 0 ? ` (${summary.phase3.evolutionRejectedReasons.slice(0, 3).join(', ')})` : ''}${summary.phase3.trustRejectedReasons.length > 0 ? `; trust ${summary.phase3.trustRejectedReasons.slice(0, 2).join(', ')}` : ''}`,
    `- Phase 3 Legacy Directive File: ${summary.phase3.directiveStatus} (${summary.phase3.directiveIgnoredReason})`,
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
    '进化状态',
    '================',
    '',
    '控制面',
    `- Legacy Trust: ${formatNumber(summary.legacyTrust.score)}/100（阶段 ${formatStage(summary.legacyTrust.stage)}，legacy/frozen，${summary.legacyTrust.rewardPolicy}）`,
    `- Runtime Trust Truth: score ${formatNumber(summary.runtime.currentTrustScore)}，classification ${summary.runtime.workspaceState.trustClassification}，frozen ${summary.runtime.workspaceState.frozen === null ? '--' : String(summary.runtime.workspaceState.frozen)}`,
    `- 会话 GFI: 当前 ${formatNumber(summary.gfi.current)}，峰值 ${formatNumber(summary.gfi.peak)}（${summary.gfi.dataQuality}）`,
    `- GFI 来源: ${formatSources(summary.gfi.sources)}`,
    `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? `（${summary.pain.activeFlagSource}）` : ''}`,
    `- 最近 Pain 信号: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
    `- Gate 事件: block ${formatNumber(summary.gate.recentBlocks)}，bypass ${formatNumber(summary.gate.recentBypasses)}（${summary.gate.dataQuality}）`,
    '',
    '进化',
    `- 队列: pending ${summary.evolution.queue.pending}，in_progress ${summary.evolution.queue.inProgress}，completed ${summary.evolution.queue.completed}（${summary.evolution.dataQuality}）`,
    `- Legacy Directive File: ${summary.phase3.legacyDirectiveFilePresent ? 'present' : 'missing'} （兼容仅显示产物）`,
    `- 注：Legacy directive file 不是 Phase 3 合格性的真实源。队列是唯一权威的执行真实源。`,
    `- Active Evolution Task: ${summary.evolution.directive.taskPreview ?? '--'}`,
    `- Phase 3: ready ${summary.phase3.phase3ShadowEligible ? 'yes' : 'no'}，queueTruthReady ${summary.phase3.queueTruthReady ? 'yes' : 'no'}，trustInputReady ${summary.phase3.trustInputReady ? 'yes' : 'no'}，eligible ${summary.phase3.evolutionEligible}，reference_only ${summary.phase3.evolutionReferenceOnly}，rejected ${summary.phase3.evolutionRejected}${summary.phase3.evolutionReferenceOnlyReasons.length > 0 ? `（reference ${summary.phase3.evolutionReferenceOnlyReasons.slice(0, 2).join(', ')}）` : ''}${summary.phase3.evolutionRejectedReasons.length > 0 ? `（${summary.phase3.evolutionRejectedReasons.slice(0, 3).join(', ')}）` : ''}${summary.phase3.trustRejectedReasons.length > 0 ? `；trust ${summary.phase3.trustRejectedReasons.slice(0, 2).join(', ')}` : ''}`,
    `- Phase 3 Legacy Directive File: ${summary.phase3.directiveStatus} (${summary.phase3.directiveIgnoredReason})`,
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
    lines.push('', '警告');
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
