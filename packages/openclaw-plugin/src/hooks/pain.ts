import * as fs from 'fs';
import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { computePainScore, trackPrincipleValue } from '../core/pain.js';
import { getSession, trackFriction, resetFriction, getInjectedProbationIds, clearInjectedProbationIds, type SessionState } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { getEvolutionLogger, createTraceId } from '../core/evolution-logger.js';
import { recordEvolutionSuccess, recordEvolutionFailure } from '../core/evolution-engine.js';
import type { EvolutionLoopEvent } from '../core/evolution-types.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { validateWorkspaceDir } from '../core/workspace-dir-validation.js';
import { resolveWorkspaceDir } from '../core/workspace-dir-service.js';
import { PainToPrincipleService, PrincipleTreeLedgerAdapter, type PainDetectedData } from '@principles/core/runtime-v2';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';

/**
 * Interface for tool parameters to avoid 'any'
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

const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'edit_file', 'replace'];

function createPainToPrincipleService(wctx: WorkspaceContext): PainToPrincipleService {
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: wctx.stateDir });
  return new PainToPrincipleService({
    workspaceDir: wctx.workspaceDir,
    stateDir: wctx.stateDir,
    ledgerAdapter,
    owner: 'openclaw-plugin',
    autoIntakeEnabled: true,
  });
}

function shouldAttributePrincipleToTool(principle: { contextTags: string[]; trigger: string; }, toolName: string): boolean {
  return principle.contextTags.includes(toolName) || principle.trigger.includes(toolName);
}

export async function emitPainDetectedEvent(wctx: WorkspaceContext, event: EvolutionLoopEvent): Promise<void> {
  try {
    wctx.evolutionReducer.emitSync(event);
  } catch (e) {
    SystemLogger.log(wctx.workspaceDir, 'EVOLUTION_EMIT_WARN', `Failed to emit evolution event: ${String(e)}`);
  }
  // M8: Bridge pain_detected → diagnostician pipeline
  if (event.type === 'pain_detected') {
    const painData = event.data as PainDetectedData;
    try {
      const service = createPainToPrincipleService(wctx);
      const result = await service.recordPain({
        painId: painData.painId,
        painType: painData.painType,
        source: painData.source,
        reason: painData.reason,
        score: painData.score,
        sessionId: painData.sessionId,
        agentId: painData.agentId,
        taskId: painData.taskId,
        traceId: painData.traceId,
        recordObservability: true,
      });
      if (result.status === 'failed' && result.failureCategory) {
        SystemLogger.log(wctx.workspaceDir, 'PAIN_SERVICE_FAILED', JSON.stringify({
          painId: result.painId,
          taskId: result.taskId,
          failureCategory: result.failureCategory,
          latencyMs: result.latencyMs,
          message: result.message,
        }));
      } else if (result.status === 'skipped') {
        SystemLogger.log(wctx.workspaceDir, 'PAIN_SERVICE_SKIPPED', JSON.stringify({
          painId: result.painId,
          taskId: result.taskId,
          latencyMs: result.latencyMs,
          message: result.message,
        }));
      }
    } catch (err) {
      SystemLogger.log(wctx.workspaceDir, 'PAIN_SERVICE_ERROR', `recordPain threw: ${String(err)}`);
    }
  }
}

function createPainId(sessionId: string): string {
  return `pain_${Date.now()}_${computeHash(sessionId).slice(0, 8)}`;
}

export function classifyToolFailureSource(toolName: string | undefined, error: unknown): 'dispatch_error' | 'tool_failure' {
  if (!toolName || toolName.trim() === '') return 'dispatch_error';
  const msg = String(error ?? '');
  // Dropped "error:" prefix to catch "failed: unknown tool read_file" style messages.
  // Catches: "tool not found", "tool <name> not found", "unknown tool".
  // Word-boundary anchors prevent "report_tool_not_found" from matching.
  if (/\btool\s+(?:\S+\s+)?not\s+found\b/i.test(msg)) return 'dispatch_error';
  if (/\bunknown\s+tool\b/i.test(msg)) return 'dispatch_error';
  return 'tool_failure';
}

export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> },
  api?: OpenClawPluginApi
): void {
  const effectiveWorkspaceDir = api
    ? resolveWorkspaceDir(api, ctx, { source: 'after_tool_call' })
    : validateWorkspaceDir(ctx.workspaceDir) ? undefined : ctx.workspaceDir;
  if (!effectiveWorkspaceDir) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContextExplicit({ ...ctx, workspaceDir: effectiveWorkspaceDir });
  const {config} = wctx;
  const {eventLog} = wctx;
  const sessionId = ctx.sessionId || 'unknown';
  const sessionState = ctx.sessionId ? getSession(ctx.sessionId) : undefined;
  const gfiBefore = sessionState?.currentGfi ?? 0;
  let latestFailureState: SessionState | undefined;
  const params = event.params as ToolParams;

  // Load profile once (with 1MB size guard) — used by both failure and legacy risky-write paths
  const profilePath = wctx.resolve('PROFILE');
  let profile = normalizeProfile({});
  if (fs.existsSync(profilePath)) {
    try {
      const content = fs.readFileSync(profilePath, 'utf8');
      if (content.length > 1024 * 1024) {
        SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', 'PROFILE.json exceeds 1 MB, skipping');
      } else {
        profile = normalizeProfile(JSON.parse(content));
      }
    } catch (e) {
      SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  // ── Track A: Empirical Friction (GFI) ──

  // 0. Special Case: Manual Pain Intervention
  if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
    const reason = params.input || params.arguments || 'Manual intervention';
    const traceId = createTraceId();
    trackFriction(sessionId, 100, 'manual_pain', effectiveWorkspaceDir, { source: 'manual_pain' });
    SystemLogger.log(effectiveWorkspaceDir, 'MANUAL_PAIN', `User manually triggered pain: ${reason}`);
    eventLog.recordPainSignal(sessionId, {
      score: 100,
      source: 'manual',
      reason: `User intervention: ${reason}`,
      isRisky: true
    });
    wctx.trajectory?.recordPainEvent?.({
      sessionId,
      source: 'manual',
      score: 100,
      reason: `User intervention: ${reason}`,
      origin: 'user_manual',
      text: reason,  // Store the intervention reason as text
    });

    // Log to EvolutionLogger
    const evoLogger = getEvolutionLogger(effectiveWorkspaceDir, wctx.trajectory);
    evoLogger.logPainDetected({
      traceId,
      source: 'manual',
      reason: `User intervention: ${reason}`,
      score: 100,
      toolName: event.toolName,
      sessionId,
    });

    // Apply PainDiagnosticGate with cooldown to prevent duplicate diagnoses
    const session = getSession(sessionId);
    const gate = evaluatePainDiagnosticGate({
      source: 'manual',
      score: 100,
      currentGfi: session?.currentGfi ?? 0,
      sessionId,
    });
    if (!gate.shouldDiagnose) {
      SystemLogger.log(effectiveWorkspaceDir, 'MANUAL_PAIN_SKIPPED', `Manual pain within cooldown: ${gate.detail}`);
      let payload: string;
      try {
        payload = JSON.stringify({
          reason: gate.reason,
          detail: gate.detail,
          source: 'manual',
          sessionId,
          gfi: 0,
          score: 100,
        });
      } catch (e) {
        SystemLogger.log(effectiveWorkspaceDir, 'PAYLOAD_SERIALIZE_FAILED', String(e));
        payload = JSON.stringify({ reason: gate.reason, detail: '(log serialization failed)' });
      }
      SystemLogger.log(effectiveWorkspaceDir, 'PAIN_GATE_REJECTED', payload);
      return;
    }

    emitPainDetectedEvent(wctx, {
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId: createPainId(sessionId),
        painType: 'user_frustration',
        source: event.toolName,
        reason: `User intervention: ${reason}`,
        score: 100,
        sessionId,
        traceId,
        agentId: ctx.agentId,
      },
    });
    return;
  }

  // 1. Determine if this was a failure
  // Support nested details structure where OpenClaw exec tool stores exitCode in result.details.exitCode
  // Prefer the first *numeric* exit code: if result.exitCode is non-numeric, fall back to details.exitCode
  const resultObj = (event.result && typeof event.result === 'object') ? event.result as Record<string, unknown> : null;
  const details = resultObj?.details && typeof resultObj.details === 'object' ? resultObj.details as Record<string, unknown> : null;
  const topExitCode = resultObj?.exitCode;
  const detailExitCode = details?.exitCode;
  const exitCode = typeof topExitCode === 'number' ? topExitCode
    : typeof detailExitCode === 'number' ? detailExitCode
    : 0;
  const isFailure = !!event.error || exitCode !== 0;

  if (isFailure) {
    const failureSource = classifyToolFailureSource(event.toolName, event.error);
    const errorText = String(event.error ?? (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)));
    const denoised = denoiseError(errorText);
    const hash = computeHash(denoised);

    const deltaF = config.get('scores.tool_failure_friction') || 30;
    const updatedState = trackFriction(sessionId, deltaF, hash, effectiveWorkspaceDir, { source: failureSource });
    latestFailureState = updatedState;
    
    // ── Trust Engine: Record failure ──
     
     
    const errorType = extractErrorType(event.error || errorText);
    const filePath = params.file_path || params.path || params.file;
    const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';
    
    // Use profile loaded at function scope (1MB guard already applied)
    const isRisk = isRisky(relPath, profile.risk_paths);
    
    recordEvolutionFailure(effectiveWorkspaceDir, event.toolName, {
        filePath: relPath,
        reason: isRisk ? 'risky' : 'tool',
        sessionId,
    });
    
    // Record tool call failure event
    eventLog.recordToolCall(sessionId, {
      toolName: event.toolName,
      filePath: typeof filePath === 'string' ? filePath : undefined,
      error: event.error ? String(event.error).substring(0, 200) : undefined,
      errorType,
      gfi: updatedState.currentGfi,
      consecutiveErrors: updatedState.consecutiveErrors,
      exitCode: exitCode as number | undefined,
      gfiBefore,
      gfiAfter: updatedState.currentGfi,
    });
    wctx.trajectory?.recordToolCall?.({
      sessionId,
      toolName: event.toolName,
      outcome: 'failure',
      durationMs: event.durationMs,
      exitCode: exitCode as number | undefined,
      errorType,
      errorMessage: event.error ? String(event.error) : undefined,
      gfiBefore,
      gfiAfter: updatedState.currentGfi,
      paramsJson: event.params,
    });

    const injectedProbationIds = getInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    for (const id of injectedProbationIds) {
      const principle = wctx.evolutionReducer.getPrincipleById(id);
      const shouldAttribute = !!principle && shouldAttributePrincipleToTool(principle, event.toolName);
      if (shouldAttribute) {
        wctx.evolutionReducer.recordProbationFeedback(id, false);
      }
    }
    clearInjectedProbationIds(sessionId, effectiveWorkspaceDir);
  } else {
    // ── SUCCESS BRANCH ──
    // PRI-80: Relieve both dispatch_error and tool_failure on success.
    // This prevents "read file success" from wiping dispatch error signals.
    const session = getSession(sessionId);
    const toolFailureGfi = session?.gfiBySource?.tool_failure || 0;
    const dispatchErrorGfi = session?.gfiBySource?.dispatch_error || 0;

    let resetState: SessionState = session || resetFriction(sessionId, effectiveWorkspaceDir);
    if (toolFailureGfi > 0 || dispatchErrorGfi > 0) {
      // Relieve both sources proportionally (50% relief each)
      if (toolFailureGfi > 0) {
        const reliefAmount = toolFailureGfi * 0.5;
        resetState = resetFriction(sessionId, effectiveWorkspaceDir, {
          source: 'tool_failure',
          amount: reliefAmount,
        });
      }
      if (dispatchErrorGfi > 0) {
        const reliefAmount = dispatchErrorGfi * 0.5;
        resetState = resetFriction(sessionId, effectiveWorkspaceDir, {
          source: 'dispatch_error',
          amount: reliefAmount,
        });
      }
    }
    
    recordEvolutionSuccess(effectiveWorkspaceDir, event.toolName, {
        sessionId,
        reason: 'tool_success',
    });

    const injectedProbationIds = getInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    for (const id of injectedProbationIds) {
      const principle = wctx.evolutionReducer.getPrincipleById(id);
      const shouldAttribute = !!principle && shouldAttributePrincipleToTool(principle, event.toolName);
      if (shouldAttribute) {
        wctx.evolutionReducer.recordProbationFeedback(id, true);
      }
    }
    clearInjectedProbationIds(sessionId, effectiveWorkspaceDir);
    wctx.trajectory?.recordToolCall?.({
      sessionId,
      toolName: event.toolName,
      outcome: 'success',
      durationMs: event.durationMs,
      exitCode,
      gfiBefore,
      gfiAfter: resetState.currentGfi,
      paramsJson: event.params,
    });
    
    const filePath = params.file_path || params.path || params.file;
    eventLog.recordToolCall(sessionId, {
      toolName: event.toolName,
      filePath: typeof filePath === 'string' ? filePath : undefined,
      gfi: resetState.currentGfi,
      gfiBefore,
      gfiAfter: resetState.currentGfi,
    });

    // ── Hygiene Tracking: Record persistence actions ──
    const normalized = typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : '';
    const isMemory = /(?:^|\/)memory\//.test(normalized) || normalized.endsWith('/MEMORY.md') || normalized === 'MEMORY.md';
    const isPlan = normalized === 'PLAN.md' || normalized.endsWith('/PLAN.md');

    if (isMemory || isPlan) {
      const content = params.content || params.new_string || '';
      wctx.hygiene.recordPersistence({
        ts: new Date().toISOString(),
        tool: event.toolName,
        path: typeof filePath === 'string' ? filePath : 'unknown',
        type: isMemory ? 'memory' : 'plan',
        contentLength: content.length,
      });
    }

    // Special case for memory_store tool (Success only)
    if (event.toolName === 'memory_store') {
       const text = params.text || '';
       wctx.hygiene.recordPersistence({
         ts: new Date().toISOString(),
         tool: event.toolName,
         path: 'DATABASE',
         type: 'memory',
         contentLength: text.length,
       });
    }
  }

  // ── Legacy/Risky Write Pain Logic (Unified WRITE_TOOLS) ──
  if (!WRITE_TOOLS.includes(event.toolName) || !isFailure) {
    return;
  }

  const failureSource = classifyToolFailureSource(event.toolName, event.error);

  const filePath = params.file_path || params.path || params.file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, effectiveWorkspaceDir) : 'unknown';

  const isRisk = isRisky(relPath, profile.risk_paths);
  const painScore = computePainScore(1, false, false, isRisk ? 20 : 0, effectiveWorkspaceDir);
  const traceId = createTraceId();
  const diagnosticGate = evaluatePainDiagnosticGate({
    source: failureSource,
    score: painScore,
    currentGfi: (latestFailureState ?? getSession(sessionId) ?? sessionState)?.currentGfi ?? 0,
    consecutiveErrors: (latestFailureState ?? getSession(sessionId) ?? sessionState)?.consecutiveErrors ?? 0,
    isRisky: isRisk,
    errorHash: latestFailureState?.lastErrorHash,
    sessionId,
    thresholds: {
      painTrigger: config.get('thresholds.pain_trigger') || 40,
      highSeverity: config.get('severity_thresholds.high') || 70,
      repeatedFailure: config.get('thresholds.stuck_loops_trigger') || 4,
    },
  });

  if (!diagnosticGate.shouldDiagnose) {
    SystemLogger.log(
      effectiveWorkspaceDir,
      'PAIN_DIAGNOSE_SKIPPED',
      `Tool failure recorded as friction only: ${diagnosticGate.detail}; tool=${event.toolName}; path=${relPath}`,
    );
    // Structured gate rejection event for traceability
    let rejectPayload: string;
    try {
      rejectPayload = JSON.stringify({
        reason: diagnosticGate.reason,
        detail: diagnosticGate.detail,
        source: failureSource,
        sessionId: sessionId,
        gfi: (latestFailureState ?? getSession(sessionId) ?? sessionState)?.currentGfi ?? 0,
        score: painScore,
      });
    } catch (e) {
      SystemLogger.log(effectiveWorkspaceDir, 'PAYLOAD_SERIALIZE_FAILED', String(e));
      rejectPayload = JSON.stringify({ reason: diagnosticGate.reason, detail: '(log serialization failed)' });
    }
    SystemLogger.log(effectiveWorkspaceDir, 'PAIN_GATE_REJECTED', rejectPayload);
    return;
  }

  // Record to trajectory before Runtime V2 diagnosis so the compiler can later
  // resolve derivedFromPainIds to the originating failed action.
  wctx.trajectory?.recordPainEvent({
    sessionId,
    source: failureSource,
    score: painScore,
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    severity: painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild',
    origin: 'system_infer',
    text: params.text ?? params.content ?? undefined,
  });

  // Pain signal emitted via emitPainDetectedEvent below — no .pain_flag file written (M8: single-path chain)

  // Observe: track which principles would have prevented this pain (Phase 1, observation-only)
  try {
    trackPrincipleValue(
      effectiveWorkspaceDir,
      {
        reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
        source: failureSource,
        score: String(painScore),
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
          // Persist to training state (best-effort, non-critical)
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
            // Non-critical — metrics tracked in memory
            SystemLogger.log(effectiveWorkspaceDir, 'METRICS_UPDATE_SKIP', String(e));
          }
        }
      },
    );
  } catch (e) {
    // Observation only — never disrupt the pain pipeline
    SystemLogger.log(effectiveWorkspaceDir, ' PRINCIPLE_TRACK_SKIP', String(e));
  }

  eventLog.recordPainSignal(sessionId, {
    score: painScore,
    source: failureSource,
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    isRisky: isRisk,
  });

  // Log to EvolutionLogger
  const evoLogger = getEvolutionLogger(effectiveWorkspaceDir, wctx.trajectory);
  evoLogger.logPainDetected({
    traceId,
    source: failureSource,
    reason: `Tool ${event.toolName} failed on ${relPath}`,
    score: painScore,
    toolName: event.toolName,
    filePath: relPath,
    sessionId,
  });

  emitPainDetectedEvent(wctx, {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId: createPainId(sessionId),
      painType: failureSource,
      source: event.toolName,
      reason: `Tool ${event.toolName} failed on ${relPath}; diagnosticGate=${diagnosticGate.reason}`,
      score: painScore,
      sessionId,
      traceId,
      agentId: ctx.agentId,
    },
  });
}

     
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
