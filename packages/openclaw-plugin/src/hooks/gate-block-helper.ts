/**
 * Gate Block Helper - Single Authoritative Block Persistence
 *
 * PURPOSE: Provide ONE authoritative implementation for gate block persistence.
 *
 * All gate sources (rule-host) must use this
 * helper to ensure consistent block tracking, event logging, and retry behavior.
 *
 * This eliminates the "multi-truth source" problem where different modules
 * had their own block persistence implementations.
 */

import * as fs from 'fs';
import { getSession, trackBlock } from '../core/session-tracker.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { TrajectoryDatabase, TrajectoryGateBlockInput } from '../core/trajectory.js';
import type { PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { emitPainDetectedEvent } from './pain.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { loadPrincipleReceiptMetadata, type PrincipleReceiptMetadata } from '../core/principle-receipt-metadata.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed } from './trigger-cooldown-tracker.js';
import { isRisky } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { SystemLogger } from '../core/system-logger.js';
import {
  TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS,
  TRAJECTORY_GATE_BLOCK_MAX_RETRIES
} from '../config/index.js';

/**
 * Block context containing all information needed for block persistence
 */
export interface BlockContext {
  /**
   * Target path. Nullable by contract (PRI-569 round 3): the shared
   * host-runtime path may deny a call whose path cannot be normalized, and
   * trajectory.db accepts a null file_path — a deny is always accounted,
   * never dropped for lack of a path. Display-only contexts use
   * `<unresolved>` via the caller-side displayPath coercion.
   */
  filePath: string | null;
  reason: string;
  toolName: string;
  sessionId?: string;
  /** Source module that triggered the block (for audit trail) */
  blockSource?: string;
  /** RuleHost rule id — enables PRI-530 receipt copy attribution */
  ruleId?: string;
  /** Principle id from the rule result — enables PRI-530 receipt copy attribution */
  principleId?: string;
}

/** Payload persisted to trajectory.db gate_blocks for one block decision. */
interface TrajectoryGateBlockPayload extends TrajectoryGateBlockInput {}

type GateBlockWriteOutcome = 'written' | 'retryable' | 'skipped';

/**
 * One synchronous attempt to write a gate_blocks row.
 *
 * Every failure mode warns with a distinct reasonCode instead of skipping
 * silently (rc-9 / PRI-569). Only a thrown write is retryable; an unmounted
 * or failing collector is permanent for this process lifetime.
 */
function attemptTrajectoryGateBlockWrite(
  wctx: WorkspaceContext,
  payload: TrajectoryGateBlockPayload,
  logWarn: (message: string) => void
): GateBlockWriteOutcome {
  let trajectory: TrajectoryDatabase | undefined;
  try {
    trajectory = wctx.trajectory;
  } catch (error: unknown) {
    logWarn(`[PD_GATE] Trajectory gate block skipped (reasonCode=trajectory_getter_failed): ${String(error)}`);
    return 'skipped';
  }
  if (!trajectory || typeof trajectory.recordGateBlock !== 'function') {
    logWarn('[PD_GATE] Trajectory gate block skipped: collector not mounted (reasonCode=trajectory_collector_unmounted); event-log row retained');
    return 'skipped';
  }
  try {
    trajectory.recordGateBlock(payload);
    return 'written';
  } catch (error: unknown) {
    logWarn(`[PD_GATE] Failed to record trajectory gate block (reasonCode=trajectory_write_failed): ${String(error)}`);
    return 'retryable';
  }
}

/**
 * Authoritative persistence core for ONE gate-block decision.
 *
 * Shared by BOTH enforcement paths (PRI-569): recordGateBlockAndReturn
 * (legacy hook path) and handleSharedRuleHostResult's deny branch (shared
 * host-runtime path). Before PRI-569 the shared path recorded only EventLog
 * JSONL rows, so trajectory.db gate_blocks stayed empty and Wave-4's
 * "blocks today" metric read 0 despite live blocks.
 *
 * None of the steps throws into the caller; degradation is observable via
 * reasonCode-carrying warnings, and trajectory write failures schedule the
 * bounded retry chain.
 */
