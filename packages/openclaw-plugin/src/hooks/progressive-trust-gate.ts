/**
 * Progressive Trust Gate Module (EP-Only Version)
 *
 * 信任分系统已移除 - EP (Evolution Points) 是唯一的门控机制。
 *
 * **EP 门控逻辑:**
 * - Seed (0分): 只读 + 基础文档
 * - Sprout (50分): 单文件编辑
 * - Sapling (200分): 多文件 + 测试 + 子智能体
 * - Tree (500分): 重构 + 风险路径
 * - Forest (1000分): 完全自主
 *
 * **风险路径控制:**
 * - 低等级不能修改风险路径
 * - 高等级解锁风险路径权限
 *
 * **不再有:**
 * - Trust Score (30-100) 系统
 * - Stage 1-4 分级
 * - Plan Approval 白名单机制
 * - 基于行数的限制
 */

import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import { normalizePath } from '../utils/io.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';

/**
 * Build EP gate rejection reason
 */
export function buildEvolutionGateReason(
  tier: number,
  tierName: string,
  reason: string
): string {
  return `[EP Gate] Tier ${tier} (${tierName}): ${reason}`;
}

/**
 * Internal helper to call the shared block helper with progressive-trust-gate source tag.
 */
function block(
  filePath: string,
  reason: string,
  wctx: WorkspaceContext,
  toolName: string,
  logger: { warn?: (message: string) => void; error?: (message: string) => void },
  sessionId?: string
): PluginHookBeforeToolCallResult {
  return recordGateBlockAndReturn(wctx, {
    filePath,
    reason,
    toolName,
    sessionId,
    blockSource: 'progressive-trust-gate',
  }, logger);
}

/**
 * Check EP-based gate
 *
 * @param event - The tool call event
 * @param wctx - Workspace context
 * @param relPath - Relative path to target file
 * @param risky - Whether the path is a risk path
 * @param lineChanges - Estimated line changes (kept for interface compatibility, not used for gating)
 * @param logger - Logger instance
 * @param ctx - Hook context
 * @param profile - Gate profile containing risk_paths config
 * @returns PluginHookBeforeToolCallResult to block, or undefined to allow
 */
export function checkProgressiveTrustGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  relPath: string,
  risky: boolean,
  lineChanges: number,
  logger: { warn?: (message: string) => void; error?: (message: string) => void; info?: (message: string) => void },
  ctx: { workspaceDir?: string; sessionId?: string },
  profile?: { risk_paths: string[] }
): PluginHookBeforeToolCallResult | void {
  // EP is the only gate now - use actual gate decision
  if (!ctx.workspaceDir) {
    logger.warn?.('[PD_GATE] No workspaceDir, skipping EP gate check');
    return;
  }

  // Call EP gate - this is the actual gate, not simulation
  const epDecision = checkEvolutionGate(ctx.workspaceDir, {
    toolName: event.toolName,
    isRiskPath: risky,
  });

  const currentTier = epDecision.currentTier ?? 1;
  const tierName = getTierName(currentTier);

  logger.info?.(`[PD_GATE] EP Gate: Tier ${currentTier} (${tierName}), Tool: ${event.toolName}, Risk: ${risky}, Allowed: ${epDecision.allowed}`);

  if (!epDecision.allowed) {
    const reason = buildEvolutionGateReason(currentTier, tierName, epDecision.reason ?? 'Unknown restriction');
    return block(relPath, reason, wctx, event.toolName, logger, ctx.sessionId);
  }

  // Gate passed - allow
  return;
}

/**
 * Get tier name from tier number
 */
function getTierName(tier: number): string {
  const names: Record<number, string> = {
    1: 'Seed',
    2: 'Sprout',
    3: 'Sapling',
    4: 'Tree',
    5: 'Forest',
  };
  return names[tier] ?? 'Unknown';
}
