import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { normalizeProfile } from '../core/profile.js';
import { trackBlock, getSession } from '../core/session-tracker.js';
import { assessRiskLevel, estimateLineChanges, getTargetFileLineCount, calculatePercentageThreshold } from '../core/risk-calculator.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';
import { EventLogService } from '../core/event-log.js';
import { checkThinkingCheckpoint } from './thinking-checkpoint.js';
import { handleEditVerification } from './edit-verification.js';
import { 
  analyzeBashCommand as extAnalyzeBashCommand, 
  calculateDynamicThreshold as extCalculateDynamicThreshold 
} from './bash-risk.js';
import { checkGfiGate } from './gfi-gate.js';
import { checkProgressiveTrustGate } from './progressive-trust-gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import {
  AGENT_TOOLS,
  BASH_TOOL_NAMES,
  BASH_TOOLS_SET,
  HIGH_RISK_TOOLS,
  LOW_RISK_WRITE_TOOLS,
  WRITE_TOOLS,
} from '../constants/tools.js';

const TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS = 250;
const TRAJECTORY_GATE_BLOCK_MAX_RETRIES = 3;

// NOTE: bash-risk functions moved to bash-risk.ts
// Using imports: extAnalyzeBashCommand, extCalculateDynamicThreshold

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const isBash = BASH_TOOLS_SET.has(event.toolName);
  const isWriteTool = WRITE_TOOLS.has(event.toolName);
  const isAgentTool = AGENT_TOOLS.has(event.toolName);
  // Profile loaded first for config-driven behavior (see below)
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash && !isAgentTool)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // 2. Load Profile
  const profilePath = wctx.resolve('PROFILE');
  let profile = {
    risk_paths: [] as string[],
    gate: { require_plan_for_risk_paths: true },
    progressive_gate: {
      enabled: true,
      plan_approvals: {
        enabled: false,
        max_lines_override: -1,
        allowed_patterns: [] as string[],
        allowed_operations: [] as string[],
      }
    },
    edit_verification: {
      enabled: true,
      max_file_size_bytes: 10 * 1024 * 1024,
      fuzzy_match_enabled: true,
      fuzzy_match_threshold: 0.8,
      skip_large_file_action: 'warn' as 'warn' | 'block',
    },
    thinking_checkpoint: {
      enabled: false,  // Default OFF
      window_ms: 5 * 60 * 1000,
      high_risk_tools: ['run_shell_command', 'delete_file', 'move_file'],
    }
  };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (e) {
      logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  // ═══ THINKING OS CHECKPOINT (P-10) — Config-gated ═══
  // Only enforced when thinking_checkpoint.enabled = true in PROFILE.json
  const thinkingResult = checkThinkingCheckpoint(
    event,
    profile.thinking_checkpoint || {},
    ctx.sessionId,
    logger
  );
  if (thinkingResult) {
    return thinkingResult;
  }

  // ═══ GFI GATE - Hard Intercept ═══
  // 根据 GFI (疲劳指数) 精细化拦截工具调用
  // 注意：TIER 0 (只读工具) 已在早期过滤中放行，此处不检查
  const gfiGateConfig = wctx.config.get('gfi_gate');
  if (gfiGateConfig?.enabled !== false && ctx.sessionId) {
    const session = getSession(ctx.sessionId);
    const currentGfi = session?.currentGfi || 0;
    
    // TIER 3: Bash 命令 - 根据内容判断
    if (BASH_TOOLS_SET.has(event.toolName)) {
      const command = String(event.params.command || event.params.args || '');
      const bashRisk = extAnalyzeBashCommand(
        command,
        gfiGateConfig?.bash_safe_patterns || [],
        gfiGateConfig?.bash_dangerous_patterns || [],
        logger
      );
      
      if (bashRisk === 'dangerous') {
        // 危险命令 - 直接拦截
        logger?.warn?.(`[PD:GFI_GATE] Dangerous bash command blocked: ${command.substring(0, 50)}...`);
        return {
          block: true,
          blockReason: `[GFI Gate] 危险命令被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}

原因: 检测到危险命令模式，需要确认执行意图。

解决方案:
1. 如果确实需要执行，请确认操作意图后重试
2. 使用更安全的方式（如手动操作）
3. 咨询用户确认是否继续

注意: 危险命令需要更严格的审批流程。`,
        };
      }
      // safe 命令 - 放行
      else if (bashRisk === 'safe') {
        // 继续执行
      }
      // normal 命令 - 按 GFI 阈值判断
      else {
        const trustEngine = wctx.trust;
        const stage = trustEngine.getStage();
        const baseThreshold = gfiGateConfig?.thresholds?.low_risk_block || 70;
        const dynamicThreshold = extCalculateDynamicThreshold(
          baseThreshold,
          stage,
          0, // bash 命令没有行数概念
          {
            large_change_lines: gfiGateConfig?.large_change_lines || 50,
            trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
          }
        );
        
        if (currentGfi >= dynamicThreshold) {
          logger?.warn?.(`[PD:GFI_GATE] Bash blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
          return {
            block: true,
            blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
          };
        }
      }
    }
    // TIER 2: 高风险操作 - GFI >= high_risk_block 时拦截
    else if (HIGH_RISK_TOOLS.has(event.toolName)) {
      const trustEngine = wctx.trust;
      const stage = trustEngine.getStage();
      const baseThreshold = gfiGateConfig?.thresholds?.high_risk_block || 40;
      const dynamicThreshold = extCalculateDynamicThreshold(
        baseThreshold,
        stage,
        0,
        {
          large_change_lines: gfiGateConfig?.large_change_lines || 50,
          trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
        }
      );
      
      if (currentGfi >= dynamicThreshold) {
        const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
        logger?.warn?.(`[PD:GFI_GATE] High-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
        return {
          block: true,
          blockReason: `[GFI Gate] 高风险操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 高风险工具需要更低的 GFI 阈值才能执行。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待 GFI 自然衰减后重试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
        };
      }
    }
    // TIER 1: 低风险修改 - GFI >= low_risk_block 时拦截
    else if (LOW_RISK_WRITE_TOOLS.has(event.toolName)) {
      const trustEngine = wctx.trust;
      const stage = trustEngine.getStage();
      const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
      const baseThreshold = gfiGateConfig?.thresholds?.low_risk_block || 70;
      const dynamicThreshold = extCalculateDynamicThreshold(
        baseThreshold,
        stage,
        lineChanges,
        {
          large_change_lines: gfiGateConfig?.large_change_lines || 50,
          trust_stage_multipliers: gfiGateConfig?.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
        }
      );
      
      if (currentGfi >= dynamicThreshold) {
        const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
        logger?.warn?.(`[PD:GFI_GATE] Low-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
        return {
          block: true,
          blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage}${lineChanges > 50 ? `, ${lineChanges}行修改` : ''})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
        };
      }
    }
    // AGENT_TOOLS: Block subagent spawn when GFI is critically high (P0 fix: prevent privilege escalation via spawned subagents)
    if (isAgentTool) {
      const AGENT_SPAWN_GFI_THRESHOLD = 90;
      if (currentGfi >= AGENT_SPAWN_GFI_THRESHOLD) {
        logger?.warn?.(`[PD:GFI_GATE] Agent tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${AGENT_SPAWN_GFI_THRESHOLD}`);
        return {
          block: true,
          blockReason: `[GFI Gate] 疲劳指数过高，禁止派生子智能体。

GFI: ${currentGfi}/100
阈值: ${AGENT_SPAWN_GFI_THRESHOLD} (Stage ${wctx.trust.getStage()})

原因: 高疲劳状态下派生子智能体会放大错误风险。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 简化任务后重试`,
        };
      }
    }
  }

  // Merge pluginConfig (OpenClaw UI settings)
  const configRiskPaths = (ctx.pluginConfig?.riskPaths as string[] | undefined) ?? [];
  if (configRiskPaths.length > 0) {
    profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
  }

  // 3. Resolve the target file path
  let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;
  
  // Heuristic for bash mutation detection
  if (isBash && !filePath) {
    const command = String(event.params.command || event.params.args || "");
    const mutationMatch = command.match(/(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/);
    
    if (mutationMatch) {
      filePath = mutationMatch[1];
    } else {
      const hasRiskPath = profile.risk_paths.some(rp => command.includes(rp));
      const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);
      
      if (hasRiskPath && isMutation) {
        filePath = command; 
      } else {
        return;
      }
    }
  }

  if (typeof filePath !== 'string') return;

  const relPath = normalizePath(filePath, ctx.workspaceDir);
  const risky = (isBash && filePath.includes(' ')) 
    ? profile.risk_paths.some(rp => filePath.includes(rp))
    : isRisky(relPath, profile.risk_paths);

  // ── PROGRESSIVE GATE LOGIC ──
  if (profile.progressive_gate?.enabled) {
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

    const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile.risk_paths);
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
    const planApprovals = profile.progressive_gate?.plan_approvals;
    const canUsePlanApproval = Boolean(
      stage === 1 &&
      planApprovals?.enabled &&
      getPlanStatus(ctx.workspaceDir) === 'READY' &&
      planApprovals.allowed_operations?.includes(event.toolName) &&
      matchesAnyPattern(relPath, planApprovals.allowed_patterns || []) &&
      ((planApprovals.max_lines_override ?? -1) === -1 || lineChanges <= (planApprovals.max_lines_override ?? -1))
    );

    logger.info(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

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
                logger.warn(`[PD_EP_SIM] Failed to create log dir: ${mkdirErr?.message ?? String(mkdirErr)}, skipping log`);
                canWriteEpLog = false;
            }
        }
        
        if (canWriteEpLog) {
            fs.appendFileSync(epLogPath, JSON.stringify(epLogEntry) + '\n');
        }
        
        logger.info(`[PD_EP_SIM] Tier: ${epDecision.currentTier}, Allowed: ${epDecision.allowed}, Trust: ${trustScore} (Stage ${stage})`);
    } catch (err) {
        // EP 模拟失败不应该影响 Trust Engine 决策
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[PD_EP_SIM] Simulation failed: ${errMsg}, continuing with Trust Engine`);
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
            logger.info(`[PD_GATE] Stage 1 PLAN approval: ${relPath}`);
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
        const targetAbsolutePath = typeof filePath === 'string' ? path.join(ctx.workspaceDir, filePath) : null;
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
            const planStatus = getPlanStatus(ctx.workspaceDir);
            if (planStatus !== 'READY') {
                return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, wctx, event.toolName, logger, ctx.sessionId);
            }
        }
        
        // Percentage-based threshold calculation
        const targetAbsolutePath = typeof filePath === 'string' ? path.join(ctx.workspaceDir, filePath) : null;
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
        logger.info(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
        // Audit log for Stage 4 bypass (security traceability)
        try {
          const stateDir = wctx.resolve('STATE_DIR');
          const eventLog = EventLogService.get(stateDir);
          eventLog.recordGateBypass(ctx.sessionId, {
            toolName: event.toolName,
            filePath: relPath,
            bypassType: 'stage4_architect',
            trustScore,
            trustStage: stage,
          });
        } catch (auditErr) {
          logger?.warn?.(`[PD_GATE] Failed to record Stage 4 bypass audit: ${String(auditErr)}`);
        }
        return;
    }

  } else {
    // FALLBACK: Legacy Gate Logic
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return block(relPath, `No READY plan found in PLAN.md.`, wctx, event.toolName, logger, ctx.sessionId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // P-03: Edit Tool Force Verification
  // ═══════════════════════════════════════════════════════════════

  // After all gate checks, verify edit operations (enforces P-03)
  if (event.toolName === 'edit' && profile.edit_verification?.enabled !== false) {
    const verifyResult = handleEditVerification(event, wctx, ctx, {
      enabled: profile.edit_verification.enabled,
      max_file_size_bytes: profile.edit_verification.max_file_size_bytes,
      fuzzy_match_enabled: profile.edit_verification.fuzzy_match_enabled,
      fuzzy_match_threshold: profile.edit_verification.fuzzy_match_threshold,
      skip_large_file_action: profile.edit_verification.skip_large_file_action as 'warn' | 'block' | undefined,
    });
    if (verifyResult) {
      return verifyResult; // Block or modify params
    }
  }
}

/**
 * Build a detailed reason message for line limit blocks.
 */
function buildLineLimitReason(
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

function block(
  filePath: string,
  reason: string,
  wctx: WorkspaceContext,
  toolName: string,
  logger: { warn?: (message: string) => void; error?: (message: string) => void },
  sessionId?: string
): PluginHookBeforeToolCallResult {
  logger.error?.(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

  if (sessionId) {
    trackBlock(sessionId);
  }

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
    scheduleTrajectoryGateBlockRetry(wctx, trajectoryPayload, 1, {
      warn: (message) => logger.warn?.(message),
      error: (message) => logger.error?.(message),
    });
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

function scheduleTrajectoryGateBlockRetry(
  wctx: WorkspaceContext,
  payload: {
    sessionId: string | null;
    toolName: string;
    filePath: string;
    reason: string;
  },
  attempt: number,
  logger: { warn: (message: string) => void; error?: (message: string) => void }
): void {
  if (attempt > TRAJECTORY_GATE_BLOCK_MAX_RETRIES) {
    logger.error?.(`[PD_GATE] Failed to persist trajectory gate block after ${TRAJECTORY_GATE_BLOCK_MAX_RETRIES} retries: ${payload.toolName} ${payload.filePath}`);
    return;
  }

  setTimeout(() => {
    try {
      wctx.trajectory?.recordGateBlock?.(payload);
    } catch (error) {
      logger.warn(`[PD_GATE] Retrying trajectory gate block persistence: ${String(error)}`);
      scheduleTrajectoryGateBlockRetry(wctx, payload, attempt + 1, logger);
    }
  }, TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS);
}

// ═══════════════════════════════════════════════════════════════
// P-03: Edit Tool Force Verification
// ═══════════════════════════════════════════════════════════════

/**
 * Normalize a line for fuzzy matching by collapsing whitespace
 */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Find fuzzy match between oldText and current file content
 * @param lines - File content split into lines
 * @param oldLines - oldText split into lines
 * @param threshold - Match threshold (0-1)
 * @returns Match index or -1 if not found
 */
function findFuzzyMatch(lines: string[], oldLines: string[], threshold: number = 0.8): number {
  if (oldLines.length === 0) return -1;  // P2 fix: empty array boundary check

  const normalizedLines = lines.map(normalizeLine);
  const normalizedOldLines = oldLines.map(normalizeLine);

  // Try to find matching sequence
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedLines[i + j] === normalizedOldLines[j]) {
        matchCount++;
      }
    }

    // Use threshold from config
    if (matchCount >= oldLines.length * threshold) {
      return i;
    }
  }

  return -1;
}

/**
 * Try to find a fuzzy match for oldText in the current content
 * @param currentContent - Current file content
 * @param oldText - Text to match
 * @param threshold - Match threshold (0-1)
 * @returns Object with found status and corrected text if found
 */
function tryFuzzyMatch(currentContent: string, oldText: string, threshold: number = 0.8): { found: boolean; correctedText?: string } {
  const lines = currentContent.split('\n');
  const oldLines = oldText.split('\n');

  const matchIndex = findFuzzyMatch(lines, oldLines, threshold);

  if (matchIndex !== -1) {
    // Found fuzzy match, extract actual text from file
    const correctedText = lines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
    return { found: true, correctedText };
  }

  return { found: false };
}

/**
 * Generate a helpful error message for edit verification failure
 */
function generateEditError(filePath: string, oldText: string, currentContent: string): string {
  const expectedSnippet = oldText.split('\n').slice(0, 3).join('\n').substring(0, 200);
  const actualSnippet = currentContent.substring(0, 200);

  return `[P-03 Violation] Edit verification failed

File: ${filePath}

The text you're trying to replace does not match the current file content.

Expected to find:
${expectedSnippet}${oldText.length > 200 ? '...' : ''}

Actual file contains:
${actualSnippet}${currentContent.length > 200 ? '...' : ''}

Possible reasons:
  - File has been modified by another process
  - Whitespace characters do not match (spaces, tabs, newlines)
  - Context compression caused outdated information

Solution:
  1. Use the 'read' tool to get the current file content
  2. Update your edit command with the exact text from the file
  3. Retry the edit operation

This is enforced by P-03 (精确匹配前验证原则).`;
}

// NOTE: handleEditVerification moved to edit-verification.ts
// Using import from './edit-verification.js'
