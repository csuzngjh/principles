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
import { buildGateBlockReason, persistGateBlock, recordGateBlockAndReturn, SHARED_RULE_HOST_BLOCK_SOURCE } from './gate-block-helper.js';
import type { RuleHostInput, RuleContextV2, RuleHostEvaluatedEventData } from '@principles/core/runtime';
import { buildRuleHostAction, validateCorrectionProposal, validateProposedPathBounds, computeFeatureFlagsFromConfig, UNAVAILABLE_RULE_CONTEXT, isRuleHostEvaluatedEventData } from '@principles/core/runtime';
import type { CorrectionProposal } from '@principles/core/runtime';
import { classifyBashRisk } from '@principles/core/runtime/internalization/bash-risk';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult, PluginLogger } from '../openclaw-sdk.js';
import { AGENT_TOOLS, BASH_TOOLS_SET, WRITE_TOOLS } from '../constants/tools.js';
import { resolveOpenClawHookToolSemantics } from './hook-tool-semantics.js';
import { trackReceiptAutoCorrect } from '../core/session-tracker.js';
import { EventLogService, type EventLog } from '../core/event-log.js';
import { estimateLineChanges } from '@principles/core/runtime';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { recordPrincipleApplication } from '../core/principle-application-ledger.js';
import { recordGateEnforcementEvidence } from '../core/intervention-evidence-recorder.js';
import { buildProductionRuleContext } from '../core/rule-context-assembler.js';
import type { HostEventResult } from '@principles/core/host';
import { observeRuleCodeSafety } from '../core/rulecode-safety-circuit.js';

// PRI-813: metadata.evaluations entries cross the HostEventResult contract as
// unknown — validate each against the CANONICAL schema authority in core
// (rc-1/rc-2; P4: adapters must not keep hand-rolled field copies).
// CodeRabbit CR-6: a shadow observation without activationId is dead evidence
// (the shadow summary keys on the exact id), so it is rejected at this
// boundary even though the canonical schema keeps the field optional.
// A blank/whitespace id is equally dead evidence.
function isSharedRuleEvaluationEntry(value: unknown): value is RuleHostEvaluatedEventData {
  return isRuleHostEvaluatedEventData(value)
    && (value.activationMode !== 'shadow' || (typeof value.activationId === 'string' && value.activationId.trim().length > 0));
}

/**
 * PRI-899: recover the winning LIVE activation id from a shared-gate result.
 *
 * The legacy hook path reads this fact from `report.liveDecisionActivationId`
 * (rule-host.ts resolves it from the winning decision's ruleId). The shared
 * gate carries the SAME fact through `metadata.evaluations`, whose live
 * aggregate entry is written first and tagged `activationMode: 'live'`
 * (host-runtime production-rulehost-gate.ts). Without recovering it here the
 * shared deny path wrote effect receipts with `activation_id = NULL`, so
 * behavior evidence could never be JOINed to the activation that produced it.
 *
 * Returns undefined when the metadata carries no attributable live activation
 * (e.g. an aggregate decision with no winner) — the receipt is then written
 * unlinked, exactly as before, and the absence stays observable.
 */
