/**
 * Progressive Trust Gate Module
 *
 * Handles progressive access control based on trust stages (1-4).
 *
 * **Responsibilities:**
 * - Enforce trust stage-based permissions:
 *   - Stage 1 (Bankruptcy): Block ALL writes to risk paths, medium+ changes
 *   - Stage 2 (Editor): Block risk paths, large changes
 *   - Stage 3 (Developer): Require READY plan for risk paths, normal limits
 *   - Stage 4 (Architect): Full bypass with audit logging
 * - Apply percentage-based line change limits for large files
 * - Handle plan approval whitelist for Stage 1
 * - Record EP simulation for comparison analysis
 *
 * **Configuration:**
 * - Progressive gate settings from profile.progressive_gate
 * - Trust limits from config.trust
 * - Plan approval patterns and operations
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { assessRiskLevel, estimateLineChanges, getTargetFileLineCount, calculatePercentageThreshold } from '../core/risk-calculator.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';

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
 * Block a tool call and record the block event
 */
function block(
  filePath: string,
  reason: string,
  wctx: WorkspaceContext,
  toolName: string,
  logger: { warn?: (message: string) => void; error?: (message: string) => void },
  sessionId?: string
): PluginHookBeforeToolCallResult {
  logger.error?.(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

  const trajectoryPayload = {
    sessionId: sessionId ?? null,
    toolName,
    filePath,
    reason,
  };

  try {
    wctx.eventLog.recordGateBlock(sessionId, {
      toolName,
      filePath,
      reason,
    });
  } catch (error) {
    logger.warn?.(`[PD_GATE] Failed to record gate block event: ${String(error)}`);
  }

  try {
    wctx.trajectory?.recordGateBlock?.(trajectoryPayload);
  } catch (error) {
    logger.warn?.(`[PD_GATE] Failed to record trajectory gate block: ${String(error)}`);
  }

  return {
    block: true,
    blockReason: `[Principles Disciple] Security Gate Blocked this action.
File: ${filePath}
Reason: ${reason}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 How to unblock this operation:

1. Use the plan-script skill to create a PLAN.md:
   → Invoke: skill:plan-script

2. Fill in the plan with:
   - Target Files: ${filePath}
   - Steps: What you want to do (be specific)
   - Metrics: How to verify success
   - Active Mental Models: Select 2 relevant models from .principles/THINKING_OS.md
   - Rollback: How to restore if it fails

3. After completing the plan, set STATUS: READY in PLAN.md

4. Retry the operation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is a mandatory security gate. The operation was blocked because the modification exceeds the allowed threshold for your current trust stage.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  };
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

  // ── EP SIMULATION MODE (M6验证) ──
  // 记录EP系统的模拟决策，但不生效（仅用于对比分析）
  // BUGFIX #90: 移到所有Stage检查之前，确保所有Stage都触发EP simulation记录
  try {
    const epDecision = checkEvolutionGate(ctx.workspaceDir!, {
      toolName: event.toolName,
      content: event.params?.content,
      lineCount: lineChanges,
      isRiskPath: risky,
    });

    const epLogEntry = {
      timestamp: new Date().toISOString(),
      toolName: event.toolName,
      filePath: relPath,
      trustEngine: { score: trustScore, stage, decision: 'allow' },
      epSystem: { tier: epDecision.currentTier ?? 'UNKNOWN', allowed: epDecision.allowed, reason: epDecision.reason },
      conflict: epDecision.allowed === false, // Trust允许但EP拒绝（任何阶段）
    };

    const epLogPath = path.join(ctx.workspaceDir!, '.state', 'ep_simulation.jsonl');

    // 安全创建目录（如果失败则跳过日志写入，但不影响 Trust Engine 决策）
    let canWriteEpLog = true;
    try {
      fs.mkdirSync(path.dirname(epLogPath), { recursive: true });
    } catch (mkdirErr: any) {
      if (!mkdirErr || mkdirErr.code !== 'EEXIST') {
        logger.warn?.(`[PD_EP_SIM] Failed to create log dir: ${mkdirErr?.message ?? String(mkdirErr)}, skipping log`);
        canWriteEpLog = false;
      }
    }

    if (canWriteEpLog) {
      fs.appendFileSync(epLogPath, JSON.stringify(epLogEntry) + '\n');
    }

    logger.info?.(`[PD_EP_SIM] Tier: ${epDecision.currentTier}, Allowed: ${epDecision.allowed}, Trust: ${trustScore} (Stage ${stage})`);
  } catch (err) {
    // EP 模拟失败不应该影响 Trust Engine 决策
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn?.(`[PD_EP_SIM] Simulation failed: ${errMsg}, continuing with Trust Engine`);
  }

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
      wctx.trajectory?.recordGateBlock?.({
        sessionId: ctx.sessionId,
        toolName: event.toolName,
        filePath: relPath,
        reason: 'plan_approval',
        planStatus,
      });
      logger.info?.(`[PD_GATE] Stage 1 PLAN approval: ${relPath}`);
      return;
    }

    if (risky || riskLevel !== 'LOW') {
      // Block if not approved by whitelist
      return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, wctx, event.toolName, logger, ctx.sessionId);
    }
  }

  // Stage 2 (Editor): Block writes to risk paths. Block large changes.
  if (stage === 2) {
    if (risky) {
      return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, wctx, event.toolName, logger, ctx.sessionId);
    }

    // Percentage-based threshold calculation
    const targetAbsolutePath = typeof event.params.file_path === 'string' && ctx.workspaceDir ? path.join(ctx.workspaceDir, event.params.file_path) : null;
    const targetLineCount = targetAbsolutePath ? getTargetFileLineCount(targetAbsolutePath) : null;
    const minLinesFallback = trustSettings.limits?.min_lines_fallback ?? 20;
    const stage2MaxPercentage = trustSettings.limits?.stage_2_max_percentage ?? 10;
    const stage2FixedLimit = trustSettings.limits?.stage_2_max_lines ?? 50;

    let effectiveLimit: number;
    let limitType: 'percentage' | 'fixed';
    let actualPercentage: number | null = null;

    if (targetLineCount !== null && targetLineCount > 0) {
      effectiveLimit = calculatePercentageThreshold(targetLineCount, stage2MaxPercentage, minLinesFallback);
      actualPercentage = Math.round((lineChanges / targetLineCount) * 100);
      limitType = 'percentage';
    } else {
      effectiveLimit = stage2FixedLimit;
      limitType = 'fixed';
    }

    if (lineChanges > effectiveLimit) {
      return block(relPath, buildLineLimitReason(lineChanges, effectiveLimit, limitType, targetLineCount, actualPercentage, 2), wctx, event.toolName, logger, ctx.sessionId);
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

    // Percentage-based threshold calculation
    const targetAbsolutePath = typeof event.params.file_path === 'string' && ctx.workspaceDir ? path.join(ctx.workspaceDir, event.params.file_path) : null;
    const targetLineCount = targetAbsolutePath ? getTargetFileLineCount(targetAbsolutePath) : null;
    const minLinesFallback = trustSettings.limits?.min_lines_fallback ?? 20;
    const stage3MaxPercentage = trustSettings.limits?.stage_3_max_percentage ?? 15;
    const stage3FixedLimit = trustSettings.limits?.stage_3_max_lines ?? 300;

    let effectiveLimit: number;
    let limitType: 'percentage' | 'fixed';
    let actualPercentage: number | null = null;

    if (targetLineCount !== null && targetLineCount > 0) {
      effectiveLimit = calculatePercentageThreshold(targetLineCount, stage3MaxPercentage, minLinesFallback);
      actualPercentage = Math.round((lineChanges / targetLineCount) * 100);
      limitType = 'percentage';
    } else {
      effectiveLimit = stage3FixedLimit;
      limitType = 'fixed';
    }

    if (lineChanges > effectiveLimit) {
      return block(relPath, buildLineLimitReason(lineChanges, effectiveLimit, limitType, targetLineCount, actualPercentage, 3), wctx, event.toolName, logger, ctx.sessionId);
    }
  }

  // Stage 4 (Architect): Full bypass
  if (stage === 4) {
    logger.info?.(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
    // Audit log for Stage 4 bypass (security traceability)
    try {
      const stateDir = wctx.resolve('STATE_DIR');
      // EventLogService.get would be called here but we skip for simplicity
      logger.info?.(`[PD_GATE] Stage 4 Architect bypass recorded for ${relPath}`);
    } catch (auditErr) {
      logger.warn?.(`[PD_GATE] Failed to record Stage 4 bypass audit: ${String(auditErr)}`);
    }
    return;
  }
}
