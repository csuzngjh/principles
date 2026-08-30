import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import { emitPainDetectedEvent } from '../hooks/pain.js';
import { SystemLogger } from '../core/system-logger.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

export function handleSamplesCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'samples');
  const zh = isZh(ctx);
  const args = normalizeCommandArgs(ctx.args).trim();
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

    // 修断裂④(spec §6.3): reject 时触发 pain event,接通"owner-rejected 纠正 → 诊断"桥。
    // 之前 recordCorrectionRejectedPain 只写 DB 不触发诊断,是假桥。
    // 这里 fire-and-forget emitPainDetectedEvent(source='correction_rejected')。
    if (normalizedDecision === 'rejected') {
      const painScore = Math.max(0, Math.min(100, Math.round(record.qualityScore)));
      void emitPainDetectedEvent(wctx, {
        ts: new Date().toISOString(),
        type: 'pain_detected',
        data: {
          painId: `correction_rejected_${record.sampleId}`,
          painType: 'user_frustration',
          source: 'correction_rejected',
          reason: `Owner rejected correction sample (quality ${record.qualityScore})`,
          score: painScore,
          sessionId: record.sessionId,
          agentId: 'main',
          provenance: 'host_context_bound',
          hostKind: 'openclaw',
          evidence: [{ sourceRef: 'correction_sample', note: record.diffExcerpt.slice(0, 200) }],
        },
      }, { recordObservability: true }).catch((e) => {
        SystemLogger.log(workspaceDir, 'SIGNAL_REJECT_EMIT_FAIL', `emitPainDetectedEvent failed on reject: ${String(e)}`);
      });
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
