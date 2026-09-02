/**
 * After-Tool-Call Decomposition Helpers — PRI-326
 *
 * Extracted functions from handleAfterToolCall that implement
 * individual pipeline stages. Each function has a focused responsibility.
 *
 * Pipeline order: classify → record → triage → gate → emit
 *
 * ERR checklist:
 * - ERR-001: No `as` casts on untrusted runtime values.
 * - ERR-002: Every skip/rejection includes structured reason + nextAction.
 * - EP-01: Runtime values validated before use.
 * - EP-03: No silent failures — every path is logged or structured.
 */

import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, trackPrincipleValue } from '../core/pain.js';
import { getSession, trackFriction, resetFriction, getInjectedProbationIds, clearInjectedProbationIds, type SessionState } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { getEvolutionLogger, createTraceId } from '../core/evolution-logger.js';
import { recordEvolutionSuccess, recordEvolutionFailure } from '../core/evolution-engine.js';
import type { PluginHookAfterToolCallEvent } from '../openclaw-sdk.js';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed, resetSharedCooldownForTest } from './trigger-cooldown-tracker.js';
import { sanitizeForEvidence, sanitizeToolParamsForEvidence } from './message-sanitize.js';
import { resolveSourceKind, buildToolFailureObservation, type RawObservation } from './raw-observation-adapter.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { buildTrajectoryEvidence } from './trajectory-evidence.js';
import { BASH_TOOL_NAMES } from '../constants/tools.js';
import type { ToolCallOutcome, ToolCallObservation, PainAdmissionDecision } from './after-tool-call-types.js';

const RESULT_PREVIEW_MAX_LENGTH = 500;

/**
 * Extract a preview string from tool call result for diagnostic evidence.
 * Pure function — no I/O, no side effects. ERR-001 / ERR-014 compliant.
 */
