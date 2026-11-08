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
 *   of N simultaneous contenders wins.
 * - Stale takeover (crashed holder): only when the lock's mtime AND the
 *   renamed file's content match what we first observed as stale. The
 *   takeover itself is an atomic RENAME (claim), never a blind unlink — a
 *   lock that was replaced meanwhile (fresh mtime) is restored, so
 *   contenders can never delete a live holder's lock.
 * - Release is ownership-checked the same way: rename the lock aside, delete
 *   it only if its body is still OURS; otherwise restore it. A late release
 *   by an already-taken-over (stale) holder therefore cannot delete the new
 *   holder's lock.
 * - Acquisition waits asynchronously with a bounded deadline and returns a
 *   definitive not-acquired result; it never degrades into lock-free writing.
 *
 * Residual, documented: between a stale holder's crash and the STALE_MS
 * threshold the lock blocks (by design); the ultra-narrow window where a
 * third create lands while a wrongly-renamed fresh lock is being restored
 * parks the displaced body as an orphan sidecar (`.take-*`/`.rel-*`) that a
 * later stale takeover cleans up — mutual exclusion itself is preserved by
 * the 'wx' create point.
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

/** Atomic claim attempt: exactly one contender can create the file. */
function tryCreateExclusiveLock(lockPath: string, body: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
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
      // orphan sidecar; harmless (a later stale takeover cleans it)
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
 * bounded deadline. Returns undefined when the lock cannot be acquired in
 * time — callers must treat that as a loud failure (or a visible skip), never
 * degrade into lock-free writing.
 */
export async function acquireExclusiveLock(stateFilePath: string, options?: {
  lockPath?: string;
  staleMs?: number;
  timeoutMs?: number;
}): Promise<ExclusiveLockHandle | undefined> {
  const lockPath = options?.lockPath ?? controlStateLockPath(stateFilePath);
  const staleMs = options?.staleMs ?? CONTROL_STATE_LOCK_STALE_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? CONTROL_STATE_LOCK_TIMEOUT_MS);
  const token = newToken();
  const body = lockBody(token);
  // A first-ever transaction on a fresh install has no ~/.pd directory yet —
  // create it (same recursive mkdir the state write itself uses) so lock
  // creation cannot spin on ENOENT until the timeout.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // a real failure surfaces through the create/stat loop below
  }
  for (;;) {
    if (tryCreateExclusiveLock(lockPath, body)) return { lockPath, token, body };
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
    if (Date.now() >= deadline) return undefined;
    await sleep(CONTROL_STATE_LOCK_POLL_MS);
  }
}

/**
 * Synchronous one-shot variant for callers that must not await: tries to
 * create the lock once, and takes over a stale lock via the same
 * rename-claim protocol. Returns undefined when the lock is busy (the caller
 * skips loudly — it must never write without the lock).
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
    // a real failure surfaces through the create/stat calls below
  }
  if (tryCreateExclusiveLock(lockPath, body)) return { lockPath, token, body };
  let staleBody: string | undefined;
  try {
    const stat = fs.statSync(lockPath);
    if (stat.mtimeMs < Date.now() - staleMs) staleBody = readLockBody(lockPath);
  } catch {
    return undefined;
  }
  if (staleBody !== undefined && takeOverStaleExclusiveLock({ lockPath, staleBody, sidecarToken: token, staleMs })) {
    if (tryCreateExclusiveLock(lockPath, body)) return { lockPath, token, body };
  }
  return undefined;
}
