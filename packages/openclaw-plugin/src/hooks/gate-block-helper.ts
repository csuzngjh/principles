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

import { trackBlock } from '../core/session-tracker.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import {
  TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS,
  TRAJECTORY_GATE_BLOCK_MAX_RETRIES
} from '../config/index.js';
import { buildPainFlag, writePainFlag } from '../core/pain.js';

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

  // 5. Emit pain signal for gate block (#256)
  // Gate blocks are a strong frustration signal — the agent tried to do something
  // and was blocked by a principle gate. This should feed into the nocturnal pipeline.
  if (sessionId) {
    const GATE_BLOCK_PAIN_SCORE = 30; // Moderate — not a failure but a blocked intent
    try {
      const trajectoryPainId = wctx.trajectory?.recordPainEvent?.({
        sessionId,
        source: 'gate_blocked',
        score: GATE_BLOCK_PAIN_SCORE,
        reason: `Gate blocked ${toolName} on ${filePath}: ${reason}`,
        severity: 'mild',
        origin: 'system_infer',
      });

      // Update .pain_flag if score is significant
      wctx.eventLog.recordPainSignal(sessionId, {
        source: 'gate_blocked',
        score: GATE_BLOCK_PAIN_SCORE,
        reason,
      });

      // Write to pain flag file (merge with existing if present)
      try {
         
        const workspaceDir = wctx.workspaceDir;
        const currentFlag = wctx.eventLog.findLatestPainSignal(sessionId);
        const currentScore = currentFlag?.score ?? 0;
        if (currentScore < GATE_BLOCK_PAIN_SCORE) {
          const flag = buildPainFlag({
            source: 'gate_blocked',
            score: String(GATE_BLOCK_PAIN_SCORE),
            reason: `Gate blocked: ${reason}`,
            session_id: sessionId,
            agent_id: 'main',
            is_risky: false,
            pain_event_id: trajectoryPainId !== undefined && trajectoryPainId >= 0 ? String(trajectoryPainId) : undefined,
          });
          writePainFlag(workspaceDir, flag);
        }
      } catch (flagErr) {
        logWarn(`[PD_GATE] Failed to update pain flag for gate block: ${String(flagErr)}`);
      }
    } catch (painErr) {
      logWarn(`[PD_GATE] Failed to record gate block pain signal: ${String(painErr)}`);
    }
  }

  // 6. Return consistent block result with operator guidance
  return {
    block: true,
    blockReason: `[Principles Disciple] Security Gate Blocked this action.
File: ${filePath}
Reason: ${reason}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 How to unblock this operation:

1. Use the plan-script skill to create a PLAN.md:
   → Invoke: skill:plan-script

2. Fill in the plan with:
   - Target Files: ${filePath}
   - Steps: What you want to do (be specific)
   - Metrics: How to verify success
   - Active Mental Models: Select 2 relevant models from .principles/THINKING_OS.md
   - Rollback: How to restore if it fails

3. After completing the plan, set STATUS: READY in PLAN.md

4. Retry the operation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is a mandatory security gate. The operation was blocked because the modification exceeds the allowed threshold for your current evolution tier.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  };
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
