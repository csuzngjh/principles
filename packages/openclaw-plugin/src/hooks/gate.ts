import * as fs from 'fs';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { normalizeProfile } from '../core/profile.js';
import { trackBlock, hasRecentThinking } from '../core/session-tracker.js';
import { assessRiskLevel, estimateLineChanges } from '../core/risk-calculator.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  const AGENT_TOOLS = ['pd_spawn_agent', 'sessions_spawn'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  const isAgentTool = AGENT_TOOLS.includes(event.toolName);
  
  // ═══ THINKING OS CHECKPOINT (P-10) ═══
  // Must run BEFORE the early return to catch all high-risk tools
  const HIGH_RISK_TOOLS = [...WRITE_TOOLS, ...BASH_TOOLS, ...AGENT_TOOLS];
  const isHighRisk = HIGH_RISK_TOOLS.includes(event.toolName);
  
  if (isHighRisk && ctx.sessionId) {
    const hasThinking = hasRecentThinking(ctx.sessionId, 5 * 60 * 1000); // 5 minute window
    if (!hasThinking) {
      logger?.info?.(`[PD:THINKING_GATE] High-risk tool "${event.toolName}" called without recent deep thinking`);
      return {
        block: true,
        blockReason: `[Thinking OS Checkpoint] 高风险操作 "${event.toolName}" 需要先进行深度思考。\n\n请先使用 deep_reflect 工具分析当前情况，然后再尝试此操作。\n\n这是强制性检查点，目的是确保决策质量。\n\n提示：调用 deep_reflect 后，5分钟内的操作将自动放行。`,
      };
    }
  }
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
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
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
    };

    const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile.risk_paths);
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });

    logger.info(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

    // Stage 1 (Bankruptcy): Block ALL writes to risk paths, and all medium+ writes
    if (stage === 1) {
        if (risky || riskLevel !== 'LOW') {
            // Check if PLAN whitelist is enabled
            if (profile.progressive_gate?.plan_approvals?.enabled) {
                const planApprovals = profile.progressive_gate.plan_approvals;
                const planStatus = getPlanStatus(ctx.workspaceDir);

                // Must have READY plan
                if (planStatus === 'READY') {
                    // Check operation type
                    if (planApprovals.allowed_operations?.includes(event.toolName)) {
                        // Check path pattern
                        if (matchesAnyPattern(relPath, planApprovals.allowed_patterns || [])) {
                            // Check line limit (if configured)
                            const maxLines = planApprovals.max_lines_override ?? -1;
                            if (maxLines === -1 || lineChanges <= maxLines) {
                                // Record PLAN approval event
                                wctx.eventLog.recordPlanApproval(ctx.sessionId, {
                                    toolName: event.toolName,
                                    filePath: relPath,
                                    pattern: relPath,
                                    planStatus
                                });
                                logger.info(`[PD_GATE] Stage 1 PLAN approval: ${relPath}`);
                                return; // Allow the operation
                            }
                        }
                    }
                }
            }

            // Block if not approved by whitelist
            return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, wctx, event.toolName);
        }
    }

    // Stage 2 (Editor): Block writes to risk paths. Block large changes.
    if (stage === 2) {
        if (risky) {
            return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, wctx, event.toolName);
        }
        const stage2Limit = trustSettings.limits?.stage_2_max_lines ?? 50;
        if (lineChanges > stage2Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 2. Max allowed is ${stage2Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 3 (Developer): Allow normal writes. Require READY plan for risk paths.
    if (stage === 3) {
        if (risky) {
            const planStatus = getPlanStatus(ctx.workspaceDir);
            if (planStatus !== 'READY') {
                return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, wctx, event.toolName);
            }
        }
        const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
        if (lineChanges > stage3Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 3. Max allowed is ${stage3Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 4 (Architect): Full bypass
    if (stage === 4) {
        logger.info(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
        return;
    }
  } else {
    // FALLBACK: Legacy Gate Logic
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return block(relPath, `No READY plan found in PLAN.md.`, wctx, event.toolName);
      }
    }
  }
}

function block(filePath: string, reason: string, wctx: WorkspaceContext, toolName: string): PluginHookBeforeToolCallResult {
  const logger = console;
  logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);
  
  trackBlock(wctx.workspaceDir);
  
  return {
    block: true,
    blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
  };
}
