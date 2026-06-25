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

// PRI-443: Pure parse/serialize functions extracted to codec module
import {
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
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf8');

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
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

  // Clean up temp file on failure
  try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  throw lastError ?? new Error('atomicWriteFileSync: rename failed');
}

// ---------------------------------------------------------------------------
// Ledger file I/O (the only non-pure part of this module)
// ---------------------------------------------------------------------------

function getLedgerFilePath(stateDir: string): string {
  return path.join(stateDir, PRINCIPLE_TRAINING_FILE);
}

function readLedgerFromFile(filePath: string): HybridLedgerStore {
  if (!fs.existsSync(filePath)) {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { trainingStore: {}, tree: createEmptyTree() };
    }
    const parsed = JSON.parse(content) as unknown;
    return parseHybridLedger(parsed);
  } catch {
    return { trainingStore: {}, tree: createEmptyTree() };
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

function tryAcquireLock(lockPath: string, pid: number): boolean {
  try {
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const fd = fs.openSync(lockPath, flags);
    fs.writeSync(fd, String(pid));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
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

function cleanupStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const pid = readLockPid(lockPath);
    const isStale = Date.now() - stat.mtimeMs > staleMs;
    const isDead = pid === null || !isProcessAlive(pid);
    if (isStale || isDead) {
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
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // bounded busy-wait for synchronous retry
  }
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
 */
function withLock<T>(filePath: string, fn: () => T, options?: LockOptions): T {
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
    const store = readLedgerFromFile(filePath);
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
    const store = readLedgerFromFile(filePath);
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
  return readLedgerFromFile(getLedgerFilePath(stateDir));
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
  return implementations.filter((impl) => impl.lifecycleState === state);
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
