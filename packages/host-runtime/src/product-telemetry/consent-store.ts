/**
 * Product telemetry control-state store — Anonymous Product Telemetry v1
 * (PRI-597, SPEC §44; review remediation: workspace-scoped export state).
 *
 * Persists the telemetry control state to `~/.pd/product-telemetry.json`.
 * This file is Telemetry Control State — it never enters
 * Principle/Pain/receipt/governance stores, and the secret never leaves the
 * machine.
 *
 * Scope model (schema v2, review remediation P1-1):
 * - MACHINE scope: consent, consentVersion, telemetrySecret.
 * - WORKSPACE scope: `workspaceExports[scopeId]` — per-workspace dedup,
 *   retry, and attempt bookkeeping keyed by the opaque local scope ID
 *   (HMAC(secret, canonical workspace path); never uploaded). One
 *   workspace succeeding must never suppress another workspace's export.
 *
 * Single-format contract (PRI-1138, 6th dual-track convergence):
 * - The ONLY writable/persisted format is the current schema version.
 *   writeProductTelemetryControlState refuses every state whose
 *   schemaVersion is not current, so no code path can persist or
 *   regenerate a legacy v1 file.
 * - Legacy v1 files remain readable through migrateLegacyConsentFile — a
 *   one-way, read-only migrator (legacy reader / one-way migrator, never a
 *   writer). A read parses a v1 file in memory (identity preserved) but
 *   NEVER writes; persistence of the migration happens exclusively inside
 *   withControlStateLock transactions (PRI-1151): the legacy v1→v2
 *   migration write-back, enable/disable/reset, and workspace export
 *   bookkeeping merges all serialize on the same cross-process
 *   `<state>.state-lock`, so no writer can build its write from a stale
 *   read or overwrite a completed authorization change.
 * - Migration from schema v1: consent, consentVersion, and telemetrySecret
 *   are preserved verbatim; legacy machine-global export bookkeeping
 *   (lastSucceededAt, retry state, attempt counters) is DISCARDED — it
 *   cannot be attributed to a workspace, and it is operational state, not a
 *   governance fact. Dropping it can cause at most one extra same-day
 *   snapshot per eligible workspace on the machine (each workspace re-exports
 *   once before its own fresh bookkeeping exists).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateTelemetrySecretHex,
  isValidBucketDate,
  isValidTelemetrySecretHex,
  PRODUCT_TELEMETRY_CONSENT_VERSION,
} from '@principles/core/runtime';
import { acquireExclusiveLock, ownsExclusiveLock, releaseExclusiveLock } from './control-state-lock.js';

export const PRODUCT_TELEMETRY_STATE_FILENAME = 'product-telemetry.json';
/** The ONE writable schema version (single-format contract, PRI-1138). */
export const PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION = '2';
/**
 * Legacy schema v1 — LEGACY-READER SEMANTICS ONLY (PRI-1138): this constant
 * exists solely so the one-way migrator can recognize historical files. It
 * is never a writable target; writeProductTelemetryControlState refuses
 * every state whose schemaVersion is not PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION.
 */
export const PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION = '1';

/** Hard bound on tracked workspaces so the file cannot grow unboundedly. */
export const MAX_WORKSPACE_EXPORT_ENTRIES = 200;

/**
 * Entries untouched for this long are pruned on the next write. This is local
 * telemetry operational state only — no workspace history is retained.
 */
export const WORKSPACE_EXPORT_STATE_MAX_AGE_DAYS = 30;

export type ProductTelemetryConsent = 'unset' | 'granted' | 'denied';

/** Per-workspace export bookkeeping (operational state; never exported). */
export interface WorkspaceExportState {
  lastAttemptedAt?: string;
  lastSucceededAt?: string;
  /** Coarse failure code (TelemetryFailureCode). No response bodies. */
  lastFailureCode?: string;
  nextRetryAt?: string;
  /** Failed export attempts in the current attemptBucketDate (0–99; hard cap enforced by the service). */
  dailyAttemptCount?: number;
  /** UTC date bucket the dailyAttemptCount belongs to (resets on day change). */
  attemptBucketDate?: string;
}