export function persistGateBlock(
  wctx: WorkspaceContext,
  blockCtx: BlockContext,
  logger: { warn?: (_message: string) => void; error?: (_message: string) => void }
): void {
  const { filePath, reason, toolName, sessionId, blockSource } = blockCtx;
  const logWarn = (msg: string) => logger.warn?.(msg);
  const logError = (msg: string) => logger.error?.(msg);

  // 1. Track block for session-level GFI calculation. Guarded so the
  // persistGateBlock never-throws invariant holds end to end.
  if (sessionId) {
    try {
      trackBlock(sessionId);
    } catch (error: unknown) {
      logWarn(`[PD_GATE] Session GFI tracking skipped (reasonCode=gfi_track_failed): ${String(error)}`);
    }
  }

  // 2. Prepare trajectory payload. Note: trajectory.db gate_blocks has no
  // source column — blockSource is EventLog-only attribution. A null
  // file_path is valid here (unresolved path still counts, PRI-569 r3).
  const trajectoryPayload: TrajectoryGateBlockPayload = {
    sessionId: sessionId ?? null,
    toolName,
    filePath,
    reason,
  };

  // 3. Record to EventLog (primary persistence). Its schema requires a
  // string path, so an unresolved target carries a placeholder instead.
  try {
    wctx.eventLog.recordGateBlock(sessionId, {
      toolName,
      filePath: filePath ?? '<unresolved>',
      reason,
      blockSource: blockSource ?? 'gate',
    });
  } catch (error: unknown) {
    logWarn(`[PD_GATE] Failed to record gate block event: ${String(error)}`);
  }

  // 4. Record to trajectory (secondary persistence with retry). Only a thrown
  // write schedules retries; skipped outcomes are permanent for this process.
  if (attemptTrajectoryGateBlockWrite(wctx, trajectoryPayload, logWarn) === 'retryable') {
    scheduleTrajectoryGateBlockRetry(wctx, trajectoryPayload, 1, logWarn, logError);
  }
}

/**
 * Single authoritative block helper.
 *
 * Responsibilities:
 * 1. Call trackBlock() for session-level GFI tracking
 * 2. Record to EventLog for operator visibility
 * 3. Record to trajectory for analytics
 * 4. Handle retry logic for trajectory persistence failures
 * 5. Generate consistent operator-facing block message
 *
 * @param wctx - Workspace context
 * @param blockCtx - Block context with file, reason, tool info
 * @param logger - Logger instance
 * @returns PluginHookBeforeToolCallResult with block=true
 */