function extractLiveActivationId(metadata: HostEventResult['metadata']): string | undefined {
  const evaluations = metadata?.['evaluations'];
  if (!Array.isArray(evaluations)) return undefined;
  for (const evaluation of evaluations) {
    if (!isSharedRuleEvaluationEntry(evaluation)) continue;
    if (evaluation.activationMode !== 'live') continue;
    const activationId = evaluation.activationId;
    if (typeof activationId === 'string' && activationId.trim().length > 0) return activationId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared decision application (legacy fallback convergence, Task 1)
//
// The legacy hook and the shared-gate handler must record/apply the same
// non-block decisions. These helpers are the ONE implementation of that
// behaviour; both call sites use them, so equivalence is by construction.
// ---------------------------------------------------------------------------

interface CorrectionFacts {
  ruleId: string;
  principleId?: string;
  confidence: number;
  correctedFieldNames: string[];
  applicationMode: 'live' | 'shadow';
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeValidateCorrectionProposal(value: unknown): { valid: boolean; errors: string[] } {
  try {
    return validateCorrectionProposal(value);
  } catch (validationError: unknown) {
    return { valid: false, errors: [`Validator threw: ${String(validationError)}`] };
  }
}

/**
 * Runtime narrowing for an untrusted proposal (rc-1/rc-2): the canonical
 * validator decides, and the predicate only reflects its verdict.
 */
function isValidCorrectionProposal(value: unknown): value is CorrectionProposal {
  return safeValidateCorrectionProposal(value).valid;
}

function readCorrectionFacts(proposal: unknown): CorrectionFacts {
  const record = isRecordLike(proposal) ? proposal : {};
  const correctedFields = Array.isArray(record['correctedFields']) ? record['correctedFields'] : [];
  const rawRuleId = record['ruleId'];
  const rawPrincipleId = record['principleId'];
  const rawConfidence = record['confidence'];
  return {
    ruleId: rawRuleId !== undefined && rawRuleId !== null ? String(rawRuleId) : 'unknown',
    principleId: rawPrincipleId !== undefined && rawPrincipleId !== null ? String(rawPrincipleId) : undefined,
    confidence: typeof rawConfidence === 'number' ? rawConfidence : 0,
    correctedFieldNames: correctedFields.map((f) => isRecordLike(f) ? String(f['field']) : String(f)),
    applicationMode: record['applicationMode'] === 'live' ? 'live' : 'shadow',
  };
}

function recordRequireApprovalDecision(
  wctx: WorkspaceContext,
  event: PluginHookBeforeToolCallEvent,
  filePath: string,
  decision: { ruleId?: string; principleId?: string; reason?: string },
  logger: Partial<PluginLogger>,
): void {
  try {
    const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
    eventLog.recordRuleEnforced({
      ruleId: decision.ruleId || 'unknown',
      principleId: decision.principleId || 'unknown',
      enforcement: 'requireApproval',
      toolName: event.toolName,
      filePath,
    });
    eventLog.recordRuleHostRequireApproval({
      toolName: event.toolName,
      filePath,
      // The shared gate always carries ruleReason for a requireApproval
      // verdict; the fallback only guards against malformed metadata and
      // keeps the event schema honest instead of writing an empty reason.
      reason: decision.reason ?? 'requireApproval without reason',
      ruleId: decision.ruleId,
    });
  } catch (evErr) {
    logger?.warn?.(`[PD_GATE] Failed to record rule_enforced/rulehost_requireApproval: ${String(evErr)}`);
  }
}

function recordAutoCorrectProposed(
  wctx: WorkspaceContext,
  event: PluginHookBeforeToolCallEvent,
  filePath: string,
  proposal: unknown,
  reason: string | undefined,
  validationValid: boolean,
  logger: Partial<PluginLogger>,
  overrides?: { reason?: string; applicationMode?: 'live' | 'shadow'; failureLabel?: string },
): void {
  try {
    const facts = readCorrectionFacts(proposal);
    const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
    eventLog.recordRuleHostAutoCorrectProposed({
      toolName: event.toolName,
      filePath,
      ruleId: facts.ruleId,
      principleId: facts.principleId,
      confidence: facts.confidence,
      // Same contract as requireApproval: ruleReason is always present on the
      // shared path; the fallback keeps the event schema honest on malformed
      // metadata.
      reason: overrides?.reason ?? reason ?? 'auto_correct without reason',
      applicationMode: overrides?.applicationMode ?? facts.applicationMode,
      correctedFields: facts.correctedFieldNames,
      validationValid,
    });
  } catch (evErr) {
    logger?.warn?.(`[PD_GATE] ${overrides?.failureLabel ?? 'Failed to record rulehost_auto_correct_proposed'}: ${String(evErr)}`);
  }
}

function applyAutoCorrectionDecision(args: {
  wctx: WorkspaceContext;
  event: PluginHookBeforeToolCallEvent;
  sessionId?: string;
  workspaceDir?: string;
  filePath: string;
  activationId?: string;
  reason?: string;
  proposal: CorrectionProposal;
  logger: Partial<PluginLogger>;
}): PluginHookBeforeToolCallResult | void {
  const { wctx, event, sessionId, workspaceDir, filePath, activationId, reason, proposal, logger } = args;
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

    const trustedWorkspaceDir = workspaceDir;
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
        filePath,
        ruleId: String(proposal.ruleId ?? 'unknown'),
        principleId: proposal.principleId != null ? String(proposal.principleId) : undefined,
        confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0,
        reason: reason || proposal.correctedFields?.[0]?.reason || 'auto-correct applied',
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
        trackReceiptAutoCorrect(sessionId, wctx.workspaceDir);
        if (loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_ledger').enabled) {
          const ledgerPrincipleId = proposal.principleId != null
            ? String(proposal.principleId)
            : String(proposal.ruleId ?? 'unknown');
          const written = recordPrincipleApplication(wctx.workspaceDir, {
            principleId: ledgerPrincipleId,
            // PRI-899: same activation lineage as the block path.
            activationId,
            ruleId: String(proposal.ruleId ?? 'unknown'),
            channel: 'code_tool_hook',
            level: 'effect',
            kind: 'auto_correct_applied',
            sessionId,
            toolName: event.toolName,
            filePath,
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
      // PD v2 Phase 1: normalized enforcement evidence for the applied
      // correction (delivery/application/episode/effect batch).
      // Call-site guarded: a throw here would otherwise land in the
      // applyError branch below and REVERT the already-applied correction.
      try {
        recordGateEnforcementEvidence({
          workspaceDir: wctx.workspaceDir,
          sessionId,
          ...evidenceToolIds(event),
          toolName: event.toolName,
          filePath,
          activationId,
          principleId: proposal.principleId != null ? String(proposal.principleId) : undefined,
          ruleId: String(proposal.ruleId ?? 'unknown'),
          reason,
          decision: 'auto_correct',
          logger,
        });
      } catch (evidenceErr) {
        logger?.warn?.(`[PD_GATE] Evidence recording threw (correction unaffected): ${String(evidenceErr)}`);
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
      recordAutoCorrectProposed(
        wctx,
        event,
        filePath,
        proposal,
        reason,
        false,
        logger,
        { reason: `Path boundary rejected: ${errorMsg}`, applicationMode: 'shadow', failureLabel: 'Failed to record path rejection telemetry' },
      );
    } else {
      logger?.warn?.(`[PD_GATE] Failed to apply auto-correction, using original params: ${errorMsg}`);
    }
  }
}

/**
 * @deprecated No production wiring. The shared host runtime
 * (`createProductionRuleHostGate` via `dispatchBeforeToolCall`) is the single
 * RuleHost entry. PRI-1208 Stage 4 deletes this function together with the
 * plugin-local `RuleHost` class after the frozen semantic corpus proves
 * equivalence.
 */
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
  // PRI-634-F + B3: canonicalKind resolves through the workspace's durable
  // host declarations (the SAME source replay/evidence/Console read), with
  // the compiled-in OpenClaw declaration as the fallback. It is the SOLE
  // hint authority inside the builder. The Sets above stay a coarse "enter
  // the gate" filter only (B2).
  // Task 2: the same resolved registry also decides the write family for the
  // risk estimate, so a declared tool family cannot drift from evaluation.
  const toolSemantics = resolveOpenClawHookToolSemantics(wctx.workspaceDir, logger);
  const action = buildRuleHostAction(event.toolName, event.params ?? {}, wctx.workspaceDir, {
    canonicalKind: toolSemantics.resolve(event.toolName),
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
      },
      evolution: {
        epTier: _getEpTier(),
      },
      derived: {
        estimatedLineChanges: estimateLineChanges({ toolName: event.toolName, params: event.params ?? {} }, toolSemantics),
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
          // SPEC-RULECODE-HOST-PROMOTION-001 B3: per-host shadow attribution.
          hostKind: 'openclaw',
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
        hostKind: 'openclaw',
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
              // PRI-899: effect receipts must carry the activation that produced
              // the enforcement, otherwise behavior evidence cannot be JOINed
              // back to its activation (the presence path already does this).
              activationId: report.liveDecisionActivationId,
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

      // PD v2 Phase 1: normalized enforcement evidence (delivery runtime_loaded
      // + runtime_verified application + episode + effect, one atomic batch).
      // Best-effort; never affects the block being returned — the recorder is
      // ingress-guarded (never throws) but the call-site try/catch keeps the
      // gate decision independent of ANY evidence-path surprise (a throw here
      // would otherwise skip recordGateBlockAndReturn and flip block→allow).
      try {
        recordGateEnforcementEvidence({
          workspaceDir: wctx.workspaceDir,
          sessionId: ctx.sessionId,
          ...evidenceToolIds(event),
          toolName: event.toolName,
          filePath: relPath,
          activationId: report.liveDecisionActivationId,
          principleId: hostResult.principleId,
          ruleId: hostResult.ruleId,
          reason: hostResult.reason,
          decision: 'block',
          logger,
        });
      } catch (evidenceErr) {
        logger?.warn?.(`[PD_GATE] Evidence recording threw (block decision unaffected): ${String(evidenceErr)}`);
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
      recordRequireApprovalDecision(wctx, event, relPath, {
        ruleId: hostResult.ruleId,
        principleId: hostResult.principleId,
        reason: hostResult.reason,
      }, logger);
    }

    if (hostResult?.decision === 'auto_correct' && hostResult.correctionProposal) {
      const proposal = hostResult.correctionProposal;
      const validation = safeValidateCorrectionProposal(proposal);
      recordAutoCorrectProposed(wctx, event, relPath, proposal, hostResult.reason, validation.valid, logger);
      if (proposal.applicationMode === 'live' && validation.valid) {
        return applyAutoCorrectionDecision({
          wctx,
          event,
          sessionId: ctx.sessionId,
          workspaceDir: ctx.workspaceDir,
          filePath: relPath,
          activationId: report.liveDecisionActivationId,
          reason: hostResult.reason,
          proposal,
          logger,
        });
      }
    } else if (hostResult?.decision === 'auto_correct') {
      // auto_correct without correctionProposal — emit telemetry for observability
      recordAutoCorrectProposed(
        wctx,
        event,
        relPath,
        { ruleId: hostResult.ruleId ?? 'unknown' },
        hostResult.reason ?? 'auto_correct without correctionProposal',
        false,
        logger,
        { failureLabel: 'Failed to record rulehost_auto_correct_proposed (no proposal)' },
      );
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

/**
 * PD v2 Phase 1: narrow the host-supplied tool-call identity fields (rc-1).
 * `toolUseId` is the preferred event identifier, `toolCallId` the fallback
 * (same precedence as the pain pipeline). Used for evidence native refs.
 */
function evidenceToolIds(event: PluginHookBeforeToolCallEvent): { toolCallId?: string; runId?: string } {
  const pick = (key: string): string | undefined => {
    if (!Object.hasOwn(event, key)) return undefined;
    const value = event[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  };
  const toolCallId = pick('toolUseId') ?? pick('toolCallId');
  const runId = pick('runId');
  return {
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}

// epTier source retired with the legacy evolution engine (PRI-731/734): the
// engine scorecard never persisted in any deployment, so the observed value was
// always the initial tier. The RuleHost input contract field stays because
// generated rule code reads it via getEpTier().
function _getEpTier(): number {
  // EvolutionTier.Seed literalized (PRI-770): the points/tier enum was deleted
  // with the retired Evolution Points subsystem; Seed === 1.
  return 1;
}

function _getBashRisk(event: PluginHookBeforeToolCallEvent): 'safe' | 'normal' | 'dangerous' | 'unknown' {
  if (!BASH_TOOLS_SET.has(event.toolName)) return 'unknown';
  // PRI-1047 Owner review R6 #1: delegate to the shared classifier so replay,
  // the host-runtime gate and this enrichment agree on ONE judgment (and the
  // git-mutation gap — `git commit` previously classified 'safe' — is fixed
  // everywhere at once).
  return classifyBashRisk(true, event.params);
}

export function buildOpenClawRuleInputEnrichment(event: PluginHookBeforeToolCallEvent) {
  return {
    epTier: _getEpTier(),
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

/**
 * PRI-1208 Stage 3: restore the persistent evidence the legacy `RuleHost` wrote.
 *
 * The shared gate returns structured `evaluationFaults` instead of writing host
 * state itself. This OpenClaw adapter maps them onto the existing EventLog
 * schema (`rulehost_unhealthy` / `rulehost_skipped`) so `pd runtime health`,
 * the Console activations model and the shadow summary keep their evidence
 * after the legacy path is deleted.
 *
 * The gate recompiles active rule code on every call, so a persistent defect
 * would otherwise write one row per tool call. The process-local key set keeps
 * this at one row per (workspace, activation, reason) per process — derived,
 * bounded, never a source of truth. An EventLog write failure is not cached,
 * so the next call retries.
 */
interface RuleHostEvaluationFaultFact {
  kind: 'unhealthy' | 'skipped';
  activationId: string;
  artifactId: string;
  ruleId: string;
  mode?: 'live' | 'shadow';
  reason: string;
  nextAction: string;
}

const recordedRuleHostFaultKeys = new Set<string>();
const MAX_RECORDED_RULEHOST_FAULT_KEYS = 1000;

function isRuleHostEvaluationFaultFact(value: unknown): value is RuleHostEvaluationFaultFact {
  if (!isRecordLike(value)) return false;
  const mode = value['mode'];
  return (value['kind'] === 'unhealthy' || value['kind'] === 'skipped')
    && typeof value['activationId'] === 'string' && value['activationId'].length > 0
    && typeof value['artifactId'] === 'string' && value['artifactId'].length > 0
    && typeof value['ruleId'] === 'string' && value['ruleId'].length > 0
    && typeof value['reason'] === 'string' && value['reason'].length > 0
    && typeof value['nextAction'] === 'string' && value['nextAction'].length > 0
    && (mode === undefined || mode === 'live' || mode === 'shadow');
}

function recordRuleHostEvaluationFaults(
  stateDir: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  logger: Partial<PluginLogger>,
): void {
  const raw = metadata?.['evaluationFaults'];
  if (!Array.isArray(raw)) return;
  let eventLog: EventLog | undefined;
  for (const entry of raw) {
    if (!isRuleHostEvaluationFaultFact(entry)) {
      logger.warn?.('[PD_GATE:RULE_HOST] shared gate produced an invalid evaluation fault; the event was not persisted (rc-9)');
      continue;
    }
    const key = `${stateDir}|${entry.kind}|${entry.activationId}|${entry.reason}`;
    if (recordedRuleHostFaultKeys.has(key)) continue;
    try {
      eventLog ??= EventLogService.get(stateDir, logger as PluginLogger | undefined);
      if (entry.kind === 'unhealthy') {
        eventLog.recordRuleHostUnhealthy({
          activationId: entry.activationId,
          artifactId: entry.artifactId,
          ruleId: entry.ruleId,
          reason: entry.reason,
          nextAction: entry.nextAction,
        });
      } else {
        eventLog.recordRuleHostSkipped({
          activationId: entry.activationId,
          artifactId: entry.artifactId,
          ruleId: entry.ruleId,
          ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
          reason: entry.reason,
          nextAction: entry.nextAction,
        });
      }
      if (recordedRuleHostFaultKeys.size >= MAX_RECORDED_RULEHOST_FAULT_KEYS) recordedRuleHostFaultKeys.clear();
      recordedRuleHostFaultKeys.add(key);
    } catch (error: unknown) {
      logger.warn?.(`[PD_GATE:RULE_HOST] Failed to record ${entry.kind} fault for ${entry.activationId}: ${String(error)}`);
    }
  }
}

export function handleSharedRuleHostResult(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir: string; logger?: Partial<PluginLogger> },
  result: HostEventResult,
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger ?? console;
  for (const warning of result.warnings ?? []) logger.warn?.(`[PD_GATE:RULE_HOST] ${warning}`);
  const evaluatedLiveRules = result.metadata?.['evaluatedLiveRules'];
  logger.info?.(`[PD_GATE:RULE_HOST] shared production gate evaluated; liveRules=${typeof evaluatedLiveRules === 'number' ? evaluatedLiveRules : 'unknown'} decision=${result.decision}`);
  const metadata = result.metadata;
  const ruleDecision = metadata?.['ruleDecision'];
  // Task 1: auto_correct / requireApproval are now recorded and applied HERE.
  // The shared gate carries the winning rule identity, matched flag, reason and
  // (already merged) correction proposal, so this handler no longer delegates
  // to the legacy hook (which re-evaluated the same activations from SQLite).
  const wctx = WorkspaceContext.fromHookContext(ctx);
  recordRuleHostEvaluationFaults(wctx.stateDir, result.metadata, logger);
  const action = buildRuleHostAction(event.toolName, event.params ?? {}, wctx.workspaceDir, {
    canonicalKind: resolveOpenClawHookToolSemantics(wctx.workspaceDir, logger).resolve(event.toolName),
  });
  const ruleId = typeof metadata?.['ruleId'] === 'string' ? metadata['ruleId'] : undefined;
  const principleId = typeof metadata?.['principleId'] === 'string' ? metadata['principleId'] : undefined;
  // PRI-899: shared-path activation lineage — resolve once, use for every deny
  // accounting branch below (resolvable and unresolved target path).
  const liveActivationId = extractLiveActivationId(metadata);
  const denyReason = result.reason ?? 'RuleHost denied the tool call';
  if (action.normalizedPath === null) {
    if (result.decision === 'deny') {
      // PRI-569 round 3: a deny is ALWAYS accounted — trajectory.db accepts
      // a null file_path, so record with null instead of dropping the count.
      return accountSharedDeny(wctx, {
        sessionId: ctx.sessionId,
        toolName: event.toolName,
        filePath: null,
        reason: denyReason,
        ruleId,
        principleId,
        activationId: liveActivationId,
        ...evidenceToolIds(event),
      }, logger);
    }
    return;
  }
  try {
    const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
    const evaluations = metadata?.['evaluations'];
    if (Array.isArray(evaluations)) {
      // PRI-813: per-activation evaluation facts from the shared gate — one
      // canonical rulehost_evaluated row per shadow activation (exact
      // activationId) plus the live aggregate row, which now also carries its
      // winning activationId (the same audit gap ISSUE-023 closed for legacy).
      // The entry shape is validated against the canonical core schema.
      let wroteEvaluationRow = false;
      for (const evaluation of evaluations) {
        if (!isSharedRuleEvaluationEntry(evaluation)) {
          logger.warn?.(`[PD_GATE:RULE_HOST] shared gate produced an invalid evaluation entry; the row was not persisted (rc-9)`);
          continue;
        }
        eventLog.recordRuleHostEvaluated({
          toolName: evaluation.toolName,
          filePath: evaluation.filePath,
          matched: evaluation.matched,
          decision: evaluation.decision,
          ...(evaluation.ruleId !== undefined ? { ruleId: evaluation.ruleId } : {}),
          ...(evaluation.activationId !== undefined ? { activationId: evaluation.activationId } : {}),
          ...(evaluation.activationMode !== undefined ? { activationMode: evaluation.activationMode } : {}),
          // SPEC B3: preserve the shared gate's host attribution; this plugin
          // IS the OpenClaw boundary, so an unattributed row defaults here.
          ...(evaluation.hostKind !== undefined ? { hostKind: evaluation.hostKind } : { hostKind: 'openclaw' }),
        });
        wroteEvaluationRow = true;
      }
      if (!wroteEvaluationRow) {
        // rc-9 (review S2): a present-but-unusable evaluations array is a
        // gate contract violation. Persist NOTHING — a fabricated aggregate
        // row would mask the failure as ordinary evidence; the warns above
        // plus this one are the observable record. The legacy single-row
        // fallback below stays only for gate results that carry no
        // evaluations array at all (rolling-upgrade compat).
        logger.warn?.(`[PD_GATE:RULE_HOST] shared gate evaluations array carried no valid entry; no rulehost_evaluated row persisted (rc-9)`);
      }
    } else {
      eventLog.recordRuleHostEvaluated({
        toolName: event.toolName, filePath: action.normalizedPath,
        matched: result.decision === 'deny', decision: result.decision === 'deny' ? 'block' : 'allow',
        ruleId, activationMode: 'live', hostKind: 'openclaw',
      });
    }
    if (result.decision === 'deny') {
      eventLog.recordRuleEnforced({ ruleId: ruleId ?? 'unknown', principleId: principleId ?? 'unknown', enforcement: 'block', toolName: event.toolName, filePath: action.normalizedPath });
      eventLog.recordRuleHostBlocked({ toolName: event.toolName, filePath: action.normalizedPath, reason: denyReason, ruleId });
    }
  } catch (error: unknown) {
    logger.warn?.(`[PD_GATE] Failed to record shared RuleHost result: ${String(error)}`);
  }
  if (result.decision === 'deny') {
    return accountSharedDeny(wctx, {
      sessionId: ctx.sessionId,
      toolName: event.toolName,
      filePath: action.normalizedPath,
      reason: denyReason,
      ruleId,
      principleId,
      activationId: liveActivationId,
      ...evidenceToolIds(event),
    }, logger);
  }

  if (ruleDecision === 'auto_correct' || ruleDecision === 'requireApproval') {
    // The legacy fallback performed this safety observation before acting on
    // the decision; preserve it verbatim so a self-blocking / protected-command
    // matching RuleCode is still isolated on these two paths.
    const circuitTripped = observeRuleCodeSafety({
      workspaceDir: wctx.workspaceDir,
      activationId: liveActivationId,
      toolName: event.toolName,
      params: event.params ?? {},
      decision: ruleDecision,
      matched: metadata?.['matched'] === true,
      logger,
    });
    if (circuitTripped) {
      logger.warn?.(`[PD_GATE] RuleCode ${liveActivationId ?? 'unknown'} safety-isolated; allowing current host call.`);
      return;
    }

    const ruleReason = typeof metadata?.['ruleReason'] === 'string' ? metadata['ruleReason'] : undefined;

    if (ruleDecision === 'requireApproval') {
      recordRequireApprovalDecision(wctx, event, action.normalizedPath, {
        ruleId,
        principleId,
        reason: ruleReason,
      }, logger);
      return;
    }

    const rawProposal = metadata?.['correctionProposal'];
    const validProposal = isValidCorrectionProposal(rawProposal);
    recordAutoCorrectProposed(wctx, event, action.normalizedPath, rawProposal, ruleReason, validProposal, logger);
    if (validProposal && rawProposal.applicationMode === 'live') {
      return applyAutoCorrectionDecision({
        wctx,
        event,
        sessionId: ctx.sessionId,
        workspaceDir: ctx.workspaceDir,
        filePath: action.normalizedPath,
        activationId: liveActivationId,
        reason: ruleReason,
        proposal: rawProposal,
        logger,
      });
    }
  }
}

/**
 * Authoritative accounting for ONE shared-path deny decision (PRI-569).
 *
 * Both shared-handler deny branches (resolvable and unresolved target path)
 * funnel here: receipt-ledger effect row (flag-gated, failure-degrading —
 * parity with the legacy hook path) plus persistGateBlock (session block
 * tally, EventLog gate_block, trajectory gate_blocks with bounded retry). A null
 * filePath is accounted with a null trajectory file_path; the EventLog copy
 * carries an '<unresolved>' placeholder. Never throws into the caller;
 * every skip/failure warns with a reasonCode (rc-9).
 *
 * Returns the block result so the host adapter can surface the SAME
 * owner-facing copy the legacy hook path returned (PRI-1184 / F4). Before
 * this, the shared path only persisted the deny, so
 * `principle_receipt_block_copy` had no producer on the production path.
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
    /**
     * PRI-899: the live activation whose decision produced this deny, when the
     * shared gate metadata attributed one. Optional — an unattributable deny
     * still writes its receipt, unlinked, exactly as before (rc-9: the skip is
     * never silent, the reason code is logged by the caller).
     */
    activationId?: string;
    /** PD v2 Phase 1: host tool-call identity for evidence native refs. */
    toolCallId?: string;
    runId?: string;
  },
  logger: { warn?: (_message: string) => void; error?: (_message: string) => void },
): PluginHookBeforeToolCallResult {
  if (accounting.filePath === null) {
    logger.warn?.('[PD_GATE] Shared-path deny accounted with unresolved target path (reasonCode=shared_deny_path_unresolved)');
  }
  try {
    if (loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_ledger').enabled) {
      const ledgerPrincipleId = accounting.principleId ?? accounting.ruleId;
      if (ledgerPrincipleId) {
        const written = recordPrincipleApplication(wctx.workspaceDir, {
          principleId: ledgerPrincipleId,
          // PRI-899: activation lineage for the shared deny path.
          activationId: accounting.activationId,
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
  // PD v2 Phase 1: normalized enforcement evidence for the shared-path deny.
  // Call-site guarded: a throw here would otherwise skip persistGateBlock
  // below and lose the block accounting.
  try {
    recordGateEnforcementEvidence({
      workspaceDir: wctx.workspaceDir,
      sessionId: accounting.sessionId,
      ...(accounting.toolCallId !== undefined ? { toolCallId: accounting.toolCallId } : {}),
      ...(accounting.runId !== undefined ? { runId: accounting.runId } : {}),
      toolName: accounting.toolName,
      filePath: accounting.filePath ?? undefined,
      activationId: accounting.activationId,
      principleId: accounting.principleId,
      ruleId: accounting.ruleId,
      reason: accounting.reason,
      decision: 'block',
      logger,
    });
  } catch (evidenceErr) {
    logger.warn?.(`[PD_GATE] Evidence recording threw (shared deny accounting continues): ${String(evidenceErr)}`);
  }
  persistGateBlock(wctx, {
    filePath: accounting.filePath,
    reason: accounting.reason,
    toolName: accounting.toolName,
    sessionId: accounting.sessionId,
    blockSource: SHARED_RULE_HOST_BLOCK_SOURCE,
    ruleId: accounting.ruleId,
    principleId: accounting.principleId,
  }, logger);
  return {
    block: true,
    blockReason: buildGateBlockReason(wctx, {
      filePath: accounting.filePath,
      reason: accounting.reason,
      toolName: accounting.toolName,
      blockSource: SHARED_RULE_HOST_BLOCK_SOURCE,
      ruleId: accounting.ruleId,
      principleId: accounting.principleId,
    }, logger),
  };
}
