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
import { checkProgressiveTrustGate, buildLineLimitReason } from './progressive-trust-gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import {
  AGENT_TOOLS,
  BASH_TOOL_NAMES,
  BASH_TOOLS_SET,
  HIGH_RISK_TOOLS,
  LOW_RISK_WRITE_TOOLS,
  WRITE_TOOLS,
} from '../constants/tools.js';
import { 
  TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS,
  TRAJECTORY_GATE_BLOCK_MAX_RETRIES 
} from '../config/index.js';

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
  // Use checkGfiGate from extracted module
  const gfiResult = checkGfiGate(event, wctx, ctx.sessionId, gfiGateConfig, logger);
  if (gfiResult) {
    return gfiResult;
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
    // Use checkProgressiveTrustGate from extracted module
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
    const progressiveGateResult = checkProgressiveTrustGate(
      event,
      wctx,
      relPath,
      risky,
      lineChanges,
      logger,
      ctx,
      profile
    );
    if (progressiveGateResult) {
      return progressiveGateResult;
    }
    // If progressive gate handled (e.g., Stage 4 bypass returned undefined), don't fall through to legacy
    return;
  }

  // FALLBACK: Legacy Gate Logic (when progressive gate is disabled)
  if (risky && profile.gate?.require_plan_for_risk_paths) {
    const planStatus = getPlanStatus(ctx.workspaceDir);
    if (planStatus !== 'READY') {
      return block(relPath, `No READY plan found in PLAN.md.`, wctx, event.toolName, logger, ctx.sessionId);
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is a mandatory security gate. The operation was blocked because the modification exceeds the allowed threshold for your current trust stage.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
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
