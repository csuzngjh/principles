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
 *   writer). The load that recognizes a v1 file persists the migrated
 *   state back through the normal atomic write, so the on-disk file
 *   converges to the current format on first load and never migrates twice.
 * - Migration from schema v1: consent, consentVersion, and telemetrySecret
 *   are preserved verbatim; legacy machine-global export bookkeeping
 *   (lastSucceededAt, retry state, attempt counters) is DISCARDED — it
 *   cannot be attributed to a workspace, and it is operational state, not a
 *   governance fact. Dropping it can cause at most one extra same-day
 *   snapshot per installation.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateTelemetrySecretHex,
  isValidBucketDate,
  isValidTelemetrySecretHex,
  PRODUCT_TELEMETRY_CONSENT_VERSION,
} from '@principles/core/runtime';

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

/** Outcome of trying to persist a just-performed legacy migration. */
type LegacyMigrationPersistOutcome =
  /** Migration persisted through the normal atomic write. */
  | { kind: 'persisted' }
  /** Another process rewrote the file first; the caller must re-parse it. */
  | { kind: 'superseded' }
  /** Re-read failed mid-flight; the state already parsed from the bytes this
   *  load actually read is the best available answer (same staleness as any
   *  pre-PRI-1138 read). */
  | { kind: 'serve-read' }
  /** The write failed loud (details carried for the caller to return). */
  | { kind: 'failed'; read: Extract<ControlStateRead, { ok: false }> };

/**
 * Persist a just-performed legacy migration through the normal atomic write
 * (the migrator itself never writes, PRI-1138). The file is re-read first:
 * if another process already rewrote it (its own migration or a consent
 * transition), the migration is superseded — it must NOT overwrite that
 * newer result, and the caller re-parses the current bytes instead of
 * returning the superseded identity. A failed write is loud (returned by the
 * caller) and leaves the legacy file on disk so the next load retries
 * (idempotent).
 *
 * Residual window (documented, PRI-1138 review): between the byte-compare
 * and the rename another process's consent transition can still land and be
 * overwritten — the same last-writer-wins exposure the service's existing
 * read→write consent transitions (enable/disable/reset) already have. Closing
 * it fully means unifying ALL control-state writes under the service-layer
 * state-update lock; the reader is itself called inside that lock today, so
 * that redesign is deliberately out of scope here.
 */
function persistLegacyMigration(args: {
  homeDir: string;
  filePath: string;
  rawAtRead: string;
  migrated: ProductTelemetryControlState;
}): LegacyMigrationPersistOutcome {
  let rawNow: string;
  try {
    rawNow = fs.readFileSync(args.filePath, 'utf8');
  } catch {
    // Unreadable mid-flight (external tampering): skip the write-back; the
    // state parsed from the bytes this load did read still serves the caller
    // and the next load retries the migration.
    return { kind: 'serve-read' };
  }
  if (rawNow !== args.rawAtRead) {
    return { kind: 'superseded' };
  }
  const written = writeProductTelemetryControlState(args.homeDir, args.migrated);
  if (!written.ok) {
    return {
      kind: 'failed',
      read: {
        ok: false,
        reason: `product_telemetry_state_legacy_migration_write_failed: ${written.reason}`,
        nextAction: written.nextAction,
      },
    };
  }
  return { kind: 'persisted' };
}

/**
 * Bound on the legacy-migration convergence loop: a file that keeps changing
 * under a migrating load (flapping concurrent writers) is reported loud
 * instead of looping forever.
 */
const MAX_LEGACY_MIGRATION_ATTEMPTS = 3;

/**
 * Read and validate the control state. A missing file is the normal
 * never-configured case (defaults, existed=false). A malformed file is a
 * loud failure — silently treating it as "unset" could re-prompt or re-export
 * against the user's recorded decision (rc-3/rc-9).
 *
 * Legacy v1 files (PRI-1138): parsed by the one-way legacy migrator
 * (identity preserved, export bookkeeping dropped) and immediately persisted
 * back as the current format through the normal atomic write, so the file on
 * disk converges on the very load that performed the migration. If another
 * process rewrites the file mid-migration, the load re-parses the CURRENT
 * bytes (never returning a superseded identity), bounded by
 * MAX_LEGACY_MIGRATION_ATTEMPTS. A failed migration write is a loud failure
 * — never a silent fallback to running on the old format — and leaves the
 * legacy file untouched (temp+rename write), so the next load retries the
 * idempotent migration.
 */
export function readProductTelemetryControlState(homeDir: string): ControlStateRead {
  const filePath = getProductTelemetryStatePath(homeDir);
  for (let attempt = 1; ; attempt += 1) {
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
        return { ok: true, state: defaultProductTelemetryControlState(), existed: false };
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
    if (!result.migratedFromLegacy) {
      return { ok: true, state: result.state, existed: true };
    }
    const persistOutcome = persistLegacyMigration({ homeDir, filePath, rawAtRead: raw, migrated: result.state });
    if (persistOutcome.kind === 'persisted' || persistOutcome.kind === 'serve-read') {
      return { ok: true, state: result.state, existed: true };
    }
    if (persistOutcome.kind === 'failed') {
      return persistOutcome.read;
    }
    // superseded: another process rewrote the file before our write — do not
    // return (or overwrite with) the superseded state; re-parse the current
    // bytes, bounded so a flapping file cannot loop forever.
    if (attempt >= MAX_LEGACY_MIGRATION_ATTEMPTS) {
      return {
        ok: false,
        reason: `product_telemetry_state_legacy_migration_unstable: the file kept changing across ${MAX_LEGACY_MIGRATION_ATTEMPTS} attempts`,
        nextAction: `Retry the operation; if it persists, inspect ${filePath}`,
      };
    }
  }
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
