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

import { normalizePath } from '../utils/io.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';
import { RuleHost } from '../core/rule-host.js';
import type { RuleHostInput, RuleContextV2 } from '@principles/core/runtime-v2';
import { validateCorrectionProposal, validateProposedPathBounds, computeFeatureFlagsFromConfig, UNAVAILABLE_RULE_CONTEXT } from '@principles/core/runtime-v2';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult, PluginLogger } from '../openclaw-sdk.js';
import { AGENT_TOOLS, BASH_TOOLS_SET, WRITE_TOOLS } from '../constants/tools.js';
import { getSession, hasRecentThinking } from '../core/session-tracker.js';
import { getEvolutionEngine } from '../core/evolution-engine.js';
import { EventLogService } from '../core/event-log.js';
import { estimateLineChanges } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from '../core/pd-config-loader.js';
import { buildProductionRuleContext } from '../core/rule-context-assembler.js';

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
  let filePath = event.params?.file_path || event.params?.path || event.params?.file || event.params?.target;

  // Heuristic for bash mutation detection
  if (isBash && !filePath) {
    const command = String(event.params?.command || event.params?.args || '');
    const mutationMatch = /(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/.exec(command);

    if (mutationMatch) {
      filePath = mutationMatch[1];
    } else {
      // Bash command without a clear file target — let it through to Rule Host
      filePath = command;
    }
  }

  // Write tools without a file path must still go through RuleHost evaluation.
  // Use a synthetic path so RuleHost can evaluate and potentially block.
  if (!filePath && isWriteTool) {
    filePath = `<tool:${event.toolName}>`;
  }

  if (typeof filePath !== 'string') return;

  const relPath = normalizePath(filePath, ctx.workspaceDir);

  // 3. Rule Host Evaluation — sole gate
  try {
    const ruleHost = new RuleHost(wctx.stateDir, logger, { workspaceDir: ctx.workspaceDir });
    // PRI-483 Phase 4: assemble RuleContextV2 when `rulecode_context_v2` flag is ON.
    // flag OFF → undefined (v1 zero-change, no trajectory access).
    // flag ON  → RuleContextV2 (available or unavailable). Never throws (ERR-024).
    const ruleContext = _buildRuleContextIfEnabled(wctx, relPath, ctx.sessionId, logger);
    const hostInput: RuleHostInput = {
      action: {
        toolName: event.toolName,
        normalizedPath: relPath,
        paramsSummary: _extractParamsSummary(event.params ?? {}),
      },
      workspace: {
        isRiskPath: false, // Rule Host determines risk dynamically
        // DEPRECATED (PRI-286): planStatus/hasPlanFile are legacy compatibility fields.
        // Live PD no longer reads or manages PLAN.md state. These fields must not be
        // used for new MVP behavior. Future "plan-first" enforcement must come from
        // owner-approved RuleHost/code_tool_hook activation, not built-in state.
        planStatus: 'NONE' as const,
        hasPlanFile: false,
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
        estimatedLineChanges: estimateLineChanges({ toolName: event.toolName, params: event.params ?? {} }),
        bashRisk: _getBashRisk(event),
      },
      context: ruleContext,
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

    if (hostResult?.decision === 'auto_correct' && hostResult.correctionProposal) {
      const proposal = hostResult.correctionProposal;
      let validation: { valid: boolean; errors: string[] };
      try {
        validation = validateCorrectionProposal(proposal);
      } catch (validationError: unknown) {
        validation = { valid: false, errors: [`Validator threw: ${String(validationError)}`] };
      }

      try {
        const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
        const correctedFields = Array.isArray(proposal.correctedFields)
          ? proposal.correctedFields.map((f: unknown) => typeof f === 'object' && f !== null ? String((f as { field?: string }).field) : String(f))
          : [];
        eventLog.recordRuleHostAutoCorrectProposed({
          toolName: event.toolName,
          filePath: relPath,
          ruleId: String(proposal.ruleId ?? 'unknown'),
          principleId: proposal.principleId != null ? String(proposal.principleId) : undefined,
          confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0,
          reason: hostResult.reason,
          applicationMode: proposal.applicationMode === 'live' ? 'live' : 'shadow',
          correctedFields,
          validationValid: validation.valid,
        });
      } catch (evErr) {
        logger?.warn?.(`[PD_GATE] Failed to record rulehost_auto_correct_proposed: ${String(evErr)}`);
      }

      if (proposal.applicationMode === 'live' && validation.valid) {
        if (!event.params) {
          return;
        }
        const originalParams = { ...event.params };
        const nextParams: Record<string, unknown> = {};
        const appliedFields: Array<{ field: string; original: unknown; applied: unknown }> = [];

        try {
          if (!Array.isArray(proposal.correctedFields)) {
            throw new Error('proposal.correctedFields is not an array');
          }

          if (!proposal.proposedParams || typeof proposal.proposedParams !== 'object' || Array.isArray(proposal.proposedParams)) {
            throw new Error('proposal.proposedParams must be an object');
          }

          const trustedWorkspaceDir = ctx.workspaceDir;
          if (typeof trustedWorkspaceDir === 'string' && trustedWorkspaceDir.trim().length > 0) {
            const pathBoundsResult = validateProposedPathBounds(proposal.proposedParams, trustedWorkspaceDir);
            if (!pathBoundsResult.valid) {
              throw new Error(`Path boundary violation: ${pathBoundsResult.reason}`);
            }
          } else {
            const hasPathField = Object.keys(proposal.proposedParams).some(k => typeof proposal.proposedParams[k] === 'string' && (k === 'file_path' || k === 'path' || k === 'filePath'));
            if (hasPathField) {
              throw new Error('Cannot apply live auto-correction with path fields: no trusted workspace directory available');
            }
          }

          for (const cf of proposal.correctedFields) {
            if (typeof cf !== 'object' || cf === null || typeof cf.field !== 'string') {
              throw new Error('correctedFields entry must be an object with a string field');
            }
            const field = cf.field;
            if (!Object.hasOwn(event.params, field)) {
              throw new Error(`Field '${field}' not found in event.params`);
            }
            if (!Object.hasOwn(proposal.proposedParams, field)) {
              throw new Error(`Field '${field}' not found in proposal.proposedParams`);
            }
          }

          for (const cf of proposal.correctedFields) {
            if (typeof cf === 'object' && cf !== null && typeof cf.field === 'string') {
              const field = cf.field;
              const originalValue = event.params[field];
              const appliedValue = proposal.proposedParams[field];
              nextParams[field] = appliedValue;
              appliedFields.push({
                field,
                original: originalValue,
                applied: appliedValue,
              });
            }
          }

          Object.assign(event.params, nextParams);

          try {
            const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
            eventLog.recordRuleHostAutoCorrectApplied({
              toolName: event.toolName,
              filePath: relPath,
              ruleId: String(proposal.ruleId ?? 'unknown'),
              principleId: proposal.principleId != null ? String(proposal.principleId) : undefined,
              confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0,
              reason: hostResult.reason || proposal.correctedFields?.[0]?.reason || 'auto-correct applied',
              correctedFields: appliedFields,
            });
          } catch (evErr) {
            logger?.warn?.(`[PD_GATE] Failed to record rulehost_auto_correct_applied: ${String(evErr)}`);
          }

          if (proposal.notifyAgent === true && appliedFields.length > 0) {
            const messages = appliedFields.map(f =>
              `[PD Auto-Correct] Rule ${proposal.ruleId}: ${proposal.correctedFields?.[0]?.reason || 'correction applied'}. Parameter '${f.field}' was adjusted from ${JSON.stringify(f.original)} to ${JSON.stringify(f.applied)}.`
            );
            return {
              toolArgs: event.toolArgs,
              skipToolCall: false,
              _pdAutoCorrectWarning: messages.join('\n'),
            };
          }
        } catch (applyError: unknown) {
          if (event.params) {
            Object.assign(event.params, originalParams);
          }
          const errorMsg = String(applyError);
          const isPathViolation = errorMsg.includes('Path boundary violation') || errorMsg.includes('no trusted workspace directory');
          if (isPathViolation) {
            logger?.warn?.(`[PD_GATE] Live auto-correction rejected — path out of bounds: ${errorMsg}`);
            try {
              const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
              eventLog.recordRuleHostAutoCorrectProposed({
                toolName: event.toolName,
                filePath: relPath,
                ruleId: String(proposal.ruleId ?? 'unknown'),
                principleId: proposal.principleId != null ? String(proposal.principleId) : undefined,
                confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0,
                reason: `Path boundary rejected: ${errorMsg}`,
                applicationMode: 'shadow',
                correctedFields: Array.isArray(proposal.correctedFields)
                  ? proposal.correctedFields.map((f: unknown) => typeof f === 'object' && f !== null ? String((f as { field?: string }).field) : String(f))
                  : [],
                validationValid: false,
              });
            } catch (evErr) {
              logger?.warn?.(`[PD_GATE] Failed to record path rejection telemetry: ${String(evErr)}`);
            }
          } else {
            logger?.warn?.(`[PD_GATE] Failed to apply auto-correction, using original params: ${errorMsg}`);
          }
        }
      }
    } else if (hostResult?.decision === 'auto_correct') {
      // auto_correct without correctionProposal — emit telemetry for observability
      try {
        const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
        eventLog.recordRuleHostAutoCorrectProposed({
          toolName: event.toolName,
          filePath: relPath,
          ruleId: hostResult.ruleId ?? 'unknown',
          confidence: 0,
          reason: hostResult.reason ?? 'auto_correct without correctionProposal',
          applicationMode: 'shadow',
          correctedFields: [],
          validationValid: false,
        });
      } catch (evErr) {
        logger?.warn?.(`[PD_GATE] Failed to record rulehost_auto_correct_proposed (no proposal): ${String(evErr)}`);
      }
    }
  } catch (hostError: unknown) {
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
  // NOTE: Do NOT redact here — this feeds into RuleHost.evaluate() which
  // may match against paramsSummary.command. Redaction happens at
  // EventLog.record() before persistence.
  if (params.file_path) summary.file_path = params.file_path;
  if (params.path) summary.path = params.path;
  if (params.command) summary.command = params.command;
  if (params.args) summary.args = params.args;
  if (params.old_string) summary.old_string = params.old_string;
  if (params.new_string) summary.new_string = params.new_string;
  return summary;
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
    const command = String(event.params?.command || event.params?.args || '');
    const isDangerous = /\brm\s+-rf\b|\bchmod\b|\bchown\b|>\s*\/dev\//.test(command);
    if (isDangerous) return 'dangerous';
    const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);
    if (isMutation) return 'normal';
    return 'safe';
  } catch {
    return 'unknown';
  }
}

