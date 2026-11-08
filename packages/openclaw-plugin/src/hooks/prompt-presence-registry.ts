/**
 * PRI-1150 Path A: in-memory registry of frozen assembly snapshots for prompt
 * presence forensics (design v2 §4, as amended by the owner's three revision
 * constraints).
 *
 * Guarantees and honest limits:
 * - Fully bounded: registry keys, snapshots per key, total snapshots, total
 *   body bytes and snapshot TTL are internal constants below; every eviction
 *   or expiry is counted and DEGRADES BINDING (history loss), never silently.
 * - History loss is sticky for a key: once any snapshot of a key is dropped
 *   (TTL or capacity) the key can never regain unique-binding qualification —
 *   not by re-registration, not by remaining the only survivor. A bounded
 *   lossy-key marker set persists the fact after its entry is gone; it is NOT
 *   an unbounded tombstone table.
 * - Late/duplicate/out-of-order llm_input callbacks are evaluated against the
 *   CURRENT live set under the same verdict rules; ordering is never assumed.
 * - PD-internal assemblySeq numbers are diagnostic only; the official host
 *   event carries no assembly identity and none is claimed.
 * - Memory only. Nothing here is persisted, logged or emitted with body text.
 */

import * as path from 'node:path';

/** Central bound constants (single authority; all limits observable via verdicts). */
export const PRESENCE_REGISTRY_LIMITS = {
  /** Distinct runId+sessionId keys kept at once. Chosen above any plausible concurrent-run count on one host. */
  MAX_KEYS: 64,
  /** Prompt builds (tool loops, compaction retries) retained per run. */
  MAX_SNAPSHOTS_PER_KEY: 8,
  /** Global snapshot ceiling across all keys. */
  MAX_TOTAL_SNAPSHOTS: 128,
  /** Aggregate bodyText bytes across the whole registry. */
  MAX_TOTAL_BODY_BYTES: 1024 * 1024,
  /** Snapshots older than this are expired (history loss — see below). */
  SNAPSHOT_TTL_MS: 30 * 60 * 1000,
  /** Per-snapshot body-bytes ceiling; larger sets register as degraded. */
  MAX_SNAPSHOT_BODY_BYTES: 512 * 1024,
} as const;

export interface RegisteredExpectation {
  activationId: string;
  bodyText: string;
  bodyChars: number;
  bodyComplete: boolean;
}

export interface PresenceSnapshot {
  /** PD-internal per-key monotonic ordinal. Diagnostic only — the host event carries no assembly identity and none is claimed. */
  assemblySeq: number;
  frozenAtMs: number;
  expectations: readonly RegisteredExpectation[];
  /** Host-runtime-side overflow reported with this assembly (entries dropped at its own cap). */
  overflowCount: number;
  bodyBytes: number;
  /**
   * PRI-1150 review: present when this snapshot was registered DEGRADED —
   * its expectation set exceeded the per-snapshot body cap, so the frozen
   * set is empty and the observation can only be unknown:snapshot_over_limit.
   * Distinguishes "over-limit" from "nothing injected" (empty_snapshot).
   */
  degradedReason?: 'snapshot_over_limit';
  /** Why this snapshot's expectation set is empty/degraded (design revision: distinct sources). */
  emptyKind?: 'none_injected' | 'shared_field_absent' | 'target_removed_by_fallback' | 'generation_failed';
  /** Canonical workspace identity this snapshot belongs to (existing path.resolve mechanism). */
  workspaceId: string;
}

export type BindingStatus =
  | 'no_key'
  | 'history_incomplete'
  | 'expired'
  | 'unique'
  | 'ambiguous'
  | 'empty_snapshot';

export type BindingVerdict =
  | { status: 'no_key' }
  | { status: 'history_incomplete' }
  | { status: 'expired' }
  | { status: 'empty_snapshot'; snapshot: PresenceSnapshot }
  | { status: 'unique'; snapshot: PresenceSnapshot }
  | { status: 'ambiguous'; liveSnapshots: number };

