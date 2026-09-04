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

import { WorkspaceContext } from '../core/workspace-context.js';
import { persistGateBlock, recordGateBlockAndReturn } from './gate-block-helper.js';
import type { RuleHostInput, RuleContextV2 } from '@principles/core/runtime-v2';
import { buildRuleHostAction, validateCorrectionProposal, validateProposedPathBounds, computeFeatureFlagsFromConfig, UNAVAILABLE_RULE_CONTEXT } from '@principles/core/runtime-v2';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult, PluginLogger } from '../openclaw-sdk.js';
import { AGENT_TOOLS, BASH_TOOLS_SET, WRITE_TOOLS } from '../constants/tools.js';
import { OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';
import { getSession, trackReceiptAutoCorrect } from '../core/session-tracker.js';
import { getEvolutionEngine } from '../core/evolution-engine.js';
import { EventLogService } from '../core/event-log.js';
import { estimateLineChanges } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { recordPrincipleApplication } from '../core/principle-application-ledger.js';
import { buildProductionRuleContext } from '../core/rule-context-assembler.js';
import type { HostEventResult } from '@principles/core/host';
import { observeRuleCodeSafety } from '../core/rulecode-safety-circuit.js';

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

  // 2. Use the same action builder as Golden Trace replay. This is the single
  // path extraction + normalization contract for production and evaluation.
  // CodeRabbit PR2 Comment 1: pass the normalized workspace root from
  // WorkspaceContext (wctx.workspaceDir) rather than the raw ctx.workspaceDir,
  // so action.normalizedPath is consistent with the rest of the hook path
  // (which uses WorkspaceContext.fromHookContext's normalized root). Mixing
  // the raw value here produced paths that disagreed with the normalized root
  // used downstream by the rule host / rule-context assembler.
  // PRI-634-F: canonicalKind resolves from the OpenClaw registry (derived
  // from constants/tools.ts) and drives hint derivation inside the builder —
  // replay resolves the identical kind/hints through the same registry.
  const action = buildRuleHostAction(event.toolName, event.params ?? {}, wctx.workspaceDir, {
    isBashTool: isBash,
    isWriteTool,
    canonicalKind: OPENCLAW_TOOL_SEMANTICS.resolve(event.toolName),
  });
  const relPath = action.normalizedPath;
  // buildRuleHostAction returns null when no path can be extracted (e.g. bash
  // command with no file target and no clear mutation operator). Mirror the
  // legacy guard: no path → no gate evaluation, let the tool through.
  if (relPath === null) return;

  // 3. Rule Host Evaluation — sole gate
  try {
    const ruleHost = wctx.getRuleHost(logger);
    // PRI-483 Phase 4: assemble RuleContextV2 when `rulecode_context_v2` flag is ON.
    // flag OFF → undefined (v1 zero-change, no trajectory access).
    // flag ON  → RuleContextV2 (available or unavailable). Never throws (ERR-024).
    const ruleContext = buildRuleContextIfEnabled(wctx, relPath, ctx.sessionId, logger);
    const hostInput: RuleHostInput = {
      action,
      workspace: {
        isRiskPath: false, // Rule Host determines risk dynamically
      },
      session: {
        sessionId: ctx.sessionId,
        currentGfi: _getCurrentGfi(ctx.sessionId),
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

    const report = typeof ruleHost.evaluateDetailed === 'function'
      ? ruleHost.evaluateDetailed(hostInput)
      : { liveDecision: ruleHost.evaluate(hostInput), shadowDecisions: [], skippedActivations: [], liveRulesLoaded: 0, evaluationStatus: 'ok' as const };
    const hostResult = report.liveDecision;
    // PRI-567: "no live rules armed" must be distinguishable from "a live rule
    // evaluated and allowed". Previously both logged decision='allow', which
    // made enforcement statistics read as if rules were active when none were.
    const liveDecisionFallback = hostResult?.decision
      ?? (report.evaluationStatus === 'failed'
        ? 'evaluation_failed'
        : report.liveRulesLoaded > 0 ? 'allow' : 'no_rules_armed');

    const safetyDecision = liveDecisionFallback === 'no_rules_armed' || liveDecisionFallback === 'evaluation_failed'
      ? 'allow'
      : liveDecisionFallback;
    const circuitTripped = observeRuleCodeSafety({ workspaceDir: wctx.workspaceDir, activationId: report.liveDecisionActivationId, toolName: event.toolName, params: event.params ?? {}, decision: safetyDecision, matched: hostResult?.matched ?? false, logger });
    if (circuitTripped) {
      logger.warn?.(`[PD_GATE] RuleCode ${report.liveDecisionActivationId ?? 'unknown'} safety-isolated; allowing current host call.`);
      return;
    }

    for (const shadowDecision of report.shadowDecisions) {
      try {
        const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
        eventLog.recordRuleHostEvaluated({
          toolName: event.toolName,
          filePath: relPath,
          matched: shadowDecision.matched,
          decision: shadowDecision.decision,
          ruleId: shadowDecision.ruleId,
          activationId: shadowDecision.activationId,
          activationMode: 'shadow',
        });
      } catch (evErr) {
        logger?.warn?.(`[PD_GATE] Failed to record shadow rulehost_evaluated: ${String(evErr)}`);
      }
    }

    // Always emit rulehost_evaluated
    try {
      const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
      eventLog.recordRuleHostEvaluated({
        toolName: event.toolName,
        filePath: relPath,
        matched: hostResult?.matched ?? false,
        decision: liveDecisionFallback,
        ruleId: hostResult?.ruleId,
        // P1 (ISSUE-023): live 事件补 activationId — 414 次 live-mode 评估
        // 无法对账到规则的审计缺口
        activationId: report.liveDecisionActivationId,
        activationMode: 'live',
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

      // PRI-531: durable receipt ledger row for the block (flag-gated; the
      // block decision itself never depends on this write — rc-9 on failure).
      try {
        if (loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_ledger').enabled) {
          const ledgerPrincipleId = hostResult.principleId ?? hostResult.ruleId;
          if (ledgerPrincipleId) {
            const written = recordPrincipleApplication(wctx.workspaceDir, {
              principleId: ledgerPrincipleId,
              ruleId: hostResult.ruleId,
              channel: 'code_tool_hook',
              level: 'effect',
              kind: 'rule_blocked',
              sessionId: ctx.sessionId,
              toolName: event.toolName,
              filePath: relPath,
              digest: hostResult.reason,
            });
            if (!written) {
              logger?.warn?.('[PD_GATE] Receipt ledger write failed (rule_blocked) — history degraded, block unaffected (rc-9)');
            }
          } else {
            // PRI-573: RuleHostResult.ruleId/principleId are both optional — a
            // block without attribution would otherwise skip the effect row
            // silently. The skip itself must be observable (rc-9).
            logger?.warn?.('[PD_GATE] Receipt ledger row skipped (rule_blocked): decision carries no principleId/ruleId — effect evidence not captured (rc-9)');
          }
        }
      } catch (ledgerErr) {
        logger?.warn?.(`[PD_GATE] Receipt ledger write threw (rule_blocked): ${String(ledgerErr)}`);
      }

      return recordGateBlockAndReturn(wctx, {
        filePath: relPath,
        reason: hostResult.reason,
        toolName: event.toolName,
        sessionId: ctx.sessionId,
        blockSource: 'rule-host',
        ruleId: hostResult.ruleId,
        principleId: hostResult.principleId,
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

          if (appliedFields.length > 0) {
            // PRI-531: durable receipt ledger row — only after the correction
            // verifiably applied (SPEC honesty rule: no applied row before D2).
            try {
              // PRI-534: session receipt counter (independent of the ledger flag).
              trackReceiptAutoCorrect(ctx.sessionId, wctx.workspaceDir);
              if (loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_ledger').enabled) {
                const ledgerPrincipleId = proposal.principleId != null
                  ? String(proposal.principleId)
                  : String(proposal.ruleId ?? 'unknown');
                const written = recordPrincipleApplication(wctx.workspaceDir, {
                  principleId: ledgerPrincipleId,
                  ruleId: String(proposal.ruleId ?? 'unknown'),
                  channel: 'code_tool_hook',
                  level: 'effect',
                  kind: 'auto_correct_applied',
                  sessionId: ctx.sessionId,
                  toolName: event.toolName,
                  filePath: relPath,
                  // rc-8: corrected values (e.g. file content) can be huge —
                  // bound the digest preview.
                  digest: appliedFields
                    .map(f => `${f.field}: ${JSON.stringify(f.original)} -> ${JSON.stringify(f.applied)}`)
                    .join(', ')
                    .slice(0, 200),
                });
                if (!written) {
                  logger?.warn?.('[PD_GATE] Receipt ledger write failed (auto_correct_applied) — history degraded, correction unaffected (rc-9)');
                }
              }
            } catch (ledgerErr) {
              logger?.warn?.(`[PD_GATE] Receipt ledger write threw (auto_correct_applied): ${String(ledgerErr)}`);
            }
            // PRI-529 (SPEC §6-D2): the host merges ONLY `params` from the hook
            // result (hook-before-tool-call-result.ts). The previous return shape
            // (`toolArgs`/`skipToolCall`/`_pdAutoCorrectWarning`) was ignored by
            // the host and `_pdAutoCorrectWarning` had zero consumers. In-place
            // mutation of event.params is kept as a secondary channel but the
            // contract field is the propagation mechanism.
            return { params: { ...event.params } };
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

function _getCurrentGfi(sessionId?: string): number {
  if (!sessionId) return 0;
  try {
    return getSession(sessionId)?.currentGfi ?? 0;
  } catch {
    return 0;
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

export function buildOpenClawRuleInputEnrichment(
  event: PluginHookBeforeToolCallEvent,
  workspaceDir: string,
  sessionId: string | undefined,
) {
  return {
    currentGfi: _getCurrentGfi(sessionId),
    epTier: _getEpTier(workspaceDir),
    bashRisk: _getBashRisk(event),
  };
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
export function buildRuleContextIfEnabled(
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

export function handleSharedRuleHostResult(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir: string; logger?: Partial<PluginLogger> },
  result: HostEventResult,
): void {
  const logger = ctx.logger ?? console;
  for (const warning of result.warnings ?? []) logger.warn?.(`[PD_GATE:RULE_HOST] ${warning}`);
  const evaluatedLiveRules = result.metadata?.['evaluatedLiveRules'];
  logger.info?.(`[PD_GATE:RULE_HOST] shared production gate evaluated; liveRules=${typeof evaluatedLiveRules === 'number' ? evaluatedLiveRules : 'unknown'} decision=${result.decision}`);
  const metadata = result.metadata;
  const ruleDecision = metadata?.['ruleDecision'];
  if (ruleDecision === 'auto_correct' || ruleDecision === 'requireApproval') {
    // These decision kinds are OpenClaw-owned (approval UX / auto-correct):
    // onBeforeToolResult falls back to the legacy handleBeforeToolCall, which
    // re-evaluates and records the actual decision events. Recording an
    // 'allow' evaluation here too would emit a duplicate, inconsistent
    // rulehost_evaluated row for the same tool call.
    logger.info?.(`[PD_GATE:RULE_HOST] shared result carries ruleDecision=${String(ruleDecision)}; the legacy handler records the decision events`);
    return;
  }
  const wctx = WorkspaceContext.fromHookContext(ctx);
  const action = buildRuleHostAction(event.toolName, event.params ?? {}, wctx.workspaceDir, {
    isBashTool: BASH_TOOLS_SET.has(event.toolName),
    isWriteTool: WRITE_TOOLS.has(event.toolName),
    canonicalKind: OPENCLAW_TOOL_SEMANTICS.resolve(event.toolName),
  });
  const ruleId = typeof metadata?.['ruleId'] === 'string' ? metadata['ruleId'] : undefined;
  const principleId = typeof metadata?.['principleId'] === 'string' ? metadata['principleId'] : undefined;
  const denyReason = result.reason ?? 'RuleHost denied the tool call';
  if (action.normalizedPath === null) {
    if (result.decision === 'deny') {
      // PRI-569 round 3: a deny is ALWAYS accounted — trajectory.db accepts
      // a null file_path, so record with null instead of dropping the count.
      accountSharedDeny(wctx, {
        sessionId: ctx.sessionId,
        toolName: event.toolName,
        filePath: null,
        reason: denyReason,
        ruleId,
        principleId,
      }, logger);
    }
    return;
  }
  try {
    const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
    eventLog.recordRuleHostEvaluated({
      toolName: event.toolName, filePath: action.normalizedPath,
      matched: result.decision === 'deny', decision: result.decision === 'deny' ? 'block' : 'allow',
      ruleId, activationMode: 'live',
    });
    if (result.decision === 'deny') {
      eventLog.recordRuleEnforced({ ruleId: ruleId ?? 'unknown', principleId: principleId ?? 'unknown', enforcement: 'block', toolName: event.toolName, filePath: action.normalizedPath });
      eventLog.recordRuleHostBlocked({ toolName: event.toolName, filePath: action.normalizedPath, reason: denyReason, ruleId });
    }
  } catch (error: unknown) {
    logger.warn?.(`[PD_GATE] Failed to record shared RuleHost result: ${String(error)}`);
  }
  if (result.decision === 'deny') {
    accountSharedDeny(wctx, {
      sessionId: ctx.sessionId,
      toolName: event.toolName,
      filePath: action.normalizedPath,
      reason: denyReason,
      ruleId,
      principleId,
    }, logger);
  }
}

/**
 * Authoritative accounting for ONE shared-path deny decision (PRI-569).
 *
 * Both shared-handler deny branches (resolvable and unresolved target path)
 * funnel here: receipt-ledger effect row (flag-gated, failure-degrading —
 * parity with the legacy hook path) plus persistGateBlock (session GFI,
 * EventLog gate_block, trajectory gate_blocks with bounded retry). A null
 * filePath is accounted with a null trajectory file_path; the EventLog copy
 * carries an '<unresolved>' placeholder. Never throws into the caller;
 * every skip/failure warns with a reasonCode (rc-9).
 */
export function accountSharedDeny(
  wctx: WorkspaceContext,
  accounting: {
    sessionId?: string;
    toolName: string;
    filePath: string | null;
    reason: string;
    ruleId?: string;
    principleId?: string;
  },
  logger: { warn?: (_message: string) => void; error?: (_message: string) => void },
): void {
  if (accounting.filePath === null) {
    logger.warn?.('[PD_GATE] Shared-path deny accounted with unresolved target path (reasonCode=shared_deny_path_unresolved)');
  }
  try {
    if (loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_ledger').enabled) {
      const ledgerPrincipleId = accounting.principleId ?? accounting.ruleId;
      if (ledgerPrincipleId) {
        const written = recordPrincipleApplication(wctx.workspaceDir, {
          principleId: ledgerPrincipleId,
          ruleId: accounting.ruleId,
          channel: 'code_tool_hook',
          level: 'effect',
          kind: 'rule_blocked',
          sessionId: accounting.sessionId,
          toolName: accounting.toolName,
          filePath: accounting.filePath ?? undefined,
          digest: accounting.reason,
        });
        if (!written) {
          logger.warn?.('[PD_GATE] Receipt ledger write failed (rule_blocked, shared) — history degraded, block unaffected (rc-9)');
        }
      } else {
        logger.warn?.('[PD_GATE] Receipt ledger row skipped (rule_blocked, shared): decision carries no principleId/ruleId — effect evidence not captured (rc-9)');
      }
    }
  } catch (ledgerErr) {
    logger.warn?.(`[PD_GATE] Receipt ledger write threw (rule_blocked, shared): ${String(ledgerErr)}`);
  }
  persistGateBlock(wctx, {
    filePath: accounting.filePath,
    reason: accounting.reason,
    toolName: accounting.toolName,
    sessionId: accounting.sessionId,
    blockSource: 'rule-host-shared',
    ruleId: accounting.ruleId,
    principleId: accounting.principleId,
  }, logger);
}
