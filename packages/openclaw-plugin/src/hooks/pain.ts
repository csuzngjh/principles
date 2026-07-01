/**
 * Pain Hook — PRI-326 decomposed
 *
 * After-tool-call hook that captures tool failures and emits pain signals.
 *
 * Pipeline stages (delegated to after-tool-call-helpers):
 *   1. classifyToolCallOutcome    — determine failure/success + source
 *   2. buildToolCallObservation   — normalize event into observation
 *   3. handleFrictionTracking     — GFI, event log, trajectory recording
 *   4. handleProbationFeedback    — probation attribution + cleanup
 *   5. evaluatePainAdmission      — triage + gate evaluation
 *   6. emitPainIfAdmitted         — pain signal emission
 *
 * The manual pain path (toolName === 'pain') remains inline because it
 * has a different control flow (early return, no triage, no gate on cooldown).
 */

import * as fs from 'fs';
import { normalizeProfile } from '../core/profile.js';
import { getSession, trackFriction } from '../core/session-tracker.js';
import { computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { getEvolutionLogger, createTraceId } from '../core/evolution-logger.js';
import type { EvolutionLoopEvent } from '../core/evolution-types.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { resolveWorkspaceDirForRuntimeV2 } from '../utils/workspace-resolver.js';
import { PainToPrincipleService, PrincipleTreeLedgerAdapter, type PainDetectedData } from '@principles/core/runtime-v2';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { loadPdConfigForPlugin, loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { createIntentDocReader, resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed } from './trigger-cooldown-tracker.js';
import { buildManualPainObservation, resolveSourceKind } from './raw-observation-adapter.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';

import {
  classifyToolCallOutcome,
  buildToolCallObservation,
  handleFrictionTrackingForFailure,
  handleFrictionTrackingForSuccess,
  recordHygieneTracking,
  handleProbationFeedback,
  evaluatePainAdmissionForToolCall,
  emitPainIfAdmitted,
} from './after-tool-call-helpers.js';

import { buildTrajectoryEvidence } from './trajectory-evidence.js';
export { buildTrajectoryEvidence };

// ── Service Factory ─────────────────────────────────────────────────────────

function createPainToPrincipleService(wctx: WorkspaceContext): PainToPrincipleService {
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: wctx.stateDir });
  const configResult = loadPdConfigForPlugin(wctx.workspaceDir);
  return new PainToPrincipleService({
    workspaceDir: wctx.workspaceDir,
    stateDir: wctx.stateDir,
    ledgerAdapter,
    owner: 'openclaw-plugin',
    autoIntakeEnabled: true,
    effectiveConfig: configResult.effective,
    getEnvVar: (name: string) => process.env[name],
    // PRI-468: wire INTENT.md reader so Stage A can produce intentTension
    // when intent_engineering flag is on. Adapter performs no I/O beyond
    // delegating to safeReadIntentDoc (which owns the flag-first check).
    intentDocReader: createIntentDocReader(wctx.workspaceDir, resolveIntentLang(wctx.workspaceDir)),
  });
}

// buildTrajectoryEvidence is in ./trajectory-evidence.ts (re-exported above)

// ── Pain Event Emission ─────────────────────────────────────────────────────

