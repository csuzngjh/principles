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
import { evaluatePainDiagnosticGate, isCooldownActiveForEpisode } from '../core/pain-diagnostic-gate.js';
import { sanitizeForEvidence, sanitizeToolParamsForEvidence } from './message-sanitize.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { resolveSourceKindFromToolFailure, evaluateEvidenceTriage } from './triage-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { buildTrajectoryEvidence } from './trajectory-evidence.js';
import type { ToolCallOutcome, ToolCallObservation, PainAdmissionDecision } from './after-tool-call-types.js';

// ── Stage 1: Classify ───────────────────────────────────────────────────────

/**
 * Classify the outcome of a tool call event.
 *
 * Pure function — no I/O, no side effects.
 * Extracts exitCode logic, determines failure/success, classifies failure source.
 */
export function classifyToolCallOutcome(event: PluginHookAfterToolCallEvent): ToolCallOutcome {
  const resultObj = (event.result && typeof event.result === 'object') ? event.result as Record<string, unknown> : null;
  const details = resultObj?.details && typeof resultObj.details === 'object' ? resultObj.details as Record<string, unknown> : null;
  const topExitCode = resultObj?.exitCode;
  const detailExitCode = details?.exitCode;

  // Prefer the first *numeric* exit code
  const exitCode = typeof topExitCode === 'number' ? topExitCode
    : typeof detailExitCode === 'number' ? detailExitCode
    : 0;
  const isFailure = !!event.error || exitCode !== 0;

  return {
    isFailure,
    exitCode,
    failureSource: isFailure ? classifyToolFailureSource(event.toolName, event.error) : undefined,
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

  wctx.trajectory?.recordToolCall?.({
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

  wctx.trajectory?.recordToolCall?.({
    sessionId,
    toolName: event.toolName,
    outcome: 'success',
    durationMs: event.durationMs,
    exitCode: outcome.exitCode,
    gfiBefore,
    gfiAfter: resetState.currentGfi,
    paramsJson: sanitizeToolParamsForEvidence(event.params, workspaceDir),
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
 * Combines:
 * 1. Write-tool check — only write tools on failures enter this path
 * 2. PEAT-B1 triage — if feature flag is on, check evidence triage
 * 3. PainDiagnosticGate — cooldown + threshold check
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
  config: { get: (key: string) => unknown },
): PainAdmissionDecision {
  // Only write-tool failures enter the pain path
  if (!WRITE_TOOLS.includes(event.toolName) || !outcome.isFailure) {
    return {
      admitted: false,
      stage: 'not_applicable',
      reason: 'not_a_write_tool_failure',
      detail: `tool=${event.toolName}, isFailure=${outcome.isFailure}`,
    };
  }

  const failureSource = outcome.failureSource ?? 'tool_failure';

  // PEAT-B1: Evidence triage (feature-flagged)
  // PEAT-B2: Trigger controller adds structured outcome + cooldown awareness
  const painTriageFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmission');
  if (painTriageFlag.enabled) {
    const sourceKind = resolveSourceKindFromToolFailure(event.toolName, failureSource);
    const triage = evaluateEvidenceTriage(sourceKind, observation.painScore);

    // PEAT-B2: Evaluate trigger controller for structured decision
    // Compute real cooldown state from PainDiagnosticGate's episode map
    // so trigger decision aligns with the gate's cooldown logic (EP-07).
    const cooldownActive = isCooldownActiveForEpisode(
      failureSource,
      sessionId,
      latestFailureState?.lastErrorHash,
    );
    const triggerDecision = evaluateTriggerController({
      triageResult: triage,
      isOwnerManual: false, // tool failures are never owner manual
      isCooldownActive: cooldownActive,
      isValid: true,
      score: observation.painScore,
      sessionId,
    });

    if (!triggerDecision.shouldCreateDiagnosticTask) {
      SystemLogger.log(workspaceDir, 'TRIGGER_DECISION', JSON.stringify({
        outcome: triggerDecision.outcome,
        sourceKind: triggerDecision.sourceKind,
        reason: triggerDecision.reason,
        nextAction: triggerDecision.nextAction,
        triageDecision: triggerDecision.triageDecision,
        tool: event.toolName,
        path: observation.relPath,
      }));
      return {
        admitted: false,
        stage: 'triage_evidence_only',
        reason: triggerDecision.reason,
        detail: `outcome=${triggerDecision.outcome}, sourceKind=${triggerDecision.sourceKind}, nextAction=${triggerDecision.nextAction}`,
      };
    }
  }

  // PainDiagnosticGate evaluation
  const diagnosticGate = evaluatePainDiagnosticGate({
    source: failureSource,
    score: observation.painScore,
    currentGfi: (latestFailureState ?? sessionState)?.currentGfi ?? 0,
    consecutiveErrors: (latestFailureState ?? sessionState)?.consecutiveErrors ?? 0,
    isRisky: observation.isRisk,
    errorHash: latestFailureState?.lastErrorHash,
    sessionId,
    thresholds: {
      painTrigger: (config.get('thresholds.pain_trigger') as number) || 40,
      highSeverity: (config.get('severity_thresholds.high') as number) || 70,
      repeatedFailure: (config.get('thresholds.stuck_loops_trigger') as number) || 4,
    },
  });

  if (!diagnosticGate.shouldDiagnose) {
    SystemLogger.log(workspaceDir, 'PAIN_DIAGNOSE_SKIPPED', `Tool failure recorded as friction only: ${diagnosticGate.detail}; tool=${event.toolName}; path=${observation.relPath}`);
    let rejectPayload: string;
    try {
      rejectPayload = JSON.stringify({
        reason: diagnosticGate.reason,
        detail: diagnosticGate.detail,
        source: failureSource,
        sessionId,
        gfi: (latestFailureState ?? sessionState)?.currentGfi ?? 0,
        score: observation.painScore,
      });
    } catch (e) {
      SystemLogger.log(workspaceDir, 'PAYLOAD_SERIALIZE_FAILED', String(e));
      rejectPayload = JSON.stringify({ reason: diagnosticGate.reason, detail: '(log serialization failed)' });
    }
    SystemLogger.log(workspaceDir, 'PAIN_GATE_REJECTED', rejectPayload);

    return {
      admitted: false,
      stage: 'gate_rejected',
      reason: diagnosticGate.reason,
      detail: diagnosticGate.detail,
      gateResult: { shouldDiagnose: false, reason: diagnosticGate.reason, detail: diagnosticGate.detail },
    };
  }

  return {
    admitted: true,
    stage: 'gate_admitted',
    reason: diagnosticGate.reason,
    detail: diagnosticGate.detail,
    gateResult: { shouldDiagnose: true, reason: diagnosticGate.reason, detail: diagnosticGate.detail },
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
  emitPainDetectedEvent: (wctx: WorkspaceContext, event: import('../core/evolution-types.js').EvolutionLoopEvent) => Promise<void>,
): void {
  if (!admission.admitted) return;

  const failureSource = outcome.failureSource ?? 'tool_failure';

  // Record to trajectory before Runtime V2 diagnosis
  wctx.trajectory?.recordPainEvent({
    sessionId,
    source: failureSource,
    score: observation.painScore,
    reason: `Tool ${event.toolName} failed on ${observation.relPath}`,
    severity: observation.painScore >= 70 ? 'severe' : observation.painScore >= 40 ? 'moderate' : 'mild',
    origin: 'system_infer',
    text: sanitizeForEvidence(observation.params.text ?? observation.params.content, workspaceDir) || undefined,
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
  const painId = `pain_${Date.now()}_${observation.errorHash.slice(0, 8)}`;

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
      provenance: 'automatic_hook',
      evidence: buildTrajectoryEvidence(wctx, sessionId),
    },
  });
}

// ── Shared Helpers ──────────────────────────────────────────────────────────

export { buildTrajectoryEvidence } from './trajectory-evidence.js';

// ── Source Classification ────────────────────────────────────────────────────

/**
 * Classify tool failure source.
 *
 * Pure function — no I/O, no side effects.
 * Determines whether a tool failure is a dispatch error (tool not found)
 * or a regular tool execution failure.
 */
export function classifyToolFailureSource(toolName: string | undefined, error: unknown): 'dispatch_error' | 'tool_failure' {
  if (!toolName || toolName.trim() === '') return 'dispatch_error';
  const msg = String(error ?? '');
  if (/\btool\s+(?:\S+\s+)?not\s+found\b/i.test(msg)) return 'dispatch_error';
  if (/\bunknown\s+tool\b/i.test(msg)) return 'dispatch_error';
  return 'tool_failure';
}

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
