/**
 * Nocturnal Rollout Command Handler
 * =================================
 *
 * Plugin command handler for nocturnal rollout and promotion operations.
 * Provides commands for:
 * - evaluate-promotion: Evaluate if checkpoint passes promotion gate
 * - advance-promotion: Advance checkpoint promotion state
 * - bind: Bind checkpoint to worker profile
 * - enable-routing: Enable routing for a profile
 * - disable-routing: Disable routing for a profile
 * - rollback: Rollback deployment to previous checkpoint
 * - status: Show deployment status for profiles
 * - show-promotion: Show promotion record for a checkpoint
 *
 * Usage:
 *   /nocturnal-rollout evaluate-promotion <checkpointId> [--profile=<profile>]
 *   /nocturnal-rollout advance-promotion <checkpointId> [--profile=<profile>] [--review]
 *   /nocturnal-rollout bind <checkpointId> --profile=<profile>
 *   /nocturnal-rollout enable-routing <profile>
 *   /nocturnal-rollout disable-routing <profile>
 *   /nocturnal-rollout rollback <profile>
 *   /nocturnal-rollout status [--profile=<profile>]
 *   /nocturnal-rollout show-promotion <checkpointId>
 */

import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import {
  evaluatePromotionGate,
  advancePromotion,
  getPromotionRecord,
  listPromotionsByState,
  DEFAULT_BASELINE_METRICS,
  DEFAULT_MIN_DELTA,
  DEFAULT_ALLOWED_MARGIN,
  type PromotionState,
} from '../core/promotion-gate.js';
import {
  bindCheckpointToWorkerProfile,
  enableRoutingForProfile,
  disableRoutingForProfile,
  rollbackDeployment,
  getDeployment,
  isRoutingEnabledForProfile,
  type WorkerProfile,
} from '../core/model-deployment-registry.js';
import {
  classifyTask,
  type RoutingInput,
} from '../core/local-worker-routing.js';
import {
  completeShadowObservation,
  completeShadowObservationByTask,
  type ShadowOutcome,
} from '../core/shadow-observation-registry.js';
import {
  getCheckpoint,
} from '../core/model-training-registry.js';
import {
  runMergeGateAudit,
  formatMergeGateAuditReport,
} from '../core/merge-gate-audit.js';
import { resolvePdPath } from '../core/paths.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

function parseProfile(arg: string | undefined): WorkerProfile {
  if (!arg) return 'local-reader';
  if (arg === 'local-reader' || arg === 'local-editor') {
    return arg;
  }
  return 'local-reader';
}

function formatPromotionState(state: PromotionState, zh: boolean): string {
  const map: Record<PromotionState, { en: string; zh: string }> = {
    rejected: { en: 'Rejected', zh: '已拒绝' },
    candidate_only: { en: 'Candidate Only', zh: '仅候选' },
    shadow_ready: { en: 'Shadow Ready', zh: '待 Shadow' },
    promotable: { en: 'Promotable', zh: '可晋升' },
  };
  return map[state][zh ? 'zh' : 'en'];
}

function formatConstraintCheck(
  check: { constraint: string; actual: number; baseline: number; threshold: number; passed: boolean },
  zh: boolean
): string {
  const constraintNames: Record<string, string> = {
    arbiterRejectRate: zh ? 'Arbiter 拒绝率' : 'Arbiter Reject Rate',
    executabilityRejectRate: zh ? '可执行性拒绝率' : 'Executability Reject Rate',
    reviewedSubsetQuality: zh ? '质量分数' : 'Quality Score',
  };
  const name = constraintNames[check.constraint] || check.constraint;
  const icon = check.passed ? (zh ? '✅' : 'PASS') : (zh ? '❌' : 'FAIL');
  return `${icon} ${name}: ${check.actual.toFixed(4)} (baseline: ${check.baseline.toFixed(4)}, threshold: ${check.threshold.toFixed(4)})`;
}

