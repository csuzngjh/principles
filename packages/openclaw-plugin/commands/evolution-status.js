import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import { normalizeLanguage } from '../i18n/commands.js';
import { RuntimeSummaryService } from '../service/runtime-summary-service.js';
function formatAge(ageSeconds, lang) {
    if (ageSeconds === null) {
        return '--';
    }
    if (ageSeconds < 60) {
        return lang === 'zh' ? `${ageSeconds} \u79d2` : `${ageSeconds}s`;
    }
    const minutes = Math.floor(ageSeconds / 60);
    if (minutes < 60) {
        return lang === 'zh' ? `${minutes} \u5206\u949f` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return lang === 'zh' ? `${hours} \u5c0f\u65f6` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return lang === 'zh' ? `${days} \u5929` : `${days}d`;
}
function formatNumber(value) {
    if (value === null || Number.isNaN(value)) {
        return '--';
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function formatStage(value) {
    return value === null ? '--' : String(value);
}
function formatSources(sources) {
    if (sources.length === 0) {
        return '--';
    }
    return sources
        .map((source) => source.score === undefined
        ? source.source
        : `${source.source}(${formatNumber(source.score)})`)
        .join(', ');
}
function buildEnglishOutput(workspaceDir, sessionId, warnings, stats, summary) {
    const lines = [
        'Evolution Status',
        '================',
        '',
        'Control Plane',
        `- Legacy Trust: ${formatNumber(summary.legacyTrust.score)}/100 (stage ${formatStage(summary.legacyTrust.stage)}, legacy/frozen, ${summary.legacyTrust.rewardPolicy})`,
        `- Session GFI: current ${formatNumber(summary.gfi.current)}, peak ${formatNumber(summary.gfi.peak)} (${summary.gfi.dataQuality})`,
        `- GFI Sources: ${formatSources(summary.gfi.sources)}`,
        `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? ` (${summary.pain.activeFlagSource})` : ''}`,
        `- Last Pain Signal: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
        `- Gate Events: blocks ${formatNumber(summary.gate.recentBlocks)}, bypasses ${formatNumber(summary.gate.recentBypasses)} (${summary.gate.dataQuality})`,
        '',
        'Evolution',
        `- Queue: pending ${summary.evolution.queue.pending}, in_progress ${summary.evolution.queue.inProgress}, completed ${summary.evolution.queue.completed} (${summary.evolution.dataQuality})`,
        `- Directive (derived from queue, compatibility only): ${summary.evolution.directive.exists ? 'present' : 'missing'}, active ${summary.evolution.directive.active === null ? '--' : summary.evolution.directive.active ? 'yes' : 'no'}, age ${formatAge(summary.evolution.directive.ageSeconds, 'en')}`,
        `- Directive Task: ${summary.evolution.directive.taskPreview ?? '--'}`,
        `- Phase 3: ready ${summary.phase3.phase3ShadowEligible ? 'yes' : 'no'}, queueTruthReady ${summary.phase3.queueTruthReady ? 'yes' : 'no'}, trustInputReady ${summary.phase3.trustInputReady ? 'yes' : 'no'}, eligible ${summary.phase3.evolutionEligible}, rejected ${summary.phase3.evolutionRejected}${summary.phase3.evolutionRejectedReasons.length > 0 ? ` (${summary.phase3.evolutionRejectedReasons.slice(0, 3).join(', ')})` : ''}${summary.phase3.trustRejectedReasons.length > 0 ? `; trust ${summary.phase3.trustRejectedReasons.slice(0, 2).join(', ')}` : ''}`,
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
function buildChineseOutput(workspaceDir, sessionId, warnings, stats, summary) {
    const lines = [
        '\u8fdb\u5316\u72b6\u6001',
        '================',
        '',
        '\u63a7\u5236\u9762',
        `- Legacy Trust: ${formatNumber(summary.legacyTrust.score)}/100\uff08\u9636\u6bb5 ${formatStage(summary.legacyTrust.stage)}\uff0clegacy/frozen\uff0c${summary.legacyTrust.rewardPolicy}\uff09`,
        `- \u4f1a\u8bdd GFI: \u5f53\u524d ${formatNumber(summary.gfi.current)}\uff0c\u5cf0\u503c ${formatNumber(summary.gfi.peak)}\uff08${summary.gfi.dataQuality}\uff09`,
        `- GFI \u6765\u6e90: ${formatSources(summary.gfi.sources)}`,
        `- Pain Flag: ${summary.pain.activeFlag ? 'active' : 'inactive'}${summary.pain.activeFlagSource ? `\uff08${summary.pain.activeFlagSource}\uff09` : ''}`,
        `- \u6700\u8fd1 Pain \u4fe1\u53f7: ${summary.pain.lastSignal ? `${summary.pain.lastSignal.source}${summary.pain.lastSignal.reason ? ` - ${summary.pain.lastSignal.reason}` : ''}` : '--'}`,
        `- Gate \u4e8b\u4ef6: block ${formatNumber(summary.gate.recentBlocks)}\uff0cbypass ${formatNumber(summary.gate.recentBypasses)}\uff08${summary.gate.dataQuality}\uff09`,
        '',
        '\u8fdb\u5316',
        `- \u961f\u5217: pending ${summary.evolution.queue.pending}\uff0cin_progress ${summary.evolution.queue.inProgress}\uff0ccompleted ${summary.evolution.queue.completed}\uff08${summary.evolution.dataQuality}\uff09`,
        `- Directive\uff08\u7531\u961f\u5217\u6d3e\u751f\uff0c\u517c\u5bb9\u4ec5\uff09: ${summary.evolution.directive.exists ? 'present' : 'missing'}\uff0cactive ${summary.evolution.directive.active === null ? '--' : summary.evolution.directive.active ? 'yes' : 'no'}\uff0cage ${formatAge(summary.evolution.directive.ageSeconds, 'zh')}`,
        `- Directive \u4efb\u52a1: ${summary.evolution.directive.taskPreview ?? '--'}`,
        `- Phase 3: ready ${summary.phase3.phase3ShadowEligible ? 'yes' : 'no'}\uff0cqueueTruthReady ${summary.phase3.queueTruthReady ? 'yes' : 'no'}\uff0ctrustInputReady ${summary.phase3.trustInputReady ? 'yes' : 'no'}\uff0celigible ${summary.phase3.evolutionEligible}\uff0crejected ${summary.phase3.evolutionRejected}${summary.phase3.evolutionRejectedReasons.length > 0 ? `\uff08${summary.phase3.evolutionRejectedReasons.slice(0, 3).join(', ')}\uff09` : ''}${summary.phase3.trustRejectedReasons.length > 0 ? `\uff1btrust ${summary.phase3.trustRejectedReasons.slice(0, 2).join(', ')}` : ''}`,
        '',
        '\u539f\u5219\u7edf\u8ba1',
        `- \u5019\u9009\u539f\u5219: ${stats.candidateCount}`,
        `- \u89c2\u5bdf\u671f\u539f\u5219: ${stats.probationCount}`,
        `- \u751f\u6548\u539f\u5219: ${stats.activeCount}`,
        `- \u5df2\u5e9f\u5f03\u539f\u5219: ${stats.deprecatedCount}`,
        `- \u6700\u8fd1\u664b\u5347: ${stats.lastPromotedAt ?? '\u65e0'}`,
        '',
        '\u5143\u6570\u636e',
        `- \u5de5\u4f5c\u533a: ${workspaceDir}`,
        `- Session: ${sessionId ?? '--'}\uff08${summary.metadata.selectedSessionReason}\uff09`,
        `- \u751f\u6210\u65f6\u95f4: ${summary.metadata.generatedAt}`,
    ];
    if (warnings.length > 0) {
        lines.push('', '警告');
        for (const warning of warnings) {
            lines.push(`- ${warning}`);
        }
    }
    return lines.join('\n');
}
export function handleEvolutionStatusCommand(ctx) {
    const workspaceDir = ctx.config?.workspaceDir || process.cwd();
    const sessionId = ctx.sessionId ?? null;
    const reducer = new EvolutionReducerImpl({ workspaceDir });
    const stats = reducer.getStats();
    const summary = RuntimeSummaryService.getSummary(workspaceDir, { sessionId });
    const rawLang = ctx.config?.language || 'en';
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
