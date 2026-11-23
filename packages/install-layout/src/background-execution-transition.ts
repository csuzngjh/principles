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
 *    pd-worktree-mutation.lock pattern, at file scope);
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
/** Stale threshold: the critical section is a millisecond-scale file op. */
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
  staleMs?: number;
  now?: () => Date;
  /** Test seam: real fs by default. */
  fsOps?: CasFsOps;
  /**
   * Holder-liveness probe for the PID recorded in a stale lock's owner
   * metadata. Default: `process.kill(pid, 0)` semantics
   * (alive / ESRCH→dead / EPERM→alive / anything else→unknown). Tests
   * inject fakes; an inconclusive answer MUST be 'unknown' (fail-closed).
   */
  probes?: {
    readonly processAlive?: (pid: number) => 'alive' | 'dead' | 'unknown';
  };
}

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
  readJson(file: string): { ok: true; value: unknown } | { ok: false; code: 'missing' | 'io'; error?: Error };
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
  // contention or mid-write windows, which are millisecond-scale events.
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    /* spin */
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

/**
 * Acquire the per-manifest CAS critical section. Fails loud (never
 * auto-overwrites a live lock); a lock whose owner metadata is unreadable
 * after a bounded retry is `lock_invalid` — fail-closed for a human, because
 * an unattributable lock may be mid-write. A lock is reclaimed ONLY when its
 * recorded holder PID is provably dead on this host (PRI-1282 review: file
 * age alone never proves abandonment — a stalled-but-live holder would
 * resume and delete the replacement lock it believed it still held).
 * Reclaim is rename-quarantine + token re-verification + restore-on-mismatch
 * so a lock that changed hands mid-reclaim is put back, never destroyed.
 */
