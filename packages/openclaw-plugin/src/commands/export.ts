import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleExportCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'export');
  const zh = isZh(ctx);
  const args = normalizeCommandArgs(ctx.args).trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const [subcommand = 'corrections'] = parts;
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  try {
    if (subcommand !== 'analytics' && subcommand !== 'corrections') {
      return {
        text: zh
          ? '无效的导出类型。请使用 `analytics` 或 `corrections [--redacted]`。'
          : 'Invalid export target. Use `analytics` or `corrections [--redacted]`',
      };
    }

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
  } catch (err) {
    console.error('[pd-export] Export failed:', {
      subcommand,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return {
      text: zh
        ? `导出失败 (${subcommand}): ${err instanceof Error ? err.message : String(err)}`
        : `Export failed (${subcommand}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
