import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleExportCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  if (args.startsWith('analytics')) {
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
      ? `已导出纠错样本到 ${result.filePath}，模式=${result.mode}，共 ${result.count} 条。`
      : `Exported correction samples to ${result.filePath} (mode=${result.mode}, count=${result.count}).`,
  };
}
