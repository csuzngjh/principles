/**
 * Durable degraded-enforcement marker (security audit run-1,
 * gate-failopen-allow-on-state-corruption).
 *
 * The RuleHost gate fails open when the governance store is unavailable
 * (missing/corrupt `.pd/state.db`) — the documented availability posture. But
 * the store lives in a space the governed agent can write, so "unavailable"
 * is an attacker-choosable state, and the only in-source trace was a per-call
 * warning plus an ambiguous console read model. This module records a durable
 * marker OUTSIDE the agent-writable workspace (`~/.pd/enforcement-health/`)
 * so an Owner can distinguish "enforcement degraded because the governance
 * store was deleted/corrupt" from an ordinary never-initialized workspace.
 *
 * Best-effort by contract: every failure is swallowed. This is observability
 * layered on top of the fail-open decision — it must never break gating.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DegradedEnforcementRecord {
  workspaceDir: string;
  reason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

/**
 * Three-state read result (PRI-1210). `unknown` is a real state, not a
 * degraded-to-healthy default: a marker file that exists but cannot be read,
 * parsed or validated means we do NOT know whether enforcement was bypassed,
 * and callers must not print it as healthy or as 0.
 */
export type DegradedEnforcementState = 'healthy' | 'degraded' | 'unknown';

export interface DegradedEnforcementReading {
  state: DegradedEnforcementState;
  markerPath: string;
  /** Present when state === 'degraded'. */
  reason?: string;
  /** Present when state === 'degraded'. */
  firstSeenAt?: string;
  /** Present when state === 'degraded' (the most recent observed fail-open). */
  lastSeenAt?: string;
  /** Present when state === 'degraded'. */
  occurrences?: number;
  /** Present when state === 'unknown' — why the marker could not be read. */
  unreadableReason?: string;
  /** Present when state !== 'healthy'. */
  nextAction?: string;
}

const UNREADABLE_MARKER_NEXT_ACTION =
  'Inspect the marker file and the workspace governance store. Enforcement ran fail-open when this was recorded; the recorder never clears the marker automatically — after investigating, an Owner may delete the marker file to reset this signal.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the persisted record as untrusted runtime data (rc-1..rc-4).
 * A record missing/malforming any field is NOT silently repaired: repairing it
 * would invent evidence about an enforcement bypass.
 */
function parseDegradedEnforcementRecord(value: unknown): DegradedEnforcementRecord | null {
  if (!isRecord(value)) return null;
  const { workspaceDir, reason, firstSeenAt, lastSeenAt, occurrences } = value;
  if (typeof workspaceDir !== 'string' || workspaceDir === '') return null;
  if (typeof reason !== 'string' || reason === '') return null;
  if (typeof firstSeenAt !== 'string' || !Number.isFinite(Date.parse(firstSeenAt))) return null;
  if (typeof lastSeenAt !== 'string' || !Number.isFinite(Date.parse(lastSeenAt))) return null;
  if (typeof occurrences !== 'number' || !Number.isSafeInteger(occurrences) || occurrences < 1) return null;
  return { workspaceDir, reason, firstSeenAt, lastSeenAt, occurrences };
}

function unknownReading(markerPath: string, unreadableReason: string): DegradedEnforcementReading {
  return { state: 'unknown', markerPath, unreadableReason, nextAction: UNREADABLE_MARKER_NEXT_ACTION };
}

function markerDir(): string {
  return path.join(path.resolve(os.homedir()), '.pd', 'enforcement-health');
}

/** Stable per-workspace marker path (keyed by resolved workspace dir). */
export function markerPathFor(workspaceDir: string): string {
  const key = createHash('sha256').update(path.resolve(workspaceDir), 'utf8').digest('hex').slice(0, 16);
  return path.join(markerDir(), `degraded-${key}.json`);
}

/**
 * Record (or bump) the degraded-enforcement marker for a workspace.
 * Overwrites atomically; repeated occurrences accumulate a counter and refresh
 * `lastSeenAt` so a stale marker is distinguishable from an active one.
 */
export function recordDegradedEnforcement(workspaceDir: string, reason: string, now = new Date()): void {
  try {
    const dir = markerDir();
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = markerPathFor(workspaceDir);

    let previous: Partial<DegradedEnforcementRecord> | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        previous = parsed;
      }
    } catch {
      // First occurrence, or the previous marker was unreadable — start fresh.
    }

    const timestamp = now.toISOString();
    const record: DegradedEnforcementRecord = {
      workspaceDir: path.resolve(workspaceDir),
      reason,
      firstSeenAt: typeof previous?.firstSeenAt === 'string' ? previous.firstSeenAt : timestamp,
      lastSeenAt: timestamp,
      occurrences: (typeof previous?.occurrences === 'number' && Number.isSafeInteger(previous.occurrences)
        ? previous.occurrences
        : 0) + 1,
    };

    const tmpPath = `${markerPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, markerPath);
  } catch {
    // Observability only — the gate's fail-open decision stands regardless.
  }
}

/**
 * Read the durable degraded-enforcement marker for one workspace (PRI-1210).
 *
 * - no marker file        → `healthy` (the gate never fail-opened here);
 * - valid marker file     → `degraded` with the recorded reason and timing;
 * - unreadable / malformed → `unknown` (never folded into healthy or into 0).
 *
 * The marker is a historical record, not a live probe: `lastSeenAt` is the most
 * recent observed fail-open, and this reader does not prove the current state
 * of the governance store. Read-only by contract.
 */
export function readDegradedEnforcement(workspaceDir: string): DegradedEnforcementReading {
  const markerPath = markerPathFor(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error: unknown) {
    // rc-5: Object.hasOwn, not `in`, on a runtime-provided error object.
    if (isRecord(error) && Object.hasOwn(error, 'code') && error.code === 'ENOENT') {
      return { state: 'healthy', markerPath };
    }
    const message = error instanceof Error ? error.message : String(error);
    return unknownReading(markerPath, `marker_unreadable: ${message}`.slice(0, 300));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownReading(markerPath, 'marker_malformed_json');
  }
  const record = parseDegradedEnforcementRecord(parsed);
  if (record === null) return unknownReading(markerPath, 'marker_shape_invalid');
  // rc-6 lineage consistency: the marker path is keyed by the resolved
  // workspace string, so a record naming another workspace means the file was
  // tampered with or copied — report unknown instead of trusting the reason.
  if (path.resolve(record.workspaceDir) !== path.resolve(workspaceDir)) {
    return unknownReading(markerPath, 'marker_workspace_mismatch');
  }
  return {
    state: 'degraded',
    markerPath,
    reason: record.reason,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    occurrences: record.occurrences,
    nextAction: UNREADABLE_MARKER_NEXT_ACTION,
  };
}
