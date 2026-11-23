/**
 * Workspace background-execution ownership transitions — the CAS write path
 * for SPEC-PD-SERVICE-HOST-001 §8.4 (PRI-1282 Phase 4).
 *
 * The manifest schema (`backgroundExecutions`, `BackgroundExecutionRecord`)
 * lives in `index.ts`; this module owns the STATE MACHINE half that the
 * schema doc string deferred: starting, completing, aborting and rolling back
 * a per-Workspace ownership transition under a cross-process critical section
 * with monotonic-generation fencing and operationId idempotency.
 *
 * Phase attribution (Owner execution directive 2026-11-22, closing the
 * SPEC §8.4-10 / TD §9 conflict): Phase 4 implements this minimal, reusable
 * primitive and uses it for the OpenClaw per-Workspace handover; Phase 5
 * REUSES it for Codex / WorkBuddy — there is no second state machine.
 *
 * Concurrency model:
 *  - physical exclusion: one lock directory next to the manifest
 *    (`<manifest>.cas.lock/`, O_EXCL mkdir + owner metadata — the
 *    pd-worktree-mutation.lock pattern, at file scope), with every
 *    acquire / stale-reclaim / release DECISION serialized through a
 *    dedicated SQLite arbitration gate (`<manifest>.cas.gate.db`,
 *    `BEGIN IMMEDIATE` — the same proven mechanism as the service-run
 *    lock's `service-run-gate.db`, here on the dependency-free
 *    `better-sqlite3`, Node ≥22.0-compatible and warning-free). Under the
 *    gate, verify→remove→create is
 *    one serialized section: no contender can interleave between a
 *    reclaim's check and its recreate, and a release deletes only the
 *    lock whose owner token it verified inside the same transaction;
 *  - logical fencing: inside the critical section the writer re-reads the
 *    current record; a stale observed `generation` or an unexpected state
 *    loses and nothing is written;
 *  - durability: the manifest lands via temp file + atomic rename, so a crash
 *    mid-write leaves either the previous or the complete new document —
 *    never a partial one.
 *
 * Ownership of process liveness is NEVER consulted: PID, startup order and
 * delays are not proof (SPEC §8.4). The persisted record is the only
 * authority; `readWorkspaceBackgroundOwnership` is its read-side projection
 * shared by the OpenClaw Gateway gate, the `pd openclaw worker` gate and the
 * handover/rollback commands.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  installManifestHostsForPersist,
  mergeInstallManifestWorkspaces,
  parseInstallManifest,
  setInstallManifestBackgroundExecution,
  type BackgroundExecutionRecord,
  type BackgroundExecutionState,
  type InstallManifest,
} from './index.js';

// ─── Lock ───────────────────────────────────────────────────────────────────

const CAS_LOCK_SCHEMA = 'pd.background-execution-cas-lock/1';
/** @deprecated Retired (PRI-1282 review round 4): file age never proves
 * abandonment — reclaim authority is holder-PID liveness only. Kept exported
 * for source compatibility; no code path consults it. */
export const DEFAULT_CAS_LOCK_STALE_MS = 30_000;

export interface CasLockOwner {
  schema: string;
  token: string;
  pid: number;
  host: string;
  operation: string;
  workspaceDir: string;
  createdAt: string;
}

export interface CasLockAcquireOptions {
  manifestPath: string;
  operation: string;
  workspaceDir: string;
  /** @deprecated Retired (PRI-1282 review round 4): file age is never a
   * reclaim authority — only a provably-dead holder PID is. Accepted and
   * ignored for source compatibility. */
  staleMs?: number;
  now?: () => Date;
  /** Test seam: real fs by default. */
  fsOps?: CasFsOps;
  /**
   * Test seams — production passes nothing.
   */
  probes?: {
    /**
     * Holder-liveness probe for the PID recorded in a stale lock's owner
     * metadata. Default: `process.kill(pid, 0)` semantics
     * (alive / ESRCH→dead / EPERM→alive / anything else→unknown). Tests
     * inject fakes; an inconclusive answer MUST be 'unknown' (fail-closed).
     */
    readonly processAlive?: (pid: number) => 'alive' | 'dead' | 'unknown';
    /**
     * Arbitration-gate factory. Default opens the real `better-sqlite3`
     * gate database at `<manifest>.cas.gate.db`. Tests inject failures
     * (gate unopenable → fail-closed `lock_io_error`) or wraps to prove
     * a decision ran inside the transaction.
     */
    readonly openGate?: (gatePath: string) => CasGateLike;
    /**
     * Deterministic test hook invoked once per phase INSIDE the gate
     * transaction — a contender parked here still holds the gate, which
     * is what interleaving tests need to prove.
     */
    readonly gateSync?: (phase: CasGatePhase) => void;
  };
}

/** Deterministic injection points inside the arbitrated section. */
export type CasGatePhase =
  | 'gate-held'          // transaction open; about to evaluate the lock
  | 'lock-evaluated'     // owner state decided; about to act on it
  | 'stale-removed'      // dead holder's lock removed; about to create ours
  | 'lock-created';      // our lock created; about to end the transaction

export interface CasLockHandle {
  lockDir: string;
  owner: CasLockOwner;
  release: () => void;
}

export type CasLockAcquireResult =
  | { ok: true; handle: CasLockHandle }
  | { ok: false; reason: 'lock_busy' | 'lock_invalid' | 'lock_io_error'; message: string; holder?: CasLockOwner };

/** Best-effort realpath probe (injectable for platform/alias tests). */
export type RealpathProbe = (target: string) => string | undefined;

function defaultRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/** Filesystem seam so tests can inject failures without monkey-patching node. */
export interface CasFsOps {
  mkdirExclusive(dir: string): { ok: true } | { ok: false; code: 'exists' | 'io'; error?: Error };
  readJson(file: string): { ok: true; value: unknown } | { ok: false; code: 'missing' | 'malformed' | 'io'; error?: Error };
  writeJson(file: string, value: unknown): { ok: true } | { ok: false; code: 'io'; error?: Error };
  removeDir(dir: string): { ok: true } | { ok: false; code: 'io'; error?: Error };
  rename(from: string, to: string): { ok: true } | { ok: false; code: 'io'; error?: Error };
  readFile(file: string): { ok: true; text: string } | { ok: false; code: 'missing' | 'io'; error?: Error };
  writeFile(file: string, text: string): { ok: true } | { ok: false; code: 'io'; error?: Error };
}

/**
 * Errno extraction without trusting the thrown shape (rc-1/rc-2/rc-5) — the
 * same classification posture as `mcp-binding-contract.ts`.
 */
function errnoOf(error: unknown): string {
  return typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
    ? String(Reflect.get(error, 'code'))
    : '';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Type-guard narrowing for untrusted JSON values (rc-2: never an `as`). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default holder-liveness probe: signal-0 semantics, the same contract the
 * service-run-lock uses — 'alive' includes EPERM-observable processes
 * (exists, we just can't signal it); 'unknown' means the platform could not
 * produce a reliable verdict and reclaim MUST fail closed on it.
 */
function defaultProcessAlive(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function busyWaitMs(ms: number): void {
  // Sync context: a bounded spin over Date.now(). Callers only reach here on
  // contention windows, which are millisecond-scale events.
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    /* spin */
  }
}

// ─── Arbitration gate (PRI-1282 review round 4) ─────────────────────────────
//
// Pure-POSIX file moves cannot express "verify identity THEN delete-or-create"
// as one atomic step: any rename-aside + conditional restore leaves a window
// where a fresh lock lands at the lock path and the restore clobbers or
// strands it. The repository's proven answer to exactly this race class is
// the service-run lock's arbitration gate (`service-run-gate.db`, SQLite
// `BEGIN IMMEDIATE`): the OS/SQLite advisory lock serializes every decision,
// so inside the transaction a contender cannot exist between our check and
// our action. The gate runs on `better-sqlite3` (already a runtime dep of
// the install cohort): `node:sqlite` only exists on Node ≥22.5 — below the
// installer's declared Node ≥22.0 floor — and emits an ExperimentalWarning
// that contaminates every spawned consumer's stderr.

/** Minimal surface of `better-sqlite3.Database` the gate needs (test-injectable). */
export interface CasGateLike {
  exec(sql: string): void;
  close(): void;
}

/** The one arbitration database per manifest — stable, never per-attempt. */
export function casGatePath(manifestPath: string): string {
  return `${manifestPath}.cas.gate.db`;
}

/** A lock decision is millisecond-scale file work; a contender waits only
 * this long for the gate before reporting `lock_busy`. */
const CAS_GATE_BUSY_TIMEOUT_MS = 250;
/** Release gets a bounded wait of its own (same posture as the run lock). */
const CAS_GATE_RELEASE_BUSY_MS = 1500;

function defaultOpenGate(gatePath: string): CasGateLike {
  const db = new Database(gatePath);
  db.exec(`PRAGMA busy_timeout = ${CAS_GATE_BUSY_TIMEOUT_MS}`);
  return db;
}

function isGateBusyError(error: unknown): boolean {
  // better-sqlite3 surfaces busy/locked as SqliteError.code strings.
  const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
    ? String(Reflect.get(error, 'code'))
    : '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

type CasGateOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'lock_busy' | 'lock_io_error'; message: string };

/**
 * Run `body` while holding the CAS arbitration gate: open the per-manifest
 * gate database, `BEGIN IMMEDIATE`, run the serialized decision, end the
 * transaction. The gate stores no state — the transaction ends with
 * `ROLLBACK`, so a failed COMMIT can never orphan filesystem work done in
 * `body`. A process dying mid-transaction releases the gate through the OS
 * (POSIX fcntl / Windows LockFileEx), so recovery is deterministic.
 * SQLITE_BUSY maps to `lock_busy`; every other gate failure is
 * `lock_io_error` — decisions NEVER run outside arbitration.
 */
function withCasGate<T>(
  manifestPath: string,
  opts: {
    busyTimeoutMs: number;
    openGate?: (gatePath: string) => CasGateLike;
    gateSync?: (phase: CasGatePhase) => void;
  },
  body: (gateSync: (phase: CasGatePhase) => void) => T,
): CasGateOutcome<T> {
  let db: CasGateLike | undefined;
  try {
    db = (opts.openGate ?? defaultOpenGate)(casGatePath(manifestPath));
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs}`);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already closing
    }
    return { ok: false, reason: 'lock_io_error', message: `arbitration gate unavailable: ${toError(error).message}` };
  }
  const gateSync = opts.gateSync ?? (() => undefined);
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
      reason: isGateBusyError(error) ? 'lock_busy' : 'lock_io_error',
      message: `arbitration gate begin failed: ${toError(error).message}`,
    };
  }
  try {
    const value = body(gateSync);
    // No persistent gate data: ROLLBACK ends the transaction.
    db.exec('ROLLBACK');
    return { ok: true, value };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback best-effort; process death releases the gate anyway
    }
    return {
      ok: false,
      reason: isGateBusyError(error) ? 'lock_busy' : 'lock_io_error',
      message: `arbitration gate transaction failed: ${toError(error).message}`,
    };
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

const realFsOps: CasFsOps = {
  mkdirExclusive(dir) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      return { ok: true };
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') return { ok: false, code: 'exists' };
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  readJson(file) {
    try {
      return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { ok: false, code: 'missing' };
      if (error instanceof SyntaxError) return { ok: false, code: 'malformed', error: toError(error) };
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  writeJson(file, value) {
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  removeDir(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  rename(from, to) {
    try {
      fs.renameSync(from, to);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  readFile(file) {
    try {
      return { ok: true, text: fs.readFileSync(file, 'utf8') };
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { ok: false, code: 'missing' };
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
  writeFile(file, text) {
    try {
      fs.writeFileSync(file, text, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'io', error: toError(error) };
    }
  },
};

export function defaultCasFsOps(): CasFsOps {
  return realFsOps;
}

function parseLockOwner(value: unknown): CasLockOwner | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== CAS_LOCK_SCHEMA) return null;
  const token = typeof record.token === 'string' ? record.token : '';
  const operation = typeof record.operation === 'string' ? record.operation : '';
  const workspaceDir = typeof record.workspaceDir === 'string' ? record.workspaceDir : '';
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
  const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : -1;
  const host = typeof record.host === 'string' ? record.host : '';
  if (token.length === 0 || operation.length === 0 || workspaceDir.length === 0 || createdAt.length === 0) return null;
  return { schema: CAS_LOCK_SCHEMA, token, pid, host, operation, workspaceDir, createdAt };
}

function randomToken(): string {
  // Identity token for lock attribution / temp-file uniqueness — not a secret,
  // but randomUUID is free and collision-proof, so no weaker source is used.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function ownerFileName(): string {
  // A fixed name keeps "is this lock well-formed" decidable without globbing.
  return 'owner.json';
}

type AcquiredOwner = { ok: true; owner: CasLockOwner } | { ok: false; reason: 'lock_busy' | 'lock_invalid' | 'lock_io_error'; message: string; holder?: CasLockOwner };

/**
 * Remove a lock dir whose removal was already DECIDED inside the gate
 * transaction: atomically move the whole directory out of the canonical
 * lock path first, then delete the moved copy (PRI-1282 review round 5).
 * Recursive deletion at the lock path removes owner.json before the dir,
 * so a mid-delete kill stranded an unattributable orphan that blocked
 * every later writer as `lock_invalid`. With move-out-first, a successor
 * sees either the complete old lock or an absent path; a leftover
 * `*.tombstone-*` sibling is inert garbage, not a lock.
 */
function removeLockDirAtomically(fsOps: CasFsOps, lockDir: string): { ok: boolean; error?: Error } {
  const tombstone = `${lockDir}.tombstone-${randomToken()}`;
  const moved = fsOps.rename(lockDir, tombstone);
  if (!moved.ok) return { ok: false, error: moved.error };
  // Best-effort: the lock path is already free; a failed rm leaves an inert
  // tombstone sibling, never a lock at the canonical path.
  fsOps.removeDir(tombstone);
  return { ok: true };
}

/**
 * Acquire the per-manifest CAS critical section. Every decision — evaluate
 * the existing lock, reclaim a provably-dead holder's lock, create ours —
 * runs inside ONE `BEGIN IMMEDIATE` transaction on the per-manifest
 * arbitration gate ({@link casGatePath}), so verify→remove→create is a
 * serialized section by construction: no second contender can interleave
 * between the check and the action (PRI-1282 review round 4 — the
 * rename-quarantine/restore pattern it replaces could strand or overwrite
 * a fresh lock in the check→act gap).
 *
 * Reclaim authority is the recorded holder's PID liveness, never file age:
 * a lock is reclaimed ONLY when the recorded PID is provably dead on this
 * host — a dead holder cannot be inside the critical section and cannot
 * resume to delete the replacement lock. A live, foreign-host or
 * unverifiable holder is `lock_busy`/`lock_invalid` — fail-closed.
 */
export function acquireBackgroundExecutionCasLock(options: CasLockAcquireOptions): CasLockAcquireResult {
  const fsOps = options.fsOps ?? realFsOps;
  const now = options.now ?? (() => new Date());
  const processAlive = options.probes?.processAlive ?? defaultProcessAlive;
  const lockDir = `${options.manifestPath}.cas.lock`;
  const ownerFile = path.join(lockDir, ownerFileName());

  const buildOwner = (): CasLockOwner => ({
    schema: CAS_LOCK_SCHEMA,
    token: randomToken(),
    pid: process.pid,
    // Diagnostics-only field; never a control input.
    host: typeof os.hostname === 'function' ? os.hostname() : 'unavailable',
    operation: options.operation,
    workspaceDir: options.workspaceDir,
    createdAt: now().toISOString(),
  });

  const gated = withCasGate(
    options.manifestPath,
    { busyTimeoutMs: CAS_GATE_BUSY_TIMEOUT_MS, openGate: options.probes?.openGate, gateSync: options.probes?.gateSync },
    (gateSync): AcquiredOwner => {
      gateSync('gate-held');
      const createOwned = (): AcquiredOwner => {
        const owner = buildOwner();
        const created = fsOps.mkdirExclusive(lockDir);
        if (!created.ok) {
          return { ok: false, reason: 'lock_io_error', message: `failed to create CAS lock directory: ${created.error?.message ?? 'io error'}` };
        }
        const written = fsOps.writeJson(ownerFile, owner);
        if (!written.ok) {
          // We own the directory but cannot attribute it — remove it so the
          // next acquirer is not stuck on an anonymous empty dir.
          fsOps.removeDir(lockDir);
          return { ok: false, reason: 'lock_io_error', message: `failed to write CAS lock owner metadata: ${written.error?.message ?? 'io error'}` };
        }
        gateSync('lock-created');
        return { ok: true, owner };
      };

      // Lock exists (or absent): attribute it.
      const ownerRead = fsOps.readJson(ownerFile);
      if (!ownerRead.ok && ownerRead.code === 'missing') {
        // No owner metadata: either the whole lock dir is absent (we create)
        // or it exists as an unattributable orphan (a crashed mid-create —
        // never a live cooperator, whose owner.json is written inside the
        // same gate transaction). The exclusive mkdir decides which.
        const probe = fsOps.mkdirExclusive(lockDir);
        if (probe.ok) {
          const owner = buildOwner();
          const written = fsOps.writeJson(ownerFile, owner);
          if (!written.ok) {
            fsOps.removeDir(lockDir);
            return { ok: false, reason: 'lock_io_error', message: `failed to write CAS lock owner metadata: ${written.error?.message ?? 'io error'}` };
          }
          gateSync('lock-created');
          return { ok: true, owner };
        }
        if (probe.code === 'exists') {
          // Orphaned dir without owner.json — a crashed mid-create (inside
          // the gate a live cooperator cannot be mid-create). Reclaim it
          // the same atomic way instead of failing closed forever: move it
          // out of the canonical path, then recreate ours.
          const cleared = removeLockDirAtomically(fsOps, lockDir);
          if (!cleared.ok) {
            return { ok: false, reason: 'lock_io_error', message: `failed to move the orphaned CAS lock aside: ${cleared.error?.message ?? 'io error'}` };
          }
          return createOwned();
        }
        return { ok: false, reason: 'lock_io_error', message: `failed to create CAS lock directory: ${probe.error?.message ?? 'io error'}` };
      }
      if (!ownerRead.ok) {
        if (ownerRead.code === 'malformed') {
          return { ok: false, reason: 'lock_invalid', message: `CAS lock ${lockDir} has malformed owner metadata; a human must inspect and remove it` };
        }
        return { ok: false, reason: 'lock_io_error', message: `failed to read CAS lock owner metadata: ${ownerRead.error?.message ?? 'io error'}` };
      }
      const holder = parseLockOwner(ownerRead.value);
      if (holder === null) {
        return { ok: false, reason: 'lock_invalid', message: `CAS lock ${lockDir} has missing or malformed owner metadata; a human must inspect and remove it` };
      }
      gateSync('lock-evaluated');
      const ageMs = Date.parse(holder.createdAt);
      const age = Number.isFinite(ageMs) ? now().getTime() - ageMs : Number.POSITIVE_INFINITY;
      const liveness = holder.host === os.hostname() && holder.pid > 0
        ? processAlive(holder.pid)
        : ('unknown' as const);
      if (liveness !== 'dead') {
        return {
          ok: false,
          reason: 'lock_busy',
          message: `CAS lock held by operation=${holder.operation} pid=${holder.pid} host=${holder.host} ageMs=${Math.max(0, Math.round(age))} target=${holder.workspaceDir} liveness=${liveness} (a lock is only reclaimed when its holder PID is provably dead)`,
          holder,
        };
      }
      // Provably-dead holder → serialized reclaim: atomic move-out of the
      // whole dir + recreate inside the SAME gate transaction, so no new
      // lock can land in between and a mid-delete kill cannot strand an
      // owner-less dir at the lock path.
      const removed = removeLockDirAtomically(fsOps, lockDir);
      if (!removed.ok) {
        return { ok: false, reason: 'lock_io_error', message: `failed to move the dead holder's CAS lock aside: ${removed.error?.message ?? 'io error'}` };
      }
      gateSync('stale-removed');
      return createOwned();
    },
  );

  if (!gated.ok) return { ok: false, reason: gated.reason, message: gated.message };
  const acquired = gated.value;
  if (!acquired.ok) return acquired;
  const { owner } = acquired;
  return {
    ok: true,
    handle: {
      lockDir,
      owner,
      release: () => {
        // Compare-and-delete under the SAME arbitration gate: the owner
        // metadata is re-read inside the transaction and the directory is
        // removed only while it still carries OUR token — a foreign or
        // replaced lock is never deleted, and no contender can interleave
        // between the verify and the remove (PRI-1282 review round 4).
        void withCasGate(
          options.manifestPath,
          { busyTimeoutMs: CAS_GATE_RELEASE_BUSY_MS, openGate: options.probes?.openGate },
          () => {
            const current = fsOps.readJson(ownerFile);
            const parsed = current.ok ? parseLockOwner(current.value) : null;
            if (parsed !== null && parsed.token === owner.token) {
              removeLockDirAtomically(fsOps, lockDir);
            }
            // Absent or foreign: nothing provably ours to remove — leave it.
          },
        );
      },
    },
  };
}

