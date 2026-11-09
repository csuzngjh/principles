/**
 * PRI-1140 — per-invocation memory of the adaptive principle resolution.
 *
 * `resolveAdaptivePriorityForHook` resolves a `{principleId}` mapping to the
 * single currently-authorized activation at provider time (inside the shared
 * runtime call). `handleBeforePromptBuild` needs the SAME resolved identity
 * later in the same invocation — for the mid-flight mapping-change comparison
 * and for the adaptive journal target. This module carries that identity
 * across the two halves of one invocation, mirroring the bounded snapshot
 * memory of `adaptive-config-identity.ts`:
 *
 * - keyed by the invocation's `hookInvocationId` (never by session or event —
 *   a replay or duplicate callback cannot consume another invocation's
 *   resolution);
 * - consume-once: `take` removes the entry, so a second callback for the same
 *   invocation degrades to the safe native baseline exactly like a lost
 *   controlled-admission handoff;
 * - bounded (capacity + TTL), never fabricated: a missing entry is
 *   `undefined`, not a guessed identity.
 *
 * This is per-round state ONLY. The Owner supplementary condition requires the
 * target to be re-resolved every request, so nothing here survives beyond the
 * invocation that produced it (the next prompt build resolves fresh).
 */

export interface AdaptivePrincipleResolution {
  principleId: string;
  artifactId: string;
  activationId: string;
}

const MAX_RESOLUTIONS = 64;
const RESOLUTION_TTL_MS = 30 * 60 * 1000;

const resolutions = new Map<string, { resolution: AdaptivePrincipleResolution; storedAt: number }>();

function evictExpired(now: number): void {
  for (const [id, entry] of resolutions) {
    if (now - entry.storedAt > RESOLUTION_TTL_MS) {
      resolutions.delete(id);
    }
  }
}

export function rememberAdaptivePrincipleResolution(
  hookInvocationId: string,
  resolution: AdaptivePrincipleResolution,
): void {
  const now = Date.now();
  evictExpired(now);
  while (resolutions.size >= MAX_RESOLUTIONS) {
    const oldest = resolutions.keys().next().value;
    if (oldest === undefined) break;
    resolutions.delete(oldest);
  }
  resolutions.set(hookInvocationId, { resolution: { ...resolution }, storedAt: now });
}

/** Consume-once: the resolution belongs to exactly one post-selection half. */
export function takeAdaptivePrincipleResolution(hookInvocationId: string | undefined): AdaptivePrincipleResolution | undefined {
  if (!hookInvocationId) return undefined;
  const entry = resolutions.get(hookInvocationId);
  resolutions.delete(hookInvocationId);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > RESOLUTION_TTL_MS) return undefined;
  return entry.resolution;
}

export function peekAdaptivePrincipleResolutionSizeForTest(): number {
  return resolutions.size;
}

/** Test-only reset for module-level state. */
export function resetAdaptivePrincipleResolutionForTest(): void {
  resolutions.clear();
}
