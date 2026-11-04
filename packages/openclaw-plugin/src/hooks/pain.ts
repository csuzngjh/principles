/**
 * Pain Hook — PRI-326 decomposed
 *
 * After-tool-call hook. Phase A retired every automatic Pain admission that
 * was triggered by a technical tool failure: failures are still classified,
 * recorded in the trajectory, and recorded as events, but they never create
 * a Pain Event or a Diagnostician task by themselves.
 *
 * Remaining stages (delegated to after-tool-call-helpers):
 *   1. classifyToolCallOutcome    — determine failure/success + source
 *   2. buildToolCallObservation   — normalize event into observation
 *   3. recordToolCallFailure/Success — event log + trajectory recording
 *
 * The manual pain path (toolName === 'pain') remains inline because it
 * has a different control flow (early return, Owner-explicit admission).
 */

import * as fs from 'fs';
import { normalizeProfile } from '../core/profile.js';
import { trackSessionControlActivity } from '../core/session-tracker.js';
import { computeHash } from '../utils/hashing.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { createTraceId } from '../utils/trace-id.js';
import type { EvolutionLoopEvent } from '../core/evolution-types.js';
import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { resolveWorkspaceDirForRuntimeV2 } from '../utils/workspace-resolver.js';
import { PainToPrincipleService, PrincipleTreeLedgerAdapter, SqliteConnection, SqliteDeadLetterStore, type PainDetectedData, type TrajectoryTurnReader } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from '../core/pd-config-loader.js';
import { createIntentDocReader, resolveIntentLang } from '../core/intent-doc-reader-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed } from './trigger-cooldown-tracker.js';
import { buildManualPainObservation, resolveSourceKind } from './raw-observation-adapter.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
import type { ProductionPainEnrichment } from '@principles/host-runtime';

import {
  classifyToolCallOutcome,
  buildToolCallObservation,
  recordToolCallFailure,
  recordToolCallSuccess,
  recordHygieneTracking,
} from './after-tool-call-helpers.js';

import { ingressDecisionForPluginPain } from './pain-ingress-adapter.js';

// ── Service Factory ─────────────────────────────────────────────────────────

function createPainToPrincipleService(wctx: WorkspaceContext): PainToPrincipleService {
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: wctx.stateDir });
  const configResult = loadPdConfigForPlugin(wctx.workspaceDir);
  const trajectoryTurnReader: TrajectoryTurnReader = {
    listUserTurnsForSession: (sessionId) => wctx.trajectory.listUserTurnsForSession(sessionId),
    listAssistantTurns: (sessionId) => wctx.trajectory.listAssistantTurns(sessionId),
  };
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
    trajectoryTurnReader,
  });
}

