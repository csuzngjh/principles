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
    currentGfi: number;
    gfiBySource?: Partial<Record<GfiSource, number>>;
    lastErrorSource?: string;
    consecutiveErrors: number;
    lastGfiDecayAt?: number;
    dailyGfiPeak?: number;
    lastActivityAt: number;
    workspaceDir?: string;
  }[];
  nowMs: number;
  staleCutoffMs?: number; // default: 2 hours
  policy?: GfiPolicy;
}

export interface GfiWorkspaceSnapshot {
  active: GfiSnapshot | null;
  staleSessionCount: number;
  staleGfiRange: { min: number; max: number } | null;
  totalSessionCount: number;
  activeSessionCount: number;
  generatedAt: string;
}

const DEFAULT_STALE_CUTOFF_MS = 2 * 60 * 60 * 1000; // 2 hours

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
    if (session.lastActivityAt >= cutoffTime) {
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
      session.currentGfi > selectedActive.currentGfi ||
      (session.currentGfi === selectedActive.currentGfi &&
        session.lastActivityAt > selectedActive.lastActivityAt)
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
      min: Math.min(...staleGfis),
      max: Math.max(...staleGfis),
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