export function handleNocturnalRolloutCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'nocturnal-rollout');
  const zh = isZh(ctx);
  const args = normalizeCommandArgs(ctx.args).trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const [subcommand = 'help'] = parts;

  // Parse common arguments
  const profileArg = parts.find((p) => p.startsWith('--profile='))?.split('=')[1];
  const checkpointIdArg = parts.find((p) => p.startsWith('--checkpoint-id='))?.split('=')[1];

  try {
    // ── Help ────────────────────────────────────────────────────────────────
    if (subcommand === 'help' || subcommand === '--help') {
      return {
        text: zh
          ? ` nocturnal-rollout 命令帮助
          
用法:
  /nocturnal-rollout evaluate-promotion <checkpointId> [--profile=<profile>]
  /nocturnal-rollout advance-promotion <checkpointId> [--profile=<profile>] [--review]
  /nocturnal-rollout bind <checkpointId> --profile=<profile>
  /nocturnal-rollout enable-routing <profile>
  /nocturnal-rollout disable-routing <profile>
  /nocturnal-rollout rollback <profile>
  /nocturnal-rollout status [--profile=<profile>]
  /nocturnal-rollout show-promotion <checkpointId>

说明:
  evaluate-promotion  - 评估检查点是否通过晋升门
  advance-promotion  - 推进检查点晋升状态 (需要 --review 标志表示人工审核通过)
  bind              - 将检查点绑定到工作机配置文件
  enable-routing    - 启用配置文件路由
  disable-routing   - 禁用配置文件路由
  rollback         - 回滚到上一个检查点
  status           - 显示所有配置文件部署状态
  show-promotion   - 显示检查点晋升记录

配置文件:
  local-reader  - 本地阅读器 (Phase 7 首发的唯一配置)
  local-editor  - 本地编辑器 (需要显式启用)

阶段状态:
  rejected       - 检查点不得路由
  candidate_only - 检查点有效但尚未准备好 shadow
  shadow_ready   - 检查点可进入受控 shadow 部署
  promotable    - 检查点可替换当前活动检查点

注意事项:
  - 晋升必须经过: 离线 lineage → eval → promotion gate → shadow rollout
  - local-reader 是 Phase 7 唯一允许的 rollout 目标
  - 路由必须在绑定后显式启用`
          : ` nocturnal-rollout command help
          
Usage:
  /nocturnal-rollout evaluate-promotion <checkpointId> [--profile=<profile>]
  /nocturnal-rollout advance-promotion <checkpointId> [--profile=<profile>] [--review]
  /nocturnal-rollout bind <checkpointId> --profile=<profile>
  /nocturnal-rollout enable-routing <profile>
  /nocturnal-rollout disable-routing <profile>
  /nocturnal-rollout rollback <profile>
  /nocturnal-rollout status [--profile=<profile>]
  /nocturnal-rollout show-promotion <checkpointId>

Description:
  evaluate-promotion  - Evaluate if checkpoint passes promotion gate
  advance-promotion  - Advance checkpoint promotion state (requires --review flag for orchestrator review)
  bind              - Bind checkpoint to worker profile
  enable-routing    - Enable routing for a profile
  disable-routing   - Disable routing for a profile
  rollback         - Rollback to previous checkpoint
  status           - Show deployment status for all profiles
  show-promotion   - Show promotion record for a checkpoint

Profiles:
  local-reader  - Local reader (only allowed profile for Phase 7)
  local-editor  - Local editor (requires explicit enablement)

Promotion States:
  rejected       - Checkpoint must not be routed
  candidate_only - Checkpoint valid but not ready for shadow
  shadow_ready   - Checkpoint may enter controlled shadow deployment
  promotable    - Checkpoint may replace current active checkpoint

Important:
  - Promotion requires: offline lineage → eval → promotion gate → shadow rollout
  - local-reader is the only allowed rollout target for Phase 7
  - Routing must be explicitly enabled after binding`,
      };
    }

    // ── Evaluate Promotion ────────────────────────────────────────────────
    if (subcommand === 'evaluate-promotion') {
      const checkpointId = parts[1] || checkpointIdArg;
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const profile = parseProfile(profileArg);
      const checkpoint = getCheckpoint(workspaceDir, checkpointId);

      if (!checkpoint) {
        return { text: zh ? `错误: Checkpoint 未找到: ${checkpointId}` : `Error: Checkpoint not found: ${checkpointId}` };
      }

      const result = evaluatePromotionGate(workspaceDir, {
        checkpointId,
        targetProfile: profile,
        baselineMetrics: DEFAULT_BASELINE_METRICS,
        minDelta: DEFAULT_MIN_DELTA,
        allowedMargin: DEFAULT_ALLOWED_MARGIN,
      });

      let text = zh
        ? `=== 晋升门评估 ===
Checkpoint: ${checkpointId.substring(0, 8)}...
Profile: ${profile}
结果: ${result.passes ? (zh ? '通过' : 'PASS') : (zh ? '未通过' : 'FAIL')}
建议状态: ${result.suggestedState ? formatPromotionState(result.suggestedState, zh) : 'N/A'}

--- Delta 检查 ---
${result.deltaCheck.passed ? (zh ? '✅' : 'PASS') : (zh ? '❌' : 'FAIL')} Delta: ${result.deltaCheck.actual >= 0 ? '+' : ''}${result.deltaCheck.actual.toFixed(4)} (阈值: ${result.deltaCheck.threshold.toFixed(4)})

--- 约束检查 ---`
        : `=== Promotion Gate Evaluation ===
Checkpoint: ${checkpointId.substring(0, 8)}...
Profile: ${profile}
Result: ${result.passes ? 'PASS' : 'FAIL'}
Suggested State: ${result.suggestedState ? formatPromotionState(result.suggestedState, zh) : 'N/A'}
Evidence Mode: ${result.evidenceSummary.evidenceMode}
Shadow Samples: ${result.evidenceSummary.shadowSampleCount}

--- Delta Check ---
${result.deltaCheck.passed ? 'PASS' : 'FAIL'} Delta: ${result.deltaCheck.actual >= 0 ? '+' : ''}${result.deltaCheck.actual.toFixed(4)} (threshold: ${result.deltaCheck.threshold.toFixed(4)})

--- Constraint Checks ---`;

      for (const check of result.constraintChecks) {
        text += `\n${formatConstraintCheck(check, zh)}`;
      }

      if (result.blockers.length > 0) {
        text += `\n\n--- Blockers ---`;
        for (const blocker of result.blockers) {
          text += `\n  - ${blocker}`;
        }
      }

      text += `\n\n--- 下一步 ---
${result.passes
        ? (zh
          ? `1. 推进晋升: /nocturnal-rollout advance-promotion ${checkpointId} --profile=${profile} --review
2. 绑定部署: /nocturnal-rollout bind ${checkpointId} --profile=${profile}`
          : `1. Advance promotion: /nocturnal-rollout advance-promotion ${checkpointId} --profile=${profile} --review
2. Bind deployment: /nocturnal-rollout bind ${checkpointId} --profile=${profile}`)
        : (zh
          ? `1. 查看 blockers 并修复问题
2. 重新运行评估前确保满足所有约束`
          : `1. Review blockers and fix issues
2. Ensure all constraints are met before re-evaluation`)}`;

      return { text };
    }

    // ── Merge-Gate Audit ──────────────────────────────────────────────────
    if (subcommand === 'audit') {
      const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
      const report = runMergeGateAudit(workspaceDir, stateDir);
      const formatted = formatMergeGateAuditReport(report);
      return { text: formatted };
    }

    // ── Advance Promotion ─────────────────────────────────────────────────
    if (subcommand === 'advance-promotion') {
      const checkpointId = parts[1] || checkpointIdArg;
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const profile = parseProfile(profileArg);
      const hasReview = args.includes('--review');
      const noteArg = parts.find((p) => p.startsWith('--note='))?.split('=')[1];
      const skipAudit = args.includes('--skip-audit');

      // ── Merge-gate auto-gate: block advance-promotion if audit is BLOCK ──
      if (!skipAudit) {
        const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        const auditReport = runMergeGateAudit(workspaceDir, stateDir);
        if (auditReport.overallStatus === 'block') {
          return {
            text: zh
              ? `❌ Merge-Gate 审计阻止了晋升：发现 ${auditReport.counts.block} 个阻断项

${formatMergeGateAuditReport(auditReport)}

如需强制晋升，请添加 --skip-audit 标志。`
              : `❌ Merge-Gate audit blocked promotion: ${auditReport.counts.block} blocking issue(s) found

${formatMergeGateAuditReport(auditReport)}

To force promotion, add --skip-audit flag.`,
          };
        }
      }

      try {
        const promotion = advancePromotion(workspaceDir, {
          checkpointId,
          targetProfile: profile,
          baselineMetrics: DEFAULT_BASELINE_METRICS,
          orchestratorReviewPassed: hasReview,
          reviewNote: noteArg,
          minDelta: DEFAULT_MIN_DELTA,
          allowedMargin: DEFAULT_ALLOWED_MARGIN,
        });

        return {
          text: zh
            ? `✅ 晋升状态已更新
Checkpoint: ${checkpointId.substring(0, 8)}...
新状态: ${formatPromotionState(promotion.state, zh)}
Review: ${promotion.orchestratorReviewPassed ? (zh ? '通过' : 'Passed') : (zh ? '未审核' : 'Not reviewed')}
Delta: ${promotion.reducedPromptDelta >= 0 ? '+' : ''}${promotion.reducedPromptDelta.toFixed(4)}

${promotion.state === 'shadow_ready'
              ? (zh ? '⚠️  进入 shadow 部署。请运行 /nocturnal-rollout bind 完成绑定。' : '⚠️  Ready for shadow deployment. Run /nocturnal-rollout bind to complete binding.')
              : promotion.state === 'promotable'
              ? (zh ? '✅ 检查点可晋升到生产环境。' : '✅ Checkpoint is promotable to production.')
              : promotion.state === 'rejected'
              ? (zh ? '❌ 检查点被拒绝。' : '❌ Checkpoint was rejected.')
              : (zh ? '等待进一步审核。' : 'Waiting for further review.')}
${promotion.shadowStartedAt ? `Shadow 开始: ${new Date(promotion.shadowStartedAt).toLocaleString()}` : ''}`
            : `✅ Promotion state updated
Checkpoint: ${checkpointId.substring(0, 8)}...
New State: ${formatPromotionState(promotion.state, zh)}
Review: ${promotion.orchestratorReviewPassed ? 'Passed' : 'Not reviewed'}
Delta: ${promotion.reducedPromptDelta >= 0 ? '+' : ''}${promotion.reducedPromptDelta.toFixed(4)}

${promotion.state === 'shadow_ready'
              ? '⚠️  Ready for shadow deployment. Run /nocturnal-rollout bind to complete binding.'
              : promotion.state === 'promotable'
              ? '✅ Checkpoint is promotable to production.'
              : promotion.state === 'rejected'
              ? '❌ Checkpoint was rejected.'
              : 'Waiting for further review.'}
${promotion.shadowStartedAt ? `Shadow started: ${new Date(promotion.shadowStartedAt).toLocaleString()}` : ''}`,
        };
      } catch (err: unknown) {
        return {
          text: zh
            ? `❌ 晋升失败: ${err instanceof Error ? err.message : String(err)}`
            : `❌ Advance promotion failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Bind ──────────────────────────────────────────────────────────────
    if (subcommand === 'bind') {
      const checkpointId = parts[1] || checkpointIdArg;
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const profile = parseProfile(profileArg);
      const noteArg = parts.find((p) => p.startsWith('--note='))?.split('=')[1];

      try {
        const deployment = bindCheckpointToWorkerProfile(workspaceDir, profile, checkpointId, noteArg);

        return {
          text: zh
            ? `✅ 部署已绑定
Profile: ${profile}
Checkpoint: ${checkpointId.substring(0, 8)}...
Artifact: ${deployment.targetModelFamily}
路由启用: ${deployment.routingEnabled ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}

下一步:
1. 启用路由: /nocturnal-rollout enable-routing ${profile}
2. 或保持禁用进行测试`
            : `✅ Deployment bound
Profile: ${profile}
Checkpoint: ${checkpointId.substring(0, 8)}...
Artifact: ${deployment.targetModelFamily}
Routing Enabled: ${deployment.routingEnabled ? 'Yes' : 'No'}

Next steps:
1. Enable routing: /nocturnal-rollout enable-routing ${profile}
2. Or keep disabled for testing`,
        };
      } catch (err: unknown) {
        return {
          text: zh
            ? `❌ 绑定失败: ${err instanceof Error ? err.message : String(err)}`
            : `❌ Bind failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Enable Routing ────────────────────────────────────────────────────
    if (subcommand === 'enable-routing') {
      const profile = parseProfile(profileArg || parts[1]);

      try {
        const deployment = enableRoutingForProfile(workspaceDir, profile);

        return {
          text: zh
            ? `✅ 路由已启用
Profile: ${profile}
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
路由状态: ${deployment.routingEnabled ? (zh ? '启用' : 'Enabled') : (zh ? '禁用' : 'Disabled')}`
            : `✅ Routing enabled
Profile: ${profile}
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
Routing: ${deployment.routingEnabled ? 'Enabled' : 'Disabled'}`,
        };
      } catch (err: unknown) {
        return {
          text: zh
            ? `❌ 启用路由失败: ${err instanceof Error ? err.message : String(err)}`
            : `❌ Enable routing failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Disable Routing ────────────────────────────────────────────────────
    if (subcommand === 'disable-routing') {
      const profile = parseProfile(profileArg || parts[1]);

      try {
        const deployment = disableRoutingForProfile(workspaceDir, profile);

        return {
          text: zh
            ? `✅ 路由已禁用
Profile: ${profile}
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
路由状态: ${deployment.routingEnabled ? (zh ? '启用' : 'Enabled') : (zh ? '禁用' : 'Disabled')}

注意: 禁用路由后，该配置文件的流量将返回主代理。`
            : `✅ Routing disabled
Profile: ${profile}
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
Routing: ${deployment.routingEnabled ? 'Enabled' : 'Disabled'}

Note: After disabling routing, traffic for this profile will return to the main agent.`,
        };
      } catch (err: unknown) {
        return {
          text: zh
            ? `❌ 禁用路由失败: ${err instanceof Error ? err.message : String(err)}`
            : `❌ Disable routing failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Rollback ──────────────────────────────────────────────────────────
    if (subcommand === 'rollback') {
      const profile = parseProfile(profileArg || parts[1]);
      const noteArg = parts.find((p) => p.startsWith('--note='))?.split('=')[1];

      try {
        const deployment = rollbackDeployment(workspaceDir, profile, noteArg);

        return {
          text: zh
            ? `✅ 已回滚
Profile: ${profile}
新 Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
上一个 Checkpoint: ${deployment.previousCheckpointId?.substring(0, 8) || 'none'}...
路由状态: ${deployment.routingEnabled ? (zh ? '启用' : 'Enabled') : (zh ? '禁用' : 'Disabled')}`
            : `✅ Rolled back
Profile: ${profile}
New Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
Previous Checkpoint: ${deployment.previousCheckpointId?.substring(0, 8) || 'none'}...
Routing: ${deployment.routingEnabled ? 'Enabled' : 'Disabled'}`,
        };
      } catch (err: unknown) {
        return {
          text: zh
            ? `❌ 回滚失败: ${err instanceof Error ? err.message : String(err)}`
            : `❌ Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── Status ─────────────────────────────────────────────────────────────
    if (subcommand === 'status') {
      const profile = profileArg ? parseProfile(profileArg) : undefined;

      if (profile) {
        const deployment = getDeployment(workspaceDir, profile);
        if (!deployment) {
          return {
            text: zh
              ? `Profile ${profile}: 无部署记录`
              : `Profile ${profile}: No deployment record`,
          };
        }

        const checkpoint = deployment.activeCheckpointId
          ? getCheckpoint(workspaceDir, deployment.activeCheckpointId)
          : null;

        return {
          text: zh
            ? `=== ${profile} 部署状态 ===
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
Deployable: ${checkpoint?.deployable ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}
路由启用: ${deployment.routingEnabled ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}
上次更新: ${new Date(deployment.updatedAt).toLocaleString()}
${deployment.previousCheckpointId ? `回滚目标: ${deployment.previousCheckpointId.substring(0, 8)}...` : ''}
${deployment.note ? `备注: ${deployment.note}` : ''}`
            : `=== ${profile} Deployment Status ===
Checkpoint: ${deployment.activeCheckpointId?.substring(0, 8) || 'none'}...
Deployable: ${checkpoint?.deployable ? 'Yes' : 'No'}
Routing Enabled: ${deployment.routingEnabled ? 'Yes' : 'No'}
Last Updated: ${new Date(deployment.updatedAt).toLocaleString()}
${deployment.previousCheckpointId ? `Rollback target: ${deployment.previousCheckpointId.substring(0, 8)}...` : ''}
${deployment.note ? `Note: ${deployment.note}` : ''}`,
        };
      }

      // Show all profiles
      const profiles: WorkerProfile[] = ['local-reader', 'local-editor'];
      let text = zh ? '=== 部署状态 ===\n' : '=== Deployment Status ===\n';

      for (const p of profiles) {
        const d = getDeployment(workspaceDir, p);
        const routing = isRoutingEnabledForProfile(workspaceDir, p);
        text += `\n${p}:
  ${d
    ? `Checkpoint: ${d.activeCheckpointId?.substring(0, 8) || 'none'}... | Routing: ${routing ? (zh ? '启用' : 'Enabled') : (zh ? '禁用' : 'Disabled')}`
    : (zh ? '  无部署记录' : '  No deployment')}`;
      }

      return { text };
    }

    // ── Show Promotion ────────────────────────────────────────────────────
    if (subcommand === 'show-promotion') {
      const checkpointId = parts[1] || checkpointIdArg;
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const promotion = getPromotionRecord(workspaceDir, checkpointId);
      if (!promotion) {
        return {
          text: zh
            ? `未找到晋升记录: ${checkpointId}`
            : `No promotion record found: ${checkpointId}`,
        };
      }

      return {
        text: zh
          ? `=== 晋升记录 ===
Checkpoint: ${promotion.checkpointId.substring(0, 8)}...
状态: ${formatPromotionState(promotion.state, zh)}
Profile: ${promotion.targetProfile}
Family: ${promotion.targetModelFamily}
Delta: ${promotion.reducedPromptDelta >= 0 ? '+' : ''}${promotion.reducedPromptDelta.toFixed(4)}

约束指标:
  Arbiter 拒绝率: ${promotion.constraintMetrics.arbiterRejectRate.toFixed(4)}
  可执行性拒绝率: ${promotion.constraintMetrics.executabilityRejectRate.toFixed(4)}
  质量分数: ${promotion.constraintMetrics.reviewedSubsetQuality.toFixed(4)}

基线:
  Arbiter 拒绝率: ${promotion.baselineMetrics.arbiterRejectRate.toFixed(4)}
  可执行性拒绝率: ${promotion.baselineMetrics.executabilityRejectRate.toFixed(4)}
  质量分数: ${promotion.baselineMetrics.reviewedSubsetQuality.toFixed(4)}

审核通过: ${promotion.orchestratorReviewPassed ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}
${promotion.reviewNote ? `审核备注: ${promotion.reviewNote}` : ''}
创建: ${new Date(promotion.createdAt).toLocaleString()}
状态变更: ${new Date(promotion.stateChangedAt).toLocaleString()}
${promotion.shadowStartedAt ? `Shadow 开始: ${new Date(promotion.shadowStartedAt).toLocaleString()}` : ''}
${promotion.promotableAt ? `可晋升时间: ${new Date(promotion.promotableAt).toLocaleString()}` : ''}
${promotion.previousPromotionId ? `上一个晋升: ${promotion.previousPromotionId.substring(0, 8)}...` : ''}`
          : `=== Promotion Record ===
Checkpoint: ${promotion.checkpointId.substring(0, 8)}...
State: ${formatPromotionState(promotion.state, zh)}
Profile: ${promotion.targetProfile}
Family: ${promotion.targetModelFamily}
Delta: ${promotion.reducedPromptDelta >= 0 ? '+' : ''}${promotion.reducedPromptDelta.toFixed(4)}

Constraint Metrics:
  Arbiter Reject Rate: ${promotion.constraintMetrics.arbiterRejectRate.toFixed(4)}
  Executability Reject Rate: ${promotion.constraintMetrics.executabilityRejectRate.toFixed(4)}
  Quality Score: ${promotion.constraintMetrics.reviewedSubsetQuality.toFixed(4)}

Baseline:
  Arbiter Reject Rate: ${promotion.baselineMetrics.arbiterRejectRate.toFixed(4)}
  Executability Reject Rate: ${promotion.baselineMetrics.executabilityRejectRate.toFixed(4)}
  Quality Score: ${promotion.baselineMetrics.reviewedSubsetQuality.toFixed(4)}

Review Passed: ${promotion.orchestratorReviewPassed ? 'Yes' : 'No'}
${promotion.reviewNote ? `Review Note: ${promotion.reviewNote}` : ''}
Created: ${new Date(promotion.createdAt).toLocaleString()}
State Changed: ${new Date(promotion.stateChangedAt).toLocaleString()}
${promotion.shadowStartedAt ? `Shadow Started: ${new Date(promotion.shadowStartedAt).toLocaleString()}` : ''}
${promotion.promotableAt ? `Promotable At: ${new Date(promotion.promotableAt).toLocaleString()}` : ''}
${promotion.previousPromotionId ? `Previous Promotion: ${promotion.previousPromotionId.substring(0, 8)}...` : ''}`,
      };
    }

    // ── List by State ─────────────────────────────────────────────────────
    if (subcommand === 'list-by-state') {
      const [, stateArg] = parts;
      if (!stateArg) {
        return { text: zh ? '错误: 需要状态参数' : 'Error: state argument required' };
      }

      const validStates: PromotionState[] = ['rejected', 'candidate_only', 'shadow_ready', 'promotable'];
      if (!validStates.includes(stateArg as PromotionState)) {
        return {
          text: zh
            ? `无效状态: ${stateArg}。有效值: ${validStates.join(', ')}`
            : `Invalid state: ${stateArg}. Valid values: ${validStates.join(', ')}`,
        };
      }

      const promotions = listPromotionsByState(workspaceDir, stateArg as PromotionState);
      if (promotions.length === 0) {
        return {
          text: zh
            ? `没有 ${stateArg} 状态的检查点`
            : `No checkpoints with state ${stateArg}`,
        };
      }

      const lines = promotions.map((p) =>
        `${p.checkpointId.substring(0, 8)}... | ${p.targetProfile} | ${p.targetModelFamily} | Delta: ${p.reducedPromptDelta >= 0 ? '+' : ''}${p.reducedPromptDelta.toFixed(4)}`
      );

      return {
        text: zh
          ? `${stateArg} 检查点 (${promotions.length}):
${lines.join('\n')}`
          : `${stateArg} checkpoints (${promotions.length}):
${lines.join('\n')}`,
      };
    }

    // ── Route ───────────────────────────────────────────────────────────────
    // Execute a routing decision for a task. Records shadow observation if routing to shadow.
    if (subcommand === 'route') {
      // Parse routing input arguments
      const intentArg = parts.find((p) => p.startsWith('--intent='))?.slice('--intent='.length) ?? '';
      const descriptionArg = parts.find((p) => p.startsWith('--description='))?.slice('--description='.length) ?? '';
      const toolsArg = parts.find((p) => p.startsWith('--tools='))?.slice('--tools='.length) ?? '';
      const filesArg = parts.find((p) => p.startsWith('--files='))?.slice('--files='.length) ?? '';
      const outputArg = parts.find((p) => p.startsWith('--output='))?.slice('--output='.length) ?? '';
      // Note: --risk= flag is deprecated (risk gating removed from routing)
      const complexityArg = parts.find((p) => p.startsWith('--complexity='))?.slice('--complexity='.length) ?? '';

      const routingInput: RoutingInput = {
        taskIntent: intentArg || undefined,
        taskDescription: descriptionArg || undefined,
        requestedTools: toolsArg ? toolsArg.split(',').map((t) => t.trim()) : undefined,
        requestedFiles: filesArg ? filesArg.split(',').map((f) => f.trim()) : undefined,
        expectedOutputShape: outputArg || undefined,
        complexityHints: complexityArg ? complexityArg.split(',').map((c) => c.trim()) : undefined,
        targetProfile: parseProfile(profileArg),
      };

      const decision = classifyTask(routingInput, workspaceDir);

      const shadowNote = decision.shadowObservationId
        ? `\n\n${zh ? '📝 Shadow 观察已记录' : '📝 Shadow observation recorded'}: ${decision.shadowObservationId}`
        : '';

      return {
        text: zh
          ? `=== 路由决策 ===
决策: ${decision.decision === 'route_local' ? '路由到本地' : '保持在主代理'}
目标配置: ${decision.targetProfile ?? 'N/A'}
分类: ${decision.classification}
原因: ${decision.reason}
${decision.blockers.length > 0 ? `阻塞因素:\n${decision.blockers.map((b) => '  - ' + b).join('\n')}` : ''}
${decision.activeCheckpointId ? `活动 Checkpoint: ${decision.activeCheckpointId.substring(0, 8)}...` : ''}
${decision.activeCheckpointState ? `Checkpoint 状态: ${decision.activeCheckpointState}` : ''}
${decision.decision === 'route_local' && decision.activeCheckpointState === 'shadow_ready' ? (zh ? '⚠️  正在路由到 shadow 检查点' : '⚠️  Routing to shadow checkpoint') : ''}
${shadowNote}

下一步:
${decision.decision === 'route_local'
  ? (zh ? '  任务将路由到本地配置文件。任务完成后使用 /nocturnal-rollout complete-shadow 完成 shadow 观察。' : '  Task will be routed to local profile. After task completes, use /nocturnal-rollout complete-shadow to complete the shadow observation.')
  : (zh ? '  任务必须保留在主代理。' : '  Task must stay on main agent.')}`
          : `=== Routing Decision ===
Decision: ${decision.decision === 'route_local' ? 'ROUTE_LOCAL' : 'STAY_MAIN'}
Target Profile: ${decision.targetProfile ?? 'N/A'}
Classification: ${decision.classification}
Reason: ${decision.reason}
${decision.blockers.length > 0 ? `Blockers:\n${decision.blockers.map((b) => '  - ' + b).join('\n')}` : ''}
${decision.activeCheckpointId ? `Active Checkpoint: ${decision.activeCheckpointId.substring(0, 8)}...` : ''}
${decision.activeCheckpointState ? `Checkpoint State: ${decision.activeCheckpointState}` : ''}
${decision.decision === 'route_local' && decision.activeCheckpointState === 'shadow_ready' ? '⚠️  Routing to shadow checkpoint' : ''}
${shadowNote}

Next steps:
${decision.decision === 'route_local'
  ? '  Task will be routed to local profile. After task completes, use /nocturnal-rollout complete-shadow to complete the shadow observation.'
  : '  Task must stay on main agent.'}`,
      };
    }

    // ── Complete Shadow Observation ─────────────────────────────────────────
    if (subcommand === 'complete-shadow') {
      const obsIdArg = parts.find((p) => p.startsWith('--observation-id='))?.split('=')[1];
      const fingerprintArg = parts.find((p) => p.startsWith('--fingerprint='))?.split('=')[1];
      const outcomeArg = parts.find((p) => p.startsWith('--outcome='))?.split('=')[1] ?? 'accepted';
      const timedOutArg = parts.includes('--timed-out');
      const threwArg = parts.includes('--threw');
      const invalidArg = parts.includes('--invalid');
      const rejectedArg = parts.includes('--rejected');

      const validOutcomes: ShadowOutcome[] = ['accepted', 'rejected', 'escalated'];
      const outcome: ShadowOutcome = validOutcomes.includes(outcomeArg as ShadowOutcome)
        ? (outcomeArg as ShadowOutcome)
        : 'accepted';

      const failureSignals = {
        timedOut: timedOutArg,
        threwException: threwArg,
        invalidOutput: invalidArg,
        profileRejected: rejectedArg,
        extra: {},
      };

      let observation = null;

      if (obsIdArg) {
        observation = completeShadowObservation(workspaceDir, {
          observationId: obsIdArg,
          outcome,
          failureSignals,
        });
      } else if (fingerprintArg) {
        // Look up by task fingerprint (recorded during route)
        observation = completeShadowObservationByTask(workspaceDir, fingerprintArg, outcome, failureSignals);
      } else {
        return {
          text: zh
            ? '错误: 需要 --observation-id 或 --fingerprint 参数'
            : 'Error: --observation-id or --fingerprint is required',
        };
      }

      if (!observation) {
        return {
          text: zh
            ? `未找到 shadow 观察。检查 ID 或指纹是否正确。`
            : `Shadow observation not found. Check the ID or fingerprint.`,
        };
      }

      return {
        text: zh
          ? `✅ Shadow 观察已完成
观察 ID: ${observation.observationId.substring(0, 8)}...
结果: ${observation.outcome}
Checkpoint: ${observation.checkpointId.substring(0, 8)}...
完成时间: ${observation.completedAt}`
          : `✅ Shadow observation completed
Observation ID: ${observation.observationId.substring(0, 8)}...
Outcome: ${observation.outcome}
Checkpoint: ${observation.checkpointId.substring(0, 8)}...
Completed At: ${observation.completedAt}`,
      };
    }

    // Unknown subcommand
    return {
      text: zh
        ? `未知子命令: ${subcommand}。运行 /nocturnal-rollout help 查看帮助。`
        : `Unknown subcommand: ${subcommand}. Run /nocturnal-rollout help for usage.`,
    };
  } catch (err: unknown) {
    return {
      text: zh
        ? `❌ 命令失败: ${err instanceof Error ? err.message : String(err)}`
        : `❌ Command failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
