import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleSamplesCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'samples');
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  if (args.startsWith('review ')) {
    const [, decision = '', sampleId = '', ...noteParts] = args.split(/\s+/);
    if (decision !== 'approve' && decision !== 'reject') {
      return {
        text: zh
          ? '无效的审核动作。请使用 `review approve <sample-id> [note]` 或 `review reject <sample-id> [note]`。'
          : 'Invalid review action. Use `review approve <sample-id> [note]` or `review reject <sample-id> [note]`.',
      };
    }
    if (!sampleId) {
      return {
        text: zh
          ? '缺少 sample-id。'
          : 'Missing sample-id.',
      };
    }
    const normalizedDecision = decision === 'approve' ? 'approved' : 'rejected';
    const note = noteParts.join(' ').trim();
     
     
    let record;
    try {
      record = wctx.trajectory.reviewCorrectionSample(sampleId, normalizedDecision, note);
    /* eslint-disable @typescript-eslint/no-unused-vars -- Reason: error handling only - returning failure response */
    } catch (error) {
      return {
        text: zh
          ? `审核样本失败：${sampleId}`
          : `Failed to review sample: ${sampleId}`,
      };
    }
    return {
      text: zh
        ? `样本 ${record.sampleId} 已标记为 ${record.reviewStatus}。`
        : `Sample ${record.sampleId} marked as ${record.reviewStatus}.`,
    };
  }

  const samples = wctx.trajectory.listCorrectionSamples('pending');
  if (samples.length === 0) {
    return { text: zh ? '当前没有待审核纠错样本。' : 'No pending correction samples.' };
  }

  const lines = samples.map((sample) => `- ${sample.sampleId} | session=${sample.sessionId} | score=${sample.qualityScore}`);
  return {
    text: zh
      ? `待审核纠错样本:\n${lines.join('\n')}`
      : `Pending correction samples:\n${lines.join('\n')}`,
  };
}
