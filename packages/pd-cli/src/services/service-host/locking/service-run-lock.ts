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
 * ── Concurrency protocol (P1-4 round 4: SQLite arbitration) ────────────────
 *
 * Every acquisition, takeover and release decision is serialized through a
 * dedicated arbitration gate: the stable, short-lived SQLite database
 * `<pdHome>/service/service-run-gate.db`, guarded by `BEGIN IMMEDIATE`.
 * While one process holds the transaction, a contender's `BEGIN IMMEDIATE`
 * fails with SQLITE_BUSY — ACQUIRE waits zero milliseconds (SPEC §8.2
 * immediate `already_running`, never a queue), RELEASE retries briefly and
 * bounded. A gate that cannot be opened or transacted at all maps to
 * `unwritable` (fail-closed).
 *
 * The state machine inside the transaction is:
 *
 *   evaluateLock ─ 'absent'            → 'wx' create → acquired
 *                ├ 'fresh'             → held
 *                ├ 'dead'              → re-evaluate → unlink → 'wx' create
 *                │                       → acquired(staleTakenOver)
 *                ├ 'stale-alive'       → held   (live or inconclusive owner)
 *                ├ 'stale-unreadable'  → corrupt (identity unverifiable)
 *                └ 'stale-anonymous'   → corrupt (no holder identity)
 *
 * 'dead' means the recorded holder PID is PROVABLY dead — age does not
 * matter: a verifiably-exited holder is recovered immediately rather than
 * waiting out the stale window (§P0.8).
 *
 * Why this closes the file-mutex races:
 *
 *   - No mutex file exists. The arbiter is a real cross-process lock held by
 *     the OS/SQLite, not a file whose mtime pretends to prove liveness — so
 *     "stale mutex" reclaim is impossible by construction, and a live
 *     coordinator's arbitration can never be reclaimed by file-age
 *     heuristics (P1-4A moot). File age only feeds `evaluateLock`, and only
 *     inside the serialized section where PID liveness remains the sole
 *     takeover authority.
 *   - verify→delete→create is one transaction: two stale breakers cannot
 *     interleave (P1-4B). The first commits before the second's BEGIN
 *     completes; the second re-evaluates AFTER the first's lock is already
 *     in place and reports `held`.
 *   - A crashed coordinator releases its transaction through the OS
 *     automatically — recovery is immediate and deterministic (P1-4B).
 *   - Release is verify-body + unlink inside the SAME transaction: a true
 *     compare-and-delete under the arbiter, never a read→compare→unlink
 *     window (P1-4C). A foreign body is never unlinked.
 *   - No generic sweep touches arbitration state: `sweepOrphanSidecars`
 *     only removes age-proven legacy sidecars (`.mtx`, `.take-*`, `.rel-*`),
 *     none of which the new protocol creates or reads (P1-4D). The gate
 *     database and its `-journal`/`-wal`/`-shm` sidecars are never swept.
 *
 * No heartbeat exists and none is needed for Phase 1: a run is bounded far
 * below the stale window, and mid-run ownership is re-verified by
 * `holdsServiceRunLock` (the body compare IS the heartbeat-identity check —
 * a file no longer carrying our body means we lost the run). PID liveness
 * remains the sole takeover authority — file age alone is never the sole
 * eviction signal (same rule as `principles-core/ledger-file-lock.ts`).
 *
 * Cross-platform note: `BEGIN IMMEDIATE` is the same advisory-file-lock
 * arbitration on POSIX and Windows (SQLite's POSIX fcntl locks and Windows
 * LockFileEx regions are both released by the OS on process death), and the
 * lock file itself still changes hands only via 'wx' create + unlink —
 * never rename, whose overwrite semantics differ between the platforms. A
 * file still open by its dead holder is not unlinkable on Windows — unlink
 * failure aborts the takeover fail-closed inside the transaction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * A lock older than this is treated as a crashed holder. A legitimate
 * run-once (bounded cycles, Phase 2 per-workspace timeouts) must stay well
 * below this window; the dry-run of Phase 1 finishes in seconds.
 */
export const SERVICE_RUN_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Busy policy is split per role (SPEC §8.2 immediate `already_running`):
 * ACQUIRE waits ZERO milliseconds — a second coordinator must never queue
 * behind a finishing run and then execute a second dry-run. RELEASE gets
 * its own bounded wait ({@link RELEASE_BUSY_TIMEOUT_MS} ×
 * {@link RELEASE_MAX_ATTEMPTS}) because a release racing a concurrent
 * arbiter should still complete when the gate frees momentarily.
 */
