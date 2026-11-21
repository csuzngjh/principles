/**
 * Shadow progress projection (F6 review fix — task §6 carry-forward).
 *
 * `lastProgressAt` must survive ACROSS runs and across dry-runs: the
 * latest-run operational status file only records the LAST run's execution
 * list (and a dry-run replaces it without a shadow section), so a run
 * sequence A→B→A — or shadow→dry-run→shadow — used to lose A's recorded
 * progress. This module owns a small, versioned, per-install projection
 * keyed by canonical workspace identity: `<pdHome>/service/shadow-progress.json`.
 *
 * Contract: reads/writes happen while the install-level run lock is held
 * (the caller's responsibility); writes merge (this run's updates
 * overwrite by key, every other workspace's entry is preserved) and are
 * atomic (temp + rename, same pattern as the status file). The store holds
 * PATHS + TIMESTAMPS only — no Pain content, task payload, or env values.
 * Bounded at 256 entries; on overflow the OLDEST-updatedAt entries are
 * evicted first (bounded output, rc-8).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SHADOW_PROGRESS_SCHEMA_VERSION = 'pd.shadow-progress.v1';
const MAX_ENTRIES = 256;
const MAX_REASON = 200;

export interface ShadowProgressEntry {
  /** The last evidenced business-progress timestamp for this workspace. */
  readonly lastProgressAt: string;
  /** How the timestamp was evidenced (mirrors the status record field). */
  readonly source: 'task_state_change' | 'cycle_evidence';
  /** When this entry was last merged (store bookkeeping). */
  readonly updatedAt: string;
}

export type ShadowProgressVerdict = 'ok' | 'missing' | 'corrupt' | 'unreadable';

export type ShadowProgressRead =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, ShadowProgressEntry>; readonly verdict: ShadowProgressVerdict }
  | { readonly ok: false; readonly reason: string; readonly verdict: 'corrupt' | 'unreadable' };

export function shadowProgressPath(pdHome: string): string {
  return path.join(pdHome, 'service', 'shadow-progress.json');
}

interface StoreShape {
  readonly schemaVersion: string;
  readonly entries: Record<string, ShadowProgressEntry>;
}

function isEntry(value: unknown): value is ShadowProgressEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.lastProgressAt === 'string'
    && record.lastProgressAt.length > 0
    && (record.source === 'task_state_change' || record.source === 'cycle_evidence')
    && typeof record.updatedAt === 'string';
}

/**
 * Read the projection. A missing file is `missing` (empty map) — never an
 * error; a corrupt/unreadable file is a structured, observable failure and
 * the caller degrades to "no previous progress" WITHOUT deleting the file
 * (preservation over cleanup).
 */
export function readShadowProgress(pdHome: string): ShadowProgressRead {
  const file = shadowProgressPath(pdHome);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String(Reflect.get(error, 'code'))
      : '';
    if (code === 'ENOENT') {
      return { ok: true, entries: new Map(), verdict: 'missing' };
    }
    return { ok: false, reason: `shadow_progress_read_failed:${code || 'unknown'}`, verdict: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'shadow_progress_unparsable', verdict: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'shadow_progress_not_an_object', verdict: 'corrupt' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== SHADOW_PROGRESS_SCHEMA_VERSION) {
    return { ok: false, reason: `shadow_progress_schema_mismatch:${String(record.schemaVersion).slice(0, 40)}`, verdict: 'corrupt' };
  }
  const entries: Map<string, ShadowProgressEntry> = new Map();
  const rawEntries: unknown = record.entries;
  if (rawEntries !== undefined) {
    if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) {
      return { ok: false, reason: 'shadow_progress_entries_not_an_object', verdict: 'corrupt' };
    }
    for (const [key, value] of Object.entries(rawEntries)) {
      if (!isEntry(value)) {
        return { ok: false, reason: `shadow_progress_entry_invalid:${key.slice(0, 60)}`, verdict: 'corrupt' };
      }
      entries.set(key, value);
    }
  }
  return { ok: true, entries, verdict: 'ok' };
}

/**
 * Merge this run's updates into the projection and persist atomically.
 * Keys are canonical workspace identity forms; values for workspaces not in
 * `updates` are preserved verbatim. Bounded: beyond MAX_ENTRIES the oldest
 * updatedAt entries are evicted (this run's updates always survive).
 */
export function mergeShadowProgress(
  pdHome: string,
  updates: ReadonlyMap<string, ShadowProgressEntry>,
): { ok: true; path: string; evicted: number } | { ok: false; reason: string; nextAction: string } {
  const file = shadowProgressPath(pdHome);
  const read = readShadowProgress(pdHome);
  const merged: Map<string, ShadowProgressEntry> = read.ok ? new Map(read.entries) : new Map();
  for (const [key, entry] of updates) {
    merged.set(key, entry);
  }
  let evicted = 0;
  if (merged.size > MAX_ENTRIES) {
    const ordered = [...merged.entries()].sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? -1 : 1));
    for (const [key] of ordered) {
      if (merged.size <= MAX_ENTRIES) break;
      if (updates.has(key)) continue; // this run's updates always survive
      merged.delete(key);
      evicted += 1;
    }
  }
  const payload: StoreShape = {
    schemaVersion: SHADOW_PROGRESS_SCHEMA_VERSION,
    entries: Object.fromEntries(merged),
  };
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, MAX_REASON) : String(error).slice(0, MAX_REASON);
    return { ok: false, reason: `shadow_progress_dir_unwritable:${message}`, nextAction: `Check the permissions of ${dir} and retry.` };
  }
  const temp = path.join(dir, `.shadow-progress.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    return { ok: true, path: file, evicted };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort cleanup of our own temp file
    }
    const message = error instanceof Error ? error.message.slice(0, MAX_REASON) : String(error).slice(0, MAX_REASON);
    return { ok: false, reason: `shadow_progress_write_failed:${message}`, nextAction: 'Fix the reported filesystem problem and re-run; a partial progress file is never left behind.' };
  }
}
