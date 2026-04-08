/**
 * Security Gate Hook - Orchestration Layer
 *
 * HOOK CHAIN PRIORITY (short-circuits on first block):
 *
 * 1. Early Return: Skip if not write/bash/agent tool or no workspace
 * 2. Thinking OS Checkpoint (P-10): Deep reflection enforcement
 * 3. GFI Gate: Fatigue index-based blocking
 * 4. Bash Mutation Detection: Heuristic for bash file modifications
 * 4.5. Rule Host: Active code implementation evaluation (Phase 12)
 * 5. Progressive Gate: EP tier-based access control
 * 6. Edit Verification (P-03): Exact/fuzzy match for edit operations
 *
 * IMPORTANT: This is the SINGLE AUTHORITATIVE orchestration path.
 * All policy modules (gfi-gate, progressive-trust-gate, rule-host) use the shared
 * `recordGateBlockAndReturn` helper to ensure consistent block persistence.
 *
 * Zero-width character detection is handled in bash-risk.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { estimateLineChanges } from '../core/risk-calculator.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { checkThinkingCheckpoint } from './thinking-checkpoint.js';
import { handleEditVerification } from './edit-verification.js';
import { checkGfiGate } from './gfi-gate.js';
import { checkProgressiveTrustGate } from './progressive-trust-gate.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';
import { RuleHost } from '../core/rule-host.js';
import type { RuleHostInput } from '../core/rule-host-types.js';
import { createRuleHostHelpers } from '../core/rule-host-helpers.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import {
  AGENT_TOOLS,
  BASH_TOOLS_SET,
  WRITE_TOOLS,
} from '../constants/tools.js';
import { getSession, hasRecentThinking } from '../core/session-tracker.js';
import { getEvolutionEngine } from '../core/evolution-engine.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const isBash = BASH_TOOLS_SET.has(event.toolName);
  const isWriteTool = WRITE_TOOLS.has(event.toolName);
  const isAgentTool = AGENT_TOOLS.has(event.toolName);

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

  // ─────────────────────────────────────────────────────────────────────────────
  // POLICY STEP 1: Thinking OS Checkpoint (P-10)
  // ─────────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────────
  // POLICY STEP 2: GFI Gate - Hard Intercept
  // ─────────────────────────────────────────────────────────────────────────────
  // 根据 GFI (疲劳指数) 精细化拦截工具调用
  // 注意：TIER 0 (只读工具) 已在早期过滤中放行，此处不检查
  const gfiGateConfig = wctx.config.get('gfi_gate');
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

  // ─────────────────────────────────────────────────────────────────────────────
  // POLICY STEP 2.5: Rule Host Evaluation (Phase 12, D-01/D-03)
  // ─────────────────────────────────────────────────────────────────────────────
  // Inserted between GFI gate and Progressive Gate so principle rules can act
  // before the capability-boundary fallback. Active code implementations run
  // through a constrained vm context with minimal helpers only.
  try {
    const ruleHost = new RuleHost(wctx.stateDir, logger);
    const hostInput: RuleHostInput = {
      action: {
        toolName: event.toolName,
        normalizedPath: relPath,
        paramsSummary: _extractParamsSummary(event.params),
      },
      workspace: {
        isRiskPath: risky,
        planStatus: _getPlanStatus(ctx.workspaceDir),
        hasPlanFile: _hasPlanFile(ctx.workspaceDir),
      },
      session: {
        sessionId: ctx.sessionId,
        currentGfi: _getCurrentGfi(ctx.sessionId),
        recentThinking: _hasRecentThinking(ctx.sessionId),
      },
      evolution: {
        epTier: _getEpTier(wctx.workspaceDir),
      },
      derived: {
        estimatedLineChanges: estimateLineChanges({ toolName: event.toolName, params: event.params }),
        bashRisk: _getBashRisk(event, profile),
      },
    };

    const hostResult = ruleHost.evaluate(hostInput);
    if (hostResult?.decision === 'block' || hostResult?.decision === 'requireApproval') {
      const reason = hostResult.decision === 'requireApproval'
        ? `[Rule Host] Approval required: ${hostResult.reason}`
        : hostResult.reason;
      return recordGateBlockAndReturn(wctx, {
        filePath: relPath,
        reason,
        toolName: event.toolName,
        sessionId: ctx.sessionId,
        blockSource: 'rule-host',
      }, logger);
    }
  } catch (hostError: unknown) {
    // D-08: Conservative degradation — log and continue to Progressive Gate
    logger.warn?.(`[PD_GATE:RULE_HOST] Host evaluation failed, degrading conservatively: ${String(hostError)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POLICY STEP 3: Progressive Trust Gate (Stage 1-4 access control)
  // ─────────────────────────────────────────────────────────────────────────────
  // IMPORTANT: This step does NOT return early on allow.
  // We must continue to edit verification for ALL allowed operations.
  if (profile.progressive_gate?.enabled) {
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
    // NOTE: Do NOT return here! Continue to edit verification.
    // All allowed operations (regardless of EP tier) should still run edit verification.
  } else {
    // FALLBACK: Legacy Gate Logic (when progressive gate is disabled)
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return recordGateBlockAndReturn(wctx, {
          filePath: relPath,
          reason: `No READY plan found in PLAN.md.`,
          toolName: event.toolName,
          sessionId: ctx.sessionId,
          blockSource: 'gate-legacy',
        }, logger);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POLICY STEP 4: Edit Tool Verification (P-03)
  // ─────────────────────────────────────────────────────────────────────────────
  // This MUST run after all other gate checks for ALL tools.
  // Edit verification ensures oldText matches the actual file content.
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

  // All checks passed - allow the operation
  return;
}

// ---------------------------------------------------------------------------
// Private helpers for building RuleHostInput snapshot
// These are NOT passed to hosted implementations — they only populate the
// frozen snapshot that implementations receive.
// ---------------------------------------------------------------------------

function _extractParamsSummary(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (params.file_path) summary.file_path = params.file_path;
  if (params.path) summary.path = params.path;
  if (params.command) summary.command = params.command;
  if (params.args) summary.args = params.args;
  if (params.old_string) summary.old_string = params.old_string;
  if (params.new_string) summary.new_string = params.new_string;
  return summary;
}

function _getPlanStatus(workspaceDir: string): 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN' {
  try {
    const status = getPlanStatus(workspaceDir);
    if (status === 'READY') return 'READY';
    if (status === 'DRAFT') return 'DRAFT';
    if (status === '') return 'NONE';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function _hasPlanFile(workspaceDir: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceDir, 'PLAN.md'));
  } catch {
    return false;
  }
}

function _getCurrentGfi(sessionId?: string): number {
  if (!sessionId) return 0;
  try {
    return getSession(sessionId)?.currentGfi ?? 0;
  } catch {
    return 0;
  }
}

function _hasRecentThinking(sessionId?: string): boolean {
  if (!sessionId) return false;
  try {
    return hasRecentThinking(sessionId);
  } catch {
    return false;
  }
}

function _getEpTier(workspaceDir: string): number {
  try {
    const engine = getEvolutionEngine(workspaceDir);
    return engine.getTier() as number;
  } catch {
    return 0;
  }
}

function _getBashRisk(
  event: PluginHookBeforeToolCallEvent,
  profile: { risk_paths: string[] }
): 'safe' | 'normal' | 'dangerous' | 'unknown' {
  if (!BASH_TOOLS_SET.has(event.toolName)) return 'unknown';
  try {
    const command = String(event.params.command || event.params.args || '');
    const isDangerous = /\brm\s+-rf\b|\bchmod\b|\bchown\b|>\s*\/dev\//.test(command);
    if (isDangerous) return 'dangerous';
    const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);
    if (isMutation) return 'normal';
    return 'safe';
  } catch {
    return 'unknown';
  }
}