const ACQUIRE_BUSY_TIMEOUT_MS = 0;
const RELEASE_BUSY_TIMEOUT_MS = 1500;
const RELEASE_MAX_ATTEMPTS = 2;

/** The one lock file per install: `<pdHome>/service/service-run.lock`. */
export function serviceRunLockPath(pdHome: string): string {
  return path.join(pdHome, 'service', 'service-run.lock');
}

/**
 * The dedicated arbitration gate for every acquire/takeover/release of the
 * lock at `lockPath`. A stable path (never per-attempt): all contenders
 * must serialize on the SAME database.
 */
function serviceRunGatePath(lockPath: string): string {
  return path.join(path.dirname(lockPath), 'service-run-gate.db');
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
 * Deterministic injection points inside the arbitrated takeover section so
 * multi-process tests can interleave contenders without random sleeps.
 * Called synchronously INSIDE the arbitration transaction — a contender
 * parked here still holds the gate, which is exactly what the tests need to
 * prove: nobody else can even evaluate the lock meanwhile.
 * A thrown error aborts the takeover fail-closed (transaction rolled back).
 */
export type ServiceRunLockTakeoverPhase =
  | 'mutex-acquired'    // arbitration held; about to re-verify the stale lock
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
   * Invoked once per phase inside the arbitration transaction; production
   * passes nothing.
   */
  readonly takeoverSync?: (phase: ServiceRunLockTakeoverPhase) => void;
  /**
   * Deterministic test seam: force the gate transaction's END to fail after
   * the acquire body ran — exercises the orphan-lock compensation path
   * (§P0). Production never sets it.
   */
  readonly gateEndFailure?: boolean;
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
/**
 * Parse the recorded creation timestamp out of a lock/sidecar body
 * (`<pid> <token> <createdAtISO>`); undefined when unverifiable.
 */
function holderCreatedAtOf(body: string): number | undefined {
  const parts = body.trim().split(/\s+/);
  const stamp = parts.length >= 3 ? parts[2] : undefined;
  if (stamp === undefined) return undefined;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

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

/**
 * Legacy-protocol guard: the retired `.mtx` file mutex was held by a LIVE
 * process for its whole critical section — a live `.mtx` therefore means an
 * old-version coordinator may be mid-takeover right now, and proceeding
 * would ignore arbitration the old protocol still honors (mixed-version
 * double-run). Fail closed as 'occupied' when the recorded PID is alive OR
 * unverifiable; only a demonstrably-dead owner lets us proceed. An
 * unreadable `.mtx` is occupied-by-default: file age or absence of a
 * parseable body never proves the old protocol's mutex is free.
 */
function legacyMutexOccupied(lockPath: string, processAlive: (pid: number) => HolderLiveness): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(`${lockPath}.mtx`, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : '';
    // ENOENT/ENOTDIR: no legacy mutex exists — proceed.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    return true; // exists but unreadable → unverifiable → fail closed
  }
  const pid = holderPidOf(raw);
  if (pid === undefined) return true; // corrupt ownership → cannot verify → fail closed
  try {
    return processAlive(pid) !== 'dead';
  } catch {
    return true;
  }
}

/**
 * PID-verified sweep of legacy sidecar orphans (§六): `.mtx` (pre-
 * arbitration file mutex), `.take-*` and `.rel-*` (the retired rename-aside
 * protocol). The current protocol creates NONE of these — but they may
 * still be held by an ACTIVE old-version process, so file age alone never
 * justifies deletion: a sidecar is removed only when it is BOTH past the
 * stale window AND its recorded holder PID is demonstrably dead. Alive,
 * unknown, unparseable or unreadable ownership keeps the file (fail-closed;
 * manual recovery remains the path for those). The arbitration gate
 * database (`service-run-gate.db` plus `-journal`/`-wal`/`-shm`) never
 * matches these patterns and is never touched.
 */
function sweepOrphanSidecars(
  lockPath: string,
  staleMs: number,
  processAlive: (pid: number) => HolderLiveness,
): void {
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
      // Ownership check before any deletion: a dead recorded owner makes
      // the orphan provably unheld; anything else is kept, never assumed.
      // Staleness comes from the body's own createdAt, not an mtime stat —
      // a stat-then-delete pair is a real check-then-act race (CodeQL
      // js/file-system-race) and mtime never proved ownership anyway.
      let sidecarBody: string;
      try {
        sidecarBody = fs.readFileSync(sidecar, 'utf8');
      } catch {
        continue;
      }
      const recordedAt = holderCreatedAtOf(sidecarBody);
      if (recordedAt === undefined || recordedAt >= Date.now() - staleMs) continue;
      const pid = holderPidOf(sidecarBody);
      if (pid === undefined) continue;
      let liveness: HolderLiveness;
      try {
        liveness = processAlive(pid);
      } catch {
        liveness = 'unknown';
      }
      if (liveness !== 'dead') continue;
      fs.rmSync(sidecar, { force: true });
    } catch {
      // best effort; a failed sweep never blocks locking
    }
  }
}

