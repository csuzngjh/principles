/**
 * Cross-process exclusive lock for product-telemetry control-state
 * read-modify-write transactions (PRI-1151).
 *
 * ONE lock file — `<state>.state-lock` — serializes every writer of
 * `~/.pd/product-telemetry.json`: the legacy v1→v2 migration write-back,
 * `pd telemetry enable/disable/reset`, and workspace export bookkeeping
 * merges (see consent-store.withControlStateLock and the service layer).
 *
 * Protocol (ownership-checked, crash-recoverable, bounded wait):
 *
 * - Acquire = `open(path, 'wx')` with an owner body
 *   `<pid> <token> <createdAtISO>`; 'wx' creation is atomic, so exactly one
 *   of N simultaneous contenders wins. A create failure other than
 *   EEXIST (e.g. EACCES on an unwritable directory) is reported immediately
 *   as `unwritable` — never misreported as lock contention and never spun
 *   against until the timeout. If the body write/close fails after creation,
 *   the freshly created file (which no other process can have taken over —
 *   it is younger than the stale threshold) is removed before failing.
 * - Stale takeover (crashed holder): only when the lock's mtime AND the
 *   renamed file's content match what we first observed as stale. The
 *   takeover itself is an atomic RENAME (claim), never a blind unlink — a
 *   lock that was replaced meanwhile (fresh mtime) is restored, so
 *   contenders can never delete a live holder's lock.
 * - Release is ownership-checked the same way: rename the lock aside, delete
 *   it only if its body is still OURS; otherwise restore it. A late release
 *   by an already-taken-over (stale) holder therefore cannot delete the new
 *   holder's lock.
 * - Ownership can be re-verified mid-transaction (ownsExclusiveLock): a
 *   transaction whose body ran longer than the stale threshold may find its
 *   lock taken over — its write must be refused (lock_lost) instead of
 *   committing without the mutex.
 * - Acquisition waits asynchronously with a bounded deadline and returns a
 *   definitive failure result; it never degrades into lock-free writing.
 * - Orphaned takeover/release sidecars (`.take-*` / `.rel-*`, left behind by
 *   a crash mid-rename) are swept by the next successful acquirer once they
 *   are older than the stale threshold — a sidecar that fresh may still be
 *   part of a live protocol step and is never touched.
 *
 * Residual, documented: between a stale holder's crash and the STALE_MS
 * threshold the lock blocks (by design); the ultra-narrow window where a
 * third create lands while a wrongly-renamed fresh lock is being restored
 * parks the displaced body as an orphan sidecar that a later stale sweep
 * cleans up — mutual exclusion itself is preserved by the 'wx' create point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A lock older than this is treated as orphaned (holder crashed) and taken over. */
export const CONTROL_STATE_LOCK_STALE_MS = 5 * 1000;
/** Bounded acquisition wait; exceeding it returns not-acquired (loud, never silent). */
export const CONTROL_STATE_LOCK_TIMEOUT_MS = 3 * 1000;
const CONTROL_STATE_LOCK_POLL_MS = 15;

export interface ExclusiveLockHandle {
  lockPath: string;
  /** Random per-acquisition token; identifies THIS holder inside the lock body. */
  token: string;
  /** The exact body we wrote (`<pid> <token> <createdAt>`); release checks it. */
  body: string;
}

/** Acquisition outcome: success, bounded-timeout contention, or a filesystem error. */
export type AcquireExclusiveLockResult =
  | { ok: true; handle: ExclusiveLockHandle }
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'unwritable'; detail: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function controlStateLockPath(stateFilePath: string): string {
  return `${stateFilePath}.state-lock`;
}

function lockBody(token: string): string {
  return `${process.pid} ${token} ${new Date().toISOString()}\n`;
}

function newToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function readLockBody(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether the lock file at `handle.lockPath` still carries OUR body. */
export function ownsExclusiveLock(handle: ExclusiveLockHandle): boolean {
  return readLockBody(handle.lockPath) === handle.body;
}

type CreateOutcome = 'created' | 'busy' | { error: string };

/**
 * Atomic claim attempt: exactly one contender can create the file. EEXIST is
 * contention ('busy'); any other failure (EACCES, ENOSPC, …) is an error. A
 * failure of the body write/close AFTER a successful create removes the
 * freshly created file — safe because it is younger than the stale
 * threshold, so no other process can have taken it over yet.
 */
function tryCreateExclusiveLock(lockPath: string, body: string): CreateOutcome {
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, body);
    fs.closeSync(fd);
    fd = undefined;
    return 'created';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // fd already closed or invalid
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // orphan with our token; stale takeover cleans it later
      }
    }
    if (code === 'EEXIST') return 'busy';
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${typeof code === 'string' ? code : ''} ${message}`.trim() };
  }
}

/**
 * Best-effort sweep of orphaned takeover/release sidecars, run by the
 * SUCCESSFUL acquirer (it owns the directory's lock protocol for this
 * instant). Only sidecars older than the stale threshold are removed — one
 * that fresh may still belong to a live protocol step in another process.
 */
function sweepOrphanSidecars(lockPath: string, staleMs: number): void {
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.take-`) && !entry.startsWith(`${base}.rel-`)) continue;
    const sidecar = path.join(dir, entry);
    try {
      if (fs.statSync(sidecar).mtimeMs >= Date.now() - staleMs) continue;
      fs.rmSync(sidecar, { force: true });
    } catch {
      // best effort; a failed sweep never blocks locking
    }
  }
}

/**
 * Take over a stale lock via atomic rename-claim. Valid only when the
 * renamed file's mtime is stale AND its body is the one we observed — a
 * lock replaced meanwhile (fresh mtime, different owner) is restored, never
 * deleted. Returns true when the stale lock was removed and the caller
 * should retry creation.
 */
function takeOverStaleExclusiveLock(args: {
  lockPath: string;
  staleBody: string;
  sidecarToken: string;
  staleMs: number;
}): boolean {
  const { lockPath, staleBody, sidecarToken, staleMs } = args;
  const takePath = `${lockPath}.take-${sidecarToken}`;
  try {
    fs.renameSync(lockPath, takePath);
  } catch {
    return false; // vanished or raced; the normal create/retry path decides
  }
  let takeStat: fs.Stats;
  try {
    takeStat = fs.statSync(takePath);
  } catch {
    return false;
  }
  const takeBody = readLockBody(takePath);
  if (takeStat.mtimeMs < Date.now() - staleMs && takeBody === staleBody) {
    // Exactly the stale lock we intended to remove.
    try {
      fs.rmSync(takePath, { force: true });
    } catch {
      // orphan sidecar; harmless (a later stale sweep cleans it)
    }
    return true;
  }
  // We grabbed a lock that was replaced meanwhile (a live holder). Restore
  // it so mutual exclusion is preserved; never delete a lock we do not own.
  try {
    if (!fs.existsSync(lockPath)) fs.renameSync(takePath, lockPath);
    // else: a new create already landed; leave the displaced body parked at
    // takePath (orphan sidecar). The newly created lock governs.
  } catch {
    // restore best-effort; the parked file becomes a stale-cleanable orphan
  }
  return false;
}

/**
 * Ownership-checked release: delete the lock only if its body is still OURS.
 * A holder that was taken over after going stale cannot delete the new
 * holder's lock — the displaced file is restored instead.
 */
export function releaseExclusiveLock(handle: ExclusiveLockHandle): void {
  const relPath = `${handle.lockPath}.rel-${handle.token}`;
  try {
    fs.renameSync(handle.lockPath, relPath);
  } catch {
    return; // already gone; nothing to release
  }
  if (readLockBody(relPath) === handle.body) {
    try {
      fs.rmSync(relPath, { force: true });
    } catch {
      // orphan sidecar; harmless
    }
    return;
  }
  // Not ours (we were taken over after going stale). Restore it — never
  // delete a lock another process owns.
  try {
    if (!fs.existsSync(handle.lockPath)) fs.renameSync(relPath, handle.lockPath);
  } catch {
    // best-effort restore
  }
}

