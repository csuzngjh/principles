/**
 * Install-level single-instance run lock (SPEC-PD-SERVICE-HOST-001 §8.2 step
 * 2, FR-08; TD §2.1 `locking/service-run-lock.ts`).
 *
 * The protocol is the one proven by PRI-1151's cross-process control-state
 * lock (`host-runtime/product-telemetry/control-state-lock.ts`): atomic
 * `'wx'` create with an owner body `<pid> <token> <createdAtISO>`; ownership-
 * checked release; stale takeover gated on holder-liveness proof. It is
 * re-declared here rather than exported because the semantic contract
 * genuinely differs (P7: a real variation axis, not a speculative seam):
 *
 *   - The control-state lock guards millisecond-scale read-modify-write
 *     transactions (5s stale window). A run-once coordinator legitimately
 *     runs for minutes, so a second coordinator must NEVER take over a lock
 *     that may still be a live run — the stale window is 30 minutes by
 *     default.
 *   - Contention is an IMMEDIATE verdict, not a bounded wait: SPEC §8.2
 *     requires the second instance to report `already_running`, not to queue
 *     behind the first.
 *   - A stale mtime whose body cannot be read is `corrupt` (fail-closed,
 *     human decision), never silently takeover-able and never reported as a
 *     live run.
 *
 * ── Concurrency protocol (P1-4 round 3) ─────────────────────────────────────
 *
 * The earlier rename-aside takeover was a TOCTOU race: a contender that had
 * observed a stale lock could rename aside a DIFFERENT, live lock written in
 * the meantime, and a third process could create in the gap — two effective
 * holders. Renaming a lock file is banned entirely. The provable-safe
 * protocol is:
 *
 *   1. The lock file is created ONLY via atomic `'wx'` create. At any instant
 *      there is at most one winner of that create — the sole holder.
 *   2. A contender MAY delete the lock file ONLY inside the takeover mutex
 *      AND ONLY after re-verifying the file still carries a provably dead
 *      stale body. A live/fresh lock is never removed by anyone but its
 *      owner — so a holder's file can never be displaced.
 *   3. The takeover mutex `<lock>.mtx` is itself an `'wx'`-created file. It
 *      serializes the verify→delete critical section: while held, every
 *      other takeover attempt fails closed as `held`. A mutex left behind
 *      by a crashed takeover is safe to break: the mutex guards only the
 *      delete window, never a lock holder — deleting a stale mutex can
 *      never displace a live lock, and two contenders racing to delete the
 *      same stale mutex both tolerate ENOENT and then race a single 'wx'
 *      create, which has exactly one winner. Its own crash recovery is
 *      therefore safe by construction (no second mutex, no rename).
 *   4. After the mutex deletes the stale file, the contender creates its own
 *      lock with 'wx'. If a direct creator won the gap first, the takeover
 *      fails cleanly as `held` — still exactly one holder.
 *   5. Worst case under a broken mutex (a live-but-slow holder's mutex
 *      removed as stale): two processes both verify the stale lock, both
 *      attempt unlink (one wins, the other tolerates ENOENT), both race
 *      'wx' create — still exactly one winner. The mutex narrows the common
 *      race; correctness never depends on it being unbreakable.
 *
 * No heartbeat exists and none is needed for Phase 1: a run is bounded far
 * below the stale window, and mid-run ownership is re-verified by
 * `holdsServiceRunLock` (the body compare IS the heartbeat-identity check —
 * a file no longer carrying our body means we lost the run). PID liveness
 * remains the sole takeover authority — file age alone is never the sole
 * eviction signal (same rule as `principles-core/ledger-file-lock.ts`).
 *
 * Cross-platform note: the protocol uses only 'wx' create + unlink, never
 * rename — `rename`'s overwrite/replace semantics differ between POSIX and
 * Windows, while atomic-create and delete are consistent on both (Node
 * `fs.openSync('wx')` maps to O_EXCL / FILE_CREATE). A file still open by
 * its dead holder is not unlinkable on Windows — unlink failure aborts the
 * takeover fail-closed as `held`.
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

/** The takeover mutex serializing verify→delete of a stale lock. */
function takeoverMutexPath(lockPath: string): string {
  return `${lockPath}.mtx`;
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

/**
 * Holder-liveness verdict. 'alive' includes EPERM-observable processes
 * (exists, we just can't signal it). 'unknown' means the platform could not
 * produce a reliable verdict — takeover must fail CLOSED on it.
 */
export type HolderLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Deterministic injection points inside the takeover critical section so
 * multi-process tests can interleave contenders without random sleeps.
 * Called synchronously; a thrown error aborts the takeover fail-closed.
 */
export type ServiceRunLockTakeoverPhase =
  | 'mutex-acquired'    // takeover mutex held; about to re-verify the stale lock
  | 'stale-verified'    // stale lock re-verified; about to delete it
  | 'lock-removed';     // stale lock deleted; about to 'wx'-create ours

export interface ServiceRunLockProbes {
  /**
   * Liveness probe for the PID recorded in a stale lock body. Default:
   * `process.kill(pid, 0)` semantics (alive / ESRCH→dead / EPERM→alive /
   * anything else→unknown). Tests inject fakes; the contract is that an
   * inconclusive answer MUST yield 'unknown' (fail-closed), never 'dead'.
   */
  readonly processAlive?: (pid: number) => HolderLiveness;
  /**
   * Synchronization hook for deterministic takeover-interleaving tests.
   * Invoked once per phase inside the mutex; production passes nothing.
   */
  readonly takeoverSync?: (phase: ServiceRunLockTakeoverPhase) => void;
}

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
 * Parse the holder PID out of a lock body (`<pid> <token> <createdAtISO>`).
 * Returns undefined when the body carries no verifiable holder identity —
 * a body we cannot attribute is treated as corrupt (fail-closed), never as
 * takeover evidence.
 */
function holderPidOf(body: string): number | undefined {
  const firstSpace = body.indexOf(' ');
  const pidText = firstSpace === -1 ? body : body.slice(0, firstSpace);
  if (!/^\d+$/.test(pidText)) return undefined;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The default liveness probe: `process.kill(pid, 0)`. ESRCH is the only
 * "demonstrably dead" answer; EPERM means the process exists but cannot be
 * signaled (still alive); any other outcome is 'unknown' (fail-closed).
 */
function defaultProcessAlive(pid: number): HolderLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : '';
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
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

/** Best-effort sweep of `.mtx` / legacy `.take-*` / `.rel-*` orphans older than the stale window. */
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
    if (entry !== `${base}.mtx` && !entry.startsWith(`${base}.take-`) && !entry.startsWith(`${base}.rel-`)) continue;
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
 * What the lock file currently is (single stat+read, no state change):
 *  - `absent`             — nothing at the path (contender may just create);
 *  - `fresh`              — inside the stale window, whatever its body is;
 *  - `stale-unreadable`   — beyond the window but unreadable (corrupt);
 *  - `stale-anonymous`    — beyond the window, body carries no holder pid;
 *  - `stale-dead`         — beyond the window AND recorded holder provably dead;
 *  - `stale-alive`        — beyond the window but holder live/inconclusive.
 * Only `stale-dead` may proceed to a takeover.
 */
type LockEvaluation =
  | { kind: 'absent' }
  | { kind: 'fresh' }
  | { kind: 'stale-unreadable' }
  | { kind: 'stale-anonymous'; body: string }
  | { kind: 'stale-alive' }
  | { kind: 'stale-dead'; body: string };

function evaluateLock(
  lockPath: string,
  staleMs: number,
  processAlive: (pid: number) => HolderLiveness,
): LockEvaluation {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(lockPath);
  } catch {
    return { kind: 'absent' };
  }
  if (stats.mtimeMs >= Date.now() - staleMs) return { kind: 'fresh' };
  const body = readLockBody(lockPath);
  if (body === undefined) return { kind: 'stale-unreadable' };
  const holderPid = holderPidOf(body);
  if (holderPid === undefined) return { kind: 'stale-anonymous', body };
  let liveness: HolderLiveness;
  try {
    liveness = processAlive(holderPid);
  } catch {
    liveness = 'unknown';
  }
  return liveness === 'dead' ? { kind: 'stale-dead', body } : { kind: 'stale-alive' };
}

/**
 * Take the takeover mutex: atomic 'wx' create; a stale mutex is an abandoned
 * one (a takeover is bounded synchronous filesystem work — a mutex older
 * than the stale window can never be an in-progress takeover) and is simply
 * deleted, then recreated. Deleting a stale mutex is safe under ANY holder
 * state: it never displaces a lock holder (the mutex guards only the
 * delete window), and simultaneous breakers race a single 'wx' create —
 * one winner, the rest report `held`.
 * Returns 'held' when a live mutex blocks us, 'acquired' on success.
 */
function acquireTakeoverMutex(
  lockPath: string,
  staleMs: number,
): 'acquired' | 'held' | { error: string } {
  const mtxPath = takeoverMutexPath(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = tryCreate(mtxPath, lockBody(`mtx-${randomUUID().replace(/-/g, '').slice(0, 8)}`));
    if (created === 'created') return 'acquired';
    if (typeof created === 'object') return { error: created.error };
    // Busy: a live mutex means a takeover is in progress right now.
    let stats: fs.Stats;
    try {
      stats = fs.statSync(mtxPath);
    } catch {
      continue; // vanished; retry create
    }
    if (stats.mtimeMs >= Date.now() - staleMs) return 'held';
    // Abandoned mutex: break it and retry the create. The breaker may race
    // another breaker — both tolerate ENOENT, then 'wx' decides once.
    try {
      fs.unlinkSync(mtxPath);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
          ? String(Reflect.get(error, 'code'))
          : '';
      if (code !== 'ENOENT') return 'held'; // couldn't break it — fail closed
    }
  }
  return 'held';
}

function releaseTakeoverMutex(lockPath: string): void {
  try {
    fs.unlinkSync(takeoverMutexPath(lockPath));
  } catch {
    // Already gone (e.g. broken by a stale-mutex breaker) — harmless.
  }
}

/** True when the lock file still carries OUR body (mid-run ownership re-check). */
export function holdsServiceRunLock(handle: ServiceRunLockHandle): boolean {
  return readLockBody(handle.lockPath) === handle.body;
}

/**
 * Acquire the install-level single-instance run lock. Single attempt +
 * mutex-guarded stale takeover, immediate verdicts — no wait loop
 * (`already_running` semantics, §8.2). A stale takeover additionally
 * requires the recorded holder PID to be demonstrably DEAD (P1-4); a live,
 * unknown or unverifiable holder is NEVER taken over.
 */
export function acquireServiceRunLock(
  pdHome: string,
  options?: { staleMs?: number; probes?: ServiceRunLockProbes },
): AcquireServiceRunLockResult {
  const lockPath = serviceRunLockPath(pdHome);
  const staleMs = options?.staleMs ?? SERVICE_RUN_LOCK_STALE_MS;
  const processAlive = options?.probes?.processAlive ?? defaultProcessAlive;
  const takeoverSync = options?.probes?.takeoverSync;
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

  // Busy. Evaluate what is actually holding the path.
  const evaluation = evaluateLock(lockPath, staleMs, processAlive);
  switch (evaluation.kind) {
    case 'absent': {
      // Vanished between EEXIST and stat — one more create decides.
      const retry = tryCreate(lockPath, body);
      if (retry === 'created') {
        sweepOrphanSidecars(lockPath, staleMs);
        return { ok: true, handle: { lockPath, token, body }, staleTakenOver: false };
      }
      if (typeof retry === 'object') return { ok: false, kind: 'unwritable', detail: retry.error };
      return heldVerdict(lockPath);
    }
    case 'fresh':
    case 'stale-alive':
      return heldVerdict(lockPath);
    case 'stale-unreadable':
      // Beyond the stale window yet unreadable: identity unverifiable —
      // fail-closed (human decision), never a silent takeover.
      return { ok: false, kind: 'corrupt', detail: 'lock age is beyond the stale window but its body is unreadable' };
    case 'stale-anonymous':
      // The stale body names no verifiable holder — cannot prove the old
      // holder died, so takeover is refused fail-closed (P1-4).
      return { ok: false, kind: 'corrupt', detail: `lock body carries no verifiable holder identity: ${bodyEcho(evaluation.body)}` };
    case 'stale-dead':
      break; // the only takeover-eligible state
  }

  // ── Mutex-guarded takeover ──
  const mtx = acquireTakeoverMutex(lockPath, staleMs);
  if (mtx === 'held') return heldVerdict(lockPath);
  if (mtx !== 'acquired') return { ok: false, kind: 'unwritable', detail: mtx.error };
  try {
    takeoverSync?.('mutex-acquired');
    // Re-evaluate INSIDE the mutex: the lock may have been replaced, taken
    // over, or released since we first observed it stale.
    const inner = evaluateLock(lockPath, staleMs, processAlive);
    switch (inner.kind) {
      case 'absent': {
        const retry = tryCreate(lockPath, body);
        if (retry === 'created') {
          sweepOrphanSidecars(lockPath, staleMs);
          return { ok: true, handle: { lockPath, token, body }, staleTakenOver: true };
        }
        if (typeof retry === 'object') return { ok: false, kind: 'unwritable', detail: retry.error };
        return heldVerdict(lockPath);
      }
      case 'fresh':
      case 'stale-alive':
        return heldVerdict(lockPath);
      case 'stale-unreadable':
        return { ok: false, kind: 'corrupt', detail: 'lock age is beyond the stale window but its body is unreadable' };
      case 'stale-anonymous':
        return { ok: false, kind: 'corrupt', detail: `lock body carries no verifiable holder identity: ${bodyEcho(inner.body)}` };
      case 'stale-dead':
        break;
    }
    takeoverSync?.('stale-verified');
    // The lock still carries the SAME provably-dead stale body under the
    // mutex — deleting it cannot displace a live holder.
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
          ? String(Reflect.get(error, 'code'))
          : '';
      if (code === 'ENOENT') {
        // Another contender's critical section already removed it (only
        // possible under a broken mutex); fall through to the create race.
      } else {
        return { ok: false, kind: 'unwritable', detail: `could not remove stale lock: ${code}` };
      }
    }
    takeoverSync?.('lock-removed');
    const retry = tryCreate(lockPath, body);
    if (retry === 'created') {
      sweepOrphanSidecars(lockPath, staleMs);
      return { ok: true, handle: { lockPath, token, body }, staleTakenOver: true };
    }
    if (typeof retry === 'object') return { ok: false, kind: 'unwritable', detail: retry.error };
    // Lost the post-takeover create race to a direct creator; the single
    // holder stands and we report held honestly.
    return heldVerdict(lockPath);
  } finally {
    releaseTakeoverMutex(lockPath);
  }
}

/**
 * Ownership-checked release: verify the lock body is OURS first — a file
 * that already belongs to another holder is NEVER touched (P1-4: deleting
 * a foreign lock, even briefly, displaces a live owner's run). Under the
 * delete-only takeover protocol no other process can move our lock aside,
 * so after the body check a plain unlink releases exactly our lock: the
 * worst case between check and unlink is a same-content coincidence, which
 * the random token makes impossible.
 */
export function releaseServiceRunLock(handle: ServiceRunLockHandle): void {
  if (readLockBody(handle.lockPath) !== handle.body) {
    return; // not ours — never displace another holder's lock
  }
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    // Already gone — the run ended; nothing left to release.
  }
}