export interface ProductTelemetryControlState {
  consent: ProductTelemetryConsent;
  consentVersion: string;
  /** Cryptographically random hex secret. Never uploaded. */
  telemetrySecret?: string;
  /** Per-workspace export bookkeeping keyed by opaque local scope ID. */
  workspaceExports?: Record<string, WorkspaceExportState>;
  schemaVersion: string;
}

export type ControlStateRead =
  | { ok: true; state: ProductTelemetryControlState; existed: boolean }
  | { ok: false; reason: string; nextAction: string };

export type ControlStateWrite = { ok: true } | { ok: false; reason: string; nextAction: string };

export function defaultProductTelemetryControlState(): ProductTelemetryControlState {
  return { consent: 'unset', consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION, schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION };
}

export function getProductTelemetryStatePath(homeDir: string): string {
  return path.join(path.resolve(homeDir), '.pd', PRODUCT_TELEMETRY_STATE_FILENAME);
}

function isConsent(value: unknown): value is ProductTelemetryConsent {
  return value === 'unset' || value === 'granted' || value === 'denied';
}

/**
 * Optional timestamp fields must be parseable dates, not just short strings —
 * a "garbage" lastSucceededAt/nextRetryAt would otherwise slip validation and
 * turn into NaN inside Date.parse, silently skipping same-day dedup or retry
 * backoff (fail-loud contract, review round 2).
 */
function isOptionalIsoString(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return false;
  return !Number.isNaN(Date.parse(value));
}

function isOptionalAttemptBucketDate(value: unknown): value is string {
  if (value === undefined) return true;
  return isValidBucketDate(value);
}

function isOptionalAttemptCount(value: unknown): value is number {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99);
}

function isOptionalFailureCode(value: unknown): value is string {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 40);
}

function isScopeKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{4,32}$/.test(value);
}

/** Validate one `workspaceExports` entry; collect errors under `prefix`. */
function workspaceExportErrors(entry: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!['lastAttemptedAt', 'lastSucceededAt', 'lastFailureCode', 'nextRetryAt', 'dailyAttemptCount', 'attemptBucketDate'].includes(key)) {
      errors.push(`${prefix}: unknown field '${key}'`);
    }
  }
  if (!isOptionalIsoString(entry.lastAttemptedAt) || !isOptionalIsoString(entry.lastSucceededAt) || !isOptionalIsoString(entry.nextRetryAt)) {
    errors.push(`${prefix}: timestamps must be parseable ISO-8601 strings (≤40 chars) when present`);
  }
  if (!isOptionalAttemptCount(entry.dailyAttemptCount)) errors.push(`${prefix}: dailyAttemptCount must be an integer 0–99 when present`);
  if (!isOptionalAttemptBucketDate(entry.attemptBucketDate)) errors.push(`${prefix}: attemptBucketDate must be a valid YYYY-MM-DD UTC date when present`);
  if (!isOptionalFailureCode(entry.lastFailureCode)) errors.push(`${prefix}: lastFailureCode must be a short non-empty string when present`);
  return errors;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The single field whitelist of the current persisted format. */
const CURRENT_ALLOWED_KEYS = ['consent', 'consentVersion', 'telemetrySecret', 'workspaceExports', 'schemaVersion'];

/**
 * Field whitelist of the LEGACY v1 reader only: identity fields plus the
 * retired machine-global export bookkeeping names. Used exclusively inside
 * the legacy branch of parseConsentState to recognize historical files —
 * never for the current format, and never a write shape (those top-level
 * bookkeeping fields are discarded by migrateLegacyConsentFile; no
 * production logic reads them).
 */
const LEGACY_V1_ALLOWED_KEYS = [
  'consent',
  'consentVersion',
  'telemetrySecret',
  'lastAttemptedAt',
  'lastSucceededAt',
  'lastFailureCode',
  'nextRetryAt',
  'dailyAttemptCount',
  'attemptBucketDate',
  'schemaVersion',
];

/** Single parse result for one persisted control-state document. */
type ParsedControlState =
  | { ok: true; state: ProductTelemetryControlState; migratedFromLegacy: boolean }
  | { ok: false; errors: string[] };

/**
 * One-way migrator for legacy schema-v1 control files — legacy reader /
 * one-way migrator, never a writer (PRI-1138). Accepts only objects already
 * validated against LEGACY_V1_ALLOWED_KEYS by parseConsentState. The
 * historical authorization identity is carried over VERBATIM — consent,
 * consentVersion, and telemetrySecret are never reset, regenerated, or
 * fabricated — while the retired machine-global export bookkeeping is
 * dropped (it cannot be attributed to a workspace; operational state, not a
 * governance fact). This function never touches the filesystem and never
 * logs the secret; persisting its result happens exclusively through
 * writeProductTelemetryControlState (the normal atomic write).
 */
