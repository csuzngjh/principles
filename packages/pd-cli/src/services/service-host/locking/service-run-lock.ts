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
 * While one process holds the transaction, every other contender's BEGIN
 * blocks for at most {@link GATE_BUSY_TIMEOUT_MS} and then fails with
 * SQLITE_BUSY — mapped to `held` (fail-closed). A gate that cannot be
 * opened or transacted at all maps to `unwritable` (fail-closed).
 *
 * The state machine inside the transaction is:
 *
 *   evaluateLock ─ 'absent'            → 'wx' create → acquired
 *                ├ 'fresh'             → held
 *                ├ 'stale-alive'       → held   (live or inconclusive owner)
 *                ├ 'stale-unreadable'  → corrupt (identity unverifiable)
 *                ├ 'stale-anonymous'   → corrupt (no holder identity)
 *                └ 'stale-dead'        → re-evaluate → unlink → 'wx' create
 *                                        → acquired(staleTakenOver)
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
 * How long a contender's `BEGIN IMMEDIATE` waits for the arbitration gate
 * before SQLite reports SQLITE_BUSY. Bounded because SPEC §8.2 requires an
 * immediate `already_running` verdict, never an unbounded queue.
 */
const GATE_BUSY_TIMEOUT_MS = 1500;

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

/**
 * Best-effort sweep of legacy sidecar orphans older than the stale window:
 * `.mtx` (pre-arbitration file mutex), `.take-*` and `.rel-*` (the retired
 * rename-aside protocol). The current protocol creates NONE of these, so
 * sweeping them can never remove arbitration state — and the arbitration
 * gate database (`service-run-gate.db` plus its `-journal`/`-wal`/`-shm`
 * sidecars) does not match these patterns and is never touched.
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
 * Run `body` while holding the cross-process arbitration gate: open the
 * gate database, `BEGIN IMMEDIATE`, run the body's serialized decisions,
 * `COMMIT`. Any failure is fail-closed:
 *  - SQLITE_BUSY anywhere               → 'busy' (a live arbiter exists);
 *  - gate unopenable / transaction error → 'unwritable' (unknown state —
 *    never decide outside arbitration).
 * A process dying mid-transaction releases the gate through the OS (POSIX
 * fcntl / Windows LockFileEx), so recovery needs no file heuristics at all.
 */
function withGateArbitration<T>(lockPath: string, body: () => T): GateOutcome<T> {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(serviceRunGatePath(lockPath));
    db.pragma(`busy_timeout = ${GATE_BUSY_TIMEOUT_MS}`);
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
    db.exec('COMMIT');
    return { ok: true, value };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback best-effort; process death releases the gate anyway
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

  const gated = withGateArbitration(lockPath, (): AcquireServiceRunLockResult => {
    const evaluate = (): LockEvaluation => evaluateLock(lockPath, staleMs, processAlive);
    const createOwned = (staleTakenOver: boolean): AcquireServiceRunLockResult => {
      const created = tryCreate(lockPath, body);
      if (created === 'created') {
        sweepOrphanSidecars(lockPath, staleMs);
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
        case 'stale-dead':
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
    if (inner.kind !== 'stale-dead') {
      // Non-cooperating writers aside, the only reachable states here are
      // 'stale-dead' or 'absent' (a cooperating process cannot change the
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
  });

  if (!gated.ok) {
    return gated.kind === 'busy'
      ? heldVerdict(lockPath)
      : { ok: false, kind: 'unwritable', detail: gated.detail };
  }
  return gated.value;
}

/**
 * Ownership-checked release under the SAME arbitration gate: verify the
 * lock body is OURS and unlink it inside one transaction — a true
 * compare-and-delete, so the file a foreign holder just created can never
 * be removed by our late release (P1-4). A gate failure leaves the lock in
 * place rather than deleting outside arbitration; the leftover is safe —
 * it carries a dead-PID body and a future stale-dead takeover recovers it.
 */
export function releaseServiceRunLock(handle: ServiceRunLockHandle): void {
  withGateArbitration(handle.lockPath, () => {
    if (readLockBody(handle.lockPath) !== handle.body) {
      return; // not ours — never displace another holder's lock
    }
    try {
      fs.unlinkSync(handle.lockPath);
    } catch {
      // Already gone — the run ended; nothing left to release.
    }
  });
}
