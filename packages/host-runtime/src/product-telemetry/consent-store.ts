/**
 * Product telemetry control-state store — Anonymous Product Telemetry v1
 * (PRI-597, SPEC §44).
 *
 * Persists the machine-scope telemetry control state (consent, local secret,
 * bounded export status) to `~/.pd/product-telemetry.json`. This file is
 * Telemetry Control State — it never enters Principle/Pain/receipt/governance
 * stores, and the secret never leaves the machine.
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
export const PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION = '1';

export type ProductTelemetryConsent = 'unset' | 'granted' | 'denied';

export interface ProductTelemetryControlState {
  consent: ProductTelemetryConsent;
  consentVersion: string;
  /** Cryptographically random hex secret. Never uploaded. */
  telemetrySecret?: string;
  lastAttemptedAt?: string;
  lastSucceededAt?: string;
  /** Coarse failure code (TelemetryFailureCode). No response bodies. */
  lastFailureCode?: string;
  nextRetryAt?: string;
  /** Failed export attempts in the current attemptBucketDate (0–99; hard cap enforced by the service). */
  dailyAttemptCount?: number;
  /** UTC date bucket the dailyAttemptCount belongs to (resets on day change). */
  attemptBucketDate?: string;
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

/**
 * Read and validate the control state. A missing file is the normal
 * never-configured case (defaults, existed=false). A malformed file is a
 * loud failure — silently treating it as "unset" could re-prompt or re-export
 * against the user's recorded decision (rc-3/rc-9).
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
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!['consent', 'consentVersion', 'telemetrySecret', 'lastAttemptedAt', 'lastSucceededAt', 'lastFailureCode', 'nextRetryAt', 'dailyAttemptCount', 'attemptBucketDate', 'schemaVersion'].includes(key)) {
      errors.push(`unknown field '${key}'`);
    }
  }
  if (!isConsent(obj.consent)) errors.push('consent must be unset|granted|denied');
  if (typeof obj.consentVersion !== 'string' || obj.consentVersion.length === 0 || obj.consentVersion.length > 8) errors.push('consentVersion must be a short non-empty string');
  if (!isValidTelemetrySecretHex(obj.telemetrySecret) && obj.telemetrySecret !== undefined) errors.push('telemetrySecret must be 64 hex chars when present');
  if (!isOptionalIsoString(obj.lastAttemptedAt) || !isOptionalIsoString(obj.lastSucceededAt) || !isOptionalIsoString(obj.nextRetryAt)) {
    errors.push('timestamps must be parseable ISO-8601 strings (≤40 chars) when present');
  }
  if (!isOptionalAttemptCount(obj.dailyAttemptCount)) errors.push('dailyAttemptCount must be an integer 0–99 when present');
  if (!isOptionalAttemptBucketDate(obj.attemptBucketDate)) errors.push('attemptBucketDate must be a valid YYYY-MM-DD UTC date when present');
  if (obj.lastFailureCode !== undefined && (typeof obj.lastFailureCode !== 'string' || obj.lastFailureCode.length === 0 || obj.lastFailureCode.length > 40)) {
    errors.push('lastFailureCode must be a short non-empty string when present');
  }
  if (typeof obj.schemaVersion !== 'string' || obj.schemaVersion !== PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION}'`);
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
  // optional-field spreads carry only guard-passing values.
  const state: ProductTelemetryControlState = {
    consent: isConsent(obj.consent) ? obj.consent : 'unset',
    consentVersion: typeof obj.consentVersion === 'string' ? obj.consentVersion : PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(isValidTelemetrySecretHex(obj.telemetrySecret) ? { telemetrySecret: obj.telemetrySecret } : {}),
    ...(isOptionalIsoString(obj.lastAttemptedAt) && obj.lastAttemptedAt !== undefined ? { lastAttemptedAt: obj.lastAttemptedAt } : {}),
    ...(isOptionalIsoString(obj.lastSucceededAt) && obj.lastSucceededAt !== undefined ? { lastSucceededAt: obj.lastSucceededAt } : {}),
    ...(isOptionalIsoString(obj.nextRetryAt) && obj.nextRetryAt !== undefined ? { nextRetryAt: obj.nextRetryAt } : {}),
    ...(typeof obj.lastFailureCode === 'string' && obj.lastFailureCode.length > 0 && obj.lastFailureCode.length <= 40
      ? { lastFailureCode: obj.lastFailureCode }
      : {}),
    ...(isOptionalAttemptCount(obj.dailyAttemptCount) && obj.dailyAttemptCount !== undefined ? { dailyAttemptCount: obj.dailyAttemptCount } : {}),
    ...(isOptionalAttemptBucketDate(obj.attemptBucketDate) && obj.attemptBucketDate !== undefined ? { attemptBucketDate: obj.attemptBucketDate } : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
  return { ok: true, state, existed: true };
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
    lastAttemptedAt: previous.lastAttemptedAt,
    lastSucceededAt: previous.lastSucceededAt,
    lastFailureCode: previous.lastFailureCode,
    nextRetryAt: previous.nextRetryAt,
    dailyAttemptCount: previous.dailyAttemptCount,
    attemptBucketDate: previous.attemptBucketDate,
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
 * enabled.
 */
export function resetControlState(previous: ProductTelemetryControlState): ProductTelemetryControlState {
  return {
    consent: previous.consent,
    consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION,
    ...(previous.consent === 'granted' ? { telemetrySecret: generateTelemetrySecretHex() } : {}),
    schemaVersion: PRODUCT_TELEMETRY_CONTROL_SCHEMA_VERSION,
  };
}
