/**
 * Daily unlinkable telemetry identity — Anonymous Product Telemetry v1
 * (PRI-598, SPEC §15-§18).
 *
 * Pure crypto derivation — no I/O (node:crypto HMAC/hash only, same purity
 * class as feedback/fingerprint.ts).
 *
 * Privacy property: the collector sees one opaque ID per (secret, UTC date).
 * IDs from different dates under the same secret are computationally
 * unlinkable without the secret, so no cross-day deployment timeline can be
 * reconstructed from collected IDs alone.
 */

import { createHmac, randomBytes } from 'node:crypto';

/** Local secret length in bytes (stored as 64 hex chars). Never uploaded. */
export const TELEMETRY_SECRET_BYTES = 32;

/** Hex length of the derived daily telemetry ID (16 bytes of HMAC output). */
export const DAILY_TELEMETRY_ID_HEX_LENGTH = 32;

/**
 * Generate a fresh cryptographically random telemetry secret.
 *
 * Unrelated to machine, user, workspace path, or project content by
 * construction (CSPRNG output only). Callers persist it locally and must
 * never export it.
 */
export function generateTelemetrySecretHex(): string {
  return randomBytes(TELEMETRY_SECRET_BYTES).toString('hex');
}

/** Return true when `value` is syntactically a valid stored telemetry secret. */
export function isValidTelemetrySecretHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Coarse UTC date bucket (YYYY-MM-DD) for a point in time.
 *
 * UTC — not local time — so a snapshot derived near midnight always maps to
 * one deterministic bucket regardless of the machine timezone.
 */
export function bucketDateFromTime(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

/** Return true when `value` is a syntactically valid YYYY-MM-DD bucket date. */
export function isValidBucketDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Derive the daily anonymous telemetry ID:
 *
 *   dailyTelemetryId = hex( HMAC-SHA256(key = telemetrySecret, msg = bucketDate) )[0..32]
 *
 * Deterministic for the same (secret, date) — required for same-day dedup on
 * the collector — and unlinkable across dates without the secret.
 */
export function deriveDailyTelemetryId(telemetrySecretHex: string, bucketDate: string): string {
  return createHmac('sha256', telemetrySecretHex).update(bucketDate).digest('hex').slice(0, DAILY_TELEMETRY_ID_HEX_LENGTH);
}

/** Return true when `value` is syntactically a valid daily telemetry ID. */
export function isValidDailyTelemetryId(value: unknown): value is string {
  return typeof value === 'string' && value.length === DAILY_TELEMETRY_ID_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}