export function extractToolResultPreview(result: unknown): string | null {
  if (result === null || result === undefined) return null;

  try {
    // String result: truncate directly
    if (typeof result === 'string') {
      return result.length > RESULT_PREVIEW_MAX_LENGTH
        ? `${result.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
        : result;
    }

    // Object with content array (e.g., Anthropic content blocks)
    if (typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        const textParts: string[] = [];
        for (const block of obj.content) {
          if (block && typeof block === 'object' && !Array.isArray(block)) {
            const blockObj = block as Record<string, unknown>;
            if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
              textParts.push(blockObj.text);
            }
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join('\n');
          return joined.length > RESULT_PREVIEW_MAX_LENGTH
            ? `${joined.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
            : joined;
        }
      }

      // Object without content array: JSON.stringify with depth limiter (ERR-014)
      const serialized = JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const keys = Object.keys(value as Record<string, unknown>);
          if (keys.length > 10) {
            const truncated: Record<string, unknown> = {};
            for (const k of keys.slice(0, 10)) {
              truncated[k] = (value as Record<string, unknown>)[k];
            }
            truncated['__truncated__'] = true;
            return truncated;
          }
        }
        return value;
      }, 2);
      if (serialized && serialized !== '{}') {
        return serialized.length > RESULT_PREVIEW_MAX_LENGTH
          ? `${serialized.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
          : serialized;
      }
    }

    return null;
  } catch {
    return '[result_preview_extraction_failed]';
  }
}

// ── Stage 1: Classify ───────────────────────────────────────────────────────

/**
 * Classify the outcome of a tool call event.
 *
 * Pure function — no I/O, no side effects.
 * Extracts exitCode logic, determines failure/success, classifies failure source.
 */
export function classifyToolCallOutcome(event: PluginHookAfterToolCallEvent): ToolCallOutcome {
  // EP-01: Validate event.result at runtime instead of `as` cast
  const resultObj = (event.result && typeof event.result === 'object' && !Array.isArray(event.result))
    ? event.result as Record<string, unknown>  // safe: guarded by typeof + Array.isArray checks above
    : null;
  const details = (resultObj && resultObj.details && typeof resultObj.details === 'object' && !Array.isArray(resultObj.details))
    ? resultObj.details as Record<string, unknown>  // safe: guarded by typeof + Array.isArray checks above
    : null;
  const topExitCode = resultObj?.exitCode;
  const detailExitCode = details?.exitCode;

  // Prefer the first *numeric* exit code
  const exitCode = typeof topExitCode === 'number' ? topExitCode
    : typeof detailExitCode === 'number' ? detailExitCode
    : 0;
  const isFailure = !!event.error || exitCode !== 0;

  // PRI-360 S1: Use centralized builder for tool failure classification
  // All dispatch/tool_failure rules live in raw-observation-adapter.ts
  const obs = buildToolFailureObservation({
    toolName: event.toolName,
    error: event.error,
    exitCode,
  });
  const failureSource = isFailure ? obs.failureSource : undefined;

  return {
    isFailure,
    exitCode,
    failureSource,
  };
}

// ── Stage 2: Build Observation ──────────────────────────────────────────────

/**
 * Interface for tool parameters — avoids `any`.
 */
interface ToolParams {
  file_path?: string;
  path?: string;
  file?: string;
  content?: string;
  new_string?: string;
  text?: string;
  query?: string;
  input?: string;
  arguments?: string;
}

/**
 * Build a normalized observation from the tool call event and workspace context.
 *
 * Combines file path normalization, risk classification, and error analysis.
 * The profile parameter is passed in (loaded once at function scope).
 */
export function buildToolCallObservation(
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  workspaceDir: string,
  profile: ReturnType<typeof normalizeProfile>,
): ToolCallObservation {
  const rawParams = event.params;
  const params: ToolParams = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
    ? rawParams as ToolParams
    : {};
  const filePath = params.file_path || params.path || params.file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, workspaceDir) : 'unknown';
  const isRisk = isRisky(relPath, profile.risk_paths);
  let errorText: string;
  if (event.error) {
    errorText = String(event.error);
  } else if (typeof event.result === 'string') {
    errorText = event.result;
  } else {
    try {
      errorText = JSON.stringify(event.result);
    } catch {
      errorText = `[unserializable result: ${typeof event.result}]`;
    }
  }
  const denoised = denoiseError(errorText);
  const hash = computeHash(denoised);
  const painScore = computePainScore(1, false, false, isRisk ? 20 : 0, workspaceDir);

  return {
    params: {
      filePath,
      content: params.content,
      text: params.text,
      newString: params.new_string,
      query: params.query,
      input: params.input,
      arguments: params.arguments,
    },
    relPath,
    isRisk,
    errorType: extractErrorType(event.error || errorText),
    errorHash: hash,
    errorText,
    painScore,
    traceId: createTraceId(),
  };
}

// ── Stage 3: Friction + Recording ──────────────────────────────────────────

/**
 * Handle friction tracking for a tool failure.
 *
 * Updates GFI, records to event log and trajectory.
 * Returns the updated session state and friction info.
 */
export function handleFrictionTrackingForFailure(
  sessionId: string,
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  observation: ToolCallObservation,
  gfiBefore: number,
  workspaceDir: string,
  config: { get: (key: string) => unknown },
  wctx: WorkspaceContext,
  options: { recordTrajectory?: boolean } = {},
): SessionState {
  const deltaF = (config.get('scores.tool_failure_friction') as number) || 30;
  const updatedState = trackFriction(sessionId, deltaF, observation.errorHash, workspaceDir, { source: outcome.failureSource });

  recordEvolutionFailure(workspaceDir, event.toolName, {
    filePath: observation.relPath,
    reason: observation.isRisk ? 'risky' : 'tool',
    sessionId,
  });

  // Record tool call failure event
  wctx.eventLog.recordToolCall(sessionId, {
    toolName: event.toolName,
    filePath: observation.params.filePath,
    error: event.error ? String(event.error).substring(0, 200) : undefined,
    errorType: observation.errorType,
    gfi: updatedState.currentGfi,
    consecutiveErrors: updatedState.consecutiveErrors,
    exitCode: outcome.exitCode as number | undefined,
    gfiBefore,
    gfiAfter: updatedState.currentGfi,
  });

  if (options.recordTrajectory !== false) wctx.trajectory?.recordToolCall?.({
    sessionId,
    toolName: event.toolName,
    outcome: 'failure',
    durationMs: event.durationMs,
    exitCode: outcome.exitCode as number | undefined,
    errorType: observation.errorType,
    errorMessage: event.error ? String(event.error) : undefined,
    gfiBefore,
    gfiAfter: updatedState.currentGfi,
    paramsJson: sanitizeToolParamsForEvidence(event.params, workspaceDir),
    resultPreview: extractToolResultPreview(event.result),
  });

  return updatedState;
}

/**
 * Handle friction relief and recording for a tool success.
 *
 * Relieves both tool_failure and dispatch_error GFI sources proportionally.
 */
export function handleFrictionTrackingForSuccess(
  sessionId: string,
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  observation: ToolCallObservation,
  gfiBefore: number,
  workspaceDir: string,
  wctx: WorkspaceContext,
  options: { recordTrajectory?: boolean } = {},
): SessionState {
  const session = getSession(sessionId);
  const toolFailureGfi = session?.gfiBySource?.tool_failure || 0;
  const dispatchErrorGfi = session?.gfiBySource?.dispatch_error || 0;

  let resetState: SessionState = session || resetFriction(sessionId, workspaceDir);
  if (toolFailureGfi > 0) {
    resetState = resetFriction(sessionId, workspaceDir, {
      source: 'tool_failure',
      amount: toolFailureGfi * 0.5,
    });
  }
  if (dispatchErrorGfi > 0) {
    resetState = resetFriction(sessionId, workspaceDir, {
      source: 'dispatch_error',
      amount: dispatchErrorGfi * 0.5,
    });
  }

  recordEvolutionSuccess(workspaceDir, event.toolName, {
    sessionId,
    reason: 'tool_success',
  });

  if (options.recordTrajectory !== false) wctx.trajectory?.recordToolCall?.({
    sessionId,
    toolName: event.toolName,
    outcome: 'success',
    durationMs: event.durationMs,
    exitCode: outcome.exitCode,
    gfiBefore,
    gfiAfter: resetState.currentGfi,
    paramsJson: sanitizeToolParamsForEvidence(event.params, workspaceDir),
    resultPreview: extractToolResultPreview(event.result),
  });

  wctx.eventLog.recordToolCall(sessionId, {
    toolName: event.toolName,
    filePath: observation.params.filePath,
    gfi: resetState.currentGfi,
    gfiBefore,
    gfiAfter: resetState.currentGfi,
  });

  return resetState;
}

// ── Stage 4: Hygiene Tracking ───────────────────────────────────────────────

/**
 * Record hygiene tracking for memory/plan persistence actions on success.
 */
export function recordHygieneTracking(
  event: PluginHookAfterToolCallEvent,
  observation: ToolCallObservation,
  wctx: WorkspaceContext,
): void {
  const normalized = typeof observation.params.filePath === 'string' ? observation.params.filePath.replace(/\\/g, '/') : '';
  const isMemory = /(?:^|\/)memory\//.test(normalized) || normalized.endsWith('/MEMORY.md') || normalized === 'MEMORY.md';
  const isPlan = normalized === 'PLAN.md' || normalized.endsWith('/PLAN.md');

  if (isMemory || isPlan) {
    wctx.hygiene.recordPersistence({
      ts: new Date().toISOString(),
      tool: event.toolName,
      path: observation.params.filePath ?? 'unknown',
      type: isMemory ? 'memory' : 'plan',
      contentLength: observation.params.content?.length ?? observation.params.newString?.length ?? 0,
    });
  }

  // Special case for memory_store tool (Success only)
  if (event.toolName === 'memory_store') {
    wctx.hygiene.recordPersistence({
      ts: new Date().toISOString(),
      tool: event.toolName,
      path: 'DATABASE',
      type: 'memory',
      contentLength: observation.params.text?.length ?? 0,
    });
  }
}

// ── Stage 5: Probation Feedback ─────────────────────────────────────────────

function shouldAttributePrincipleToTool(principle: { contextTags: string[]; trigger: string; }, toolName: string): boolean {
  return principle.contextTags.includes(toolName) || principle.trigger.includes(toolName);
}

/**
 * Record probation feedback for injected probation IDs.
 *
 * On success: positive feedback for matching principles.
 * On failure: negative feedback for matching principles.
 */
export function handleProbationFeedback(
  sessionId: string,
  toolName: string,
  workspaceDir: string,
  wctx: WorkspaceContext,
  isSuccess: boolean,
): void {
  const injectedProbationIds = getInjectedProbationIds(sessionId, workspaceDir);
  for (const id of injectedProbationIds) {
    const principle = wctx.evolutionReducer.getPrincipleById(id);
    const shouldAttribute = !!principle && shouldAttributePrincipleToTool(principle, toolName);
    if (shouldAttribute) {
      wctx.evolutionReducer.recordProbationFeedback(id, isSuccess);
    }
  }
  clearInjectedProbationIds(sessionId, workspaceDir);
}

// ── Stage 6: Pain Admission ─────────────────────────────────────────────────

const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'edit_file', 'replace'];

/**
 * Evaluate whether a tool failure should trigger pain diagnosis.
 *
 * PRI-363: Single-gate architecture — only TriggerController decides.
 *
 * Combines:
 * 1. Write-tool check — only write tools on failures enter this path
 * 2. PEAT-B1 triage — evidence triage (always enabled now)
 * 3. PEAT-B2 trigger controller — single source of truth for task creation
 * 4. Cooldown tracking — plugin layer owns this state
 *
 * Returns a structured decision with reason and stage.
 */
export function evaluatePainAdmissionForToolCall(
  event: PluginHookAfterToolCallEvent,
  observation: ToolCallObservation,
  outcome: ToolCallOutcome,
  latestFailureState: SessionState | undefined,
  sessionState: SessionState | undefined,
  sessionId: string,
  workspaceDir: string,
  _config: { get: (key: string) => unknown },
): PainAdmissionDecision {
  // Only write-tool failures enter the pain path.
  // E2E harness sets PD_E2E_MODE=1 so acceptance tests can also emit pain from
  // shell/exec tool failures (trap tasks build via shell commands).
  // Path-substring matching was rejected: a production workspace whose path
  // happens to contain "e2e-workspace" would silently get E2E behavior (rc-9).
  const isE2E = process.env.PD_E2E_MODE === '1';
  const allowedTools = isE2E
    ? [...WRITE_TOOLS, ...BASH_TOOL_NAMES]
    : WRITE_TOOLS;

  if (!allowedTools.includes(event.toolName) || !outcome.isFailure) {
    // PRI-442 A-09: rc-9-no-silent-fallback. Only emit observability when we
    // are DECLINING an actual failure (Case A). Successful tool calls (happy
    // path) must stay silent — they are not degradation. evaluatePainAdmission
    // is called on every after_tool_call event, so logging the success path
    // would spam SYSTEM_*.log on essentially every successful tool call.
    if (outcome.isFailure) {
      SystemLogger.log(workspaceDir, 'PAIN_ADMISSION_SKIPPED', JSON.stringify({
        hook: 'after_tool_call',
        reason: 'not_a_write_tool_failure',
        tool: event.toolName,
        failureSource: outcome.failureSource,
        sessionId,
        nextAction: 'No pain task created; failure is outside write-tool admission scope. Retry or investigate if unexpected.',
      }));
    }
    return {
      admitted: false,
      stage: 'not_applicable',
      reason: 'not_a_write_tool_failure',
      detail: `tool=${event.toolName}, isFailure=${outcome.isFailure}`,
    };
  }

  const failureSource = outcome.failureSource ?? 'tool_failure';

  // Check cooldown before calling trigger controller (PRI-454: shared Map)
  const cooldownActive = isSharedCooldownActive(
    failureSource,
    sessionId,
    latestFailureState?.lastErrorHash,
  );

  // PRI-360 S1: Build RawObservation for unified source mapping
  const rawObs: RawObservation = {
    observedAt: new Date().toISOString(),
    workspaceId: workspaceDir,
    sessionId,
    toolName: event.toolName,
    failureSource: outcome.failureSource,
    // Infer toolNotFound from failureSource for resolveSourceKind compatibility
    toolNotFound: outcome.failureSource === 'dispatch_error',
    // Extract exit code from outcome for triage (nonZeroExit)
    nonZeroExit: outcome.exitCode !== 0,
  };

  // PRI-360 S1: Use unified resolveSourceKind instead of resolveSourceKindFromToolFailure
  const sourceKind = resolveSourceKind(rawObs);

  // E2E harness cannot propagate session state across the OpenClaw CLI adapter
  // boundary (root cause tracked in PRI-501). Until that is fixed, E2E runs
  // force the Rule 3 (consecutiveErrors >= 4 → admit) upgrade so the trap
  // task's first failure is admitted. Production never sets PD_E2E_MODE.
  const realConsecutiveErrors = (latestFailureState ?? sessionState)?.consecutiveErrors;
  const consecutiveErrors = isE2E
    ? Math.max(4, realConsecutiveErrors ?? 0)
    : realConsecutiveErrors;

  // PEAT-B1: Evidence triage (with consecutiveErrors and isRisky for upgrade logic)
  const triage = evaluateEvidenceTriage(sourceKind, observation.painScore, {
    consecutiveErrors,
    isRisky: observation.isRisk,
  });

  // PEAT-B2: Trigger controller — single source of truth for task creation
  const triggerDecision = evaluateTriggerController({
    triageResult: triage,
    isOwnerManual: false, // tool failures are never owner manual
    isCooldownActive: cooldownActive,
    isValid: true,
    score: observation.painScore,
    sessionId,
  });

  // Log the decision
  SystemLogger.log(workspaceDir, 'TRIGGER_DECISION', JSON.stringify({
    outcome: triggerDecision.outcome,
    sourceKind: triggerDecision.sourceKind,
    reason: triggerDecision.reason,
    nextAction: triggerDecision.nextAction,
    triageDecision: triggerDecision.triageDecision,
    tool: event.toolName,
    path: observation.relPath,
  }));

  // If trigger controller says yes, mark cooldown and admit (PRI-454: shared Map)
  if (triggerDecision.shouldCreateDiagnosticTask) {
    markSharedEpisodeAsDiagnosed(
      failureSource,
      sessionId,
      latestFailureState?.lastErrorHash,
    );
    return {
      admitted: true,
      stage: 'trigger_admitted',
      reason: triggerDecision.reason,
      detail: `outcome=${triggerDecision.outcome}, sourceKind=${triggerDecision.sourceKind}, nextAction=${triggerDecision.nextAction}`,
    };
  }

  // Otherwise, reject with trigger controller's reason
  return {
    admitted: false,
    stage: 'trigger_rejected',
    reason: triggerDecision.reason,
    detail: `outcome=${triggerDecision.outcome}, sourceKind=${triggerDecision.sourceKind}, nextAction=${triggerDecision.nextAction}`,
  };
}

// ── Stage 7: Emit Pain ─────────────────────────────────────────────────────

/**
 * Emit pain signal after admission.
 *
 * Records to trajectory, event log, evolution logger, principle value tracker,
 * and emits the pain_detected event.
 *
 * Only called when the admission decision is 'admitted'.
 */
export function emitPainIfAdmitted(
  wctx: WorkspaceContext,
  event: PluginHookAfterToolCallEvent,
  observation: ToolCallObservation,
  outcome: ToolCallOutcome,
  admission: PainAdmissionDecision,
  sessionId: string,
  agentId: string | undefined,
  workspaceDir: string,
  emitPainDetectedEvent: (wctx: WorkspaceContext, event: import('../core/evolution-types.js').EvolutionLoopEvent, options?: { recordObservability?: boolean }) => Promise<void>,
): void {
  if (!admission.admitted) return;

  const failureSource = outcome.failureSource ?? 'tool_failure';

  // PRI-453: Generate painId early so it can be passed as canonicalPainId to
  // recordPainEvent, enabling dedup between legacy trajectory write and SDK path.
  const painId = `pain_${Date.now()}_${observation.errorHash.slice(0, 8)}`;

  // Record to trajectory before Runtime V2 diagnosis
  wctx.trajectory?.recordPainEvent({
    sessionId,
    source: failureSource,
    score: observation.painScore,
    reason: `Tool ${event.toolName} failed on ${observation.relPath}`,
    severity: observation.painScore >= 70 ? 'severe' : observation.painScore >= 40 ? 'moderate' : 'mild',
    origin: 'system_infer',
    text: sanitizeForEvidence(observation.params.text ?? observation.params.content, workspaceDir) || undefined,
    canonicalPainId: painId,
    hostKind: 'openclaw',
  });

  // Observe: track which principles would have prevented this pain (observation-only)
  try {
    trackPrincipleValue(
      workspaceDir,
      {
        reason: `Tool ${event.toolName} failed on ${observation.relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
        source: failureSource,
        score: String(observation.painScore),
      },
      () => wctx.evolutionReducer.getActivePrinciples().map((p) => ({
        id: p.id,
        trigger: p.trigger,
        valueMetrics: p.valueMetrics,
      })),
      (id, metrics) => {
        const principle = wctx.evolutionReducer.getPrincipleById(id);
        if (principle) {
          principle.valueMetrics = metrics;
          try {
            wctx.principleTreeLedger.updatePrincipleValueMetrics(id, {
              principleId: id,
              painPreventedCount: metrics.painPreventedCount,
              lastPainPreventedAt: metrics.lastPainPreventedAt,
              calculatedAt: metrics.calculatedAt,
              avgPainSeverityPrevented: 0,
              totalOpportunities: 0,
              adheredCount: 0,
              violatedCount: 0,
              implementationCost: 0,
              benefitScore: 0,
            });
          } catch (e) {
            SystemLogger.log(workspaceDir, 'METRICS_UPDATE_SKIP', String(e));
          }
        }
      },
    );
  } catch (e) {
    SystemLogger.log(workspaceDir, 'PRINCIPLE_TRACK_SKIP', String(e));
  }

  wctx.eventLog.recordPainSignal(sessionId, {
    score: observation.painScore,
    source: failureSource,
    reason: `Tool ${event.toolName} failed on ${observation.relPath}`,
    isRisky: observation.isRisk,
  });

  const evoLogger = getEvolutionLogger(workspaceDir, wctx.trajectory);
  evoLogger.logPainDetected({
    traceId: observation.traceId,
    source: failureSource,
    reason: `Tool ${event.toolName} failed on ${observation.relPath}`,
    score: observation.painScore,
    toolName: event.toolName,
    filePath: observation.relPath,
    sessionId,
  });

  // Create painId inline (matches original createPainId)
  // PRI-453: painId is now generated early (above) to pass as canonicalPainId.

  emitPainDetectedEvent(wctx, {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId,
      painType: failureSource,
      source: event.toolName,
      reason: `Tool ${event.toolName} failed on ${observation.relPath}; diagnosticGate=${admission.reason}`,
      score: observation.painScore,
      sessionId,
      traceId: observation.traceId,
      agentId,
    },
  }, { recordObservability: false });
}

