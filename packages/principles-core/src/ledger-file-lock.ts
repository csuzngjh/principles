/**
 * Ledger file lock - the O_EXCL cross-process primitive shared by the
 * principle-tree-ledger mutators (extracted verbatim from
 * principle-tree-ledger.ts, PRI-459 lineage).
 *
 * INTERNAL module: not reachable through the package exports map. The
 * ledger module re-exports `withLock` and `LockAcquisitionError` for its
 * existing public consumers; the ASYNC twin (`withLockAsync`, Phase 7.2
 * P1-02) serves the runtime adapter's per-candidate coordination lock and
 * stays internal - an in-core consumer never justifies widening the
 * public surface.
 *
 * Semantics (unchanged): O_EXCL create with owner-only mode, PID-liveness
 * stale cleanup (a dead holder's lock is reclaimable, a live one's never -
 * file age is never the sole eviction signal), bounded exponential backoff,
 * fail-loud LockAcquisitionError. Lock ordering rule: a candidate
 * coordination lock is ALWAYS acquired BEFORE any ledger lock.
 */
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// File lock (PRI-459: hoisted from openclaw-plugin/utils/file-lock.ts)
// ---------------------------------------------------------------------------
/* global NodeJS */
//
// The principle_training_state.json file has a SINGLE writer contract. Before
// PRI-459, core wrote it UNLOCKED and the plugin wrote it WITH a lock — but
// neither knew about the other's lock, so concurrent writers (e.g.
// evolution-worker async + a pd-cli command) could lose updates. The atomic
// rename only prevents torn files; it does NOT prevent lost updates.
//
// The lock is now owned by core (the single mutator source of truth). Both
// the sync and async mutate paths acquire it. Acquisition failure fails LOUD
// (EP-03 / ERR-009) — never silently swallowed.

export class LockAcquisitionError extends Error {
  public readonly filePath: string;
  public readonly lockPath: string;
  constructor(message: string, filePath: string, lockPath: string) {
    super(message);
    this.name = 'LockAcquisitionError';
    this.filePath = filePath;
    this.lockPath = lockPath;
  }
}

export interface LockOptions {
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  lockStaleMs?: number;
  lockSuffix?: string;
}

export interface LockContext {
  lockPath: string;
  pid: number;
  acquiredAt: number;
}

const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  maxRetries: 50,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 500,
  lockStaleMs: 10000,
  lockSuffix: '.lock',
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'code');
}