export async function emitPainDetectedEvent(
  wctx: WorkspaceContext,
  event: EvolutionLoopEvent,
  options?: { recordObservability?: boolean },
): Promise<void> {
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
      const isManual = painData.source === 'manual' || painData.source === 'pain' || painData.source === 'skill:pain';

      // PEAT-B2: Record trigger decision for observability
      if (isManual) {
        SystemLogger.log(wctx.workspaceDir, 'TRIGGER_DECISION', JSON.stringify({
          outcome: 'manual_owner_admitted',
          sourceKind: 'owner_reported',
          reason: 'Owner explicit manual pain. Bypasses triage and cooldown.',
          nextAction: 'create_diagnostic_task',
          painId: painData.painId,
          score: painData.score,
        }));
      }

      // PRI-453: Hook paths that already write events_*.jsonl + trajectory.db
      // via legacy writers pass recordObservability: false to avoid triple-write.
      // CLI pd pain record and paths without legacy writers keep the default true.
      const recordObs = options?.recordObservability ?? true;

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
        provenance: painData.provenance,
        evidence: painData.evidence,
        recordObservability: recordObs,
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

// ── Source Classification ────────────────────────────────────────────────────

// PRI-360 S1: classifyToolFailureSource is removed; source mapping is now unified
// through resolveSourceKind in raw-observation-adapter.ts

// ── Main Hook ───────────────────────────────────────────────────────────────

/**
 * Handle after_tool_call hook — decomposed into pipeline stages.
 *
 * Pipeline: classify → record → triage → gate → emit
 *
 * Manual pain (toolName === 'pain') is handled inline with early return.
 */
export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown> },
  api?: OpenClawPluginApi
): void {
  // ── Workspace Resolution ──
  let effectiveWorkspaceDir: string;
  try {
    effectiveWorkspaceDir = resolveWorkspaceDirForRuntimeV2(ctx, api, 'after_tool_call');
  } catch (error) {
    SystemLogger.log(
      ctx.workspaceDir ?? 'unknown',
      'WORKSPACE_RESOLUTION_FAILED',
      JSON.stringify({
        hook: 'after_tool_call',
        sessionId: ctx.sessionId ?? 'unknown',
        toolName: event.toolName,
        reason: 'workspace_resolution_failed',
        nextAction: 'check_plugin_config_workspace_resolution',
        error: String(error).slice(0, 200),
      }),
    );
    return;
  }

  const wctx = WorkspaceContext.fromHookContextExplicit({ ...ctx, workspaceDir: effectiveWorkspaceDir });
  const { config } = wctx;
  const sessionId = ctx.sessionId || 'unknown';
  const sessionState = ctx.sessionId ? getSession(ctx.sessionId) : undefined;
  const gfiBefore = sessionState?.currentGfi ?? 0;

  // ── Profile Loading (once per call) ──
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

  // ── Manual Pain Early Return ──
  if (event.toolName === 'pain' || event.toolName === 'skill:pain') {
    handleManualPain(event, ctx, wctx, effectiveWorkspaceDir, sessionId);
    return;
  }

  // ── Stage 1: Classify ──
  const outcome = classifyToolCallOutcome(event);

  // ── Stage 2: Build Observation ──
  const observation = buildToolCallObservation(event, outcome, effectiveWorkspaceDir, profile);

  let latestFailureState: import('../core/session-tracker.js').SessionState | undefined;

  if (outcome.isFailure) {
    // ── Stage 3a: Friction + Recording (Failure) ──
    latestFailureState = handleFrictionTrackingForFailure(
      sessionId, event, outcome, observation, gfiBefore, effectiveWorkspaceDir, config, wctx
    );

    // ── Stage 4: Probation Feedback (Failure) ──
    handleProbationFeedback(sessionId, event.toolName, effectiveWorkspaceDir, wctx, false);
  } else {
    // ── Stage 3b: Friction + Recording (Success) ──
    handleFrictionTrackingForSuccess(
      sessionId, event, outcome, observation, gfiBefore, effectiveWorkspaceDir, wctx
    );

    // ── Stage 4: Probation Feedback (Success) ──
    handleProbationFeedback(sessionId, event.toolName, effectiveWorkspaceDir, wctx, true);

    // ── Stage 5b: Hygiene Tracking (Success only) ──
    recordHygieneTracking(event, observation, wctx);
  }

  // ── Stage 6: Pain Admission ──
  const admission = evaluatePainAdmissionForToolCall(
    event, observation, outcome, latestFailureState, sessionState, sessionId, effectiveWorkspaceDir, config
  );

  if (admission.stage === 'not_applicable') {
    return;
  }

  // ── Stage 7: Emit Pain (only if admitted) ──
  emitPainIfAdmitted(
    wctx, event, observation, outcome, admission, sessionId, ctx.agentId, effectiveWorkspaceDir, emitPainDetectedEvent
  );
}

// ── Manual Pain Handler ─────────────────────────────────────────────────────

/**
 * Handle manual pain intervention (toolName === 'pain' or 'skill:pain').
 *
 * This path is separate because:
 * - It always records pain at score 100
 * - It uses a different GFI track (manual_pain)
 * - It has its own cooldown via PainDiagnosticGate
 * - It does NOT go through evidence triage
 */