/**
 * PRI-483 Phase 4 — Build RuleContextV2 for RuleHost.evaluate when the
 * `rulecode_context_v2` feature flag is ON. Returns `undefined` when the flag
 * is OFF (v1 zero-change — does NOT touch trajectory) or when config loading
 * fails (conservative fail-soft: can't determine flag state → v1-style).
 *
 * ERR-024 prevention: context assembly failures never skip RuleHost.evaluate.
 * - loadPdConfigForPlugin throws → return undefined (v1-style)
 * - buildProductionRuleContext throws → return UNAVAILABLE_RULE_CONTEXT
 *   (structured unavailable so v2 rules see "context unavailable" and allow)
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §5.3
 */
function _buildRuleContextIfEnabled(
  wctx: WorkspaceContext,
  targetPath: string,
  sessionId: string | undefined,
  logger: { warn?: (msg: string) => void } | undefined,
): RuleContextV2 | undefined {
  // Step 1: load PD config (flag-gated). If this throws, we can't safely
  // determine whether v2 context is required — fall back to v1 (undefined).
  let configResult: ReturnType<typeof loadPdConfigForPlugin>;
  try {
    configResult = loadPdConfigForPlugin(wctx.workspaceDir);
  } catch (err) {
    logger?.warn?.(`[PD_GATE] RuleContext v2: config load failed, skipping context assembly: ${String(err)}`);
    return undefined;
  }

  // Step 2: compute effective flags and check rulecode_context_v2.
  // Explicit ok:false guard (rc-9-no-silent-fallback): when config is malformed,
  // do NOT silently fall through to flag computation on defaults — log and
  // return v1-style undefined so config issues surface to the operator.
  if (!configResult.ok) {
    const reasons = configResult.errors.map(e => e.reason).join('; ');
    logger?.warn?.(`[PD_GATE] RuleContext v2: config load returned malformed result, skipping context assembly: ${reasons}`);
    return undefined;
  }
  const flagsResult = computeFeatureFlagsFromConfig(configResult.effective);
  const v2Flag = flagsResult.flags.rulecode_context_v2;
  if (!v2Flag?.enabled) {
    // Flag OFF → v1 zero-change. Do NOT access trajectory (spec §10.1).
    return undefined;
  }

  // Step 3: flag ON → assemble context via production data source.
  // buildProductionRuleContext is fail-soft internally (returns unavailable),
  // but wrap in try/catch as defense-in-depth (ERR-024).
  try {
    return buildProductionRuleContext(sessionId, targetPath, wctx.trajectory, wctx.workspaceDir);
  } catch (err) {
    logger?.warn?.(`[PD_GATE] RuleContext v2: buildProductionRuleContext threw unexpectedly, using unavailable context: ${String(err)}`);
    return UNAVAILABLE_RULE_CONTEXT;
  }
}
