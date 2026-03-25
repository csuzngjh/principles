import { WorkspaceContext } from '../core/workspace-context.js';
function isZh(ctx) {
    return String(ctx.config?.language || 'en').startsWith('zh');
}
export function handleExportCommand(ctx) {
    const workspaceDir = ctx.config?.workspaceDir || process.cwd();
    const zh = isZh(ctx);
    const args = (ctx.args || '').trim();
    const [subcommand = 'corrections'] = args.split(/\s+/).filter(Boolean);
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    if (subcommand !== 'analytics' && subcommand !== 'corrections') {
        return {
            text: zh
                ? '无效的导出类型。请使用 `analytics` 或 `corrections [--redacted]`。'
                : 'Invalid export target. Use `analytics` or `corrections [--redacted]`.',
        };
    }
    try {
        if (subcommand === 'analytics') {
            const result = wctx.trajectory.exportAnalytics();
            return {
                text: zh
                    ? `已导出 analytics 快照到 ${result.filePath}，共 ${result.count} 条聚合记录。`
                    : `Exported analytics snapshot to ${result.filePath} (${result.count} aggregated rows).`,
            };
        }
        const redacted = args.includes('--redacted');
        const result = wctx.trajectory.exportCorrections({
            mode: redacted ? 'redacted' : 'raw',
            approvedOnly: true,
        });
        return {
            text: zh
                ? `已导出纠错样本到 ${result.filePath}，模式 ${result.mode}，共 ${result.count} 条。`
                : `Exported correction samples to ${result.filePath} (mode=${result.mode}, count=${result.count}).`,
        };
    }
    catch {
        return {
            text: zh
                ? '导出失败，请检查日志。'
                : 'Export failed. Check logs.',
        };
    }
}