// Trajectory evidence acquisition lives in ./trajectory-evidence.ts.

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

      // PRI-642 Scope B: the shared ingress derives provenance, evidence and
      // the persisted painIngress.v1 facts — emitters no longer assemble
      // them (SPEC §8.3). Sentinel-shaped evidence from the legacy array API
      // is re-classified through typed acquisition by the adapter.
      const decision = ingressDecisionForPluginPain({
        wctx,
        painId: painData.painId,
        painType: painData.painType,
        source: painData.source,
        reason: painData.reason,
        score: painData.score,
        sessionId: painData.sessionId,
        inlineEvidence: painData.evidence,
      });

      if (decision.action === 'refuse') {
        // Invalid origin/correlation/lineage combination — fail loud, no writes.
        SystemLogger.log(wctx.workspaceDir, 'PAIN_INGRESS_REFUSED', JSON.stringify({
          painId: painData.painId,
          source: painData.source,
          reasonCode: decision.reasonCode,
          warning: decision.warning,
          nextAction: decision.nextAction,
        }));
        return;
      }
      if (decision.action === 'observation_only') {
        // Automatic signal without binding/evidence — observation-only. The
        // recordPain call below keeps the observability projection alive;
        // the bridge's empty-evidence short-circuit guarantees no LLM run
        // and no diagnostic task (SPEC §12.2.1/§12.2.2).
        SystemLogger.log(wctx.workspaceDir, 'PAIN_INGRESS_OBSERVATION_ONLY', JSON.stringify({
          painId: painData.painId,
          source: painData.source,
          reasonCode: decision.reasonCode,
          note: decision.note,
        }));
      }
      if (decision.action === 'degrade') {
        // rc-9: funnel-level degradation disclosures must be observable even
        // when the caller has no Owner-facing surface (tool-invoked pains).
        SystemLogger.log(wctx.workspaceDir, 'PAIN_INGRESS_DEGRADED', JSON.stringify({
          painId: painData.painId,
          source: painData.source,
          reasonCode: decision.reasonCode,
          warning: decision.warning,
          nextAction: decision.nextAction,
        }));
      } else if (decision.action === 'submit' && decision.warnings.length > 0) {
        SystemLogger.log(wctx.workspaceDir, 'PAIN_INGRESS_DEGRADED', JSON.stringify({
          painId: painData.painId,
          source: painData.source,
          warnings: decision.warnings,
        }));
      }

      // PRI-642 SPEC §7.4/§18: an unbound submission must never materialize
      // the sentinel session 'cli' in the trajectory projection — the
      // observability writer upserts sessions/pain_events under
      // data.sessionId ?? 'cli'. Skip the projection entirely when the
      // ingress produced no bound session (skipped projection is disclosed
      // in the degrade/warning log above).
      const effectiveRecordObservability = decision.legacy.sessionId === undefined ? false : recordObs;

      const result = await service.recordPain({
        painId: decision.legacy.painId,
        painType: decision.legacy.painType,
        source: decision.legacy.source,
        reason: decision.legacy.reason,
        score: decision.legacy.score,
        sessionId: decision.legacy.sessionId,
        agentId: painData.agentId,
        taskId: painData.taskId,
        traceId: decision.legacy.traceId,
        provenance: decision.legacy.provenance,
        hostKind: decision.legacy.hostKind,
        evidence: decision.legacy.evidence,
        painIngress: decision.legacy.painIngress,
        // PRI-844: forward the producer's verbatim Owner correction so the
        // pain bridge can ride it as first-class evidence (PHASE 1.5). The
        // signal collector sets it on the emitted event; dropping it here
        // silently downgraded the diagnosis to the 200-char excerpt channel.
        ...(painData.correctionEvidence ? { correctionEvidence: painData.correctionEvidence } : {}),
        recordObservability: effectiveRecordObservability,
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
      } else if (result.status === 'degraded'
        && (result.candidateOutcomes ?? []).some((o) => o.reason === 'reuse_review_required')) {
        // PRI-917 v0.3.3 review fix (P2-2): a parked candidate is invisible in a
        // plain succeeded/degraded result here — surface it so the Owner sees
        // WHAT awaits review. Gated on the park disposition (not any degraded
        // run) so the pre-v0.3.3 log stream stays byte-identical (T11).
        SystemLogger.log(wctx.workspaceDir, 'PAIN_SERVICE_REUSE_REVIEW_REQUIRED', JSON.stringify({
          painId: result.painId,
          taskId: result.taskId,
          latencyMs: result.latencyMs,
          parkedCandidateIds: (result.candidateOutcomes ?? [])
            .filter((o) => o.reason === 'reuse_review_required')
            .map((o) => o.candidateId),
          message: result.message,
        }));
      }
    } catch (err) {
      // rc-9: no silent fallback — persist pain data to dead_letter_pains so
      // `pd pain retry --pain-id <id>` can replay it later. The original
      // PAIN_SERVICE_ERROR log is kept for backwards-compatible observability.
      SystemLogger.log(wctx.workspaceDir, 'PAIN_SERVICE_ERROR', `recordPain threw: ${String(err)}`);
      const errorMessage = err instanceof Error ? err.message : String(err);
      let deadLetterInserted = false;
      try {
        const dlConnection = new SqliteConnection({ workspaceDir: wctx.workspaceDir });
        try {
          const dlStore = new SqliteDeadLetterStore(dlConnection);
          const insertResult = dlStore.insertDeadLetter({ painId: painData.painId, painData });
          if (insertResult.ok) {
            deadLetterInserted = true;
          } else {
            // rc-9: record the insert failure reason — no silent degradation.
            SystemLogger.log(wctx.workspaceDir, 'DEAD_LETTER_PERSIST_FAILED', insertResult.error);
          }
        } finally {
          dlConnection.close();
        }
      } catch (dlErr) {
        // rc-9: record the connection/store failure reason — no silent degradation.
        SystemLogger.log(wctx.workspaceDir, 'DEAD_LETTER_PERSIST_FAILED', String(dlErr));
      }
      SystemLogger.log(wctx.workspaceDir, 'PAIN_DEAD_LETTER', JSON.stringify({
        painId: painData.painId,
        painType: painData.painType,
        source: painData.source,
        score: painData.score,
        deadLetterInserted,
        error: errorMessage,
        nextAction: `Run 'pd pain retry --pain-id ${painData.painId}' to replay this pain signal`,
      }));
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
  const sessionId = ctx.sessionId || 'unknown';

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

  if (outcome.isFailure) {
    // ── Stage 3a: Recording (Failure) ──
    recordToolCallFailure(
      sessionId, event, outcome, observation, effectiveWorkspaceDir, wctx
    );
  } else {
    // ── Stage 3b: Recording (Success) ──
    recordToolCallSuccess(
      sessionId, event, outcome, observation, effectiveWorkspaceDir, wctx
    );

    // ── Stage 3c: Hygiene Tracking (Success only) ──
    recordHygieneTracking(event, observation, wctx);
  }
}

