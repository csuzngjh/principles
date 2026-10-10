/**
 * Principle Tree Ledger — file-based ledger for principle entries.
 *
 * Lives in principles-core so pd-cli can read/write the ledger without
 * importing openclaw-plugin private code.
 *
 * M8: Single-path ledger. The ledger file is at:
 *   {stateDir}/principle_training_state.json
 *
 * PRI-459: This module is the SINGLE source of truth for parsing,
 * serialization, AND mutation of principle_training_state.json. Every
 * read-modify-write acquires a cross-process file lock (see withLock above),
 * eliminating the dual-writer lost-update class. The openclaw-plugin ledger
 * is now a thin re-export adapter over this module.
 */

import * as fs from 'fs';
import * as path from 'path';

// PRI-443: Types and constants now live in the pure module
import type {
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
} from './runtime-v2/types/ledger-store.js';
import { TREE_NAMESPACE } from './runtime-v2/types/ledger-store.js';
// PRI-459: lifecycle enum is the core SSOT (values match the transition table)
import type { ImplementationLifecycleState } from './runtime-v2/types/principle-enums.js';
// PRI-917 PR3B: reuse evidence contract lives with the Principle schema SSOT
import type { ReuseEvidenceActor, ReuseEvidenceEntry } from './runtime-v2/types/principle-schema.js';

// PRI-443: Pure parse/serialize functions extracted to codec module
import {
  isRecord,
  uniqueStrings,
  createEmptyTree,
  parseHybridLedger,
  serializeLedger,
} from './runtime-v2/principle-tree/ledger-codec.js';

// Re-export for backward compatibility — existing imports from
// @principles/core/principle-tree-ledger continue to work.
export type {
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
  ImplementationLifecycleState,
};
export type { ReuseEvidenceActor, ReuseEvidenceEntry };
export { TREE_NAMESPACE };

const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

// ---------------------------------------------------------------------------
// Atomic file write (inlined PRI-443 Phase 4)
// ---------------------------------------------------------------------------
//
// Previously exported from ./io.ts. Inlined here as a private helper because
// this is the ONLY consumer in principles-core. The openclaw-plugin has its
// own copy at src/utils/io.ts.
//
// Crash-safe: writes to a .tmp file then renames. On Windows, retries with
// exponential backoff on EPERM/EBUSY/EACCES to handle transient file locks.

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

function atomicWriteFileSync(filePath: string, data: string): void {
  // CodeQL fix (js/insecure-temporary-file): create a unique temp directory
  // in the SAME directory as the target (preserving atomic rename — same
  // filesystem) instead of using a predictable '.tmp' suffix. mkdtempSync
  // generates a randomized directory name with 0o700 permissions, preventing
  // symlink-attack and predictable-name vulnerabilities when stateDir is in
  // a world-writable location such as os.tmpdir() (common in tests).
  const targetDir = path.dirname(filePath);
  const tmpDir = fs.mkdtempSync(path.join(targetDir, '.pd-write-'));
  const tmpPath = path.join(tmpDir, 'tmp');
  try {
    fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        // Success — return; finally handles tmpDir cleanup.
        return;
      } catch (err) {
        lastError = err as Error;
        const {code} = (err as { code?: string });
        // Only retry on Windows transient lock errors
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          if (attempt < RENAME_MAX_RETRIES - 1) {
            const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt);
            // Synchronous sleep using a tight spin with accessSync yield
            const waitUntil = Date.now() + delay;
            while (Date.now() < waitUntil) {
              try { fs.accessSync(tmpPath); } catch { /* ignore */ }
            }
          }
          continue;
        }
        // Non-retryable error — throw immediately
        break;
      }
    }
    throw lastError ?? new Error('atomicWriteFileSync: rename failed');
  } finally {
    // best-effort cleanup: after rename, tmpPath no longer exists (unlink
    // fails silently), and tmpDir removal succeeds since it's now empty.
    // On writeFileSync or rename failure, both are cleaned up here — this
    // guarantees tmpDir never leaks even if writeFileSync throws (ENOSPC,
    // EACCES, etc.) before entering the retry loop.
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Ledger file I/O (the only non-pure part of this module)
// ---------------------------------------------------------------------------

function getLedgerFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

/**
 * PRI-915: why a ledger read produced the store it produced. `empty` is a
 * design-legal TRUE empty ledger (no file yet — fresh workspace — or a
 * zero-byte file): membership answers against it are real "non-member"
 * verdicts. `unreadable` is a transient outage (the file exists but cannot be
 * read/parsed): membership answers against it are NOT decidable, and callers
 * that would report "data drift" must consult availability first.
 */
export type LedgerFileAvailability =
  | { status: 'ok' }
  | { status: 'empty' }
  | { status: 'unreadable'; problem: string };

export function readLedgerFileState(stateDir: string): {
  ledger: HybridLedgerStore;
  availability: LedgerFileAvailability;
} {
  const filePath = getLedgerFilePath(stateDir);
  if (!fs.existsSync(filePath)) {
    return { ledger: { trainingStore: {}, tree: createEmptyTree() }, availability: { status: 'empty' } };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { ledger: { trainingStore: {}, tree: createEmptyTree() }, availability: { status: 'empty' } };
    }
    const parsed = JSON.parse(content) as unknown;
    return { ledger: parseHybridLedger(parsed), availability: { status: 'ok' } };
  } catch (err: unknown) {
    return {
      ledger: { trainingStore: {}, tree: createEmptyTree() },
      availability: { status: 'unreadable', problem: err instanceof Error ? err.message : String(err) },
    };
  }
}

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

