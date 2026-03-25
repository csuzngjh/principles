import { WorkspaceContext } from '../core/workspace-context.js';
function createProgressBar(value, max, length = 12) {
    const safeValue = Math.max(0, Math.min(max, value));
    const filledLength = Math.round((safeValue / max) * length);
    const emptyLength = Math.max(0, length - filledLength);
    return `[${'#'.repeat(filledLength)}${'-'.repeat(emptyLength)}]`;
}
function formatStageTitle(stage, isZh) {
    const titles = isZh
        ? ['Observer', 'Editor', 'Developer', 'Architect']
        : ['Observer', 'Editor', 'Developer', 'Architect'];
    return titles[Math.max(0, Math.min(3, stage - 1))] ?? 'Unknown';
}
export function handleTrustCommand(ctx) {
    const { workspaceDir } = ctx;
    if (!workspaceDir)
        return 'Error: Workspace directory not found.';
    const wctx = WorkspaceContext.fromHookContext(ctx);
    const trustEngine = wctx.trust;
    const trustScore = trustEngine.getScore();
    const stage = trustEngine.getStage();
    const isZh = wctx.config.get('language') === 'zh';
    const scorecard = trustEngine.getScorecard();
    const hygiene = wctx.hygiene.getStats();
    const trustBar = createProgressBar(trustScore, 100);
    const hygieneScore = Math.min(100, hygiene.persistenceCount * 10);
    const hygieneBar = createProgressBar(hygieneScore, 100);
    const rewardPolicy = scorecard.reward_policy ?? 'frozen_all_positive';
    const lastUpdated = scorecard.last_updated ?? '--';
    if (isZh) {
        return [
            'Principles Disciple - Legacy Trust',
            '=================================',
            '',
            `- Legacy Trust: ${trustBar} ${trustScore}/100`,
            `- Stage: ${stage} (${formatStageTitle(stage, true)})`,
            `- Status: legacy/frozen`,
            `- Reward Policy: ${rewardPolicy}`,
            `- Last Updated: ${lastUpdated}`,
            '',
            '说明',
            '- 这是兼容旧控制面的 legacy trust 视图，不再代表新的长期能力模型。',
            '- `tool_success` 与 `subagent_success` 不再自动提升 trust。',
            '- 当前观察窗口内，trust 主要保留为兼容读数与 gate 兼容输入。',
            '',
            '认知卫生',
            `- Persistence: ${hygieneBar} ${hygiene.persistenceCount} actions today`,
            `- Total Chars Persisted: ${hygiene.totalCharsPersisted}`,
            `- Workspace Grooming: ${hygiene.groomingExecutedCount > 0 ? 'done' : 'pending'}`,
            '',
            '下一步',
            '- 在进入 Phase 3 capability shadow 之前，先看 production observation 数据是否稳定。',
        ].join('\n');
    }
    return [
        'Principles Disciple - Legacy Trust',
        '=================================',
        '',
        `- Legacy Trust: ${trustBar} ${trustScore}/100`,
        `- Stage: ${stage} (${formatStageTitle(stage, false)})`,
        '- Status: legacy/frozen',
        `- Reward Policy: ${rewardPolicy}`,
        `- Last Updated: ${lastUpdated}`,
        '',
        'Notes',
        '- This is a compatibility view of legacy trust, not the future long-term capability model.',
        '- `tool_success` and `subagent_success` no longer raise trust automatically.',
        '- During the current observation window, trust remains mainly for compatibility reads and gate compatibility.',
        '',
        'Cognitive Hygiene',
        `- Persistence: ${hygieneBar} ${hygiene.persistenceCount} actions today`,
        `- Total Chars Persisted: ${hygiene.totalCharsPersisted}`,
        `- Workspace Grooming: ${hygiene.groomingExecutedCount > 0 ? 'done' : 'pending'}`,
        '',
        'Next',
        '- Do not move into Phase 3 capability shadow until production observation data is stable.',
    ].join('\n');
}
