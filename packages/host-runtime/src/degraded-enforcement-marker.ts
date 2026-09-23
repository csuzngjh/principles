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