/**
 * What the lock file currently is (single stat+read, no state change):
 *  - `absent`             — nothing at the path (contender may just create);
 *  - `fresh`              — inside the stale window with a live/unverifiable holder;
 *  - `dead`               — recorded holder PID is demonstrably dead, ANY age
 *                           (recovery on PID evidence, not the 30-min window);
 *  - `stale-unreadable`   — beyond the window but unreadable (corrupt);
 *  - `stale-anonymous`    — beyond the window, body carries no holder pid;
 *  - `stale-alive`        — beyond the window but holder live/inconclusive.
 * Only `dead` may proceed to a takeover.
 */
type LockEvaluation =
  | { kind: 'absent' }
  | { kind: 'fresh' }
  | { kind: 'stale-unreadable' }
  | { kind: 'stale-anonymous'; body: string }
  | { kind: 'stale-alive' }
  | { kind: 'dead'; body: string };

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
  const stale = stats.mtimeMs < Date.now() - staleMs;
  const body = readLockBody(lockPath);
  if (body === undefined) return stale ? { kind: 'stale-unreadable' } : { kind: 'fresh' };
  const holderPid = holderPidOf(body);
  if (holderPid === undefined) return stale ? { kind: 'stale-anonymous', body } : { kind: 'fresh' };
  let liveness: HolderLiveness;
  try {
    liveness = processAlive(holderPid);
  } catch {
    liveness = 'unknown';
  }
  // A PROVABLY-dead recorded holder is recoverable immediately — the stale
  // window bounds only UNVERIFIABLE ownership, not verified death (§P0.8).
  if (liveness === 'dead') return { kind: 'dead', body };
  return stale ? { kind: 'stale-alive' } : { kind: 'fresh' };
}

/** SQLITE_BUSY (and its extended variants) means a live contender holds the gate. */
function isBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Object.hasOwn(error, 'code') &&
    String(Reflect.get(error, 'code')).startsWith('SQLITE_BUSY')
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GateOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'busy' | 'unwritable'; detail: string };

/**
 * Options for one arbitrated section.
 *
 * The gate database exists ONLY to be the arbiter — it stores no state that
 * must persist, so a transaction ends with `ROLLBACK`, never `COMMIT`.
 * That removes the entire "commit failed but the filesystem write already
 * happened" failure class (§P0): nothing is ever half-persisted.
 */
interface GateArbitrationOptions {
  /** SQLITE_BUSY wait — zero for acquire (immediate refusal), bounded for release. */
  readonly busyTimeoutMs: number;
  /**
   * The lock body THIS section may have written. When the transaction end
   * still fails, compensation deletes the file — but only while it still
   * carries THIS exact body (compare-and-delete; a foreign body is never
   * touched). Safe even after the gate slipped away: our file and another
   * contender's 'wx'-created file cannot coexist at the same path.
   */
  readonly createdBody?: string;
  /** Test seam: force the transaction end to fail after `body` ran. */
  readonly injectEndFailure?: boolean;
  /** Hook invoked once inside the transaction (deterministic tests). */
  readonly insideTxn?: () => void;
}

/**
 * Run `body` while holding the cross-process arbitration gate: open the
 * gate database, `BEGIN IMMEDIATE`, run the body's serialized decisions,
 * end the transaction. Any failure is fail-closed:
 *  - SQLITE_BUSY anywhere               → 'busy' (a live arbiter exists);
 *  - gate unopenable / transaction error → 'unwritable' (unknown state —
 *    never decide outside arbitration).
 * A process dying mid-transaction releases the gate through the OS (POSIX
 * fcntl / Windows LockFileEx), so recovery needs no file heuristics at all.
 *
 * If ending the transaction fails AFTER the body created our lock file,
 * compensation removes that file while it still carries our body — a
 * same-path-exclusive compare-and-delete, never a blind unlink (§P0.6).
 */