export function tryAcquireLock(lockPath: string, pid: number): boolean {
  try {
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    // CodeQL fix (js/insecure-temporary-file): restrict lock file permissions
    // to owner-only (0o600). O_EXCL already prevents pre-existing-file/symlink
    // attacks on creation; the mode tightens permissions so the lock file is
    // not world-readable/writable even when stateDir is in os.tmpdir().
    const fd = fs.openSync(lockPath, flags, 0o600);
    fs.writeSync(fd, String(pid));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    // Runtime Contract Rule #2: never `as` to bypass validation on caught
    // unknown. A non-object `err` would throw on `.code` access and mask the
    // original EEXIST (EP-01 / ERR-001).
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

export function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function safeReleaseLock(lockPath: string, expectedPid: number): void {
  try {
    if (readLockPid(lockPath) === expectedPid) {
      fs.unlinkSync(lockPath);
    }
    // If PID does not match, the lock was re-acquired by another process; leave it.
  } catch {
    // best effort
  }
}

export function cleanupStaleLock(lockPath: string, _staleMs: number): boolean {
  // PRI-459 review: reclaim ONLY when the holder is dead/unknown. The file
  // age must NEVER be the sole eviction signal — a legitimately long write
  // that exceeds lockStaleMs would otherwise let a second writer steal the
  // lock and re-introduce the lost-update class this PR exists to eliminate.
  // PID liveness is the sole authority. `_staleMs` is retained on the
  // signature for back-compat with callers but is intentionally unused.
  try {
    const pid = readLockPid(lockPath);
    const isDead = pid === null || !isProcessAlive(pid);
    if (isDead) {
      try {
        fs.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const exponentialDelay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponentialDelay * 0.2 * Math.random();
  return Math.floor(exponentialDelay + jitter);
}

export function sleepSync(ms: number): void {
  // Non-spinning blocking sleep. Atomics.wait parks the thread instead of
  // busy-polling Date.now(), so lock-contention retries don't burn a CPU
  // core for the whole backoff window. Returns immediately when ms <= 0
  // (Atomics.wait requires a positive timeout).
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export function tryAcquireWithStaleCleanup(
  filePath: string,
  opts: Required<LockOptions>,
  pid: number,
): LockContext | null {
  const lockPath = filePath + opts.lockSuffix;
  if (tryAcquireLock(lockPath, pid) && readLockPid(lockPath) === pid) {
    return { lockPath, pid, acquiredAt: Date.now() };
  }
  cleanupStaleLock(lockPath, opts.lockStaleMs);
  if (tryAcquireLock(lockPath, pid) && readLockPid(lockPath) === pid) {
    return { lockPath, pid, acquiredAt: Date.now() };
  }
  return null;
}

function buildLockError(filePath: string, opts: Required<LockOptions>): LockAcquisitionError {
  const lockPath = filePath + opts.lockSuffix;
  const holderPid = readLockPid(lockPath);
  const holderStatus = holderPid !== null
    ? (isProcessAlive(holderPid) ? `alive (PID ${holderPid})` : `dead (PID ${holderPid})`)
    : 'unknown';
  return new LockAcquisitionError(
    `Failed to acquire lock for ${filePath}. Lock holder: ${holderStatus}.`,
    filePath,
    lockPath,
  );
}

export function acquireLock(filePath: string, options: LockOptions = {}): LockContext {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const { pid } = process;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const ctx = tryAcquireWithStaleCleanup(filePath, opts, pid);
    if (ctx) return ctx;
    if (attempt < opts.maxRetries - 1) {
      sleepSync(calculateBackoff(attempt, opts.baseRetryDelayMs, opts.maxRetryDelayMs));
    }
  }
  throw buildLockError(filePath, opts);
}

export async function acquireLockAsync(filePath: string, options: LockOptions = {}): Promise<LockContext> {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const { pid } = process;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const ctx = tryAcquireWithStaleCleanup(filePath, opts, pid);
    if (ctx) return ctx;
    if (attempt < opts.maxRetries - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, calculateBackoff(attempt, opts.baseRetryDelayMs, opts.maxRetryDelayMs)));
    }
  }
  throw buildLockError(filePath, opts);
}

export function releaseLock(ctx: LockContext): void {
  safeReleaseLock(ctx.lockPath, ctx.pid);
}

/**
 * Run `fn` while holding the ledger file lock. FAIL-LOUD: if the lock cannot
 * be acquired after bounded retries, throws LockAcquisitionError carrying the
 * file + lock path (EP-03 / ERR-009 — no silent fallback).
 *
 * Exported so tests and integrators can drive the lock primitive directly with
 * a tight retry budget (the public mutators use production defaults).
 */
export function withLock<T>(filePath: string, fn: () => T, options?: LockOptions): T {
  const ctx = acquireLock(filePath, options);
  try {
    return fn();
  } finally {
    releaseLock(ctx);
  }
}

/**
 * Async variant of {@link withLock} — same O_EXCL cross-process semantics,
 * PID-liveness stale cleanup and fail-loud LockAcquisitionError, with
 * non-blocking backoff so an async critical section (e.g. the candidate
 * intake coordination section: SQLite reads → ledger write → evidence audit)
 * can await WITHOUT freezing the event loop. Exported for the adapter's
 * candidate-level coordination lock (Phase 7.2 P1-02) and for integrations
 * that must serialize async work on the same discipline as the ledger
 * mutators. Lock ordering rule: a candidate coordination lock is ALWAYS
 * acquired BEFORE any ledger lock, never the reverse.
 */
async function withLockAsyncInternal<T>(filePath: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  const ctx = await acquireLockAsync(filePath, options);
  try {
    return await fn();
  } finally {
    releaseLock(ctx);
  }
}

export function withLockAsync<T>(filePath: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  return withLockAsyncInternal(filePath, fn, options);
}


