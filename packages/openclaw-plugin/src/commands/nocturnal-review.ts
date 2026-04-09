/**
 * Nocturnal Review Command — Human Review Queue for Nocturnal Dataset
 * =================================================================
 *
 * PURPOSE: Provide human review gateway before training export.
 * Reviews operate on nocturnal dataset records, NOT on artifact files directly.
 *
 * COMMAND SHAPE:
 *   pd-nocturnal-review list                        — list pending review samples
 *   pd-nocturnal-review approve <fingerprint> [reason]  — approve for training
 *   pd-nocturnal-review reject <fingerprint> [reason]  — reject sample
 *   pd-nocturnal-review show <fingerprint>           — show sample lineage summary
 *   pd-nocturnal-review set-family <fingerprint> <family> — set target model family
 *   pd-nocturnal-review stats                        — show dataset statistics
 *
 * DESIGN CONSTRAINTS:
 *   - Review state lives in dataset registry, not in artifacts
 *   - approve/reject require reason (unless default is provided)
 *   - Rejected samples cannot enter export
 *   - Superseded samples cannot enter export
 *   - No Web UI (CLI only)
 */

import * as fs from 'fs';
import {
  listDatasetRecords,
  getDatasetRecord,
  updateReviewStatus,
  updateTargetModelFamily,
  getDatasetStats,
  type NocturnalDatasetRecord,
  type NocturnalReviewStatus,
} from '../core/nocturnal-dataset.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

function formatRecord(record: NocturnalDatasetRecord, includeDetails = false): string {
  const lines: string[] = [];

  lines.push(`  sampleFingerprint: ${record.sampleFingerprint.substring(0, 16)}...`);
  lines.push(`  artifactId: ${record.artifactId}`);
  lines.push(`  sessionId: ${record.sessionId}`);
  lines.push(`  principleId: ${record.principleId}`);
  lines.push(`  targetModelFamily: ${record.targetModelFamily ?? '(none)'}`);
  lines.push(`  reviewStatus: ${record.reviewStatus}`);
  if (record.reviewReason) {
    lines.push(`  reviewReason: ${record.reviewReason}`);
  }
  lines.push(`  createdAt: ${new Date(record.createdAt).toLocaleString('en-US')}`);

  if (includeDetails) {
    const {artifactPath} = record;
    if (fs.existsSync(artifactPath)) {
      try {
        const content = fs.readFileSync(artifactPath, 'utf-8');
        const artifact = JSON.parse(content);
        lines.push(`  artifact: ${artifactPath}`);
        if (artifact.badDecision) {
          lines.push(`  badDecision: ${artifact.badDecision.substring(0, 80)}...`);
        }
        if (artifact.betterDecision) {
          lines.push(`  betterDecision: ${artifact.betterDecision.substring(0, 80)}...`);
        }
        if (artifact.rationale) {
          lines.push(`  rationale: ${artifact.rationale.substring(0, 80)}...`);
        }
      } catch {
        lines.push(`  artifact: (could not read)`);
      }
    } else {
      lines.push(`  artifact: ${artifactPath} (MISSING)`);
    }
  }

  return lines.join('\n');
}

function statusLabel(status: NocturnalReviewStatus, zh: boolean): string {
  const labels: Record<NocturnalReviewStatus, { zh: string; en: string }> = {
    pending_review: { zh: '待审核', en: 'pending_review' },
    approved_for_training: { zh: '已批准', en: 'approved_for_training' },
    rejected: { zh: '已拒绝', en: 'rejected' },
    superseded: { zh: '已替代', en: 'superseded' },
  };
  return labels[status][zh ? 'zh' : 'en'];
}