function migrateLegacyConsentFile(parsed: Record<string, unknown>): ProductTelemetryControlState {
  // Post-validation reconstruction from guard-narrowed fields — no `as` on
  // the untrusted parsed object (rc-2). The ternary fallbacks are
  // unreachable after parseConsentState's validation and mirror the
  // defensive reconstruction style of the current-format path.
  return {
    consent: isConsent(parsed.consent) ? parsed.consent : 'unset',
    consentVersion: typeof parsed.consentVersion === 'string' ? parsed.consentVersion : PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(isValidTelemetrySecretHex(parsed.telemetrySecret) ? { telemetrySecret: parsed.telemetrySecret } : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
}

/**
 * Reconstruct the current-format state from guard-narrowed fields — no `as`
 * on the untrusted parsed object (rc-2). isConsent is a type guard; the
 * optional-field spreads carry only guard-passing values.
 */
function reconstructCurrentState(obj: Record<string, unknown>): ProductTelemetryControlState {
  const state: ProductTelemetryControlState = {
    consent: isConsent(obj.consent) ? obj.consent : 'unset',
    consentVersion: typeof obj.consentVersion === 'string' ? obj.consentVersion : PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(isValidTelemetrySecretHex(obj.telemetrySecret) ? { telemetrySecret: obj.telemetrySecret } : {}),
    ...(isPlainRecord(obj.workspaceExports)
      ? {
          workspaceExports: Object.fromEntries(
            Object.entries(obj.workspaceExports)
              .filter(([scopeKey, entry]) => isScopeKey(scopeKey) && isPlainRecord(entry))
              .map(([scopeKey, entry]) => {
                const record = entry as Record<string, unknown>;
                return [
                  scopeKey,
                  {
                    ...(isOptionalIsoString(record.lastAttemptedAt) && record.lastAttemptedAt !== undefined ? { lastAttemptedAt: record.lastAttemptedAt } : {}),
                    ...(isOptionalIsoString(record.lastSucceededAt) && record.lastSucceededAt !== undefined ? { lastSucceededAt: record.lastSucceededAt } : {}),
                    ...(isOptionalIsoString(record.nextRetryAt) && record.nextRetryAt !== undefined ? { nextRetryAt: record.nextRetryAt } : {}),
                    ...(isOptionalFailureCode(record.lastFailureCode) && record.lastFailureCode !== undefined ? { lastFailureCode: record.lastFailureCode } : {}),
                    ...(isOptionalAttemptCount(record.dailyAttemptCount) && record.dailyAttemptCount !== undefined ? { dailyAttemptCount: record.dailyAttemptCount } : {}),
                    ...(isOptionalAttemptBucketDate(record.attemptBucketDate) && record.attemptBucketDate !== undefined ? { attemptBucketDate: record.attemptBucketDate } : {}),
                  } satisfies WorkspaceExportState,
                ];
              }),
          ),
        }
      : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
  if (state.workspaceExports !== undefined && Object.keys(state.workspaceExports).length === 0) {
    delete state.workspaceExports;
  }
  return state;
}

/**
 * parseConsentState — the ONE parse entry for the persisted control state
 * (PRI-1138). Current-format files validate against the single current
 * whitelist; legacy v1 files go through the one-way migrator path and are
 * flagged migratedFromLegacy so the caller persists the migration exactly
 * once. Every other shape — missing, malformed, or future schemaVersion —
 * fails loud: versions are never guessed and invalid data is never silently
 * treated as an empty/default consent state.
 */
function parseConsentState(parsed: unknown): ParsedControlState {
  if (!isPlainRecord(parsed)) {
    return { ok: false, errors: ['state must be a JSON object'] };
  }
  const obj = parsed;
  const { schemaVersion } = obj;
  const isLegacyV1 = schemaVersion === PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION;
  const isCurrent = schemaVersion === PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION;
  if (!isLegacyV1 && !isCurrent) {
    return {
      ok: false,
      errors: [
        `schemaVersion must be '${PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION}' or legacy '${PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION}'`,
      ],
    };
  }
  const allowedKeys = isLegacyV1 ? LEGACY_V1_ALLOWED_KEYS : CURRENT_ALLOWED_KEYS;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`unknown field '${key}'`);
    }
  }
  if (!isConsent(obj.consent)) errors.push('consent must be unset|granted|denied');
  if (typeof obj.consentVersion !== 'string' || obj.consentVersion.length === 0 || obj.consentVersion.length > 8) errors.push('consentVersion must be a short non-empty string');
  if (!isValidTelemetrySecretHex(obj.telemetrySecret) && obj.telemetrySecret !== undefined) errors.push('telemetrySecret must be 64 hex chars when present');
  if (isLegacyV1) {
    // Legacy machine-global export fields are migrated by DISCARDING them —
    // validating values that are about to be dropped would only turn a
    // smooth migration into a hard failure (the identity fields carry the
    // user's decision). Only the field-NAME allowlist above still applies to
    // legacy files.
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, state: migrateLegacyConsentFile(obj), migratedFromLegacy: true };
  }
  if (obj.workspaceExports !== undefined) {
    if (typeof obj.workspaceExports !== 'object' || obj.workspaceExports === null || Array.isArray(obj.workspaceExports)) {
      errors.push('workspaceExports must be an object');
    } else {
      const entries = obj.workspaceExports as Record<string, unknown>;
      const scopeKeys = Object.keys(entries);
      if (scopeKeys.length > MAX_WORKSPACE_EXPORT_ENTRIES) {
        errors.push(`workspaceExports must track at most ${MAX_WORKSPACE_EXPORT_ENTRIES} workspaces`);
      }
      for (const scopeKey of scopeKeys) {
        if (!isScopeKey(scopeKey)) {
          errors.push(`workspaceExports key '${scopeKey}' must be 4–32 hex chars`);
          continue;
        }
        const entry = entries[scopeKey];
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          errors.push(`workspaceExports['${scopeKey}'] must be an object`);
          continue;
        }
        errors.push(...workspaceExportErrors(entry as Record<string, unknown>, `workspaceExports['${scopeKey}']`));
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, state: reconstructCurrentState(obj), migratedFromLegacy: false };
}

/**
 * Atomic write (temp file + rename) so a crash never truncates the state.
 *
 * Single-format contract (PRI-1138): ONLY the current schema version is
 * writable. This is the structural guarantee that no code path can persist
 * or regenerate a legacy v1 file — a state carrying any other schemaVersion
 * is refused loud and the file on disk is left untouched.
 *
 * Concurrency convention (PRI-1151): production read-modify-write callers
 * must run inside withControlStateLock (tx.write) so their write is built
 * from a read taken under the same cross-process mutex as every other
 * writer; calling this function directly is for lock-held transaction
 * internals and single-writer utilities.
 */
export function writeProductTelemetryControlState(homeDir: string, state: ProductTelemetryControlState): ControlStateWrite {
  if (state.schemaVersion !== PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `product_telemetry_state_write_refused: only schemaVersion '${PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION}' is writable, got '${String(state.schemaVersion).slice(0, 16)}'`,
      nextAction: 'Build states via defaultProductTelemetryControlState / grantedControlState / deniedControlState / resetControlState (schemaVersion is not a free choice)',
    };
  }
  const filePath = getProductTelemetryStatePath(homeDir);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup; the write failure below is the loud signal
    }
    return {
      ok: false,
      reason: `product_telemetry_state_write_failed: ${message}`,
      nextAction: `Check permissions on ${dir}`,
    };
  }
}

