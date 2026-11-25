/**
 * Same-process correlation between OpenClaw's before_prompt_build and
 * after_tool_call hooks.
 *
 * OpenClaw exposes a host runId on both callbacks, but runId is NOT a turn id.
 * We use it only as a join key to the exact PD-owned user_turn row (or native
 * message id) captured during before_prompt_build. The value returned to Core
 * is that turn identity, never the runId itself.
 *
 * The map is intentionally bounded and short-lived. A restart, missing runId,
 * session mismatch, workspace mismatch or expired entry means no correlation;
 * receipt recovery then stays unbound instead of guessing the latest session
 * turn.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_ENTRIES = 512;
const TTL_MS = 30 * 60 * 1000;

interface RunTurnEntry {
  /** undefined is an ambiguity tombstone: the host reused a run id for a different turn. */
  readonly targetTurnId: string | undefined;
  readonly messageDigest: string | undefined;
  readonly expiresAt: number;
}

const entries = new Map<string, RunTurnEntry>();

function usable(value: unknown, maxLength = 200): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

function key(input: { workspaceDir: string; sessionId: string; runId: string }): string | undefined {
  if (!usable(input.workspaceDir, 4096) || !usable(input.sessionId) || !usable(input.runId, 256)) return undefined;
  return `${path.resolve(input.workspaceDir)}\u0000${input.sessionId}\u0000${input.runId}`;
}

/** Remember the exact turn identity produced by this run's persisted user-turn write. */
export function rememberOpenclawRunTurnCorrelation(input: {
  readonly workspaceDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly targetTurnId: string;
  /** Exact message bytes that were cross-checked against the final host message. */
  readonly message: string;
  readonly now?: number;
}): boolean {
  if (!usable(input.targetTurnId) || typeof input.message !== 'string' || input.message.length === 0) return false;
  const messageDigest = createHash('sha256').update(input.message, 'utf8').digest('hex');
  const entryKey = key(input);
  if (entryKey === undefined) return false;
  const now = input.now ?? Date.now();
  for (const [existingKey, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(existingKey);
  }
  const existing = entries.get(entryKey);
  if (existing !== undefined) {
    // OpenClaw run ids may be reused after a run ends. If the same tuple now
    // points at a different row, it is impossible to distinguish a late event
    // from the prior run; quarantine the key instead of silently retargeting it.
    if (existing.targetTurnId !== input.targetTurnId || existing.messageDigest !== messageDigest) {
      entries.set(entryKey, { targetTurnId: undefined, messageDigest: undefined, expiresAt: Math.max(existing.expiresAt, now + TTL_MS) });
      return false;
    }
    entries.delete(entryKey);
    entries.set(entryKey, existing);
    return true;
  }
  entries.set(entryKey, { targetTurnId: input.targetTurnId, messageDigest, expiresAt: now + TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== 'string') break;
    entries.delete(oldest);
  }
  return true;
}

/** Confirm a repeated prompt callback is still the same admitted user message.
 * A runId reused for different text is quarantined, never retargeted. */
export function confirmOpenclawRunTurnMessage(input: {
  readonly workspaceDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly message: string;
  readonly now?: number;
}): boolean {
  const entryKey = key(input);
  if (entryKey === undefined || typeof input.message !== 'string') return false;
  const entry = entries.get(entryKey);
  if (entry === undefined) return false;
  const now = input.now ?? Date.now();
  if (entry.expiresAt <= now) {
    entries.delete(entryKey);
    return false;
  }
  const messageDigest = createHash('sha256').update(input.message, 'utf8').digest('hex');
  if (entry.targetTurnId === undefined || entry.messageDigest !== messageDigest) {
    entries.set(entryKey, { targetTurnId: undefined, messageDigest: undefined, expiresAt: Math.max(entry.expiresAt, now + TTL_MS) });
    return false;
  }
  return true;
}

/** Resolve only the same workspace/session/run tuple; never infer from session recency. */
export function resolveOpenclawRunTurnCorrelation(input: {
  readonly workspaceDir: string;
  readonly sessionId: string | undefined;
  readonly runId: string | undefined;
  /** Production consumes the mapping once so a reused runId cannot retarget a later tool call. */
  readonly consume?: boolean;
  readonly now?: number;
}): string | undefined {
  if (input.sessionId === undefined || input.runId === undefined) return undefined;
  const entryKey = key({ workspaceDir: input.workspaceDir, sessionId: input.sessionId, runId: input.runId });
  if (entryKey === undefined) return undefined;
  const entry = entries.get(entryKey);
  if (entry === undefined) return undefined;
  const now = input.now ?? Date.now();
  if (entry.expiresAt <= now) {
    entries.delete(entryKey);
    return undefined;
  }
  if (input.consume !== false) {
    // A target association is for one receipt completion. Consuming it prevents
    // a delayed or later tool call from reusing a stale runId mapping.
    entries.delete(entryKey);
  } else {
    // Test/diagnostic peek: refresh insertion order without extending TTL.
    entries.delete(entryKey);
    entries.set(entryKey, entry);
  }
  return entry.targetTurnId;
}

/** Test isolation only. */
export function clearOpenclawRunTurnCorrelationsForTest(): void {
  entries.clear();
}
