/**
 * Fallback Audit — CONTRACT-04 & CONTRACT-05
 * ==========================================
 *
 * This module is the authoritative registry of all fallback behavior in the
 * evolution worker pipeline. Each silent fallback has been classified as:
 *
 * - fail-fast: Boundary entry error — return/stop at the boundary, do not continue pipeline.
 *   Examples: missing workspaceDir, corrupt queue, init failure.
 *
 * - fail-visible: Pipeline middle degradation — emit EventLog recordSkip/recordDrop event,
 *   then continue pipeline with degraded behavior.
 *   Examples: trajectory unavailable, heartbeat unavailable, flush failures.
 *
 * - removed: Fallback point no longer exists — processDetectionQueue retired per D-05.
 *   No EventLog wiring needed; location no longer exists in codebase.
 *
 * Design rule: "boundary entry" = fail-fast, "pipeline middle" = fail-visible.
 *
 * Downstream diagnostics consume EventLog 'skip' and 'drop' events to observe
 * pipeline degradation without blocking the pipeline.
 */

/**
 * Fallback classification: fail-fast, fail-visible, or removed.
 */
export type FallbackDisposition = 'fail-fast' | 'fail-visible' | 'removed';

/**
 * A single fallback point in the pipeline.
 */
export interface FallbackPoint {
  /** Unique ID within the fallback audit */
  id: string;
  /** Human-readable name */
  name: string;
  /** File and line reference */
  location: string;
  /** What operation is being guarded */
  guards: string;
  /** fail-fast, fail-visible, or removed */
  disposition: FallbackDisposition;
  /**
   * For fail-visible: the EventLog skip/drop reason string used.
   * For fail-fast: undefined or 'n/a'.
   * For removed: null.
   */
  eventReason: string | null;
  /**
   * For fail-visible: description of the degradation behavior.
   * For removed: 'Removed in Phase 28 (D-05 — detection queue retired)'.
   */
  fallbackBehavior: string;
}

/**
 * Complete registry of all fallback points in the evolution pipeline.
 * 14 active points + 2 removed + 1 N/A = 16 total from original audit.
 * Sorted by location (worker -> modules).
 */