export function handleNocturnalReviewCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const [action = 'list'] = parts;

  try {
    if (action === 'list') {
      const pending = listDatasetRecords(workspaceDir, { reviewStatus: 'pending_review' });
      const all = listDatasetRecords(workspaceDir);

      if (pending.length === 0) {
        return {
          text: zh
            ? '没有待审核的 nocturnal 样本。'
            : 'No pending nocturnal samples for review.',
        };
      }

      const lines = pending.map((r) => {
        const label = statusLabel(r.reviewStatus, zh);
        return `[${label}] ${r.sampleFingerprint.substring(0, 16)}... | ${r.principleId} | ${r.targetModelFamily ?? '(no family)'}`;
      });

      return {
        text: zh
          ? `待审核样本 (${pending.length}/${all.length}):\n${lines.join('\n')}\n\n使用 /pd-nocturnal-review show <fingerprint> 查看详情。`
          : `Pending review samples (${pending.length}/${all.length}):\n${lines.join('\n')}\n\nUse /pd-nocturnal-review show <fingerprint> for details.`,
      };
    }

    if (action === 'show') {
      const fingerprint = parts[1];
      if (!fingerprint) {
        return {
          text: zh
            ? '用法: /pd-nocturnal-review show <fingerprint>'
            : 'Usage: /pd-nocturnal-review show <fingerprint>',
        };
      }

      const record = getDatasetRecord(workspaceDir, fingerprint);
      if (!record) {
        return {
          text: zh
            ? `未找到样本: ${fingerprint}`
            : `Sample not found: ${fingerprint}`,
        };
      }

      const details = formatRecord(record, true);
      return {
        text: zh
          ? `样本详情:\n${details}`
          : `Sample details:\n${details}`,
      };
    }

    if (action === 'approve') {
      const fingerprint = parts[1];
      const reason = parts.slice(2).join(' ') || (zh ? 'Approved by human reviewer' : 'Approved by human reviewer');

      if (!fingerprint) {
        return {
          text: zh
            ? '用法: /pd-nocturnal-review approve <fingerprint> [reason]'
            : 'Usage: /pd-nocturnal-review approve <fingerprint> [reason]',
        };
      }

      const record = getDatasetRecord(workspaceDir, fingerprint);
      if (!record) {
        return {
          text: zh
            ? `未找到样本: ${fingerprint}`
            : `Sample not found: ${fingerprint}`,
        };
      }

      if (record.reviewStatus === 'approved_for_training') {
        return {
          text: zh
            ? `样本已是 approved_for_training 状态。`
            : `Sample is already approved_for_training.`,
        };
      }

      if (record.reviewStatus === 'rejected') {
        return {
          text: zh
            ? `样本已被 rejected，需要先重置为 pending_review 才能重新审核。`
            : `Sample is rejected. Reset to pending_review first before re-reviewing.`,
        };
      }

      if (record.reviewStatus === 'superseded') {
        return {
          text: zh
            ? `样本已被 superseded，无法更改。`
            : `Sample is superseded and cannot be changed.`,
        };
      }

      const updated = updateReviewStatus(workspaceDir, fingerprint, 'approved_for_training', reason);

      return {
        text: zh
          ? `样本已批准用于训练:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  principleId: ${updated.principleId}\n  targetModelFamily: ${updated.targetModelFamily ?? '(none)'}\n  reason: ${updated.reviewReason}`
          : `Sample approved for training:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  principleId: ${updated.principleId}\n  targetModelFamily: ${updated.targetModelFamily ?? '(none)'}\n  reason: ${updated.reviewReason}`,
      };
    }

    if (action === 'reject') {
      const fingerprint = parts[1];
      const reason = parts.slice(2).join(' ') || (zh ? 'Rejected by human reviewer' : 'Rejected by human reviewer');

      if (!fingerprint) {
        return {
          text: zh
            ? '用法: /pd-nocturnal-review reject <fingerprint> [reason]'
            : 'Usage: /pd-nocturnal-review reject <fingerprint> [reason]',
        };
      }

      const record = getDatasetRecord(workspaceDir, fingerprint);
      if (!record) {
        return {
          text: zh
            ? `未找到样本: ${fingerprint}`
            : `Sample not found: ${fingerprint}`,
        };
      }

      if (record.reviewStatus === 'rejected') {
        return {
          text: zh
            ? `样本已是 rejected 状态。`
            : `Sample is already rejected.`,
        };
      }

      if (record.reviewStatus === 'superseded') {
        return {
          text: zh
            ? `样本已被 superseded，无法更改。`
            : `Sample is superseded and cannot be changed.`,
        };
      }

      const updated = updateReviewStatus(workspaceDir, fingerprint, 'rejected', reason);

      return {
        text: zh
          ? `样本已拒绝:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  reason: ${updated.reviewReason}`
          : `Sample rejected:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  reason: ${updated.reviewReason}`,
      };
    }

    if (action === 'set-family') {
      const fingerprint = parts[1];
      const family = parts[2];

      if (!fingerprint || !family) {
        return {
          text: zh
            ? '用法: /pd-nocturnal-review set-family <fingerprint> <model-family>'
            : 'Usage: /pd-nocturnal-review set-family <fingerprint> <model-family>',
        };
      }

      const record = getDatasetRecord(workspaceDir, fingerprint);
      if (!record) {
        return {
          text: zh
            ? `未找到样本: ${fingerprint}`
            : `Sample not found: ${fingerprint}`,
        };
      }

      if (record.reviewStatus === 'superseded') {
        return {
          text: zh
            ? `样本已被 superseded，无法修改模型家族。`
            : `Sample is superseded and cannot be modified.`,
        };
      }

      const updated = updateTargetModelFamily(workspaceDir, fingerprint, family);

      return {
        text: zh
          ? `已设置目标模型家族:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  targetModelFamily: ${updated.targetModelFamily}`
          : `Target model family set:\n  fingerprint: ${updated.sampleFingerprint.substring(0, 16)}...\n  targetModelFamily: ${updated.targetModelFamily}`,
      };
    }

    if (action === 'stats') {
      const stats = getDatasetStats(workspaceDir);

      return {
        text: zh
          ? `Nocturnal Dataset 统计:\n  总样本数: ${stats.total}\n  待审核: ${stats.pendingReview}\n  已批准训练: ${stats.approvedForTraining}\n  已拒绝: ${stats.rejected}\n  已替代: ${stats.superseded}\n  可导出 (按家族): ${Object.entries(stats.exportReadyByFamily).map(([f, c]) => `${f}: ${c}`).join(', ') || '无'}`
          : `Nocturnal Dataset Stats:\n  Total: ${stats.total}\n  Pending review: ${stats.pendingReview}\n  Approved for training: ${stats.approvedForTraining}\n  Rejected: ${stats.rejected}\n  Superseded: ${stats.superseded}\n  Export-ready (by family): ${Object.entries(stats.exportReadyByFamily).map(([f, c]) => `${f}: ${c}`).join(', ') || 'none'}`,
      };
    }

    return {
      text: zh
        ? `未知操作: ${action}\n用法:\n  /pd-nocturnal-review list\n  /pd-nocturnal-review show <fingerprint>\n  /pd-nocturnal-review approve <fingerprint> [reason]\n  /pd-nocturnal-review reject <fingerprint> [reason]\n  /pd-nocturnal-review set-family <fingerprint> <model-family>\n  /pd-nocturnal-review stats`
        : `Unknown action: ${action}\nUsage:\n  /pd-nocturnal-review list\n  /pd-nocturnal-review show <fingerprint>\n  /pd-nocturnal-review approve <fingerprint> [reason]\n  /pd-nocturnal-review reject <fingerprint> [reason]\n  /pd-nocturnal-review set-family <fingerprint> <model-family>\n  /pd-nocturnal-review stats`,
    };
  } catch (err) {
    return {
      text: zh
        ? `审核操作失败: ${String(err)}`
        : `Review operation failed: ${String(err)}`,
    };
  }
}
