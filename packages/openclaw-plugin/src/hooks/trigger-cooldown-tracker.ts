/**
 * Trigger Cooldown Tracker — PRI-363
 *
 * Manages cooldown state for trigger controller decisions.
 *
 * This is a plugin-layer concern because:
 * - Core (trigger-controller) is stateless and pure
 * - Cooldown state needs to persist across tool calls
 * - The map is scoped to the plugin's lifecycle
 *
 * EP-05: Loop State Freshness — each check reads fresh state from the map.
 * ERR-001: No `as` casts on map access.
 * ERR-002: Every rejected decision includes reason + nextAction.
 */

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Episode key format: sessionId:source:errorHash
 */
function buildEpisodeKey(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
): string {
  const sid = sessionId || 'unknown';
  const hash = errorHash || 'no-hash';
  return `${sid}:${source}:${hash}`;
}

/**
 * Check whether cooldown is currently active for a given episode.
 */
export function isCooldownActive(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
  cooldownMap: ReadonlyMap<string, number>,
): boolean {
  const episodeKey = buildEpisodeKey(source, sessionId, errorHash);
  const lastDiagnosedAt = cooldownMap.get(episodeKey);

  if (lastDiagnosedAt === undefined) {
    return false;
  }

  const now = Date.now();
  return now - lastDiagnosedAt < DEFAULT_COOLDOWN_MS;
}

/**
 * Mark an episode as diagnosed (set cooldown timestamp).
 */
export function markEpisodeAsDiagnosed(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
  cooldownMap: Map<string, number>,
): void {
  const episodeKey = buildEpisodeKey(source, sessionId, errorHash);
  cooldownMap.set(episodeKey, Date.now());
}

/**
 * Clear all cooldown state (for tests).
 */
export function clearCooldownState(cooldownMap: Map<string, number>): void {
  cooldownMap.clear();
}

/**
 * Get the cooldown timestamp for a given episode (for tests).
 */
export function getCooldownTimestamp(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
  cooldownMap: ReadonlyMap<string, number>,
): number | undefined {
  const episodeKey = buildEpisodeKey(source, sessionId, errorHash);
  return cooldownMap.get(episodeKey);
}

// ── Shared Cooldown Map (PRI-454) ───────────────────────────────────────────
//
// Module-level singleton Map shared across all Gate B paths.
// Replaces the per-file TRIGGER_COOLDOWN_MAP in after-tool-call-helpers.ts.
// All paths (gate-block, llm, empathy, manual pain) use this single Map
// to ensure unified cooldown state.

const SHARED_COOLDOWN_MAP = new Map<string, number>();

/**
 * Check whether cooldown is currently active using the shared Map.
 */
export function isSharedCooldownActive(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
): boolean {
  return isCooldownActive(source, sessionId, errorHash, SHARED_COOLDOWN_MAP);
}

/**
 * Mark an episode as diagnosed using the shared Map.
 */
export function markSharedEpisodeAsDiagnosed(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
): void {
  markEpisodeAsDiagnosed(source, sessionId, errorHash, SHARED_COOLDOWN_MAP);
}

/**
 * Clear all shared cooldown state (for tests).
 */
export function resetSharedCooldownForTest(): void {
  SHARED_COOLDOWN_MAP.clear();
}