export const FALLBACK_AUDIT: readonly FallbackPoint[] = [
  // ── FAIL-FAST (boundary entry) ──────────────────────────────────────────

  {
    id: 'FB-01',
    name: 'Missing workspaceDir',
    location: 'workspace-context.ts L184-187 (WorkspaceContext.fromHookContext)',
    guards: 'Worker requires a valid workspace to operate',
    disposition: 'fail-fast',
    eventReason: 'n/a',
    fallbackBehavior: 'n/a — worker cannot function without workspaceDir',
  },
  {
    id: 'FB-02',
    name: 'Missing stateDir',
    location: 'workspace-context.ts L199-203 (WorkspaceContext.fromHookContext)',
    guards: 'State directory must be computable for all subsequent operations',
    disposition: 'fail-fast',
    eventReason: 'n/a',
    fallbackBehavior: 'n/a — stateDir is required for session persistence, config, and queue',
  },
  {
    id: 'FB-03',
    name: 'initPersistence failure',
    location: 'session-tracker.ts L79-88 (initPersistence)',
    guards: 'Session persistence must be initialized before worker starts processing',
    disposition: 'fail-fast',
    eventReason: 'n/a',
    fallbackBehavior: 'n/a — running without session persistence risks session data loss',
  },
  {
    id: 'FB-06',
    name: 'Queue load corruption',
    location: 'evolution-queue-store.ts L270-336 (EvolutionQueueStore.load)',
    guards: 'Corrupt queue items cannot be safely processed',
    disposition: 'fail-fast',
    eventReason: 'n/a',
    fallbackBehavior: 'n/a — corrupt queue items are backed up and excluded; empty queue continues',
  },

  // ── FAIL-VISIBLE (pipeline middle) ──────────────────────────────────────

  {
    id: 'FB-04',
    name: 'checkWorkspaceIdle failure',
    location: 'task-context-builder.ts (buildCycleContext catch block)',
    guards: 'Idle determination may fail due to filesystem or session read errors',
    disposition: 'fail-visible',  // REVISED: was 'fail-fast' — actual behavior is fail-visible
    eventReason: 'checkWorkspaceIdle_error',
    fallbackBehavior: 'Returns default idle={isIdle:false}, emits eventLog.recordSkip(), pipeline continues with default idle assumption',
  },
  {
    id: 'FB-05',
    name: 'checkCooldown failure',
    location: 'task-context-builder.ts (buildCycleContext catch block)',
    guards: 'Cooldown check may fail due to filesystem or config read errors',
    disposition: 'fail-visible',  // REVISED: was 'fail-fast' — actual behavior is fail-visible
    eventReason: 'checkCooldown_error',
    fallbackBehavior: 'Returns default cooldown={globalCooldownActive:false}, emits eventLog.recordSkip(), pipeline continues with no cooldown',
  },
  {
    id: 'FB-07',
    name: 'PainFlagDetector error',
    location: 'evolution-worker.ts L266 (PainFlagDetector.detect catch block)',
    guards: 'Pain flag detection may fail due to filesystem or parsing errors',
    disposition: 'fail-visible',
    eventReason: 'pain_detector_error',
    fallbackBehavior: 'Returns {exists: false}, emits eventLog.recordSkip(), pipeline continues with no pain signal',
  },
  {
    id: 'FB-08',
    name: 'runHeartbeatOnce unavailable',
    location: 'evolution-worker.ts L291-308 (immediate heartbeat trigger)',
    guards: 'Immediate heartbeat triggering requires api.runtime.system.runHeartbeatOnce',
    disposition: 'fail-visible',
    eventReason: 'heartbeat_trigger_unavailable',
    fallbackBehavior: 'Diagnostician starts on next regular 15-minute cycle instead of immediately',
  },
  {
    id: 'FB-13',
    name: 'Dictionary flush failure',
    location: 'evolution-worker.ts L341 (wctx.dictionary.flush in finally block)',
    guards: 'Dictionary flush may fail due to filesystem errors',
    disposition: 'fail-visible',
    eventReason: 'dictionary_flush_failed',
    fallbackBehavior: 'Logs warning, emits eventLog.recordSkip(), cycle completes without flushing dictionary',
  },
  {
    id: 'FB-14',
    name: 'Session flush failure',
    location: 'evolution-worker.ts L342 (sessionTracker.flush in finally block)',
    guards: 'Session persistence flush may fail due to filesystem errors',
    disposition: 'fail-visible',
    eventReason: 'session_flush_failed',
    fallbackBehavior: 'Logs warning, emits eventLog.recordSkip(), cycle completes without persisting sessions',
  },
  {
    id: 'FB-15',
    name: 'Worker status write failure',
    location: 'evolution-worker.ts L189-196 (writeWorkerStatus)',
    guards: 'Non-critical monitoring file write may fail (permissions, disk full)',
    disposition: 'fail-visible',
    eventReason: 'worker_status_write_failed',
    fallbackBehavior: 'Silent catch, emits eventLog.recordSkip(), pipeline continues. Monitoring gap is acceptable.',
  },
  {
    id: 'FB-16',
    name: 'subagentRuntime unavailable for sweep',
    location: 'workflow-orchestrator.ts L250-266 (sweepExpired fallback path)',
    guards: 'subagentRuntime may not be available in all environments',
    disposition: 'fail-visible',
    eventReason: 'subagent_runtime_unavailable_sweep',
    fallbackBehavior: 'Workflows marked expired via WorkflowStore direct ops, session cleanup skipped. Warning logged.',
  },

  // ── REMOVED (D-05 — detection queue retired) ────────────────────────────

  {
    id: 'FB-09',
    name: 'processDetectionQueue entire failure',
    location: 'removed in Phase 28 (D-05 — detection queue retired)',
    guards: 'N/A — feature removed',
    disposition: 'removed',
    eventReason: null,
    fallbackBehavior: 'Removed in Phase 28 (D-05 — detection queue retired). processDetectionQueue no longer exists in evolution-worker.ts.',
  },
  {
    id: 'FB-10',
    name: 'L3 trajectory search no results',
    location: 'removed in Phase 28 (D-05 — detection queue retired)',
    guards: 'N/A — feature removed',
    disposition: 'removed',
    eventReason: null,
    fallbackBehavior: 'Removed in Phase 28 (D-05 — detection queue retired). L3 trajectory search no longer exists in evolution-worker.ts.',
  },
  {
    id: 'FB-11',
    name: 'Trajectory database unavailable',
    location: 'removed in Phase 28 (D-05 — detection queue retired)',
    guards: 'N/A — feature removed',
    disposition: 'removed',
    eventReason: null,
    fallbackBehavior: 'Removed in Phase 28 (D-05 — detection queue retired). Trajectory database check no longer exists in evolution-worker.ts.',
  },

  // ── N/A ─────────────────────────────────────────────────────────────────

  {
    id: 'FB-12',
    name: 'Pain candidate tracking removed (D-05)',
    location: 'N/A — intentional removal, not a fallback',
    guards: 'N/A — intentional removal, not a fallback',
    disposition: 'removed',
    eventReason: null,
    fallbackBehavior: 'N/A — feature intentionally removed, no action needed',
  },
] as const;

/**
 * Lookup a fallback point by ID.
 */
export function getFallback(id: string): FallbackPoint | undefined {
  return FALLBACK_AUDIT.find(fb => fb.id === id);
}

/**
 * Get all fail-fast fallback points.
 */
export function getFailFastFallbacks(): readonly FallbackPoint[] {
  return FALLBACK_AUDIT.filter(fb => fb.disposition === 'fail-fast');
}

/**
 * Get all fail-visible fallback points.
 */
export function getFailVisibleFallbacks(): readonly FallbackPoint[] {
  return FALLBACK_AUDIT.filter(fb => fb.disposition === 'fail-visible');
}

/**
 * Get all removed fallback points.
 */
export function getRemovedFallbacks(): readonly FallbackPoint[] {
  return FALLBACK_AUDIT.filter(fb => fb.disposition === 'removed');
}

/**
 * Validate that a given EventLog skip/drop reason matches a known fallback.
 * Useful for downstream diagnostics to correlate events with fallback points.
 */
export function isKnownFallbackReason(reason: string): boolean {
  return FALLBACK_AUDIT.some(fb => fb.eventReason === reason);
}
