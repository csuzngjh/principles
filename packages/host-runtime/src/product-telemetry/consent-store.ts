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
 * Migration from schema v1: consent, consentVersion, and telemetrySecret are
 * preserved; legacy machine-global export bookkeeping (lastSucceededAt,
 * retry state, attempt counters) is DISCARDED — it cannot be attributed to a
 * workspace, and it is operational state, not a governance fact. Dropping it
 * can cause at most one extra same-day snapshot per installation.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateTelemetrySecretHex,
  isValidBucketDate,
  isValidTelemetrySecretHex,
  PRODUCT_TELEMETRY_CONSENT_VERSION,
} from '@principles/core/runtime-v2';

export const PRODUCT_TELEMETRY_STATE_FILENAME = 'product-telemetry.json';
export const PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION = '2';
/** v1 files are still read (then migrated in memory and rewritten as v2). */
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

/**
 * Read and validate the control state. A missing file is the normal
 * never-configured case (defaults, existed=false). A malformed file is a
 * loud failure — silently treating it as "unset" could re-prompt or re-export
 * against the user's recorded decision (rc-3/rc-9).
 *
 * v1 files are migrated in memory (export bookkeeping dropped, consent
 * identity preserved); the migration is persisted on the next write.
 */
export function readProductTelemetryControlState(homeDir: string): ControlStateRead {
  const filePath = getProductTelemetryStatePath(homeDir);
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'product_telemetry_state_malformed_shape',
      nextAction: `Fix or delete ${filePath} (delete = consent returns to unset)`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const { schemaVersion } = obj;
  const isV1 = schemaVersion === PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION;
  const isV2 = schemaVersion === PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION;
  if (!isV1 && !isV2) {
    return {
      ok: false,
      reason: `product_telemetry_state_malformed: schemaVersion must be '${PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION}' or legacy '${PRODUCT_TELEMETRY_LEGACY_CONTROL_SCHEMA_VERSION}'`,
      nextAction: `Fix or delete ${filePath} (delete = consent returns to unset)`,
    };
  }
  // v1 machine-global export fields exist only in v1 files; v2 files carry
  // workspaceExports instead. Unknown keys are rejected per shape.
  const allowedKeys = isV1
    ? ['consent', 'consentVersion', 'telemetrySecret', 'lastAttemptedAt', 'lastSucceededAt', 'lastFailureCode', 'nextRetryAt', 'dailyAttemptCount', 'attemptBucketDate', 'schemaVersion']
    : ['consent', 'consentVersion', 'telemetrySecret', 'workspaceExports', 'schemaVersion'];
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`unknown field '${key}'`);
    }
  }
  if (!isConsent(obj.consent)) errors.push('consent must be unset|granted|denied');
  if (typeof obj.consentVersion !== 'string' || obj.consentVersion.length === 0 || obj.consentVersion.length > 8) errors.push('consentVersion must be a short non-empty string');
  if (!isValidTelemetrySecretHex(obj.telemetrySecret) && obj.telemetrySecret !== undefined) errors.push('telemetrySecret must be 64 hex chars when present');
  if (isV1) {
    // v1 legacy export fields are migrated by DISCARDING them — validating
    // values that are about to be dropped would only turn a smooth migration
    // into a hard failure (the identity fields carry the user's decision).
    // Only the field-NAME allowlist above still applies to v1 files.
  } else {
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
  }
  if (errors.length > 0) {
    return {
      ok: false,
      reason: `product_telemetry_state_malformed: ${errors.join('; ')}`,
      nextAction: `Fix or delete ${filePath} (delete = consent returns to unset)`,
    };
  }

  // Post-validation reconstruction from guard-narrowed fields — no `as` on
  // the untrusted parsed object (rc-2). isConsent is a type guard; the
  // optional-field spreads carry only guard-passing values. v1 export
  // bookkeeping is deliberately NOT carried over (see module doc).
  const state: ProductTelemetryControlState = {
    consent: isConsent(obj.consent) ? obj.consent : 'unset',
    consentVersion: typeof obj.consentVersion === 'string' ? obj.consentVersion : PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(isValidTelemetrySecretHex(obj.telemetrySecret) ? { telemetrySecret: obj.telemetrySecret } : {}),
    ...(isV2 && isPlainRecord(obj.workspaceExports)
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
  return { ok: true, state, existed: true };
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

/** Atomic write (temp file + rename) so a crash never truncates the state. */
export function writeProductTelemetryControlState(homeDir: string, state: ProductTelemetryControlState): ControlStateWrite {
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
