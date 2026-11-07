/**
 * Daily unlinkable telemetry identity — Anonymous Product Telemetry v1
 * (PRI-598, SPEC §15-§18; review remediation: workspace measurement unit).
 *
 * Pure crypto derivation — no I/O (node:crypto HMAC/hash only, same purity
 * class as feedback/fingerprint.ts).
 *
 * Privacy property: the collector sees one opaque ID per
 * (secret, workspace, UTC date). IDs from different dates — and from
 * different workspaces — are computationally unlinkable without the secret,
 * so no cross-day or cross-workspace timeline can be reconstructed from
 * collected IDs alone. The workspace scope ID is LOCAL bookkeeping only;
 * it is never uploaded (the server cannot derive it without the secret).
 */

import { createHmac, randomBytes } from 'node:crypto';

/** Local secret length in bytes (stored as 64 hex chars). Never uploaded. */
export const TELEMETRY_SECRET_BYTES = 32;

/** Hex length of the derived daily telemetry ID (16 bytes of HMAC output). */
export const DAILY_TELEMETRY_ID_HEX_LENGTH = 32;

/** Hex length of the local workspace scope ID (8 bytes of HMAC output). */
export const WORKSPACE_SCOPE_ID_HEX_LENGTH = 16;

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
 * Derive the LOCAL workspace scope ID used to key workspace-scoped export
 * bookkeeping (dedup, retry, lock) inside the control state:
 *
 *   workspaceScopeId = hex( HMAC-SHA256(key = telemetrySecret,
 *                                       msg = "workspace:" + canonicalWorkspacePath) )[0..16]
 *
 * Keyed by the telemetry secret so the stored map keys carry no information
 * about the workspace path (a plain hash of the path would be enumerable;
 * without the secret the value is indistinguishable from random). Used for
 * local bookkeeping and lock filenames ONLY — never uploaded, never sent.
 *
 * Callers pass an already-canonicalized path (resolve + realpath + separator
 * and case normalization live at the I/O boundary in host-runtime).
 */
export function deriveWorkspaceScopeId(telemetrySecretHex: string, canonicalWorkspacePath: string): string {
  return createHmac('sha256', telemetrySecretHex).update(`workspace:${canonicalWorkspacePath}`).digest('hex').slice(0, WORKSPACE_SCOPE_ID_HEX_LENGTH);
}

/**
 * Derive the daily anonymous telemetry ID for one workspace:
 *
 *   dailyTelemetryId = hex( HMAC-SHA256(key = telemetrySecret,
 *                       msg = "daily-workspace:" + workspaceScopeId + ":" + bucketDate) )[0..32]
 *
 * Deterministic for the same (secret, workspace, date) — required for
 * same-day dedup on the collector — and unlinkable across dates AND across
 * workspaces without the secret. The "daily-workspace:"/"workspace:" message
 * prefixes keep the two derivations domain-separated.
 */
export function deriveDailyTelemetryId(telemetrySecretHex: string, workspaceScopeId: string, bucketDate: string): string {
  return createHmac('sha256', telemetrySecretHex).update(`daily-workspace:${workspaceScopeId}:${bucketDate}`).digest('hex').slice(0, DAILY_TELEMETRY_ID_HEX_LENGTH);
}

/** Return true when `value` is syntactically a valid daily telemetry ID. */
export function isValidDailyTelemetryId(value: unknown): value is string {
  return typeof value === 'string' && value.length === DAILY_TELEMETRY_ID_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}