/**
 * Lock-held read result: the parsed CURRENT disk state plus the schema
 * version the bytes on disk actually carried (so a transaction can tell a
 * migrated-in-memory v1 apart from a genuine v2 and persist the migration).
 */
export type LatestControlStateRead =
  | { ok: true; state: ProductTelemetryControlState; existed: boolean; diskSchemaVersion: '1' | '2' }
  | { ok: false; reason: string; nextAction: string };

/**
 * Read the raw bytes from disk and parse them — pure, no write, no lock.
 * A missing file is the normal never-configured case (defaults,
 * existed=false, diskSchemaVersion '2'). A malformed file is a loud failure
 * — silently treating it as "unset" could re-prompt or re-export against the
 * user's recorded decision (rc-3/rc-9).
 */
function loadControlStateFromDisk(filePath: string): LatestControlStateRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // Guarded code access (rc-1/rc-2: runtime check before use; rc-5:
    // Object.hasOwn on untrusted objects; no NodeJS namespace in this config).
    const codeValue =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    const code = typeof codeValue === 'string' ? codeValue : undefined;
    if (code === 'ENOENT') {
      return { ok: true, state: defaultProductTelemetryControlState(), existed: false, diskSchemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION };
    }
    return {
      ok: false,
      reason: `product_telemetry_state_unreadable: ${code ?? String(error)}`,
      nextAction: `Check permissions on ${filePath}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: 'product_telemetry_state_malformed_json',
      nextAction: `Fix or delete ${filePath} (delete = consent returns to unset)`,
    };
  }
  const result = parseConsentState(parsed);
  if (!result.ok) {
    return {
      ok: false,
      reason: `product_telemetry_state_malformed: ${result.errors.join('; ')}`,
      nextAction: `Fix or delete ${filePath} (delete = consent returns to unset)`,
    };
  }
  return {
    ok: true,
    state: result.state,
    existed: true,
    diskSchemaVersion: result.migratedFromLegacy
      ? PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION
      : PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
}

/**
 * Read and validate the control state — PURE READ, never writes (PRI-1151).
 * A legacy v1 file is parsed in memory (identity preserved, bookkeeping
 * dropped) so callers observe the migrated semantics, but persisting the
 * migration happens exclusively inside withControlStateLock transactions;
 * a read-only caller (status/preview) can therefore never race a concurrent
 * authorization change.
 */
export function readProductTelemetryControlState(homeDir: string): ControlStateRead {
  const loaded = loadControlStateFromDisk(getProductTelemetryStatePath(homeDir));
  if (!loaded.ok) return loaded;
  return { ok: true, state: loaded.state, existed: loaded.existed };
}

/** Transactional read/write surface handed to withControlStateLock bodies. */
export interface ControlStateLockTx {
  /**
   * Read the CURRENT disk state inside the lock. No re-acquisition — the
   * caller already holds the lock; nesting withControlStateLock inside a
   * body is a programming error and would deadlock against the bounded
   * wait.
   */
  readLatest(): LatestControlStateRead;
  /** Atomic single-format write inside the lock. */
    write(state: ProductTelemetryControlState): ControlStateWrite;
}

/**
 * withControlStateLock — the ONE cross-process transaction entry for the
 * control state (PRI-1151): acquire `<state>.state-lock` → run the body with
 * lock-held readLatest/write primitives → release. Every control-state
 * writer (legacy migration write-back, enable/disable/reset, workspace
 * bookkeeping merge) goes through here, so each write is built from a read
 * taken under the same mutex that serializes every other writer — a stale
 * read can no longer overwrite a completed authorization change (e.g. a
 * concurrent disable).
 *
 * Failure semantics: lock acquisition is bounded and CONTENTION (timeout) is
 * distinguished from a FILESYSTEM failure (e.g. unwritable directory); on
 * either failure nothing was written (no lock-free degradation). A body that
 * runs longer than the lock's stale threshold may find its lock taken over
 * by another process — tx.write then refuses (lock_lost) instead of
 * committing without the mutex. A throwing body releases the lock and
 * returns a structured failure — this function never throws.
 */
export async function withControlStateLock<T>(
  homeDir: string,
  body: (tx: ControlStateLockTx) => Promise<T> | T,
  options?: { timeoutMs?: number },
): Promise<{ ok: true; value: T } | { ok: false; reason: string; nextAction: string }> {
  const stateFilePath = getProductTelemetryStatePath(homeDir);
  const acquired = await acquireExclusiveLock(stateFilePath, options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined);
  if (!acquired.ok) {
    if (acquired.kind === 'timeout') {
      return {
        ok: false,
        reason: 'product_telemetry_state_lock_timeout: another process holds the control-state lock',
        nextAction: 'Retry the operation; if it keeps failing, check for a stuck PD process before touching ~/.pd/product-telemetry.json.state-lock',
      };
    }
    return {
      ok: false,
      reason: `product_telemetry_state_lock_unwritable: ${acquired.detail}`,
      nextAction: `Check permissions on ${path.dirname(stateFilePath)}`,
    };
  }
  const lock = acquired.handle;
  try {
    const tx: ControlStateLockTx = {
      readLatest: () => loadControlStateFromDisk(stateFilePath),
      write: (state: ProductTelemetryControlState) => {
        // Ownership re-verify before committing: a body that outlived the
        // stale threshold may have had its lock taken over — refuse instead
        // of writing without the mutex (review round 2).
        if (!ownsExclusiveLock(lock)) {
          return {
            ok: false,
            reason: 'product_telemetry_state_lock_lost: another process took over the lock during this transaction; nothing was written',
            nextAction: 'Retry the operation',
          };
        }
        return writeProductTelemetryControlState(homeDir, state);
      },
    };
    const value = await body(tx);
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `product_telemetry_state_transaction_error: ${message}`,
      nextAction: 'Retry the operation; the control state on disk was not left half-written (atomic temp+rename)',
    };
  } finally {
    releaseExclusiveLock(lock);
  }
}

/**
 * One-way legacy v1→v2 migration as a locked transaction (PRI-1151): read
 * the CURRENT disk state under the lock; if it is still v1, persist the
 * migrated state (identity preserved) through the normal atomic write; if it
 * is already the current format, do nothing (idempotent — no rewrite). A
 * concurrent disable/reset/enable serializes on the same lock, so this can
 * never overwrite a completed authorization change.
 */
export async function migrateLegacyControlState(homeDir: string): Promise<ControlStateWrite> {
  const outcome = await withControlStateLock(homeDir, (tx) => {
    const latest = tx.readLatest();
    if (!latest.ok) return latest;
    if (latest.diskSchemaVersion !== PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION) {
      return { ok: true as const };
    }
    return tx.write(latest.state);
  });
  if (!outcome.ok) return outcome;
  return outcome.value;
}

/**
 * Drop `workspaceExports` entries whose most recent activity (attempt or
 * success) is older than WORKSPACE_EXPORT_STATE_MAX_AGE_DAYS. Bounded local
 * operational state only — this is not a workspace history database.
 */
export function pruneWorkspaceExports(state: ProductTelemetryControlState, nowMs: number): ProductTelemetryControlState {
  const exports = state.workspaceExports;
  if (exports === undefined) return state;
  const cutoff = nowMs - WORKSPACE_EXPORT_STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const kept: Record<string, WorkspaceExportState> = {};
  for (const [scopeKey, entry] of Object.entries(exports)) {
    const stamps = [entry.lastAttemptedAt, entry.lastSucceededAt].filter((s): s is string => s !== undefined).map((s) => Date.parse(s));
    const latest = stamps.length > 0 ? Math.max(...stamps) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(latest) || latest < cutoff) continue;
    kept[scopeKey] = entry;
  }
  const next: ProductTelemetryControlState = { ...state };
  if (Object.keys(kept).length > 0) next.workspaceExports = kept;
  else delete next.workspaceExports;
  return next;
}

/** State after `pd telemetry enable`: explicit granted consent + secret. */
export function grantedControlState(previous: ProductTelemetryControlState): ProductTelemetryControlState {
  return {
    consent: 'granted',
    consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION,
    telemetrySecret: isValidTelemetrySecretHex(previous.telemetrySecret) ? previous.telemetrySecret : generateTelemetrySecretHex(),
    ...(previous.workspaceExports !== undefined ? { workspaceExports: previous.workspaceExports } : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
}

/**
 * State after `pd telemetry disable`: consent denied and all export identity
 * removed (SPEC §19). The explicit `denied` choice is preserved so PD never
 * re-prompts.
 */
export function deniedControlState(): ProductTelemetryControlState {
  return { consent: 'denied', consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION, schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION };
}

/**
 * State after `pd telemetry reset` (SPEC §18): secret and export status are
 * deleted — no future daily ID relates to previous ones. The consent choice
 * is preserved; a fresh secret is generated only while telemetry remains
 * enabled. Workspace bookkeeping keyed under the OLD secret's scope IDs is
 * dropped with it (the IDs are meaningless under a new secret).
 */
export function resetControlState(previous: ProductTelemetryControlState): ProductTelemetryControlState {
  return {
    consent: previous.consent,
    consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(previous.consent === 'granted' ? { telemetrySecret: generateTelemetrySecretHex() } : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
}