// ─── Manifest write lock for non-transition writers (ERR-168) ───────────────

export interface WithManifestWriteLockOptions {
  manifestPath: string;
  /** Attribution label, e.g. 'installer.writeInstallManifest'. */
  operation: string;
  /** Attribution context — install-level writers pass the PD home. */
  context: string;
  /** Bounded busy-wait retries; the critical section is millisecond-scale. */
  retries?: number;
  retryDelayMs?: number;
  fsOps?: CasFsOps;
  now?: () => Date;
}

export type WithManifestWriteLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'lock_busy' | 'lock_invalid' | 'lock_io_error'; message: string };

/**
 * Run a manifest read-modify-write under the SAME physical lock the §8.4
 * transition path takes (ERR-168: a whole-object load→modify→save writer that
 * ignores the locked single-writer mutator can clobber its sub-section). The
 * installer and update-side config writers wrap their writes with this; the
 * transition primitive uses the lock directly. Lock failure is LOUD — a
 * writer must never fall back to an unlocked write.
 */
export function withInstallManifestWriteLock<T>(
  options: WithManifestWriteLockOptions,
  fn: () => T,
): WithManifestWriteLockResult<T> {
  const retries = options.retries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 50;
  let lastFailure: { reason: 'lock_busy' | 'lock_invalid' | 'lock_io_error'; message: string } | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const lock = acquireBackgroundExecutionCasLock({
      manifestPath: options.manifestPath,
      operation: options.operation,
      workspaceDir: options.context,
      now: options.now,
      fsOps: options.fsOps,
    });
    if (lock.ok) {
      try {
        return { ok: true, value: fn() };
      } finally {
        lock.handle.release();
      }
    }
    lastFailure = { reason: lock.reason, message: lock.message };
    if (lock.reason !== 'lock_busy') break; // invalid/io failures never improve by retrying
    if (attempt < retries) busyWaitMs(retryDelayMs);
  }
  return { ok: false, reason: lastFailure?.reason ?? 'lock_busy', message: lastFailure?.message ?? 'lock acquisition failed' };
}

