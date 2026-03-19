import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleSamplesCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });

  if (args.startsWith('review ')) {
    const [, decision = '', sampleId = '', ...noteParts] = args.split(/\s+/);
    const normalizedDecision = decision === 'approve' ? 'approved' : 'rejected';
    const note = noteParts.join(' ').trim();
    const record = wctx.trajectory.reviewCorrectionSample(sampleId, normalizedDecision, note);
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
