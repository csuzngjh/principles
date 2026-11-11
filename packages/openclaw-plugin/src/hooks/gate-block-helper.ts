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
import type { TrajectoryDatabase, TrajectoryGateBlockInput } from '../core/trajectory.js';
import type { PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { loadPrincipleReceiptMetadata, type PrincipleReceiptMetadata } from '../core/principle-receipt-metadata.js';
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

  // 1. Track the block on the session (blockedAttempts counter). Guarded so the
  // persistGateBlock never-throws invariant holds end to end.
  if (sessionId) {
    try {
      trackBlock(sessionId);
    } catch (error: unknown) {
      logWarn(`[PD_GATE] Session block tracking skipped (reasonCode=block_track_failed): ${String(error)}`);
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
 * 1. Call trackBlock() for the session block tally
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
  const { filePath, reason, blockSource } = blockCtx;
  // Legacy hook path always has a resolvable path (gate.ts returns before
  // calling this when none can be extracted); the coercion only satisfies
  // the widened BlockContext contract for display/risk-matching contexts.
  const displayPath = filePath ?? '<unresolved>';

  // Default logger if not provided
  const logError = (msg: string) => logger.error?.(msg);

  // Log the block event
  const sourceTag = blockSource ? `[${blockSource}]` : '';
  logError(`[PD_GATE]${sourceTag} BLOCKED: ${displayPath}. Reason: ${reason}`);

  // Steps 1-4 (session block tally, EventLog row, trajectory row with
  // bounded retry) are the authoritative persistence core shared by BOTH
  // enforcement paths — the legacy hook path here, and
  // handleSharedRuleHostResult's deny branch (PRI-569).
  //
  // Phase A: a correct RuleHost block is a real technical fact, not Owner
  // behavioural-pain evidence. It persists gate_blocks but never creates a
  // Pain Event or Diagnostician task by itself. The Owner can still correct a
  // wrong block explicitly, which flows through the shared correction
  // detection instead.
  persistGateBlock(wctx, blockCtx, logger);

  // 5. Return consistent block result with contextual operator guidance
  // PRI-530: when principle_receipt_block_copy is enabled and this block came
  // from RuleHost, enrich the copy with principle attribution (SPEC §5.1).
  // PRI-1184 / F4: the SAME builder serves the shared host-runtime path, so
  // both enforcement paths produce the receipt copy from one authority.
  return {
    block: true,
    blockReason: buildGateBlockReason(wctx, blockCtx, logger),
  };
}

/**
 * The block-source tag the shared production gate writes for its denies
 * (PRI-569). Exported as the ONE authority for the tag: gate.ts writes it and
 * buildGateBlockReason accepts it as a RuleHost source.
 */
export const SHARED_RULE_HOST_BLOCK_SOURCE = 'rule-host-shared';

/**
 * Both enforcement paths narrate RuleHost decisions: the legacy hook path tags
 * `rule-host`, the shared production gate tags `rule-host-shared`. The receipt
 * copy is a RuleHost surface, not a source-specific one (PRI-1184 / F4).
 */
function isRuleHostBlockSource(source: string | undefined): boolean {
  return source === 'rule-host' || source === SHARED_RULE_HOST_BLOCK_SOURCE;
}

/**
 * PRI-530: owner-facing reason text for ONE gate block.
 *
 * Single authority for both enforcement paths (legacy hook path via
 * recordGateBlockAndReturn, shared production path via accountSharedDeny).
 * Receipt copy requires BOTH the flag and a RuleHost source, so a generic gate
 * block never claims principle attribution.
 */
export function buildGateBlockReason(
  wctx: WorkspaceContext,
  blockCtx: BlockContext,
  logger: { warn?: (_message: string) => void },
): string {
  const displayPath = blockCtx.filePath ?? '<unresolved>';
  const receiptFlag = loadFeatureFlagFromConfig(wctx.workspaceDir, 'principle_receipt_block_copy', logger);
  if (receiptFlag.enabled && isRuleHostBlockSource(blockCtx.blockSource)) {
    const metadata = loadPrincipleReceiptMetadata(wctx.workspaceDir, blockCtx.ruleId, blockCtx.principleId);
    if (metadata) {
      return buildReceiptBlockMessage({
        filePath: displayPath,
        reason: blockCtx.reason,
        toolName: blockCtx.toolName,
        metadata,
      });
    }
    logger.warn?.('[PD_GATE] Receipt metadata unresolved — generic block copy used (rc-9)');
  }
  return buildContextualBlockMessage({ filePath: displayPath, reason: blockCtx.reason });
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
