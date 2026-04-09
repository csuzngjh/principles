import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { exportORPOSamples, listExports } from '../core/nocturnal-export.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleExportCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const [subcommand = 'corrections'] = parts;
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  try {
    if (subcommand === 'orpo') {
      // Nocturnal ORPO export
      // Usage: pd-export orpo [--family=<targetModelFamily>]
      const familyArg = parts.find((p) => p.startsWith('--family='));
      const targetModelFamily = familyArg ? familyArg.split('=')[1] : undefined;

      const result = exportORPOSamples(workspaceDir, targetModelFamily);

      if (!result.success) {
        const reasonMap: Record<string, string> = {
          no_approved_samples: zh
            ? '没有已批准的样本'
            : 'No approved samples',
          family_mismatch: zh
            ? '没有找到指定模型家族的已批准样本'
            : 'No approved samples for the specified target model family',
          all_samples_missing_artifacts: zh
            ? '所有样本的 artifact 文件都缺失'
            : 'All sample artifact files are missing',
        };
        return {
          text: zh
            ? `ORPO 导出失败: ${reasonMap[result.emptyReason ?? ''] ?? result.error}`
            : `ORPO export failed: ${reasonMap[result.emptyReason ?? ''] ?? result.error}`,
        };
      }

       
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Reason: Type narrowing impractical - caller guarantees manifest exists via success check above
      return {
        text: zh
          ? `已导出 ORPO 决策点样本到 ${result.manifest!.exportPath}，` + // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
              `共 ${result.manifest!.sampleCount} 条，模型家族: ${result.manifest!.targetModelFamily}，` + // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
              `数据集指纹: ${result.manifest!.datasetFingerprint.substring(0, 16)}...` // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
          : `Exported ORPO decision-point samples to ${result.manifest!.exportPath}, ` + // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
              `${result.manifest!.sampleCount} samples, target: ${result.manifest!.targetModelFamily}, ` + // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
              `dataset fingerprint: ${result.manifest!.datasetFingerprint.substring(0, 16)}...`, // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: caller guarantees manifest exists via success check
      };
    }

    if (subcommand === 'orpo-list') {
      // List previous ORPO exports
      const exports = listExports(workspaceDir);
      if (exports.length === 0) {
        return {
          text: zh
            ? '没有找到 ORPO 导出记录。'
            : 'No ORPO exports found.',
        };
      }
      const lines = exports.slice(0, 10).map((e) =>
        `- ${e.exportId.substring(0, 8)}... | ${e.sampleCount} samples | ${e.targetModelFamily} | ${new Date(e.createdAt).toLocaleDateString()}`
      );
      return {
        text: zh
          ? `ORPO 导出记录:\n${lines.join('\n')}`
          : `ORPO exports:\n${lines.join('\n')}`,
      };
    }

    if (subcommand !== 'analytics' && subcommand !== 'corrections') {
      return {
        text: zh
          ? '无效的导出类型。请使用 `analytics`、`corrections [--redacted]` 或 `orpo [--family=<target>]`。'
          : 'Invalid export target. Use `analytics`, `corrections [--redacted]`, or `orpo [--family=<target>]`',
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
  } catch {
    return {
      text: zh
        ? '导出失败，请检查日志。'
        : 'Export failed. Check logs.',
    };
  }
}