// ── Shared Helpers ──────────────────────────────────────────────────────────

export { buildTrajectoryEvidence } from './trajectory-evidence.js';

/**
 * Reset trigger cooldown state (for tests).
 * PRI-454: Delegates to shared cooldown Map reset.
 */
export function resetTriggerCooldownForTest(): void {
  resetSharedCooldownForTest();
}

// ── Source Classification ────────────────────────────────────────────────────

// classifyToolFailureSource logic is now in resolveSourceKind (PRI-360 S1)
// This function is removed to avoid duplication.

/**
 * Extract error type classification from error value.
 */
function extractErrorType(error: unknown): string {
  if (!error) return 'Unknown';
  const msg = String(error);
  if (msg.includes('EACCES') || msg.includes('permission denied')) return 'EACCES';
  if (msg.includes('ENOENT') || msg.includes('no such file')) return 'ENOENT';
  if (msg.includes('EISDIR')) return 'EISDIR';
  if (msg.includes('ENOSPC')) return 'ENOSPC';
  if (msg.includes('SyntaxError')) return 'SyntaxError';
  if (msg.includes('TypeError')) return 'TypeError';
  if (msg.includes('ReferenceError')) return 'ReferenceError';
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'Timeout';
  if (msg.includes('network') || msg.includes('ECONNREFUSED')) return 'Network';
  return 'Other';
}
