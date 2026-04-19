/**
 * Security Gate Hook - Rule Host Only
 *
 * This is the SINGLE AUTHORITATIVE orchestration path.
 * All blocking logic is now dynamic via Rule Host — no hardcoded gates remain.
 *
 * Flow:
 * 1. Early Return: Skip if not write/bash/agent tool or no workspace
 * 2. Rule Host: Dynamic principle-based evaluation (sole gate)
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from '../utils/io.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';
import { RuleHost } from '../core/rule-host.js';
import type { RuleHostInput } from '../core/rule-host-types.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult, PluginLogger } from '../openclaw-sdk.js';
import { AGENT_TOOLS, BASH_TOOLS_SET, WRITE_TOOLS } from '../constants/tools.js';
import { getSession, hasRecentThinking } from '../core/session-tracker.js';
import { getEvolutionEngine } from '../core/evolution-engine.js';
import { EventLogService } from '../core/event-log.js';
import { estimateLineChanges } from '../core/risk-calculator.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: Partial<PluginLogger> }
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

  // 2. Resolve the target file path
  let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;

  // Heuristic for bash mutation detection
  if (isBash && !filePath) {
    const command = String(event.params.command || event.params.args || '');
    const mutationMatch = /(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/.exec(command);

    if (mutationMatch) {
      filePath = mutationMatch[1];
    } else {
      // Bash command without a clear file target — let it through to Rule Host
      filePath = command;
    }
  }

  if (typeof filePath !== 'string') return;

  const relPath = normalizePath(filePath, ctx.workspaceDir);

  // 3. Rule Host Evaluation — sole gate
  try {
    const ruleHost = new RuleHost(wctx.stateDir, logger);
    const hostInput: RuleHostInput = {
      action: {
        toolName: event.toolName,
        normalizedPath: relPath,
        paramsSummary: _extractParamsSummary(event.params),
      },
      workspace: {
        isRiskPath: false, // Rule Host determines risk dynamically
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
        bashRisk: _getBashRisk(event),
      },
    };

    const hostResult = ruleHost.evaluate(hostInput);

    // Always emit rulehost_evaluated
    try {
      const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
      eventLog.recordRuleHostEvaluated({
        toolName: event.toolName,
        filePath: relPath,
        matched: hostResult?.matched ?? false,
        decision: hostResult?.decision ?? 'allow',
        ruleId: hostResult?.ruleId,
      });
    } catch (evErr) {
      logger?.warn?.(`[PD_GATE] Failed to record rulehost_evaluated: ${String(evErr)}`);
    }

    if (hostResult?.decision === 'block') {
      try {
        const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
        eventLog.recordRuleEnforced({
          ruleId: hostResult.ruleId || 'unknown',
          principleId: hostResult.principleId || 'unknown',
          enforcement: 'block',
          toolName: event.toolName,
          filePath: relPath,
        });
        eventLog.recordRuleHostBlocked({
          toolName: event.toolName,
          filePath: relPath,
          reason: hostResult.reason,
          ruleId: hostResult.ruleId,
        });
      } catch (evErr) {
        logger?.warn?.(`[PD_GATE] Failed to record rule_enforced/rulehost_blocked: ${String(evErr)}`);
      }

      return recordGateBlockAndReturn(wctx, {
        filePath: relPath,
        reason: hostResult.reason,
        toolName: event.toolName,
        sessionId: ctx.sessionId,
        blockSource: 'rule-host',
      }, logger);
    }

    if (hostResult?.decision === 'requireApproval') {
      try {
        const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
        eventLog.recordRuleEnforced({
          ruleId: hostResult.ruleId || 'unknown',
          principleId: hostResult.principleId || 'unknown',
          enforcement: 'requireApproval',
          toolName: event.toolName,
          filePath: relPath,
        });
        eventLog.recordRuleHostRequireApproval({
          toolName: event.toolName,
          filePath: relPath,
          reason: hostResult.reason,
          ruleId: hostResult.ruleId,
        });
      } catch (evErr) {
        logger?.warn?.(`[PD_GATE] Failed to record rule_enforced/rulehost_requireApproval: ${String(evErr)}`);
      }
    }
  } catch (hostError: unknown) {
    // D-08: Conservative degradation — log and allow on Rule Host failure
    logger.warn?.(`[PD_GATE:RULE_HOST] Host evaluation failed, allowing conservatively: ${String(hostError)}`);
  }

  // All checks passed - allow the operation
  return;
}

// ---------------------------------------------------------------------------
// Private helpers
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
    const { planStatus } = require('../utils/io.js');
    const status = planStatus(workspaceDir);
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

function _getBashRisk(event: PluginHookBeforeToolCallEvent): 'safe' | 'normal' | 'dangerous' | 'unknown' {
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