export function recordGateBlockAndReturn(
  wctx: WorkspaceContext,
  blockCtx: BlockContext,
   
  logger: { warn?: (_message: string) => void; error?: (_message: string) => void; info?: (_message: string) => void }
   
): PluginHookBeforeToolCallResult {
  const { filePath, reason, toolName, sessionId, blockSource } = blockCtx;
  // Legacy hook path always has a resolvable path (gate.ts returns before
  // calling this when none can be extracted); the coercion only satisfies
  // the widened BlockContext contract for display/risk-matching contexts.
  const displayPath = filePath ?? '<unresolved>';

  // Default logger if not provided
  const logWarn = (msg: string) => logger.warn?.(msg);
  const logError = (msg: string) => logger.error?.(msg);

  // Log the block event
  const sourceTag = blockSource ? `[${blockSource}]` : '';
  logError(`[PD_GATE]${sourceTag} BLOCKED: ${displayPath}. Reason: ${reason}`);

  // Steps 1-4 (session GFI tracking, EventLog row, trajectory row with
  // bounded retry) are the authoritative persistence core shared by BOTH
  // enforcement paths — the legacy hook path here, and
  // handleSharedRuleHostResult's deny branch (PRI-569).
  persistGateBlock(wctx, blockCtx, logger);

  // 5. Record gate block pain context. Runtime V2 diagnosis is gated by GFI
  // so one mild block does not start a long diagnostician run.
  if (sessionId) {
    const GATE_BLOCK_PAIN_SCORE = 45; // Must be >= pain_trigger (40) so single gate block can trigger diagnosis (PRI-274)
    // PRI-453: Generate painId early. SDK observability path (emitPainDetectedEvent
    // with default recordObservability: true) handles all writes: events_*.jsonl +
    // evolution.jsonl + trajectory.db (with canonicalPainId for dedup). No separate
    // legacy recordPainEvent call needed — avoids double-write to trajectory.db.
    const gatePainId = `gate_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // PRI-454: Dual-gate migration. When both flags ON → Gate B (TriggerController).
    // When either OFF → Gate A (PainDiagnosticGate, rollback).
    const triageFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'painEvidenceAdmission');
    const defaultFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'painEvidenceAdmissionDefault');
    const useGateB = triageFlag.enabled && defaultFlag.enabled;

    // PEAT-B1: Evidence triage (runs when Gate B is active)
    const session = getSession(sessionId);
    if (useGateB) {
      // Load profile with 1MB size guard, matching pain.ts pattern
      const profilePath = wctx.resolve('PROFILE');
      let profile = normalizeProfile({});
      if (fs.existsSync(profilePath)) {
        try {
          const content = fs.readFileSync(profilePath, 'utf8');
          if (content.length > 1024 * 1024) {
            logger.warn?.('[PD_GATE] PROFILE.json exceeds 1 MB, skipping');
            SystemLogger.log(wctx.workspaceDir, 'PROFILE_PARSE_WARN', 'PROFILE.json exceeds 1 MB, skipping — fallback to non-risky');
          } else {
            profile = normalizeProfile(JSON.parse(content));
          }
        } catch (e) {
          logger.warn?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
          SystemLogger.log(wctx.workspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(e)} — fallback to non-risky`);
        }
      }
      // Real judgment for rulehost blocks: if a principle blocked an action on a risky path,
      // it IS a high-confidence unsafe action. The pain score (45) is the evidence friction
      // weight, NOT the action risk severity. The rulehost principle already determined
      // this action was important enough to block — that is the real signal.
      const isUnsafe = isRisky(displayPath, profile.risk_paths);
      // PRI-454 P2-1: Pass consecutiveErrors and isRisky to match Gate A's
      // upgrade logic. Rule 3 (consecutiveErrors >= 4 → admit) was being
      // dropped, so non-risky repeated gate blocks never triggered diagnosis.
      const triage = evaluateEvidenceTriage('rulehost_block', GATE_BLOCK_PAIN_SCORE, {
        isUnsafeHighConfidence: isUnsafe,
        isRisky: isUnsafe,
        consecutiveErrors: session?.consecutiveErrors,
      });

      if (triage.decision !== 'admit') {
        logger.info?.(`[PD_GATE] Triage ${triage.decision}: ${triage.reason}`);
      } else {
        // PRI-454: Gate B path — TriggerController owns admission
        const errorHash = `${toolName}:${displayPath}:${reason}`;
        const cooldownActive = isSharedCooldownActive('rulehost_block', sessionId, errorHash);
        const triggerDecision = evaluateTriggerController({
          triageResult: triage,
          isOwnerManual: false,
          isCooldownActive: cooldownActive,
          isValid: true,
          score: GATE_BLOCK_PAIN_SCORE,
          sessionId,
        });
        if (triggerDecision.shouldCreateDiagnosticTask) {
          markSharedEpisodeAsDiagnosed('rulehost_block', sessionId, errorHash);
          void emitPainDetectedEvent(wctx, {
            ts: new Date().toISOString(),
            type: 'pain_detected',
            data: {
              painId: gatePainId,
              painType: 'user_frustration',
              source: 'gate_blocked',
              reason: `Gate blocked ${toolName} on ${displayPath}: ${reason}`,
              score: GATE_BLOCK_PAIN_SCORE,
              sessionId,
              agentId: 'main',
              hostKind: 'openclaw',
            },
          }).catch((emitErr) => {
            logWarn(`[PD_GATE] Failed to emit gate block pain event: ${String(emitErr)}`);
          });
        } else {
          logger.info?.(`[PD_GATE] Gate B skipped: ${triggerDecision.reason}`);
        }
      }
    } else {
      // PRI-454: Gate A path (rollback when either flag is OFF)
      const gate = evaluatePainDiagnosticGate({
        source: 'gate_blocked',
        score: GATE_BLOCK_PAIN_SCORE,
        currentGfi: session?.currentGfi ?? 0,
        consecutiveErrors: session?.consecutiveErrors ?? 0,
        sessionId,
        errorHash: `${toolName}:${displayPath}:${reason}`,
        thresholds: {
          painTrigger: wctx.config.get('thresholds.pain_trigger') || 40,
          highSeverity: wctx.config.get('severity_thresholds.high') || 70,
        },
      });

      if (gate.shouldDiagnose) {
        void emitPainDetectedEvent(wctx, {
          ts: new Date().toISOString(),
          type: 'pain_detected',
          data: {
            painId: gatePainId,
            painType: 'user_frustration',
            source: 'gate_blocked',
            reason: `Gate blocked ${toolName} on ${displayPath}: ${reason}`,
            score: GATE_BLOCK_PAIN_SCORE,
            sessionId,
            agentId: 'main',
            hostKind: 'openclaw',
          },
        }).catch((emitErr) => {
          logWarn(`[PD_GATE] Failed to emit gate block pain event: ${String(emitErr)}`);
        });
      } else {
        logger.info?.(`[PD_GATE] Gate block recorded without Runtime V2 diagnosis: ${gate.detail}`);
      }
    }
  }

  // 6. Return consistent block result with contextual operator guidance
  // PRI-530: when principle_receipt_block_copy is enabled and this block came
  // from RuleHost, enrich the copy with principle attribution (SPEC §5.1).
  let blockMessage: string;
  const receiptFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_block_copy', logger);
  if (receiptFlag.enabled && blockCtx.blockSource === 'rule-host') {
    const metadata = loadPrincipleReceiptMetadata(wctx.workspaceDir, blockCtx.ruleId, blockCtx.principleId);
    if (metadata) {
      blockMessage = buildReceiptBlockMessage({
        filePath: displayPath,
        reason,
        toolName,
        metadata,
      });
    } else {
      logWarn('[PD_GATE] Receipt metadata unresolved — generic block copy used (rc-9)');
      blockMessage = buildContextualBlockMessage({ filePath: displayPath, reason });
    }
  } else {
    blockMessage = buildContextualBlockMessage({ filePath: displayPath, reason });
  }

  return {
    block: true,
    blockReason: blockMessage,
  };
}