/**
 * OpenClaw-owned enrichment for the shared ordinary after-tool kernel.
 * Session/event-log, PROFILE and hygiene behavior stays here;
 * the shared runtime owns classification/admission and the atomic trajectory write.
 */
export function prepareOrdinaryAfterToolCallForSharedRuntime(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir: string; pluginConfig?: Record<string, unknown> },
): ProductionPainEnrichment {
  const wctx = WorkspaceContext.fromHookContextExplicit(ctx);
  const sessionId = ctx.sessionId || 'unknown';

  const profilePath = wctx.resolve('PROFILE');
  let profile = normalizeProfile({});
  if (fs.existsSync(profilePath)) {
    try {
      const content = fs.readFileSync(profilePath, 'utf8');
      if (content.length <= 1024 * 1024) profile = normalizeProfile(JSON.parse(content));
      else SystemLogger.log(ctx.workspaceDir, 'PROFILE_PARSE_WARN', 'PROFILE.json exceeds 1 MB, skipping');
    } catch (error) {
      SystemLogger.log(ctx.workspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(error)}`);
    }
  }
  const outcome = classifyToolCallOutcome(event);
  const observation = buildToolCallObservation(event, outcome, ctx.workspaceDir, profile);
  const rawEventId = Object.hasOwn(event, 'toolUseId') ? event.toolUseId
    : Object.hasOwn(event, 'toolCallId') ? event.toolCallId
    : undefined;
  if (outcome.isFailure) {
    recordToolCallFailure(sessionId, event, outcome, observation, ctx.workspaceDir, wctx, { recordTrajectory: false });
  } else {
    recordToolCallSuccess(sessionId, event, outcome, observation, ctx.workspaceDir, wctx, { recordTrajectory: false });
    recordHygieneTracking(event, observation, wctx);
  }
  // The shared kernel still owns the atomic tool_calls row. Phase A retired
  // the pain admission that used to ride on this enrichment; only the stable
  // event identity remains meaningful.
  return typeof rawEventId === 'string' && rawEventId.trim().length > 0 ? { eventId: `openclaw:${rawEventId}` } : {};
}

// ── Manual Pain Handler ─────────────────────────────────────────────────────

/**
 * Handle manual pain intervention (toolName === 'pain' or 'skill:pain').
 *
 * This path is separate because:
 * - It always records pain at score 100
 * - It has its own cooldown
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

  // Mark control activity for the manual Owner intervention
  trackSessionControlActivity(sessionId, workspaceDir);
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
    hostKind: 'openclaw',
  });

  // PRI-651-B1: Unconditional Gate B — TriggerController is the only
  // admission authority. Gate A fallback (PRI-454 rollback) removed.
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
        // PRI-844: a manual pain's `input` IS the Owner's own words — keep
        // them verbatim as first-class evidence (not just the reason prefix).
        correctionEvidence: {
          text: reason,
          sessionId,
          occurredAt: new Date().toISOString(),
        },
      },
    }, { recordObservability: false });
  } else {
    SystemLogger.log(workspaceDir, 'MANUAL_PAIN_SKIPPED', triggerDecision.reason);
  }
}