function withGateArbitration<T>(
  lockPath: string,
  opts: GateArbitrationOptions,
  body: () => T,
): GateOutcome<T> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(serviceRunGatePath(lockPath));
    db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
  } catch (error) {
    return { ok: false, kind: 'unwritable', detail: `arbitration gate unavailable: ${errorDetail(error)}` };
  }
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try {
      db.close();
    } catch {
      // already closing
    }
    return {
      ok: false,
      kind: isBusyError(error) ? 'busy' : 'unwritable',
      detail: `arbitration gate begin failed: ${errorDetail(error)}`,
    };
  }
  try {
    const value = body();
    opts.insideTxn?.();
    if (opts.injectEndFailure === true) {
      const injected = new Error('injected gate transaction-end failure');
      Reflect.set(injected, 'code', 'SQLITE_IOERR');
      throw injected;
    }
    // No persistent gate data: ROLLBACK ends the transaction — a failed
    // COMMIT can never orphan the filesystem writes made inside `body`.
    db.exec('ROLLBACK');
    return { ok: true, value };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback best-effort; process death releases the gate anyway
    }
    if (opts.createdBody !== undefined) {
      try {
        if (readLockBody(lockPath) === opts.createdBody) fs.unlinkSync(lockPath);
      } catch {
        // Leave it — a dead-holder body recovers on PID evidence anyway.
      }
    }
    return {
      ok: false,
      kind: isBusyError(error) ? 'busy' : 'unwritable',
      detail: `arbitration gate transaction failed: ${errorDetail(error)}`,
    };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/** True when the lock file still carries OUR body (mid-run ownership re-check). */
export function holdsServiceRunLock(handle: ServiceRunLockHandle): boolean {
  return readLockBody(handle.lockPath) === handle.body;
}

/**
 * Acquire the install-level single-instance run lock. Every decision —
 * evaluate, stale takeover, create — runs inside the arbitration gate
 * (§P1-4 round 4), immediate verdicts, no wait loop (`already_running`
 * semantics, §8.2). A stale takeover additionally requires the recorded
 * holder PID to be demonstrably DEAD; a live, unknown or unverifiable
 * holder is NEVER taken over, and the verify→delete→create sequence is
 * serialized by the same transaction that a second contender's BEGIN
 * cannot enter.
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

  const gated = withGateArbitration(
    lockPath,
    {
      busyTimeoutMs: ACQUIRE_BUSY_TIMEOUT_MS,
      createdBody: body,
      injectEndFailure: options?.probes?.gateEndFailure === true,
    },
    (): AcquireServiceRunLockResult => {
    // Mixed-version protection (§六): an old-protocol coordinator may be
    // mid-takeover holding `.mtx`. A live/unverifiable legacy mutex means
    // fail-closed held — never run a second instance beside it.
    if (legacyMutexOccupied(lockPath, processAlive)) return heldVerdict(lockPath);
    const evaluate = (): LockEvaluation => evaluateLock(lockPath, staleMs, processAlive);
    const createOwned = (staleTakenOver: boolean): AcquireServiceRunLockResult => {
      const created = tryCreate(lockPath, body);
      if (created === 'created') {
        sweepOrphanSidecars(lockPath, staleMs, processAlive);
        return { ok: true, handle: { lockPath, token, body }, staleTakenOver };
      }
      if (typeof created === 'object') return { ok: false, kind: 'unwritable', detail: created.error };
      return heldVerdict(lockPath);
    };
    const mapEvaluation = (evaluation: LockEvaluation): AcquireServiceRunLockResult | 'takeover' => {
      switch (evaluation.kind) {
        case 'absent':
          return createOwned(false);
        case 'fresh':
        case 'stale-alive':
          return heldVerdict(lockPath);
        case 'stale-unreadable':
          // Beyond the stale window yet unreadable: identity unverifiable —
          // fail-closed (human decision), never a silent takeover.
          return { ok: false, kind: 'corrupt', detail: 'lock age is beyond the stale window but its body is unreadable' };
        case 'stale-anonymous':
          // The stale body names no verifiable holder — cannot prove the
          // old holder died, so takeover is refused fail-closed (P1-4).
          return { ok: false, kind: 'corrupt', detail: `lock body carries no verifiable holder identity: ${bodyEcho(evaluation.body)}` };
        case 'dead':
          return 'takeover';
      }
    };

    const first = mapEvaluation(evaluate());
    if (first !== 'takeover') return first;

    // ── Arbitrated takeover: re-verify under the SAME transaction. The
    // gate serializes us against every other contender, so the lock we
    // verified is the lock we are about to remove — no second breaker can
    // interleave a fresh create between our check and our unlink.
    takeoverSync?.('mutex-acquired');
    const inner = evaluate();
    if (inner.kind !== 'dead') {
      // Non-cooperating writers aside, the only reachable states here are
      // 'dead' or 'absent' (a cooperating process cannot change the
      // file under our transaction). Map defensively anyway.
      if (inner.kind === 'absent') return createOwned(true);
      const mapped = mapEvaluation(inner);
      if (mapped !== 'takeover') return mapped;
    }
    takeoverSync?.('stale-verified');
    // The lock still carries a provably-dead stale body under arbitration —
    // deleting it cannot displace a live holder.
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
          ? String(Reflect.get(error, 'code'))
          : '';
      if (code !== 'ENOENT') {
        return { ok: false, kind: 'unwritable', detail: `could not remove stale lock: ${code}` };
      }
      // ENOENT: a non-cooperating writer already removed it; fall through
      // to the 'wx' create, which still decides exactly once.
    }
    takeoverSync?.('lock-removed');
    return createOwned(true);
    },
  );

  if (!gated.ok) {
    return gated.kind === 'busy'
      ? heldVerdict(lockPath)
      : { ok: false, kind: 'unwritable', detail: gated.detail };
  }
  return gated.value;
}

/**
 * Structured release outcome (§三): a release can never be silent.
 *  - `released`           — our lock was verified and unlinked under the gate;
 *  - `not_owned`          — the lock is gone or already another holder's;
 *                           never an error, and never deletes a foreign body;
 *  - `failed_busy`        — the arbiter stayed busy through the bounded retry;
 *  - `failed_unwritable`  — the gate/transaction itself failed.
 */