export function acquireBackgroundExecutionCasLock(options: CasLockAcquireOptions): CasLockAcquireResult {
  const fsOps = options.fsOps ?? realFsOps;
  const now = options.now ?? (() => new Date());
  const staleMs = options.staleMs ?? DEFAULT_CAS_LOCK_STALE_MS;
  const processAlive = options.probes?.processAlive ?? defaultProcessAlive;
  const lockDir = `${options.manifestPath}.cas.lock`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = fsOps.mkdirExclusive(lockDir);
    if (created.ok) {
      const owner: CasLockOwner = {
        schema: CAS_LOCK_SCHEMA,
        token: randomToken(),
        pid: process.pid,
        host: 'unknown-host',
        operation: options.operation,
        workspaceDir: options.workspaceDir,
        createdAt: now().toISOString(),
      };
      // Diagnostics-only field; never a control input.
      owner.host = typeof os.hostname === 'function' ? os.hostname() : 'unavailable';
      const written = fsOps.writeJson(path.join(lockDir, ownerFileName()), owner);
      if (!written.ok) {
        // We own the directory but cannot attribute it — remove and retry once;
        // if removal fails the next acquirer sees lock_invalid (fail-closed).
        fsOps.removeDir(lockDir);
        return { ok: false, reason: 'lock_io_error', message: `failed to write CAS lock owner metadata: ${written.error?.message ?? 'io error'}` };
      }
      return {
        ok: true,
        handle: {
          lockDir,
          owner,
          release: () => {
            // Move-then-verify release: the directory at lockDir is renamed
            // aside atomically and only deleted when its owner.json still
            // carries OUR token. A read-then-delete-by-path is NOT used —
            // between the token check and the delete a stale reclaimer could
            // have quarantined this lock and a fresh holder could have taken
            // the path, letting us delete a lock we no longer own (PRI-1282
            // review). A foreign lock moved aside is restored, never deleted.
            const aside = `${lockDir}.release-${owner.token}`;
            const moved = fsOps.rename(lockDir, aside);
            if (!moved.ok) {
              // Already gone — the stale-reclaimer quarantined it or a crash
              // cleanup removed it; nothing to do.
              return;
            }
            const current = fsOps.readJson(path.join(aside, ownerFileName()));
            const parsed = current.ok ? parseLockOwner(current.value) : null;
            if (parsed !== null && parsed.token === owner.token) {
              fsOps.removeDir(aside);
              return;
            }
            // The directory we moved is NOT our lock — put it back exactly
            // where contenders expect it. If a fresh holder already acquired
            // lockDir in the gap, the restore fails and the aside directory
            // stays for a human — a foreign lock is NEVER deleted either way.
            fsOps.rename(aside, lockDir);
          },
        },
      };
    }
    if (created.code === 'io') {
      return { ok: false, reason: 'lock_io_error', message: `failed to create CAS lock directory: ${created.error?.message ?? 'io error'}` };
    }
    // Lock exists: attribute it.
    const ownerFile = fsOps.readJson(path.join(lockDir, ownerFileName()));
    if (!ownerFile.ok && ownerFile.code === 'missing' && attempt < 2) {
      // Mid-write holder (mkdir landed, owner.json not yet): back off so the
      // attribution write completes, then retry — declaring lock_invalid on a
      // microseconds window would fail operations spuriously.
      busyWaitMs(25);
      continue;
    }
    const holder = ownerFile.ok ? parseLockOwner(ownerFile.value) : null;
    if (holder === null) {
      return { ok: false, reason: 'lock_invalid', message: `CAS lock ${lockDir} has missing or malformed owner metadata; a human must inspect and remove it` };
    }
    const ageMs = Date.parse(holder.createdAt);
    const age = Number.isFinite(ageMs) ? now().getTime() - ageMs : Number.POSITIVE_INFINITY;
    // Reclaim authority is PID liveness, never file age (PRI-1282 review):
    // a lock whose recorded holder PID is PROVABLY dead is abandoned by
    // construction — the dead holder cannot be inside the critical section
    // and cannot resume to delete a replacement lock. A live holder past the
    // stale TTL keeps its lock (the critical section is millisecond-scale,
    // so >TTL liveness is a bug elsewhere — fail-closed busy, never evict a
    // lock that may still be held). A holder on a different host or with an
    // unverifiable PID is likewise never reclaimed.
    const liveness = holder.host === os.hostname() && holder.pid > 0
      ? processAlive(holder.pid)
      : ('unknown' as const);
    if (liveness === 'dead') {
      // Quarantine-then-verify: rename the stale lock away (atomic), re-read
      // the token inside the renamed directory, and only then delete. A
      // directory that changed identity between our read and the rename is
      // a DIFFERENT (possibly live) holder's lock — restore it exactly,
      // never move or delete a lock we cannot prove is the dead one.
      const quarantine = `${lockDir}.stale-${randomToken()}`;
      const renamed = fsOps.rename(lockDir, quarantine);
      if (!renamed.ok) continue;
      const verify = fsOps.readJson(path.join(quarantine, ownerFileName()));
      const verified = verify.ok ? parseLockOwner(verify.value) : null;
      if (verified === null || verified.token !== holder.token) {
        const restored = fsOps.rename(quarantine, lockDir);
        if (!restored.ok) {
          return { ok: false, reason: 'lock_invalid', message: `stale CAS lock reclaim at ${lockDir} observed an identity change and could not restore the moved lock; inspect ${quarantine}` };
        }
        continue; // re-evaluate the (restored or fresh) lock
      }
      fsOps.removeDir(quarantine);
      continue; // retry acquisition with the dead lock gone
    }
    void staleMs;
    return {
      ok: false,
      reason: 'lock_busy',
      message: `CAS lock held by operation=${holder.operation} pid=${holder.pid} host=${holder.host} ageMs=${Math.max(0, Math.round(age))} target=${holder.workspaceDir} liveness=${liveness} (a lock is only reclaimed when its holder PID is provably dead)`,
      holder,
    };
  }
  return { ok: false, reason: 'lock_invalid', message: `could not acquire CAS lock ${lockDir} after bounded retries` };
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