/**
 * Acquire the cross-process exclusive lock, waiting asynchronously with a
 * bounded deadline. The result distinguishes bounded-timeout CONTENTION from
 * a FILESYSTEM failure (e.g. an unwritable directory) — both are loud, and
 * neither ever degrades into lock-free writing.
 */
export async function acquireExclusiveLock(stateFilePath: string, options?: {
  lockPath?: string;
  staleMs?: number;
  timeoutMs?: number;
}): Promise<AcquireExclusiveLockResult> {
  const lockPath = options?.lockPath ?? controlStateLockPath(stateFilePath);
  const staleMs = options?.staleMs ?? CONTROL_STATE_LOCK_STALE_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? CONTROL_STATE_LOCK_TIMEOUT_MS);
  const token = newToken();
  const body = lockBody(token);
  // A first-ever transaction on a fresh install has no ~/.pd directory yet —
  // create it (same recursive mkdir the state write itself uses) so lock
  // creation cannot fail on ENOENT. A real failure here surfaces as
  // 'unwritable' below.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: 'unwritable', detail: `mkdir failed: ${message}` };
  }
  for (;;) {
    const created = tryCreateExclusiveLock(lockPath, body);
    if (created === 'created') {
      sweepOrphanSidecars(lockPath, staleMs);
      return { ok: true, handle: { lockPath, token, body } };
    }
    if (typeof created === 'object') {
      return { ok: false, kind: 'unwritable', detail: created.error };
    }
    let stale = false;
    let staleBody: string | undefined;
    try {
      const stat = fs.statSync(lockPath);
      if (stat.mtimeMs < Date.now() - staleMs) {
        staleBody = readLockBody(lockPath);
        stale = staleBody !== undefined;
      }
    } catch {
      // vanished between create-attempt and stat; next loop's create decides
    }
    if (stale && staleBody !== undefined) {
      if (takeOverStaleExclusiveLock({ lockPath, staleBody, sidecarToken: token, staleMs })) continue;
    }
    if (Date.now() >= deadline) return { ok: false, kind: 'timeout' };
    await sleep(CONTROL_STATE_LOCK_POLL_MS);
  }
}

/**
 * Synchronous one-shot variant for callers that must not await: tries to
 * create the lock once, and takes over a stale lock via the same
 * rename-claim protocol. Returns undefined when the lock is busy or cannot
 * be created (the caller skips loudly — it must never write without the
 * lock).
 */
export function tryAcquireExclusiveLockSync(stateFilePath: string, options?: {
  lockPath?: string;
  staleMs?: number;
}): ExclusiveLockHandle | undefined {
  const lockPath = options?.lockPath ?? controlStateLockPath(stateFilePath);
  const staleMs = options?.staleMs ?? CONTROL_STATE_LOCK_STALE_MS;
  const token = newToken();
  const body = lockBody(token);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return undefined;
  }
  const created = tryCreateExclusiveLock(lockPath, body);
  if (created === 'created') {
    sweepOrphanSidecars(lockPath, staleMs);
    return { lockPath, token, body };
  }
  if (typeof created === 'object') return undefined;
  let staleBody: string | undefined;
  try {
    const stat = fs.statSync(lockPath);
    if (stat.mtimeMs < Date.now() - staleMs) staleBody = readLockBody(lockPath);
  } catch {
    return undefined;
  }
  if (staleBody !== undefined && takeOverStaleExclusiveLock({ lockPath, staleBody, sidecarToken: token, staleMs })) {
    const retried = tryCreateExclusiveLock(lockPath, body);
    if (retried === 'created') {
      sweepOrphanSidecars(lockPath, staleMs);
      return { lockPath, token, body };
    }
  }
  return undefined;
}