export type ReleaseServiceRunLockResult = 'released' | 'not_owned' | 'failed_busy' | 'failed_unwritable';

export interface ReleaseServiceRunLockOptions {
  /** Deterministic test seam: force the release transaction's end to fail. */
  readonly injectEndFailure?: boolean;
  /** Hook invoked once inside the release transaction (deterministic tests). */
  readonly insideTxn?: () => void;
}

/**
 * Ownership-checked release under the SAME arbitration gate: verify the
 * lock body is OURS and unlink it inside one transaction — a true
 * compare-and-delete, so the file a foreign holder just created can never
 * be removed by our late release (P1-4). The release gets its own bounded
 * retry (`RELEASE_BUSY_TIMEOUT_MS` × `RELEASE_MAX_ATTEMPTS`) independent of
 * acquire's zero-wait policy, but NEVER bypasses the gate to unlink: a gate
 * failure leaves the lock in place and reports it — the leftover carries
 * our own PID, which the next contender recovers on death evidence.
 */
export function releaseServiceRunLock(
  handle: ServiceRunLockHandle,
  options?: ReleaseServiceRunLockOptions,
): ReleaseServiceRunLockResult {
  for (let attempt = 0; attempt < RELEASE_MAX_ATTEMPTS; attempt += 1) {
    let verdict: ReleaseServiceRunLockResult = 'released';
    const gated = withGateArbitration(
      handle.lockPath,
      {
        busyTimeoutMs: RELEASE_BUSY_TIMEOUT_MS,
        injectEndFailure: options?.injectEndFailure === true,
        ...(options?.insideTxn !== undefined ? { insideTxn: options.insideTxn } : {}),
      },
      () => {
        const current = readLockBody(handle.lockPath);
        if (current !== handle.body) {
          verdict = 'not_owned'; // gone or foreign — never displace it
          return;
        }
        try {
          fs.unlinkSync(handle.lockPath);
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
              ? String(Reflect.get(error, 'code'))
              : '';
          if (code === 'ENOENT') {
            verdict = 'not_owned'; // already gone — nothing left to release
            return;
          }
          throw error; // real unlink failure → transaction fails → unwritable
        }
      },
    );
    if (gated.ok) return verdict;
    if (gated.kind === 'unwritable') return 'failed_unwritable';
    // 'busy': bounded retry — the concurrent arbiter usually frees shortly.
  }
  return 'failed_busy';
}
