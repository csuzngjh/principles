/**
 * Progressive Trust Gate Module
 *
 * 2026-03-28: 重构为 EP 系统优先决策
 * - EP System 作为主决策系统
 * - Trust Engine 作为 fallback
 *
 * **决策流程：**
 * 1. EP System 检查 → 拒绝则直接返回
 * 2. EP System 允许 → 放行
 * 3. EP System 异常 → 回退到 Trust Engine
 *
 * **Block Persistence:**
 * - Uses shared `recordGateBlockAndReturn` from gate-block-helper.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { assessRiskLevel, estimateLineChanges } from '../core/risk-calculator.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';

/**
 * Configuration for progressive gate behavior
 */
export interface ProgressiveGateConfig {
  enabled?: boolean;
  plan_approvals?: {
    enabled?: boolean;
    max_lines_override?: number;
    allowed_patterns?: string[];
    allowed_operations?: string[];
  };
}

/**
 * Trust stage limits configuration
 */
export interface TrustLimits {
  stage_2_max_lines?: number;
  stage_3_max_lines?: number;
  stage_2_max_percentage?: number;
  stage_3_max_percentage?: number;
  min_lines_fallback?: number;
}

/**
 * Build line limit rejection reason
 */
export function buildLineLimitReason(
  lineChanges: number,
  effectiveLimit: number,
  limitType: 'percentage' | 'fixed',
  targetLineCount: number | null,
  actualPercentage: number | null,
  stage: number
): string {
  if (limitType === 'percentage' && targetLineCount !== null && actualPercentage !== null) {
    return `Modification too large: ${lineChanges} lines (${actualPercentage}% of ${targetLineCount} lines). ` +
           `Stage ${stage} limit is ${effectiveLimit} lines (${limitType}). ` +
           `Threshold calculation: min(${targetLineCount} × ${actualPercentage}%, ${effectiveLimit} lines).`;
  } else {
    return `Modification too large: ${lineChanges} lines. ` +
           `Stage ${stage} limit is ${effectiveLimit} lines (fixed threshold). ` +
           `Note: Could not read target file to calculate percentage-based limit. Check file permissions and encoding.`;
  }
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
 * Check progressive trust gate based on trust stage and operation context
 *
 * @param event - The tool call event
 * @param wctx - Workspace context
 * @param relPath - Relative path to target file
 * @param risky - Whether the path is a risk path
 * @param lineChanges - Estimated line changes
 * @param logger - Logger instance
 * @param ctx - Hook context
 * @param profile - Gate profile containing risk_paths and progressive_gate config
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
  profile?: { risk_paths: string[]; progressive_gate?: { enabled?: boolean; plan_approvals?: any } }
): PluginHookBeforeToolCallResult | void {
  // Check if progressive gate is disabled
  if (profile?.progressive_gate?.enabled === false) {
    return;
  }

  const trustEngine = wctx.trust;
  const trustScore = trustEngine.getScore();
  const stage = trustEngine.getStage();
  const trustSettings = wctx.config.get('trust') || {
    limits: {
      stage_2_max_lines: 50,
      stage_3_max_lines: 300,
      stage_2_max_percentage: 10,
      stage_3_max_percentage: 15,
      min_lines_fallback: 20,
    }
  };

  const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile?.risk_paths || []);
  const planApprovals = profile?.progressive_gate?.plan_approvals;
  const canUsePlanApproval = Boolean(
    stage === 1 &&
    planApprovals?.enabled &&
    getPlanStatus(ctx.workspaceDir || '') === 'READY' &&
    planApprovals.allowed_operations?.includes(event.toolName) &&
    matchesAnyPattern(relPath, planApprovals.allowed_patterns || []) &&
    ((planApprovals.max_lines_override ?? -1) === -1 || lineChanges <= (planApprovals.max_lines_override ?? -1))
  );

  logger.info?.(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

  // ═══════════════════════════════════════════════════════════════
  // EP SYSTEM - PRIMARY DECISION MAKER (2026-03-28)
  // Evolution Points 系统替代 Trust Engine 成为主决策系统
  // ═══════════════════════════════════════════════════════════════
  try {
    const epDecision = checkEvolutionGate(ctx.workspaceDir!, {
      toolName: event.toolName,
      content: event.params?.content,
      lineCount: lineChanges,
      isRiskPath: risky,
    });

    logger.info?.(`[PD_GATE] EP Tier: ${epDecision.currentTier}, Allowed: ${epDecision.allowed}, Reason: ${epDecision.reason || 'none'}`);

    // EP 系统拒绝时直接返回
    if (!epDecision.allowed) {
      return block(relPath, epDecision.reason || `EP System blocked this operation.`, wctx, event.toolName, logger, ctx.sessionId);
    }

    // EP 系统允许，记录并放行
    // 记录 EP 决策日志（用于审计和分析）
    const epLogPath = path.join(ctx.workspaceDir!, '.state', 'ep_decisions.jsonl');
    try {
      fs.mkdirSync(path.dirname(epLogPath), { recursive: true });
      fs.appendFileSync(epLogPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        toolName: event.toolName,
        filePath: relPath,
        tier: epDecision.currentTier,
        allowed: true,
        lineChanges,
        isRiskPath: risky,
      }) + '\n');
    } catch (logErr) {
      // 日志失败不影响决策
    }

    // EP 系统允许，直接放行（不再走 Trust Engine 逻辑）
    return;
  } catch (err) {
    // EP 系统异常时，回退到 Trust Engine
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn?.(`[PD_GATE] EP system error, falling back to Trust Engine: ${errMsg}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FALLBACK: Trust Engine (仅在 EP 系统异常时使用)
  // ═══════════════════════════════════════════════════════════════

  // Stage 1 (Bankruptcy): Block ALL writes to risk paths, and all medium+ writes
  if (stage === 1) {
    if (canUsePlanApproval) {
      const planStatus = 'READY';
      wctx.eventLog.recordPlanApproval(ctx.sessionId, {
        toolName: event.toolName,
        filePath: relPath,
        pattern: relPath,
        planStatus
      });
      logger.info?.(`[PD_GATE] Stage 1 PLAN approval: ${relPath}`);
      return;
    }

    if (risky || riskLevel !== 'LOW') {
      return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, wctx, event.toolName, logger, ctx.sessionId);
    }
  }

  // Stage 2 (Editor): Block writes to risk paths. Block large changes.
  if (stage === 2) {
    if (risky) {
      return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, wctx, event.toolName, logger, ctx.sessionId);
    }

    const stage2FixedLimit = trustSettings.limits?.stage_2_max_lines ?? 50;
    if (lineChanges > stage2FixedLimit) {
      return block(relPath, `Modification too large (${lineChanges} lines) for Stage 2. Max allowed is ${stage2FixedLimit}.`, wctx, event.toolName, logger, ctx.sessionId);
    }
  }

  // Stage 3 (Developer): Allow normal writes. Require READY plan for risk paths.
  if (stage === 3) {
    if (risky) {
      const planStatus = getPlanStatus(ctx.workspaceDir || '');
      if (planStatus !== 'READY') {
        return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, wctx, event.toolName, logger, ctx.sessionId);
      }
    }

    const stage3FixedLimit = trustSettings.limits?.stage_3_max_lines ?? 300;
    if (lineChanges > stage3FixedLimit) {
      return block(relPath, `Modification too large (${lineChanges} lines) for Stage 3. Max allowed is ${stage3FixedLimit}.`, wctx, event.toolName, logger, ctx.sessionId);
    }
  }

  // Stage 4 (Architect): Full bypass
  if (stage === 4) {
    logger.info?.(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
    return;
  }
}
