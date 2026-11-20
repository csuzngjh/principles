/**
 * Install-level single-instance run lock (SPEC-PD-SERVICE-HOST-001 §8.2 step
 * 2, FR-08; TD §2.1 `locking/service-run-lock.ts`).
 *
 * The protocol is the one proven by PRI-1151's cross-process control-state
 * lock (`host-runtime/product-telemetry/control-state-lock.ts`): atomic
 * `'wx'` create with an owner body `<pid> <token> <createdAtISO>`; stale
 * takeover via atomic RENAME with body re-verification (a lock replaced
 * meanwhile is RESTORED, never deleted); ownership-checked release; orphan
 * sidecar sweeps. It is re-declared here rather than exported because the
 * semantic contract genuinely differs (P7: a real variation axis, not a
 * speculative seam):
 *
 *   - The control-state lock guards millisecond-scale read-modify-write
 *     transactions (5s stale window). A run-once coordinator legitimately
 *     runs for minutes, so a second coordinator must NEVER take over a lock
 *     that may still be a live run — the stale window is 30 minutes by
 *     default, and the takeover stays body-verified so a misdated-but-live
 *     lock can still be detected and restored.
 *   - Contention is an IMMEDIATE verdict, not a bounded wait: SPEC §8.2
 *     requires the second instance to report `already_running`, not to queue
 *     behind the first.
 *   - A stale mtime whose body cannot be read is `corrupt` (fail-closed,
 *     human decision), never silently takeover-able and never reported as a
 *     live run.
 *
 * Ownership facts: a live PID is NEVER takeover evidence (git-style — mtime
 * beyond the stale window AND byte-identical body are required together), so
 * "PID does not exist" alone can never recycle a lock.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A lock older than this is treated as a crashed holder. A legitimate
 * run-once (bounded cycles, Phase 2 per-workspace timeouts) must stay well
 * below this window; the dry-run of Phase 1 finishes in seconds.
 */
export const SERVICE_RUN_LOCK_STALE_MS = 30 * 60 * 1000;

/** The one lock file per install: `<pdHome>/service/service-run.lock`. */
export function serviceRunLockPath(pdHome: string): string {
  return path.join(pdHome, 'service', 'service-run.lock');
}

export interface ServiceRunLockHandle {
  readonly lockPath: string;
  /** Random per-acquisition token; identifies THIS holder inside the body. */
  readonly token: string;
  /** The exact body we wrote; release and re-verification check it. */
  readonly body: string;
}

export type AcquireServiceRunLockResult =
  | { ok: true; handle: ServiceRunLockHandle; staleTakenOver: boolean }
  | { ok: false; kind: 'held'; holderBodyHash: string }
  | { ok: false; kind: 'corrupt'; detail: string }
  | { ok: false; kind: 'unwritable'; detail: string };

