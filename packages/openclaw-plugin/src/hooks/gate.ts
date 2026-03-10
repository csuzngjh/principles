import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { EventLogService } from '../core/event-log.js';
import { trackBlock } from '../core/session-tracker.js';
import { getAgentScorecard, TRUST_CONFIG } from '../core/trust-engine.js';
import { assessRiskLevel, estimateLineChanges } from '../core/risk-calculator.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
    return;
  }

  // 2. Load Profile
  const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
  let profile = { 
    risk_paths: [] as string[], 
    gate: { require_plan_for_risk_paths: true },
    progressive_gate: { enabled: true } // Default to enabled for now
  };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (e) {
      logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
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
    const scorecard = getAgentScorecard(ctx.workspaceDir);
    const trustScore = scorecard.trust_score ?? 50;
    
    // Determine Stage
    let stage = 2;
    if (trustScore < TRUST_CONFIG.STAGES.STAGE_1_OBSERVER) stage = 1;
    else if (trustScore < TRUST_CONFIG.STAGES.STAGE_2_EDITOR) stage = 2;
    else if (trustScore < TRUST_CONFIG.STAGES.STAGE_3_DEVELOPER) stage = 3;
    else stage = 4;

    const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile.risk_paths);
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });

    logger.info(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

    // Stage 1 (Bankruptcy): Block ALL writes to risk paths, and all medium+ writes
    if (stage === 1) {
        if (risky || riskLevel !== 'LOW') {
            return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, ctx, event.toolName);
        }
    }

    // Stage 2 (Editor): Block writes to risk paths. Block large changes.
    if (stage === 2) {
        if (risky) {
            return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, ctx, event.toolName);
        }
        if (lineChanges > TRUST_CONFIG.LIMITS.STAGE_2_MAX_LINES) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 2. Max allowed is ${TRUST_CONFIG.LIMITS.STAGE_2_MAX_LINES}.`, ctx, event.toolName);
        }
    }

    // Stage 3 (Developer): Normal rules (requires PLAN for risk_paths). Limit extra-large changes.
    if (stage === 3) {
        if (lineChanges > TRUST_CONFIG.LIMITS.STAGE_3_MAX_LINES) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 3. Max allowed is ${TRUST_CONFIG.LIMITS.STAGE_3_MAX_LINES}.`, ctx, event.toolName);
        }
        
        if (risky) {
            const status = getPlanStatus(ctx.workspaceDir);
            if (status !== 'READY') {
                return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, ctx, event.toolName, status);
            }
        }
    }

    // Stage 4 (Architect): All allowed.
    if (stage === 4) {
        logger.info(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
        return;
    }
  }

  // 4. Original/Fallback Gate Logic
  if (risky && profile.gate.require_plan_for_risk_paths) {
    const status = getPlanStatus(ctx.workspaceDir);
    if (status !== 'READY') {
      return block(relPath, 'No READY plan found in docs/PLAN.md.', ctx, event.toolName, status);
    }
  }
}

function block(relPath: string, reason: string, ctx: any, toolName: string, planStatus?: string): PluginHookBeforeToolCallResult {
    const logger = ctx.logger || console;
    logger.warn(`[PD_GATE] BLOCKED: ${relPath}. Reason: ${reason}`);
    
    if (ctx.sessionId) trackBlock(ctx.sessionId);
    
    const stateDir = ctx.stateDir || path.join(ctx.workspaceDir, 'memory', '.state');
    EventLogService.get(stateDir).recordGateBlock(ctx.sessionId, {
        toolName,
        filePath: relPath,
        reason,
        planStatus,
    });

    return {
        block: true,
        blockReason: `[PRINCIPLES_GATE] Blocked: ${relPath}\nREASON: ${reason}\nACTION: Improve your trust score or provide a READY plan if allowed.`,
    };
}