// ─── Read-side projection ───────────────────────────────────────────────────

export type WorkspaceBackgroundOwnership =
  | {
      status: 'legacy_owned';
      source: 'no_record' | 'record';
      /** Implicit generation of the legacy default is 0; a record carries its own. */
      generation: number;
      record?: BackgroundExecutionRecord;
    }
  | {
      status: Exclude<BackgroundExecutionState, 'legacy_owned'>;
      generation: number;
      record: BackgroundExecutionRecord;
    }
  | { status: 'manifest_unreadable'; reason: string; nextAction: string };

export interface ReadOwnershipOptions {
  manifestPath: string;
  workspaceDir: string;
  platform?: string;
  fsOps?: CasFsOps;
  /** Realpath probe for alias identity (default: native realpath). */
  realpath?: RealpathProbe;
}

// ─── Real-directory identity (PRI-1282 review: path alias hole) ─────────────

/**
 * Ownership must resolve by the REAL directory, not the lexical spelling the
 * caller happened to pass: `workspaces[]` may hold an alias (symlinked or
 * differently-spelled canonical path) of the same directory while the worker
 * is launched with the real path — a lexical lookup then misses the record
 * and silently drops the workspace to the legacy default. Every
 * `workspaces[]` entry naming the same real directory is a candidate record
 * key; several disagreeing records under one real directory are
 * refuse-to-guess structural damage, never silently merged.
 */