interface LockOptions {
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  lockStaleMs?: number;
  lockSuffix?: string;
}

interface LockContext {
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

function tryAcquireLock(lockPath: string, pid: number): boolean {
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

function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function safeReleaseLock(lockPath: string, expectedPid: number): void {
  try {
    if (readLockPid(lockPath) === expectedPid) {
      fs.unlinkSync(lockPath);
    }
    // If PID does not match, the lock was re-acquired by another process; leave it.
  } catch {
    // best effort
  }
}

function cleanupStaleLock(lockPath: string, _staleMs: number): boolean {
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

function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const exponentialDelay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponentialDelay * 0.2 * Math.random();
  return Math.floor(exponentialDelay + jitter);
}

function sleepSync(ms: number): void {
  // Non-spinning blocking sleep. Atomics.wait parks the thread instead of
  // busy-polling Date.now(), so lock-contention retries don't burn a CPU
  // core for the whole backoff window. Returns immediately when ms <= 0
  // (Atomics.wait requires a positive timeout).
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function tryAcquireWithStaleCleanup(
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

function acquireLock(filePath: string, options: LockOptions = {}): LockContext {
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

async function acquireLockAsync(filePath: string, options: LockOptions = {}): Promise<LockContext> {
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

function releaseLock(ctx: LockContext): void {
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

async function withLockAsync<T>(filePath: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  const ctx = await acquireLockAsync(filePath, options);
  try {
    return await fn();
  } finally {
    releaseLock(ctx);
  }
}

// ---------------------------------------------------------------------------
// Ledger mutations (single writer, cross-process safe via the file lock above)
// ---------------------------------------------------------------------------

/**
 * Read-modify-write the ledger file atomically AND under a cross-process file
 * lock. Single source of truth since PRI-459: every mutation (sync + async)
 * acquires `<file>.lock`, eliminating the dual-writer lost-update class.
 */
function mutateLedger<T>(stateDir: string, mutate: (store: HybridLedgerStore) => T): T {
  const filePath = getLedgerFilePath(stateDir);
  return withLock(filePath, () => {
    const store = readLedgerFileState(stateDir).ledger;
    const result = mutate(store);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(filePath, serializeLedger(store));
    return result;
  });
}

/**
 * Async read-modify-write. Same lock semantics as {@link mutateLedger}.
 */
async function mutateLedgerAsync<T>(
  stateDir: string,
  mutate: (store: HybridLedgerStore) => Promise<T>,
): Promise<T> {
  const filePath = getLedgerFilePath(stateDir);
  return withLockAsync(filePath, async () => {
    const store = readLedgerFileState(stateDir).ledger;
    const result = await mutate(store);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(filePath, serializeLedger(store));
    return result;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadLedger(stateDir: string): HybridLedgerStore {
  return readLedgerFileState(stateDir).ledger;
}

export function saveLedger(stateDir: string, store: HybridLedgerStore): void {
  mutateLedger(stateDir, (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export function addPrincipleToLedger(stateDir: string, principle: LedgerPrinciple): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    store.tree.principles[principle.id] = principle;
    store.tree.lastUpdated = new Date().toISOString();
    return principle;
  });
}

export function updatePrinciple(stateDir: string, principleId: string, updates: Partial<LedgerPrinciple>): LedgerPrinciple {
  return mutateLedger(stateDir, (store) => {
    const existing = store.tree.principles[principleId];
    if (!existing) throw new Error(`Cannot update missing principle "${principleId}".`);
    const next: LedgerPrinciple = {
      ...existing,
      ...updates,
      id: principleId,
      ruleIds: updates.ruleIds ? uniqueStrings(updates.ruleIds) : existing.ruleIds,
      conflictsWithPrincipleIds: updates.conflictsWithPrincipleIds
        ? uniqueStrings(updates.conflictsWithPrincipleIds) : existing.conflictsWithPrincipleIds,
      derivedFromPainIds: updates.derivedFromPainIds
        ? uniqueStrings(updates.derivedFromPainIds) : existing.derivedFromPainIds,
    };
    store.tree.principles[principleId] = next;
    return next;
  });
}

// ---------------------------------------------------------------------------
// PRI-917 PR3B: reuse evidence append (SPEC v0.2.1 §12)
// ---------------------------------------------------------------------------

/**
 * Thrown when the ledger file's content is not trustworthy for a read-modify-
 * write: it parses to an empty principles tree while the file exists on disk
 * (empty, corrupt, or truncated), or an entity's persisted reuseEvidence field
 * has a malformed shape. Unlike a missing principle, writing over this state
 * would DESTROY ledger content, so the write refuses instead of proceeding
 * (rc-3).
 */
export class LedgerIntegrityError extends Error {
  public readonly filePath: string;
  constructor(message: string, filePath: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
    this.filePath = filePath;
  }
}

const REUSE_EVIDENCE_KEYS: readonly string[] = [
  'painId',
  'candidateId',
  'decision',
  'actor',
  'reason',
  'decidedAt',
  'decisionId',
];

/**
 * Runtime shape check for an untrusted reuse evidence entry (rc-1/rc-2/rc-3).
 * The caller-side decision surface parses owner/model output, so the ledger
 * writer re-validates at this boundary: any malformed or unexpected field
 * refuses the write — a half-valid evidence row must never land in the ledger.
 */
function validateReuseEvidenceEntry(entry: ReuseEvidenceEntry): void {
  const refuse = (detail: string): never => {
    throw new Error(
      `appendReuseEvidence: malformed reuse evidence entry (${detail}) — refusing to write (fail closed).`,
    );
  };
  if (!isRecord(entry)) refuse(`expected an object, got ${typeof entry}`);
  for (const key of Object.keys(entry)) {
    if (!REUSE_EVIDENCE_KEYS.includes(key)) refuse(`unknown field "${key}"`);
  }
  if (typeof entry.painId !== 'string' || entry.painId.trim() === '') refuse('painId must be a non-empty string');
  if (typeof entry.candidateId !== 'string' || entry.candidateId.trim() === '') {
    refuse('candidateId must be a non-empty string');
  }
  if (entry.decision !== 'reuse') refuse('decision must be exactly "reuse"');
  if (!isRecord(entry.actor)) refuse('actor must be an object');
  if (entry.actor.kind !== 'owner' && entry.actor.kind !== 'ai_owner') {
    refuse('actor.kind must be "owner" or "ai_owner"');
  }
  if (typeof entry.actor.id !== 'string' || entry.actor.id.trim() === '') refuse('actor.id must be a non-empty string');
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') refuse('reason must be a non-empty string');
  if (typeof entry.decidedAt !== 'string' || entry.decidedAt.trim() === '' || Number.isNaN(Date.parse(entry.decidedAt))) {
    refuse('decidedAt must be a parseable date string');
  }
  if (entry.decisionId !== undefined && (typeof entry.decisionId !== 'string' || entry.decisionId.trim() === '')) {
    refuse('decisionId, when present, must be a non-empty string');
  }
}

/**
 * Append one reuse-evidence entry to an existing Principle (PRI-917 PR3B,
 * SPEC v0.2.1 §12). The ONLY writer for `Principle.reuseEvidence`.
 *
 * Runs entirely inside the single-writer file lock via mutateLedger —
 * read → integrity guard → dedupe → append → save — so a concurrent append
 * can never be lost, and there is no load-then-update window between
 * processes. Do NOT implement appends via addPrincipleToLedger (it replaces
 * the whole entry and would silently drop existing evidence) or via an
 * external loadLedger+updatePrinciple sequence (read outside the lock).
 *
 * Fail-closed:
 *   - a ledger file that exists but parses to an empty principles tree (empty
 *     file, corrupt, or truncated) is treated as corruption — the write
 *     refuses rather than risk replacing the corpus with the new entry alone
 *     (LedgerIntegrityError);
 *   - a missing principleId refuses the write (no file mutation);
 *   - a malformed entry refuses the write.
 *
 * Idempotency key: (principleId, entry.candidateId). A candidate resolves
 * into a principle at most once, so replaying the same decision is a no-op
 * that returns the existing evidence with `appended: false` (INV-R07). A
 * no-op still goes through the normal save path, so the tree's lastUpdated
 * is refreshed; the ledger content itself is unchanged.
 *
 * Append-only (INV-R05): no other Principle field — including updatedAt —
 * is touched, and existing entries are never rewritten or removed. Target
 * eligibility (e.g. archived/deprecated exclusion, SPEC §15) is the
 * retrieval/proposal layer's invariant; this writer records the decision
 * verbatim.
 */
export function appendReuseEvidence(
  stateDir: string,
  principleId: string,
  entry: ReuseEvidenceEntry,
): { principleId: string; reuseEvidence: ReuseEvidenceEntry[]; appended: boolean } {
  validateReuseEvidenceEntry(entry);
  const filePath = getLedgerFilePath(stateDir);
  // Stat captured just before the lock as a hint; the authoritative check is
  // the in-lock one below against the parsed store. A file created between
  // this stat and the lock cannot trip the guard (it only fires when the
  // file already existed at stat time AND the parsed tree is empty).
  const statBefore = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return mutateLedger(stateDir, (store) => {
    if (statBefore !== null && Object.keys(store.tree.principles).length === 0) {
      throw new LedgerIntegrityError(
        `Ledger file ${filePath} exists (${statBefore.size} bytes) but parsed to an empty principles tree — ` +
          'the file is likely corrupt or truncated. Refusing to append reuse evidence, because the save ' +
          'below would replace the ledger with this write alone. Restore the ledger file first (fail closed).',
        filePath,
      );
    }
    const principle = store.tree.principles[principleId];
    if (!principle) {
      throw new Error(`Cannot append reuse evidence: principle "${principleId}" does not exist in the ledger.`);
    }
    const existing = principle.reuseEvidence;
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new LedgerIntegrityError(
        `Principle "${principleId}" has a malformed reuseEvidence field (expected an array, got ${typeof existing}). ` +
          'Refusing to append — fix or restore the ledger entry first (fail closed).',
        filePath,
      );
    }
    const current = existing ?? [];
    if (current.some((e) => isRecord(e) && e.candidateId === entry.candidateId)) {
      // Idempotent replay (INV-R07): this candidate already resolved into
      // this principle. No new entry, no new logical decision.
      return { principleId, reuseEvidence: current, appended: false };
    }
    const next: ReuseEvidenceEntry[] = [...current, entry];
    principle.reuseEvidence = next;
    return { principleId, reuseEvidence: next, appended: true };
  });
}

export function updatePrincipleValueMetrics(stateDir: string, principleId: string, metrics: PrincipleValueMetrics): PrincipleValueMetrics {
  return mutateLedger(stateDir, (store) => {
    const next: PrincipleValueMetrics = { ...metrics, principleId };
    store.tree.metrics[principleId] = next;
    return next;
  });
}

export function getLedgerFilePathPublic(stateDir: string): string {
  return getLedgerFilePath(stateDir);
}

// ---------------------------------------------------------------------------
// PRI-459: Rule / Implementation CRUD + lifecycle (hoisted from plugin ledger)
// ---------------------------------------------------------------------------
//
// These mutators previously existed ONLY in the openclaw-plugin ledger copy.
// They are now the core SSOT so the plugin ledger can become a re-export
// adapter. Behavior is preserved verbatim (parent-existence guards, cross-
// parent rule migration maintaining both ruleIds arrays, cascade delete,
// lifecycle state machine).

export interface PrincipleSubtree {
  principle: LedgerPrinciple;
  rules: {
    rule: LedgerRule;
    implementations: Implementation[];
  }[];
}

export function createRule(stateDir: string, rule: LedgerRule): LedgerRule {
  return mutateLedger(stateDir, (store) => {
    const principle = store.tree.principles[rule.principleId];
    if (!principle) {
      throw new Error(`Cannot create rule "${rule.id}" for missing principle "${rule.principleId}".`);
    }
    if (Object.hasOwn(store.tree.rules, rule.id)) {
      // Fail loud: overwriting would orphan the old parent's ruleIds link.
      // Use updateRule for intentional replacement (EP-09 / ERR-009).
      throw new Error(`Cannot create rule "${rule.id}": it already exists. Use updateRule instead.`);
    }
    const nextRule: LedgerRule = {
      ...rule,
      implementationIds: uniqueStrings(rule.implementationIds),
    };
    store.tree.rules[nextRule.id] = nextRule;
    principle.ruleIds = uniqueStrings([...principle.ruleIds, nextRule.id]);
    return nextRule;
  });
}

export function createImplementation(stateDir: string, implementation: Implementation): Implementation {
  return mutateLedger(stateDir, (store) => {
    const rule = store.tree.rules[implementation.ruleId];
    if (!rule) {
      throw new Error(`Cannot create implementation "${implementation.id}" for missing rule "${implementation.ruleId}".`);
    }
    if (Object.hasOwn(store.tree.implementations, implementation.id)) {
      // Fail loud: overwriting would orphan the old rule's implementationIds link.
      // Use updateImplementation for intentional replacement (EP-09 / ERR-009).
      throw new Error(`Cannot create implementation "${implementation.id}": it already exists. Use updateImplementation instead.`);
    }
    store.tree.implementations[implementation.id] = implementation;
    rule.implementationIds = uniqueStrings([...rule.implementationIds, implementation.id]);
    return implementation;
  });
}

export function updateRule(stateDir: string, ruleId: string, updates: Partial<LedgerRule>): LedgerRule {
  return mutateLedger(stateDir, (store) => {
    const existingRule = store.tree.rules[ruleId];
    if (!existingRule) {
      throw new Error(`Cannot update missing rule "${ruleId}".`);
    }
    const nextPrincipleId = updates.principleId ?? existingRule.principleId;
    const nextPrinciple = store.tree.principles[nextPrincipleId];
    if (!nextPrinciple) {
      throw new Error(`Cannot move rule "${ruleId}" to missing principle "${nextPrincipleId}".`);
    }
    const nextRule: LedgerRule = {
      ...existingRule,
      ...updates,
      id: ruleId,
      principleId: nextPrincipleId,
      implementationIds: updates.implementationIds
        ? uniqueStrings(updates.implementationIds)
        : existingRule.implementationIds,
    };
    if (existingRule.principleId !== nextPrincipleId) {
      const previousPrinciple = store.tree.principles[existingRule.principleId];
      if (previousPrinciple) {
        previousPrinciple.ruleIds = previousPrinciple.ruleIds.filter((candidateId) => candidateId !== ruleId);
      }
      nextPrinciple.ruleIds = uniqueStrings([...nextPrinciple.ruleIds, ruleId]);
    }
    store.tree.rules[ruleId] = nextRule;
    return nextRule;
  });
}

export function deleteRule(stateDir: string, ruleId: string): LedgerRule | undefined {
  return mutateLedger(stateDir, (store) => {
    const existingRule = store.tree.rules[ruleId];
    if (!existingRule) {
      return undefined;
    }
    const parentPrinciple = store.tree.principles[existingRule.principleId];
    if (parentPrinciple) {
      parentPrinciple.ruleIds = parentPrinciple.ruleIds.filter((candidateId) => candidateId !== ruleId);
    }
    // Cascade: delete every implementation attached to this rule, including
    // any whose implementationIds were not pre-listed on the rule.
    const implementationIds = uniqueStrings([
      ...existingRule.implementationIds,
      ...Object.values(store.tree.implementations)
        .filter((implementation) => implementation.ruleId === ruleId)
        .map((implementation) => implementation.id),
    ]);
    for (const implementationId of implementationIds) {
      delete store.tree.implementations[implementationId];
    }
    delete store.tree.rules[ruleId];
    return existingRule;
  });
}

export function updateImplementation(
  stateDir: string,
  implementationId: string,
  updates: Partial<Implementation>,
): Implementation {
  return mutateLedger(stateDir, (store) => {
    const existingImplementation = store.tree.implementations[implementationId];
    if (!existingImplementation) {
      throw new Error(`Cannot update missing implementation "${implementationId}".`);
    }
    const nextRuleId = updates.ruleId ?? existingImplementation.ruleId;
    const nextRule = store.tree.rules[nextRuleId];
    if (!nextRule) {
      throw new Error(`Cannot move implementation "${implementationId}" to missing rule "${nextRuleId}".`);
    }
    const nextImplementation: Implementation = {
      ...existingImplementation,
      ...updates,
      id: implementationId,
      ruleId: nextRuleId,
    };
    if (existingImplementation.ruleId !== nextRuleId) {
      const previousRule = store.tree.rules[existingImplementation.ruleId];
      if (previousRule) {
        previousRule.implementationIds = previousRule.implementationIds.filter(
          (candidateId) => candidateId !== implementationId,
        );
      }
      nextRule.implementationIds = uniqueStrings([...nextRule.implementationIds, implementationId]);
    }
    store.tree.implementations[implementationId] = nextImplementation;
    return nextImplementation;
  });
}

export function deleteImplementation(stateDir: string, implementationId: string): Implementation | undefined {
  return mutateLedger(stateDir, (store) => {
    const existingImplementation = store.tree.implementations[implementationId];
    if (!existingImplementation) {
      return undefined;
    }
    const parentRule = store.tree.rules[existingImplementation.ruleId];
    if (parentRule) {
      parentRule.implementationIds = parentRule.implementationIds.filter(
        (candidateId) => candidateId !== implementationId,
      );
    }
    delete store.tree.implementations[implementationId];
    return existingImplementation;
  });
}

export function listImplementationsForRule(stateDir: string, ruleId: string): Implementation[] {
  const ledger = loadLedger(stateDir);
  const rule = ledger.tree.rules[ruleId];
  if (!rule) {
    return [];
  }
  return rule.implementationIds
    .map((implementationId) => ledger.tree.implementations[implementationId])
    .filter((implementation): implementation is Implementation => implementation !== undefined);
}

export function getPrincipleSubtree(stateDir: string, principleId: string): PrincipleSubtree | undefined {
  const ledger = loadLedger(stateDir);
  const principle = ledger.tree.principles[principleId];
  if (!principle) {
    return undefined;
  }
  return {
    principle,
    rules: principle.ruleIds
      .map((ruleId) => ledger.tree.rules[ruleId])
      .filter((rule): rule is LedgerRule => rule !== undefined)
      .map((rule) => ({
        rule,
        implementations: rule.implementationIds
          .map((implementationId) => ledger.tree.implementations[implementationId])
          .filter((implementation): implementation is Implementation => implementation !== undefined),
      })),
  };
}

// ---------------------------------------------------------------------------
// Implementation Lifecycle State Transitions
// ---------------------------------------------------------------------------
//
// Valid transitions (per Phase 13 context D-15). Values match the core enum
// ImplementationLifecycleState: candidate / active / disabled / archived.
//   candidate -> active      (promote)
//   active -> disabled       (disable)
//   disabled -> active       (re-enable via promote)
//   disabled -> archived     (permanent disable)
//   active -> archived       (direct archive)
//   candidate -> archived    (rejected candidate cleanup)

const VALID_LIFECYCLE_TRANSITIONS: Record<ImplementationLifecycleState, ImplementationLifecycleState[]> = {
  candidate: ['active', 'archived'],
  active: ['disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: [],
};

export function isValidLifecycleTransition(
  from: ImplementationLifecycleState,
  to: ImplementationLifecycleState,
): boolean {
  return VALID_LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAllowedTransitions(from: ImplementationLifecycleState): ImplementationLifecycleState[] {
  return VALID_LIFECYCLE_TRANSITIONS[from] ?? [];
}

/**
 * Transition an implementation's lifecycle state with validation.
 * Throws on invalid transitions or missing implementation (fail loud).
 */
export function transitionImplementationState(
  stateDir: string,
  implementationId: string,
  newState: ImplementationLifecycleState,
): Implementation {
  return mutateLedger(stateDir, (store) => {
    const impl = store.tree.implementations[implementationId];
    if (!impl) {
      throw new Error(`Implementation not found: ${implementationId}`);
    }
    const currentState = impl.lifecycleState ?? 'candidate';
    if (!isValidLifecycleTransition(currentState, newState)) {
      const allowed = getAllowedTransitions(currentState);
      throw new Error(
        `Invalid lifecycle transition: ${currentState} -> ${newState}. ` +
          `Allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)'}`,
      );
    }
    const updated: Implementation = {
      ...impl,
      lifecycleState: newState,
      updatedAt: new Date().toISOString(),
    };
    store.tree.implementations[implementationId] = updated;
    return updated;
  });
}

export function listRuleImplementationsByState(
  stateDir: string,
  ruleId: string,
  state: ImplementationLifecycleState,
): Implementation[] {
  const implementations = listImplementationsForRule(stateDir, ruleId);
  // Match transitionImplementationState: a missing lifecycleState is treated
  // as 'candidate'. Filtering on strict equality would silently drop
  // historical/minimal records from candidate queries (EP-09 consistency).
  return implementations.filter((impl) => (impl.lifecycleState ?? 'candidate') === state);
}

export function findActiveImplementation(stateDir: string, ruleId: string): Implementation | null {
  const implementations = listImplementationsForRule(stateDir, ruleId);
  return implementations.find((impl) => impl.lifecycleState === 'active') ?? null;
}

// ---------------------------------------------------------------------------
// PRI-459: training store + async mutators (hoisted from plugin ledger)
// ---------------------------------------------------------------------------

export async function saveLedgerAsync(stateDir: string, store: HybridLedgerStore): Promise<void> {
  await mutateLedgerAsync(stateDir, async (current) => {
    current.trainingStore = store.trainingStore;
    current.tree = store.tree;
  });
}

export function updateTrainingStore(
  stateDir: string,
  mutate: (store: LegacyPrincipleTrainingStore) => void,
): void {
  mutateLedger(stateDir, (store) => {
    mutate(store.trainingStore);
  });
}
