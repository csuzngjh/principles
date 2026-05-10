/**
 * GFI Observability Read Model
 *
 * Pure domain model for building workspace-level GFI snapshots.
 * Partitions sessions into active vs stale and produces an authoritative snapshot
 * for operator visibility.
 *
 * PRI-78: GFI Observability
 */

import type { GfiPolicy, GfiSource, GfiSnapshot, GfiState } from './gfi-types.js';
import { DEFAULT_GFI_POLICY } from './gfi-policy.js';
import { createGfiSnapshot } from './gfi-kernel.js';

export interface GfiReadModelInput {
  sessions: {
    sessionId: string;
    /** Defaults to 0 if omitted */
    currentGfi?: number;
    gfiBySource?: Partial<Record<GfiSource, number>>;
    lastErrorSource?: string;
    /** Defaults to 0 if omitted */
    consecutiveErrors?: number;
    lastGfiDecayAt?: number;
    dailyGfiPeak?: number;
    /** Defaults to 0 if omitted — session older than cutoff is classified stale */
    lastActivityAt?: number;
  }[];
  nowMs: number;
  /** Sessions with lastActivityAt < nowMs - staleCutoffMs are classified stale. Default: 2 hours */
  staleCutoffMs?: number;
  policy?: GfiPolicy;
}

/**
 * Workspace-level GFI snapshot — partitions sessions into active vs stale.
 *
 * Invariant: `active === null` iff `activeSessionCount === 0` (no active sessions exist).
 * Invariant: `staleGfiRange === null` iff `staleSessionCount === 0` (not an error state).
 */
export interface GfiWorkspaceSnapshot {
  /**
   * Snapshot for the highest-GFI active session.
   * Null when there are no active sessions (all stale, or no sessions exist).
   */
  active: GfiSnapshot | null;
  staleSessionCount: number;
  /**
   * Min/max GFI across all stale sessions.
   * Null when staleSessionCount === 0 (no stale sessions — not an error state).
   */
  staleGfiRange: { min: number; max: number } | null;
  totalSessionCount: number;
  activeSessionCount: number;
  generatedAt: string;
}

const DEFAULT_STALE_CUTOFF_MS = 2 * 60 * 60 * 1000; // 2 hours

const DEFAULT_STALE_GFI_DEGRADED_THRESHOLD = 40;

export interface GfiWorkspaceHealthAssessment {
  status: 'healthy' | 'degraded';
  reason: string;
  staleGfiDegradedThreshold: number;
}

export function classifyGfiWorkspaceHealth(
  snapshot: GfiWorkspaceSnapshot,
  options?: { staleGfiDegradedThreshold?: number },
): GfiWorkspaceHealthAssessment {
  const staleGfiDegradedThreshold = options?.staleGfiDegradedThreshold ?? DEFAULT_STALE_GFI_DEGRADED_THRESHOLD;

  if (snapshot.active !== null && snapshot.active.currentGfi >= staleGfiDegradedThreshold) {
    return {
      status: 'degraded',
      reason: `Active session has elevated GFI (${snapshot.active.currentGfi})`,
      staleGfiDegradedThreshold,
    };
  }

  if (snapshot.activeSessionCount === 0 && snapshot.staleSessionCount > 0) {
    const maxStaleGfi = snapshot.staleGfiRange?.max ?? 0;
    if (maxStaleGfi >= staleGfiDegradedThreshold) {
      return {
        status: 'degraded',
        reason: `No active sessions, ${snapshot.staleSessionCount} stale sessions with high GFI (max: ${maxStaleGfi})`,
        staleGfiDegradedThreshold,
      };
    }
    return {
      status: 'healthy',
      reason: `No active sessions, ${snapshot.staleSessionCount} stale sessions with low GFI (max: ${maxStaleGfi})`,
      staleGfiDegradedThreshold,
    };
  }

  return {
    status: 'healthy',
    reason: `${snapshot.activeSessionCount} active, ${snapshot.staleSessionCount} stale sessions`,
    staleGfiDegradedThreshold,
  };
}

/**
 * Convert a session's fields to a GfiState for snapshot creation.
 * Note: lastErrorHash is not persisted across sessions, so we omit it.
 */
function sessionToGfiState(
  session: GfiReadModelInput['sessions'][0],
): GfiState {
  return {
    currentGfi: session.currentGfi ?? 0,
    gfiBySource: (session.gfiBySource ?? {}),
    lastErrorSource: session.lastErrorSource,
    consecutiveErrors: session.consecutiveErrors ?? 0,
    lastGfiDecayAt: session.lastGfiDecayAt,
    dailyGfiPeak: session.dailyGfiPeak,
  };
}

/**
 * Build a workspace-level GFI snapshot from session data.
 *
 * Algorithm:
 * 1. Default stale cutoff to 2 hours if not provided
 * 2. Partition sessions into active (lastActivityAt >= nowMs - staleCutoffMs) and stale
 * 3. Select active session with highest currentGfi (tie-break: most recent lastActivityAt)
 * 4. Build GfiSnapshot for selected active session using createGfiSnapshot
 * 5. Compute staleGfiRange from stale sessions' currentGfi values
 * 6. Return GfiWorkspaceSnapshot
 *
 * Key invariant: stale sessions do NOT influence the active snapshot.
 * This prevents old UAT sessions with GFI=197.8 from making current health look critical.
 */
export function buildGfiWorkspaceSnapshot(
  input: GfiReadModelInput,
): GfiWorkspaceSnapshot {
  const { sessions, nowMs, policy = DEFAULT_GFI_POLICY } = input;
  const staleCutoffMs = input.staleCutoffMs ?? DEFAULT_STALE_CUTOFF_MS;

  if (sessions.length === 0) {
    return {
      active: null,
      staleSessionCount: 0,
      staleGfiRange: null,
      totalSessionCount: 0,
      activeSessionCount: 0,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  const cutoffTime = nowMs - staleCutoffMs;

  // Partition sessions
  const activeSessions: GfiReadModelInput['sessions'] = [];
  const staleSessions: GfiReadModelInput['sessions'] = [];

  for (const session of sessions) {
    if ((session.lastActivityAt ?? 0) >= cutoffTime) {
      activeSessions.push(session);
    } else {
      staleSessions.push(session);
    }
  }

  // Select active session: highest currentGfi, tie-break by most recent lastActivityAt
  let selectedActive: GfiReadModelInput['sessions'][0] | null = null;

  for (const session of activeSessions) {
    if (
      selectedActive === null ||
      (session.currentGfi ?? 0) > (selectedActive.currentGfi ?? 0) ||
      ((session.currentGfi ?? 0) === (selectedActive.currentGfi ?? 0) &&
        (session.lastActivityAt ?? 0) > (selectedActive.lastActivityAt ?? 0))
    ) {
      selectedActive = session;
    }
  }

  // Build snapshot for active session
  const activeSnapshot: GfiSnapshot | null = selectedActive
    ? createGfiSnapshot(sessionToGfiState(selectedActive), policy)
    : null;

  // Compute stale GFI range
  let staleGfiRange: { min: number; max: number } | null = null;

  if (staleSessions.length > 0) {
    const staleGfis = staleSessions.map((s) => s.currentGfi ?? 0);
    staleGfiRange = {
      min: staleGfis.reduce((a, b) => Math.min(a, b), Infinity),
      max: staleGfis.reduce((a, b) => Math.max(a, b), -Infinity),
    };
  }

  return {
    active: activeSnapshot,
    staleSessionCount: staleSessions.length,
    staleGfiRange,
    totalSessionCount: sessions.length,
    activeSessionCount: activeSessions.length,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
