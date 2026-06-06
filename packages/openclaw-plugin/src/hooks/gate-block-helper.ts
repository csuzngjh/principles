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
import type { PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { emitPainDetectedEvent } from './pain.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
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
  filePath: string;
  reason: string;
  toolName: string;
  sessionId?: string;
  /** Source module that triggered the block (for audit trail) */
  blockSource?: string;
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

  // Default logger if not provided
  const logWarn = (msg: string) => logger.warn?.(msg);
  const logError = (msg: string) => logger.error?.(msg);

  // Log the block event
  const sourceTag = blockSource ? `[${blockSource}]` : '';
  logError(`[PD_GATE]${sourceTag} BLOCKED: ${filePath}. Reason: ${reason}`);

  // 1. Track block for session-level GFI calculation
  if (sessionId) {
    trackBlock(sessionId);
  }

  // 2. Prepare trajectory payload
  const trajectoryPayload = {
    sessionId: sessionId ?? null,
    toolName,
    filePath,
    reason,
    blockSource: blockSource ?? 'gate',
  };

  // 3. Record to EventLog (primary persistence)
  try {
    wctx.eventLog.recordGateBlock(sessionId, {
      toolName,
      filePath,
      reason,
      blockSource: blockSource ?? 'gate',
    });
  } catch (error: unknown) {
    logWarn(`[PD_GATE] Failed to record gate block event: ${String(error)}`);
  }

  // 4. Record to trajectory (secondary persistence with retry)
  try {
    wctx.trajectory?.recordGateBlock?.(trajectoryPayload);
  } catch (error: unknown) {
    logWarn(`[PD_GATE] Failed to record trajectory gate block: ${String(error)}`);

     
    scheduleTrajectoryGateBlockRetry(wctx, trajectoryPayload, 1, logWarn, logError);
  }

  // 5. Record gate block pain context. Runtime V2 diagnosis is gated by GFI
  // so one mild block does not start a long diagnostician run.
  if (sessionId) {
    const GATE_BLOCK_PAIN_SCORE = 45; // Must be >= pain_trigger (40) so single gate block can trigger diagnosis (PRI-274)
    // Record to trajectory (fire-and-forget, no .pain_flag file needed)
    wctx.trajectory?.recordPainEvent?.({
      sessionId,
      source: 'gate_blocked',
      score: GATE_BLOCK_PAIN_SCORE,
      reason: `Gate blocked ${toolName} on ${filePath}: ${reason}`,
      severity: 'mild',
      origin: 'system_infer',
    });

    // PEAT-B1: Evidence triage (feature-flagged)
    let triageAdmitted = true;
    const gateBlockTriageFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'painEvidenceAdmission');
    if (gateBlockTriageFlag.enabled) {
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
      const isUnsafe = isRisky(filePath, profile.risk_paths);
      const triage = evaluateEvidenceTriage('rulehost_block', GATE_BLOCK_PAIN_SCORE, {
        isUnsafeHighConfidence: isUnsafe,
      });
      if (triage.decision !== 'admit') {
        triageAdmitted = false;
        logger.info?.(`[PD_GATE] Triage ${triage.decision}: ${triage.reason}`);
      }
    }

    const session = getSession(sessionId);
    if (triageAdmitted) {
      const gate = evaluatePainDiagnosticGate({
        source: 'gate_blocked',
        score: GATE_BLOCK_PAIN_SCORE,
        currentGfi: session?.currentGfi ?? 0,
        consecutiveErrors: session?.consecutiveErrors ?? 0,
        sessionId,
        errorHash: `${toolName}:${filePath}:${reason}`,
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
            painId: `gate_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            painType: 'user_frustration',
            source: 'gate_blocked',
            reason: `Gate blocked ${toolName} on ${filePath}: ${reason}`,
            score: GATE_BLOCK_PAIN_SCORE,
            sessionId,
            agentId: 'main',
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
  const blockMessage = buildContextualBlockMessage({ filePath, reason });

  return {
    block: true,
    blockReason: blockMessage,
  };
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
  payload: {
    sessionId: string | null;
    toolName: string;
    filePath: string;
    reason: string;
    blockSource?: string;
  },
  attempt: number,
  logWarn: (message: string) => void,
  logError: (message: string) => void
): void {
  if (attempt > TRAJECTORY_GATE_BLOCK_MAX_RETRIES) {
    logError(`[PD_GATE] Failed to persist trajectory gate block after ${TRAJECTORY_GATE_BLOCK_MAX_RETRIES} retries: ${payload.toolName} ${payload.filePath}`);
    return;
  }

  setTimeout(() => {
    try {
      wctx.trajectory?.recordGateBlock?.(payload);
      logWarn(`[PD_GATE] Trajectory gate block persisted on retry ${attempt}`);
    } catch (error: unknown) {
      logWarn(`[PD_GATE] Retrying trajectory gate block persistence (attempt ${attempt + 1}): ${String(error)}`);
      scheduleTrajectoryGateBlockRetry(wctx, payload, attempt + 1, logWarn, logError);
    }
  }, TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS * attempt).unref();
}