/** A bounded, control-char-free echo of a lock body for diagnostics (rc-8). */
function bodyEcho(body: string): string {
  const clean = body.replace(/[^\x20-\x7E]+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}

function readLockBody(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Bounded echo of the current holder body for the `held` verdict. */
function heldVerdict(lockPath: string): { ok: false; kind: 'held'; holderBodyHash: string } {
  const body = readLockBody(lockPath);
  return { ok: false, kind: 'held', holderBodyHash: body === undefined ? 'unreadable' : bodyEcho(body) };
}

function lockBody(token: string): string {
  return `${process.pid} ${token} ${new Date().toISOString()}`;
}

/**
 * Atomic claim attempt: exactly one of N simultaneous contenders can create
 * the file. EEXIST is contention; any other failure is `unwritable` (never
 * misreported as contention). A body write failure after a successful
 * create removes the fresh file — safe: it is younger than the stale
 * window, so no other process can have taken it over yet.
 */
function tryCreate(lockPath: string, body: string): 'created' | 'busy' | { error: string } {
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
        ? String(Reflect.get(error, 'code'))
        : undefined;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // orphan with our token; stale sweep cleans it later
      }
    }
    if (code === 'EEXIST') return 'busy';
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${code ?? ''} ${message}`.trim() };
  }
}

/** Best-effort sweep of `.take-*` / `.rel-*` orphans older than the stale window. */
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
 * Stale takeover via atomic rename-claim, valid ONLY when the renamed file's
 * mtime is beyond the stale window AND its body is byte-identical to the one
 * observed as stale. A lock replaced meanwhile (fresh, different owner) is
 * restored — a contender can never delete a live holder's lock.
 */
function takeOverStale(args: {
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
    return false; // vanished or raced; the normal create path decides
  }
  let takeStat: fs.Stats;
  try {
    takeStat = fs.statSync(takePath);
  } catch {
    return false;
  }
  const takeBody = readLockBody(takePath);
  if (takeStat.mtimeMs < Date.now() - staleMs && takeBody === staleBody) {
    try {
      fs.rmSync(takePath, { force: true });
    } catch {
      // orphan sidecar; a later sweep cleans it
    }
    return true;
  }
  try {
    if (!fs.existsSync(lockPath)) fs.renameSync(takePath, lockPath);
  } catch {
    // restore best-effort; the parked body becomes a stale-cleanable orphan
  }
  return false;
}

/** True when the lock file still carries OUR body (mid-run ownership re-check). */
export function holdsServiceRunLock(handle: ServiceRunLockHandle): boolean {
  return readLockBody(handle.lockPath) === handle.body;
}

/**
 * Acquire the install-level single-instance run lock. Single attempt +
 * body-verified stale takeover, immediate verdicts — no wait loop
 * (`already_running` semantics, §8.2).
 */
export function acquireServiceRunLock(pdHome: string, options?: { staleMs?: number }): AcquireServiceRunLockResult {
  const lockPath = serviceRunLockPath(pdHome);
  const staleMs = options?.staleMs ?? SERVICE_RUN_LOCK_STALE_MS;
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  const body = lockBody(token);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: 'unwritable', detail: message };
  }

  const created = tryCreate(lockPath, body);
  if (created === 'created') {
    sweepOrphanSidecars(lockPath, staleMs);
    return { ok: true, handle: { lockPath, token, body }, staleTakenOver: false };
  }
  if (typeof created === 'object') {
    return { ok: false, kind: 'unwritable', detail: created.error };
  }

  // Busy. Take over ONLY a lock that is provably a crashed holder.
  let staleBody: string | undefined;
  try {
    const stats = fs.statSync(lockPath);
    if (stats.mtimeMs < Date.now() - staleMs) {
      staleBody = readLockBody(lockPath);
      if (staleBody === undefined) {
        // Beyond the stale window yet unreadable: identity unverifiable —
        // fail-closed (human decision), never a silent takeover.
        return { ok: false, kind: 'corrupt', detail: 'lock age is beyond the stale window but its body is unreadable' };
      }
    }
  } catch {
    // vanished between EEXIST and stat — one more create attempt decides
    const retry = tryCreate(lockPath, body);
    if (retry === 'created') {
      sweepOrphanSidecars(lockPath, staleMs);
      return { ok: true, handle: { lockPath, token, body }, staleTakenOver: false };
    }
    if (typeof retry === 'object') return { ok: false, kind: 'unwritable', detail: retry.error };
    return heldVerdict(lockPath);
  }
  if (staleBody !== undefined && takeOverStale({ lockPath, staleBody, sidecarToken: token, staleMs })) {
    const retry = tryCreate(lockPath, body);
    if (retry === 'created') {
      sweepOrphanSidecars(lockPath, staleMs);
      return { ok: true, handle: { lockPath, token, body }, staleTakenOver: true };
    }
    if (typeof retry === 'object') return { ok: false, kind: 'unwritable', detail: retry.error };
    // Lost the post-takeover create race; report held honestly.
    return heldVerdict(lockPath);
  }

  return heldVerdict(lockPath);
}

/**
 * Ownership-checked release: rename aside, delete only when the body is
 * still OURS; otherwise restore — a holder taken over after going stale
 * cannot delete the new holder's lock.
 */
export function releaseServiceRunLock(handle: ServiceRunLockHandle): void {
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
  try {
    if (!fs.existsSync(handle.lockPath)) fs.renameSync(relPath, handle.lockPath);
  } catch {
    // best-effort restore
  }
}