function handleManualPain(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string },
  wctx: WorkspaceContext,
  workspaceDir: string,
  sessionId: string,
): void {
  const rawParams = event.params;
  const params: { input?: string; arguments?: string } =
    (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
      ? rawParams as { input?: string; arguments?: string }
      : {};
  const reason = params.input || params.arguments || 'Manual intervention';
  const traceId = createTraceId();

  // Track friction at max score
  trackFriction(sessionId, 100, 'manual_pain', workspaceDir, { source: 'manual_pain' });
  SystemLogger.log(workspaceDir, 'MANUAL_PAIN', `User manually triggered pain: ${reason}`);

  wctx.eventLog.recordPainSignal(sessionId, {
    score: 100,
    source: 'manual',
    reason: `User intervention: ${reason}`,
    isRisky: true
  });

  // PRI-453: Generate painId early to pass as canonicalPainId for dedup.
  const painId = createPainId(sessionId);

  wctx.trajectory?.recordPainEvent?.({
    sessionId,
    source: 'manual',
    score: 100,
    reason: `User intervention: ${reason}`,
    origin: 'user_manual',
    text: reason,
    canonicalPainId: painId,
  });

  // Log to EvolutionLogger
  const evoLogger = getEvolutionLogger(workspaceDir, wctx.trajectory);
  evoLogger.logPainDetected({
    traceId,
    source: 'manual',
    reason: `User intervention: ${reason}`,
    score: 100,
    toolName: event.toolName,
    sessionId,
  });

  // PRI-454: Dual-gate migration. When both flags ON → Gate B (TriggerController).
  // When either OFF → Gate A (PainDiagnosticGate, rollback).
  const triageFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmission');
  const defaultFlag = loadFeatureFlagFromConfig(workspaceDir, 'painEvidenceAdmissionDefault');
  const useGateB = triageFlag.enabled && defaultFlag.enabled;

  if (useGateB) {
    // PRI-454: Gate B path — manual pain is owner-reported.
    // isOwnerManual: true → evaluateTriggerController returns manual_owner_admitted
    // (bypasses triage and cooldown per PRODUCT_IDENTITY: owner-governed).
    const rawObs = buildManualPainObservation({ sessionId });
    const sourceKind = resolveSourceKind(rawObs); // → 'owner_reported'
    const triage = evaluateEvidenceTriage(sourceKind, 100); // → 'admit'
    const cooldownActive = isSharedCooldownActive(sourceKind, sessionId, 'manual_pain');
    const triggerDecision = evaluateTriggerController({
      triageResult: triage,
      isOwnerManual: true,
      isCooldownActive: cooldownActive,
      isValid: true,
      score: 100,
      sessionId,
    });

    // PEAT-B2: Record trigger decision
    const painTriageFlag = loadPdConfigForPlugin(workspaceDir);
    if (painTriageFlag.effective) {
      SystemLogger.log(workspaceDir, 'TRIGGER_DECISION', JSON.stringify({
        outcome: triggerDecision.outcome,
        sourceKind: triggerDecision.sourceKind,
        reason: triggerDecision.reason,
        nextAction: triggerDecision.nextAction,
        isOwnerManual: true,
        sessionId,
        score: 100,
      }));
    }

    if (triggerDecision.shouldCreateDiagnosticTask) {
      markSharedEpisodeAsDiagnosed(sourceKind, sessionId, 'manual_pain');
      emitPainDetectedEvent(wctx, {
        ts: new Date().toISOString(),
        type: 'pain_detected',
        data: {
          painId,
          painType: 'user_frustration',
          source: event.toolName,
          reason: `User intervention: ${reason}`,
          score: 100,
          sessionId,
          traceId,
          agentId: ctx.agentId,
          provenance: (sessionId && sessionId !== 'unknown') ? 'openclaw_context_bound' : 'owner_reported_no_host_trace',
          evidence: buildTrajectoryEvidence(wctx, sessionId),
        },
      }, { recordObservability: false });
    } else {
      SystemLogger.log(workspaceDir, 'MANUAL_PAIN_SKIPPED', triggerDecision.reason);
    }
  } else {
    // PRI-454: Gate A path (rollback when either flag is OFF)
    const session = getSession(sessionId);
    const gate = evaluatePainDiagnosticGate({
      source: 'manual',
      score: 100,
      currentGfi: session?.currentGfi ?? 0,
      sessionId,
    });

    if (!gate.shouldDiagnose) {
      SystemLogger.log(workspaceDir, 'MANUAL_PAIN_SKIPPED', `Manual pain within cooldown: ${gate.detail}`);
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
        SystemLogger.log(workspaceDir, 'PAYLOAD_SERIALIZE_FAILED', String(e));
        payload = JSON.stringify({ reason: gate.reason, detail: '(log serialization failed)' });
      }
      SystemLogger.log(workspaceDir, 'PAIN_GATE_REJECTED', payload);

      // PEAT-B2: Record trigger decision even when cooldown blocks manual pain
      const painTriageFlag = loadPdConfigForPlugin(workspaceDir);
      if (painTriageFlag.effective) {
        SystemLogger.log(workspaceDir, 'TRIGGER_DECISION', JSON.stringify({
          outcome: 'cooldown_skipped',
          sourceKind: 'owner_reported',
          reason: `Manual pain within cooldown: ${gate.detail}`,
          nextAction: 'wait_for_cooldown_or_manual_retrigger',
          isOwnerManual: true,
          sessionId,
          score: 100,
        }));
      }
      return;
    }

    emitPainDetectedEvent(wctx, {
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId,
        painType: 'user_frustration',
        source: event.toolName,
        reason: `User intervention: ${reason}`,
        score: 100,
        sessionId,
        traceId,
        agentId: ctx.agentId,
        provenance: (sessionId && sessionId !== 'unknown') ? 'openclaw_context_bound' : 'owner_reported_no_host_trace',
        evidence: buildTrajectoryEvidence(wctx, sessionId),
      },
    }, { recordObservability: false });
  }
}