interface OwnershipIdentityResolution {
  /** `workspaces[]` entries naming the queried real directory. */
  registeredAliases: string[];
  /** The distinct ownership records found under those keys (deduped). */
  records: { key: string; record: BackgroundExecutionRecord }[];
  /** Two or more DIFFERENT records under the same real directory. */
  conflicting: boolean;
}

function sameOwnershipRecord(a: BackgroundExecutionRecord, b: BackgroundExecutionRecord): boolean {
  return a.state === b.state
    && a.effectiveOwner === b.effectiveOwner
    && a.generation === b.generation
    && a.operationId === b.operationId
    && a.previousOwner === b.previousOwner
    && a.targetOwner === b.targetOwner;
}

function resolveOwnershipIdentity(args: {
  readonly manifest: InstallManifest;
  readonly workspaceDir: string;
  readonly platform: string;
  readonly realpath: RealpathProbe;
}): OwnershipIdentityResolution {
  const { manifest, workspaceDir, platform, realpath } = args;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const identityOf = (candidate: string): string => {
    const lexical = api.resolve(candidate);
    const resolved = realpath(lexical) ?? lexical;
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = identityOf(workspaceDir);
  const registeredAliases = (manifest.workspaces ?? []).filter((entry) => identityOf(entry) === target);
  const records: { key: string; record: BackgroundExecutionRecord }[] = [];
  for (const key of registeredAliases) {
    const record = manifest.backgroundExecutions?.[key];
    if (record !== undefined && !records.some((entry) => sameOwnershipRecord(entry.record, record))) {
      records.push({ key, record });
    }
  }
  return { registeredAliases, records, conflicting: records.length > 1 };
}


const OWNER_ALIAS_CONFLICT_NEXT_ACTION =
  'Two registered path spellings of the same directory carry DIFFERENT ownership records; a writer must reconcile ~/.pd/install.json (remove the duplicate workspace entry / record) before background execution decisions.';

/**
 * The single read-side projection of §8.4 ownership for ONE workspace.
 * Consumers: the OpenClaw Gateway start/tick gate, the `pd openclaw worker`
 * gate, and the handover/rollback commands. Fail-closed: an unreadable or
 * malformed manifest is `manifest_unreadable` — "cannot decide" is NEVER
 * collapsed into "legacy by default" for a consumer that is about to act.
 */
export function readWorkspaceBackgroundOwnership(options: ReadOwnershipOptions): WorkspaceBackgroundOwnership {
  const fsOps = options.fsOps ?? realFsOps;
  const text = fsOps.readFile(options.manifestPath);
  if (!text.ok) {
    return {
      status: 'manifest_unreadable',
      reason: text.code === 'missing' ? 'install_manifest_missing' : 'install_manifest_io_error',
      nextAction: text.code === 'missing'
        ? 'The PD install manifest was not found; run the PD installer or restore ~/.pd/install.json before background execution decisions.'
        : 'The PD install manifest could not be read; check permissions/disk and restore ~/.pd/install.json before background execution decisions.',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.text) as unknown;
  } catch {
    return {
      status: 'manifest_unreadable',
      reason: 'install_manifest_malformed',
      nextAction: 'The PD install manifest is not valid JSON; repair ~/.pd/install.json before background execution decisions.',
    };
  }
  const parsed = parseInstallManifest(raw, options.platform);
  if (!parsed.manifest) {
    return {
      status: 'manifest_unreadable',
      reason: parsed.error ?? 'install_manifest_malformed',
      nextAction: 'The PD install manifest failed validation; repair ~/.pd/install.json before background execution decisions.',
    };
  }
  const platform = options.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const canonical = api.resolve(options.workspaceDir);
  const identity = resolveOwnershipIdentity({
    manifest: parsed.manifest,
    workspaceDir: canonical,
    platform,
    realpath: options.realpath ?? defaultRealpath,
  });
  if (identity.conflicting) {
    return {
      status: 'manifest_unreadable',
      reason: `owner_alias_conflict:${identity.records.map((entry) => entry.key).join('|')}`,
      nextAction: OWNER_ALIAS_CONFLICT_NEXT_ACTION,
    };
  }
  const record = identity.records[0]?.record;
  if (record === undefined) {
    return { status: 'legacy_owned', source: 'no_record', generation: 0 };
  }
  if (record.state === 'legacy_owned') {
    return { status: 'legacy_owned', source: 'record', generation: record.generation, record };
  }
  return { status: record.state, generation: record.generation, record };
}

// ─── Transitions ────────────────────────────────────────────────────────────

export const BACKGROUND_EXECUTION_TRANSITIONS = [
  'begin_handover',
  'abort_handover',
  'complete_handover',
  'begin_rollback',
  'complete_rollback',
  'abort_rollback',
] as const;
export type BackgroundExecutionTransitionKind = (typeof BACKGROUND_EXECUTION_TRANSITIONS)[number];

export interface TransitionBackgroundExecutionInput {
  manifestPath: string;
  workspaceDir: string;
  kind: BackgroundExecutionTransitionKind;
  /**
   * Idempotency key of the operator's operation. Must match the persisted
   * `operationId` of an in-flight transition record for complete/abort; a
   * begin replaying the SAME id onto the same transition state is a no-op.
   */
  operationId: string;
  /** Caller-observed generation fence; mismatch refuses (stale view loses). */
  expectedGeneration?: number;
  /** begin_handover only: also merge the workspace into `workspaces[]`. */
  registerWorkspace?: boolean;
  platform?: string;
  now?: () => Date;
  staleMs?: number;
  fsOps?: CasFsOps;
  /** Realpath probe for alias identity (default: native realpath). */
  realpath?: RealpathProbe;
  /** Forwarded to the CAS lock acquire (holder-liveness test seam). */
  probes?: CasLockAcquireOptions['probes'];
}

export interface TransitionBackgroundExecutionSuccess {
  ok: true;
  /** Whether this call mutated the manifest (false = idempotent replay). */
  changed: boolean;
  record: BackgroundExecutionRecord;
  previous: BackgroundExecutionRecord | undefined;
}

export interface TransitionBackgroundExecutionFailure {
  ok: false;
  reason:
    | 'invalid_input'
    | 'manifest_unreadable'
    | 'workspace_not_registered'
    | 'unexpected_state'
    | 'stale_generation'
    | 'operation_in_progress'
    | 'operation_mismatch'
    | 'lock_busy'
    | 'lock_invalid'
    | 'lock_io_error'
    | 'io_error';
  message: string;
  nextAction?: string;
  current?: WorkspaceBackgroundOwnership;
}

export type TransitionBackgroundExecutionResult =
  | TransitionBackgroundExecutionSuccess
  | TransitionBackgroundExecutionFailure;

interface TransitionSpec {
  from: readonly BackgroundExecutionState[];
  to: BackgroundExecutionState;
  /** The transition record must carry an operationId (in-flight states). */
  needsOperationId: boolean;
}

const TRANSITION_SPECS: Record<BackgroundExecutionTransitionKind, TransitionSpec> = {
  // legacy_owned -> handover_preparing; effectiveOwner stays legacy (SPEC §8.4-3:
  // PREPARING grants no new rights — the old consumer remains the only one).
  begin_handover: { from: ['legacy_owned', 'handover_preparing'], to: 'handover_preparing', needsOperationId: true },
  abort_handover: { from: ['handover_preparing'], to: 'legacy_owned', needsOperationId: false },
  complete_handover: { from: ['handover_preparing'], to: 'service_host_owned', needsOperationId: false },
  begin_rollback: { from: ['service_host_owned', 'rollback_pending'], to: 'rollback_pending', needsOperationId: true },
  complete_rollback: { from: ['rollback_pending'], to: 'legacy_owned', needsOperationId: false },
  abort_rollback: { from: ['rollback_pending'], to: 'service_host_owned', needsOperationId: false },
};

function buildTargetRecord(context: {
  kind: BackgroundExecutionTransitionKind;
  currentGeneration: number;
  operationId: string;
  nowIso: string;
}): BackgroundExecutionRecord {
  const generation = context.currentGeneration + 1;
  const { operationId, nowIso } = context;
  switch (context.kind) {
    case 'begin_handover':
      return { state: 'handover_preparing', effectiveOwner: 'legacy', generation, operationId, previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: nowIso };
    case 'abort_handover':
      return { state: 'legacy_owned', effectiveOwner: 'legacy', generation, operationId: null, previousOwner: null, targetOwner: null, updatedAt: nowIso };
    case 'complete_handover':
      return { state: 'service_host_owned', effectiveOwner: 'service_host', generation, operationId: null, previousOwner: null, targetOwner: null, updatedAt: nowIso };
    case 'begin_rollback':
      return { state: 'rollback_pending', effectiveOwner: 'service_host', generation, operationId, previousOwner: 'service_host', targetOwner: 'legacy', updatedAt: nowIso };
    case 'complete_rollback':
      return { state: 'legacy_owned', effectiveOwner: 'legacy', generation, operationId: null, previousOwner: null, targetOwner: null, updatedAt: nowIso };
    case 'abort_rollback':
      return { state: 'service_host_owned', effectiveOwner: 'service_host', generation, operationId: null, previousOwner: null, targetOwner: null, updatedAt: nowIso };
  }
}

function projectOwnership(
  state: BackgroundExecutionState,
  generation: number,
  record: BackgroundExecutionRecord | undefined,
): WorkspaceBackgroundOwnership {
  if (state === 'legacy_owned') {
    return { status: 'legacy_owned', source: record !== undefined ? 'record' : 'no_record', generation, record };
  }
  if (record === undefined) {
    // Unreachable for transition states (a record must exist), kept total.
    return { status: 'legacy_owned', source: 'no_record', generation };
  }
  return { status: state, generation, record };
}

/**
 * Execute one §8.4 state-machine transition for one Workspace under the CAS
 * critical section. The manifest is read, validated, mutated as a RAW object
 * (unknown top-level fields survive — the update side owns `channel` /
 * `autoCheck` / `releaseMetadataUrl`), re-validated, and landed with an
 * atomic rename. A legacy single-key `backgroundExecution` spelling is
 * migrated to the per-Workspace map in the same write (both spellings after
 * the write would be a parse conflict).
 */
export function transitionWorkspaceBackgroundExecution(
  input: TransitionBackgroundExecutionInput,
): TransitionBackgroundExecutionResult {
  if (input.operationId.length === 0) {
    return { ok: false, reason: 'invalid_input', message: 'operationId must be a non-empty idempotency key' };
  }
  const fsOps = input.fsOps ?? realFsOps;
  const now = input.now ?? (() => new Date());
  const lock = acquireBackgroundExecutionCasLock({
    manifestPath: input.manifestPath,
    operation: input.kind,
    workspaceDir: input.workspaceDir,
    staleMs: input.staleMs,
    now,
    fsOps,
    probes: input.probes,
  });
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === 'lock_busy' ? 'lock_busy' : lock.reason === 'lock_invalid' ? 'lock_invalid' : 'lock_io_error', message: lock.message };
  }
  try {
    const text = fsOps.readFile(input.manifestPath);
    if (!text.ok) {
      return {
        ok: false,
        reason: 'manifest_unreadable',
        message: text.code === 'missing' ? 'install manifest not found' : 'install manifest not readable',
        nextAction: 'Restore ~/.pd/install.json; a transition never fabricates a fresh manifest over a missing one.',
      };
    }
    let raw: Record<string, unknown>;
    try {
      const parsedJson: unknown = JSON.parse(text.text);
      if (!isJsonObject(parsedJson)) {
        return { ok: false, reason: 'manifest_unreadable', message: 'install manifest is not a JSON object', nextAction: 'Repair ~/.pd/install.json.' };
      }
      raw = parsedJson;
    } catch {
      return { ok: false, reason: 'manifest_unreadable', message: 'install manifest is not valid JSON', nextAction: 'Repair ~/.pd/install.json.' };
    }
    const parsed = parseInstallManifest(raw, input.platform);
    if (!parsed.manifest) {
      return { ok: false, reason: 'manifest_unreadable', message: parsed.error ?? 'install manifest malformed', nextAction: 'Repair ~/.pd/install.json.' };
    }
    const manifest: InstallManifest = parsed.manifest;
    const platform = input.platform ?? process.platform;
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const canonical = pathApi.resolve(input.workspaceDir);
    const realpath = input.realpath ?? defaultRealpath;
    // The real directory the caller's path resolves to — records are pinned
    // to THIS, never to a registered alias spelling that could repoint.
    const realDir = pathApi.resolve(realpath(canonical) ?? canonical);

    // Identity is the REAL directory: the record may live under any
    // workspaces[] spelling of it (PRI-1282 review). Conflicting records
    // under one real directory refuse — never guess which alias wins.
    const identity = resolveOwnershipIdentity({ manifest, workspaceDir: canonical, platform, realpath });
    if (identity.conflicting) {
      return {
        ok: false,
        reason: 'manifest_unreadable',
        message: `conflicting ownership records across path aliases: ${identity.records.map((entry) => entry.key).join(' vs ')}`,
        nextAction: OWNER_ALIAS_CONFLICT_NEXT_ACTION,
      };
    }

    // Workspace registration: begin_handover may register (single atomic write
    // together with the record); every other kind requires existing membership
    // because a marker key outside `workspaces[]` cannot parse back. An alias
    // registration for the same real directory counts as registered.
    const registered = identity.registeredAliases.length > 0;
    if (!registered && !(input.kind === 'begin_handover' && input.registerWorkspace === true)) {
      return {
        ok: false,
        reason: 'workspace_not_registered',
        message: `workspace ${canonical} is not in the manifest workspaces list`,
        nextAction: 'Register the workspace through a begin_handover with registration, or the installer bind path.',
      };
    }

    const spec = TRANSITION_SPECS[input.kind];
    const recordKey = realDir;
    const priorKey = identity.records[0]?.key;
    const currentRecord = identity.records[0]?.record;
    const currentState: BackgroundExecutionState = currentRecord?.state ?? 'legacy_owned';
    const currentGeneration = currentRecord?.generation ?? 0;

    if (input.expectedGeneration !== undefined && input.expectedGeneration !== currentGeneration) {
      return {
        ok: false,
        reason: 'stale_generation',
        message: `observed generation ${input.expectedGeneration} but the manifest holds ${currentGeneration}`,
        nextAction: 'Re-read the ownership record and retry with the current generation; a stale observer never writes.',
        current: projectOwnership(currentState, currentGeneration, currentRecord),
      };
    }

    if (currentRecord !== undefined && currentState === spec.to && spec.needsOperationId) {
      // Idempotent begin replay: same operationId onto the same transition
      // state is a no-op; a different id means another operation owns it.
      const holderOp = currentRecord.operationId ?? '';
      if (holderOp === input.operationId) {
        return { ok: true, changed: false, record: currentRecord, previous: currentRecord };
      }
      return {
        ok: false,
        reason: 'operation_in_progress',
        message: `workspace is ${currentState} under operationId ${holderOp || '(none)'}; refusing to start ${input.operationId}`,
        nextAction: 'Wait for the in-flight operation to finish or abort it explicitly; one transition operation per workspace.',
        current: projectOwnership(currentState, currentGeneration, currentRecord),
      };
    }

    if (!spec.from.includes(currentState)) {
      return {
        ok: false,
        reason: 'unexpected_state',
        message: `${input.kind} requires state ${spec.from.join('|')} but the workspace is ${currentState}`,
        nextAction: 'Re-read the ownership record; recovery continues from the persisted state, never from process liveness.',
        current: projectOwnership(currentState, currentGeneration, currentRecord),
      };
    }

    // complete/abort must address the operation that opened the transition.
    if (currentState === 'handover_preparing' || currentState === 'rollback_pending') {
      const holderOp = currentRecord?.operationId ?? '';
      if (holderOp !== input.operationId) {
        return {
          ok: false,
          reason: 'operation_mismatch',
          message: `${input.kind} addresses operationId ${input.operationId} but the transition record holds ${holderOp || '(none)'}`,
          nextAction: 'Use the persisted operationId, or abort the in-flight operation first.',
          current: projectOwnership(currentState, currentGeneration, currentRecord),
        };
      }
    }

    const target = buildTargetRecord({
      kind: input.kind,
      currentGeneration,
      operationId: input.operationId,
      nowIso: now().toISOString(),
    });

    // Mutate the RAW object (unknown top-level fields survive) using the same
    // single-key authority helper the schema exposes. The record key is the
    // REAL directory; a record persisting under an alias spelling migrates
    // onto it in the same write so a repointed symlink cannot carry this
    // workspace's ownership to another directory (PRI-1282 review).
    const nextRecords = setInstallManifestBackgroundExecution(manifest, { workspaceDir: recordKey, platform }, target);
    if (priorKey !== undefined && priorKey !== recordKey) {
      delete nextRecords[priorKey];
    }
    if (Object.keys(nextRecords).length > 0) {
      raw.backgroundExecutions = nextRecords;
    } else {
      delete raw.backgroundExecutions;
    }
    // Migrate the legacy single-key spelling away in the same write.
    delete raw.backgroundExecution;
    // The record key MUST be a workspaces[] member or it cannot parse back:
    // the real directory registers in the same CAS — on begin_handover for
    // a new workspace, on any later transition that migrated an alias-keyed
    // record (PRI-1282 review).
    const registeredKeys = manifest.workspaces ?? [];
    const recordKeyRegistered = registeredKeys.some((entry) => pathApi.resolve(entry) === recordKey);
    if (!recordKeyRegistered) {
      raw.workspaces = mergeInstallManifestWorkspaces(manifest, recordKey, platform);
      raw.hosts = installManifestHostsForPersist(manifest);
    } else if (input.kind === 'begin_handover' && input.registerWorkspace === true && !registered) {
      raw.workspaces = mergeInstallManifestWorkspaces(manifest, recordKey, platform);
      raw.hosts = installManifestHostsForPersist(manifest);
    }

    // Re-validate the exact bytes we are about to land.
    const revalidated = parseInstallManifest(raw, input.platform);
    if (!revalidated.manifest || revalidated.manifest.backgroundExecutions?.[recordKey] === undefined) {
      return {
        ok: false,
        reason: 'io_error',
        message: `post-mutation validation failed: ${revalidated.error ?? 'target record missing after mutation'}`,
        nextAction: 'The manifest was NOT written; report this with the manifest backup.',
      };
    }

    const serialized = JSON.stringify(raw, null, 2) + '\n';
    const tempPath = `${input.manifestPath}.cas-tmp-${process.pid}-${randomToken()}`;
    const written = fsOps.writeFile(tempPath, serialized);
    if (!written.ok) {
      fsOps.removeDir(tempPath);
      return { ok: false, reason: 'io_error', message: `failed to write transition temp file: ${written.error?.message ?? 'io error'}` };
    }
    const renamed = fsOps.rename(tempPath, input.manifestPath);
    if (!renamed.ok) {
      fsOps.removeDir(tempPath);
      return { ok: false, reason: 'io_error', message: `failed to land the transition atomically: ${renamed.error?.message ?? 'io error'}` };
    }
    return { ok: true, changed: true, record: target, previous: currentRecord };
  } finally {
    lock.handle.release();
  }
}