/**
 * PRI-530 (SPEC §5.1): owner-facing receipt copy for RuleHost blocks.
 * Primary visible surface is the agent's narration (the template instructs
 * it); the expanded tool card is the secondary surface. Fields degrade per
 * the metadata reader's fallback chain — the source line only appears when
 * the artifact actually carries painReasonSummary.
 */
function buildReceiptBlockMessage({
  filePath,
  reason,
  toolName,
  metadata,
}: {
  filePath: string;
  reason: string;
  toolName: string;
  metadata: PrincipleReceiptMetadata;
}): string {
  const approvedLine = metadata.approvedAt
    ? `你 ${metadata.approvedAt} 批准`
    : '你批准';
  const sourceLine = metadata.sourceSummary
    ? ` · 来源：${metadata.sourceSummary}`
    : '';
  return `⛔ [PD 原则]「${metadata.title}」拦截了 ${toolName} ${filePath}
   ${approvedLine}${sourceLine}
   Reason: ${reason}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 如何解除拦截：

此操作被 Rule Host 原则（来自 Principles Disciple）拦截。
如果该操作确实安全且必要，请向 Owner（用户）解释原因，
并请求 Owner 明确确认后再继续。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

/**
 * Build contextual block message based on block source.
 * - rule-host: principle-based guidance
 * - default/gate: generic security gate message
 */
function buildContextualBlockMessage({
  filePath,
  reason,
}: {
  filePath: string;
  reason: string;
}): string {
  // rule-host or generic gate blocks
  return `[Principles Disciple] Security Gate Blocked this action.
File: ${filePath}
Reason: ${reason}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 How to unblock this operation:

This action was blocked by a Rule Host principle.
If the blocked path is correct and safe, explain the reasoning to the owner
and ask for explicit confirmation to proceed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

/**
 * Schedule retry for trajectory gate block persistence.
 *
 * Uses exponential backoff with max retries.
 * Failures are logged but do not affect the runtime block decision.
 */
 
 
function scheduleTrajectoryGateBlockRetry(
  wctx: WorkspaceContext,
  payload: TrajectoryGateBlockPayload,
  attempt: number,
  logWarn: (message: string) => void,
  logError: (message: string) => void
): void {
  if (attempt > TRAJECTORY_GATE_BLOCK_MAX_RETRIES) {
    logError(`[PD_GATE] Failed to persist trajectory gate block after ${TRAJECTORY_GATE_BLOCK_MAX_RETRIES} retries (reasonCode=trajectory_write_exhausted): ${payload.toolName} ${payload.filePath}`);
    return;
  }

  setTimeout(() => {
    const outcome = attemptTrajectoryGateBlockWrite(wctx, payload, logWarn);
    if (outcome === 'written') {
      logWarn(`[PD_GATE] Trajectory gate block persisted on retry ${attempt}`);
      return;
    }
    if (outcome === 'skipped') {
      // Collector went away mid-retry — not retryable, warn already emitted.
      return;
    }
    scheduleTrajectoryGateBlockRetry(wctx, payload, attempt + 1, logWarn, logError);
  }, TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS * attempt).unref();
}