interface RegistryEntry {
  snapshots: PresenceSnapshot[];
  nextAssemblySeq: number;
  /** False once any snapshot of this key was lost to TTL/capacity (sticky). */
  historyComplete: boolean;
}

function bodyBytesOf(expectations: readonly RegisteredExpectation[]): number {
  let total = 0;
  for (const expectation of expectations) {
    total += Buffer.byteLength(expectation.bodyText, 'utf8');
  }
  return total;
}

/**
 * PRI-1150 review (D4): canonical workspace identity via the SAME existing
 * normalization the workspace resolver uses for comparisons (path.resolve).
 * Unknown/absent workspace dirs get a single shared unknown identity — the
 * binding verdict stays honest (unknown) while the identity fact remains
 * distinct from any real workspace.
 */
function resolveWorkspaceIdentity(workspaceDir: string | undefined): string {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    return '\u0001unknown-workspace';
  }
  return path.resolve(workspaceDir);
}

export class PromptPresenceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /** Bounded marker: keys whose snapshot history was lost, surviving entry removal. */
  private readonly lossyKeys = new Map<string, true>();
  private totalSnapshots = 0;
  private totalBodyBytes = 0;
  private evictedCount = 0;
  private expiredCount = 0;
  /**
   * PRI-1150 review (D2): count of lossy markers dropped by the marker table's
   * own capacity. When > 0, a re-registered key with no surviving marker
   * CANNOT prove complete candidate history — such registrations start
   * history-incomplete (conservative). Documented scope/recovery: this only
   * affects keys re-registered after >MAX_KEYS whole-key evictions (heavy
   * churn); it never disables observations (events still emit with
   * history_incomplete), and a process restart resets the in-memory registry
   * entirely. No unbounded tombstone table is introduced.
   */
  private lossyMarkersDropped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Observable counters (for events/diagnostics; no body content). */
  stats(): { keys: number; snapshots: number; totalBodyBytes: number; evictedCount: number; expiredCount: number; lossyKeys: number } {
    return {
      keys: this.entries.size,
      snapshots: this.totalSnapshots,
      totalBodyBytes: this.totalBodyBytes,
      evictedCount: this.evictedCount,
      expiredCount: this.expiredCount,
      lossyKeys: this.lossyKeys.size,
    };
  }

  private keyOf(runId: string, sessionId: string, workspaceDir?: string): string {
    // PRI-1150 review (D4): the registry is process-wide, so the key MUST
    // carry the canonical workspace identity. Normalization uses the SAME
    // existing mechanism as workspace-dir-validation / the resolver
    // (path.resolve) — no custom lowercasing or concatenation.
    return `${resolveWorkspaceIdentity(workspaceDir)}\u0000${runId}\u0000${sessionId}`;
  }

  private workspaceIdOf(workspaceDir?: string): string {
    return resolveWorkspaceIdentity(workspaceDir);
  }

  /** Drops TTL-expired snapshots; returns true when any expired (history loss). */
  private sweepExpiredLocked(key: string, entry: RegistryEntry, nowMs: number): boolean {
    const ttl = PRESENCE_REGISTRY_LIMITS.SNAPSHOT_TTL_MS;
    const live = entry.snapshots.filter((snapshot) => nowMs - snapshot.frozenAtMs < ttl);
    const expired = entry.snapshots.length - live.length;
    if (expired === 0) return false;
    for (const snapshot of entry.snapshots) {
      if (nowMs - snapshot.frozenAtMs >= ttl) {
        this.totalSnapshots -= 1;
        this.totalBodyBytes -= snapshot.bodyBytes;
        this.expiredCount += 1;
      }
    }
    entry.snapshots = live;
    // Any TTL loss makes the remaining history incomplete — a later sole
    // survivor must not be mistaken for the only assembly ever made.
    entry.historyComplete = false;
    if (entry.snapshots.length === 0) {
      this.entries.delete(key);
      this.pushLossyKey(key);
    }
    return true;
  }

  private pushLossyKey(key: string): void {
    if (this.lossyKeys.has(key)) return;
    this.lossyKeys.set(key, true);
    // PRI-1150 review (D2): a DROPPED marker is itself a loss fact we can no
    // longer attribute to a key. Any subsequent re-registration of an
    // unmarked-and-absent key starts history-incomplete (see
    // registerAssemblySnapshot) — conservative, bounded, and documented.
    while (this.lossyKeys.size > PRESENCE_REGISTRY_LIMITS.MAX_KEYS) {
      const oldest = this.lossyKeys.keys().next();
      if (oldest.done) break;
      this.lossyKeys.delete(oldest.value);
      this.lossyMarkersDropped += 1;
    }
  }

  /** Drops whole oldest entries / oldest snapshots until the global caps hold. */
  private enforceGlobalCapsLocked(): void {
    const dropOldestSnapshot = (): boolean => {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        const candidate = entry.snapshots[0];
        if (candidate && candidate.frozenAtMs < oldestAt) {
          oldestAt = candidate.frozenAtMs;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return false;
      const entry = this.entries.get(oldestKey)!;
      const dropped = entry.snapshots.shift();
      if (!dropped) return false;
      this.totalSnapshots -= 1;
      this.totalBodyBytes -= dropped.bodyBytes;
      this.evictedCount += 1;
      entry.historyComplete = false;
      if (entry.snapshots.length === 0) {
        this.entries.delete(oldestKey);
        this.pushLossyKey(oldestKey);
      }
      return true;
    };

    while (this.totalSnapshots > PRESENCE_REGISTRY_LIMITS.MAX_TOTAL_SNAPSHOTS) {
      if (!dropOldestSnapshot()) break;
    }
    while (this.totalBodyBytes > PRESENCE_REGISTRY_LIMITS.MAX_TOTAL_BODY_BYTES) {
      if (!dropOldestSnapshot()) break;
    }
    while (this.entries.size > PRESENCE_REGISTRY_LIMITS.MAX_KEYS) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done) break;
      const entry = this.entries.get(oldestKey.value)!;
      this.totalSnapshots -= entry.snapshots.length;
      this.totalBodyBytes -= entry.snapshots.reduce((sum, snapshot) => sum + snapshot.bodyBytes, 0);
      this.evictedCount += entry.snapshots.length;
      this.entries.delete(oldestKey.value);
      this.pushLossyKey(oldestKey.value);
    }
  }

  registerAssemblySnapshot(params: {
    runId: string;
    sessionId: string;
    expectations: readonly RegisteredExpectation[];
    overflowCount?: number;
    /** Canonical workspace identity (existing path.resolve mechanism); scopes the key. */
    workspaceDir?: string;
    /** Why this assembly's expectation set is empty/degraded (distinct sources, design revision). */
    emptyKind?: PresenceSnapshot['emptyKind'];
  }): { registered: boolean; degradedReason?: 'snapshot_over_limit'; assemblySeq?: number } {
    const nowMs = this.now();
    const key = this.keyOf(params.runId, params.sessionId, params.workspaceDir);
    const bodyBytes = bodyBytesOf(params.expectations);
    const overLimit = bodyBytes > PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOT_BODY_BYTES;

    this.enforceGlobalCapsLocked();
    let entry = this.entries.get(key);
    // PRI-1150 review (D1): sweep BEFORE reading the loss state — a TTL sweep
    // triggered by THIS registration is itself a history-loss fact that must
    // poison the rebuilt entry (the old code read lossBefore first and
    // whitewashed the sweep).
    let entrySweptLoss = false;
    if (entry) {
      entrySweptLoss = this.sweepExpiredLocked(key, entry, nowMs);
    }
    const lossBefore =
      this.lossyKeys.get(key) === true ||
      // A dropped lossy MARKER (D2) or a swept loss (D1) means candidate
      // history cannot be proven complete for this key.
      this.lossyMarkersDropped > 0 ||
      entrySweptLoss;
    if (!entry || !this.entries.has(key)) {
      entry = { snapshots: [], nextAssemblySeq: 0, historyComplete: !lossBefore };
      this.entries.set(key, entry);
      this.lossyKeys.delete(key);
    }
    if (lossBefore) {
      // Re-registration never erases a past history loss for this key.
      entry.historyComplete = false;
    }

    const assemblySeq = ++entry.nextAssemblySeq;
    // PRI-1150 review (D5): degraded and normal snapshots share ONE capacity
    // path — per-key, global-snapshot, global-byte and key-count caps all
    // apply to both, and the degraded fact is carried on the snapshot itself
    // (never guessed from an empty array or an overflow count).
    const degradedReason = overLimit ? ('snapshot_over_limit' as const) : undefined;
    const snapshot: PresenceSnapshot = {
      assemblySeq,
      frozenAtMs: nowMs,
      expectations: overLimit ? [] : params.expectations.map((expectation) => ({ ...expectation })),
      overflowCount: params.overflowCount ?? 0,
      bodyBytes: overLimit ? 0 : bodyBytes,
      ...(degradedReason ? { degradedReason } : {}),
      ...(params.emptyKind ? { emptyKind: params.emptyKind } : {}),
      workspaceId: this.workspaceIdOf(params.workspaceDir),
    };
    entry.snapshots.push(snapshot);
    this.totalSnapshots += 1;
    if (!overLimit) this.totalBodyBytes += bodyBytes;
    // Per-key capacity (unified): dropping older snapshots of this key —
    // normal or degraded — is history loss.
    while (entry.snapshots.length > PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY) {
      const dropped = entry.snapshots.shift();
      if (!dropped) break;
      this.totalSnapshots -= 1;
      this.totalBodyBytes -= dropped.bodyBytes;
      this.evictedCount += 1;
      entry.historyComplete = false;
    }
    this.enforceGlobalCapsLocked();
    return { registered: true, degradedReason, assemblySeq };
  }

  resolveBinding(params: { runId: string; sessionId: string; workspaceDir?: string }): BindingVerdict {
    const nowMs = this.now();
    const key = this.keyOf(params.runId, params.sessionId, params.workspaceDir);
    const entry = this.entries.get(key);
    if (!entry) {
      return this.lossyKeys.has(key) ? { status: 'history_incomplete' } : { status: 'no_key' };
    }
    const sweptAny = this.sweepExpiredLocked(key, entry, nowMs);
    if (entry.snapshots.length === 0) {
      // Everything expired (or the entry never had live snapshots): a late
      // callback must not bind to whatever gets registered next.
      return sweptAny ? { status: 'expired' } : { status: 'history_incomplete' };
    }
    if (!entry.historyComplete) {
      return { status: 'history_incomplete' };
    }
    if (entry.snapshots.length === 1) {
      return { status: 'unique', snapshot: entry.snapshots[0]! };
    }
    return { status: 'ambiguous', liveSnapshots: entry.snapshots.length };
  }

  /** Test/diagnostic reset (per-workspace isolation); never called in production paths. */
  resetForTest(): void {
    this.entries.clear();
    this.lossyKeys.clear();
    this.totalSnapshots = 0;
    this.totalBodyBytes = 0;
    this.evictedCount = 0;
    this.expiredCount = 0;
    this.lossyMarkersDropped = 0;
  }
}

/** Process-wide registry singleton (one host process, one plugin runtime). */
const REGISTRY_KEY = Symbol.for('principles-disciple.promptPresenceRegistry');

export function getPromptPresenceRegistry(): PromptPresenceRegistry {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[REGISTRY_KEY]) {
    holder[REGISTRY_KEY] = new PromptPresenceRegistry();
  }
  return holder[REGISTRY_KEY] as PromptPresenceRegistry;
}
