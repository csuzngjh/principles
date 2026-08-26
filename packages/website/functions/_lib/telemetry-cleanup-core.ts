// telemetry-cleanup-core.ts
// Protected retention cleanup — Anonymous Product Telemetry v1
// (review remediation: retention independent of writes).
//
// POST /api/product-telemetry/cleanup — deletes rows older than the 90-day
// retention policy. The write-time sweep in telemetry-core.ts is kept as an
// opportunistic safeguard, but THIS endpoint is the actual enforcement path:
// a scheduled GitHub workflow calls it daily, so records expire on time even
// when no new telemetry is written.
//
// Contract:
// - POST only (the Pages entry refuses other methods with 405).
// - Bearer auth against PRODUCT_TELEMETRY_CLEANUP_TOKEN (independent secret;
//   NOT the maintainer-view PRODUCT_SIGNALS_TOKEN), compared in constant
//   time, minimum strength ≥24 bytes as hex (48+ hex chars) — fail closed.
// - The server computes the cutoff from the shared retentionCutoffDate()
//   policy; the client cannot specify an arbitrary cutoff.
// - Fixed parameterized SQL; idempotent (a second run deletes 0 rows and
//   still returns ok).
// - No telemetry row contents are ever returned — only the deleted count
//   and the applied cutoff.

import { retentionCutoffDate, type TelemetryD1 } from './telemetry-core.js';

export interface CleanupEnv {
  PD_PRODUCT_TELEMETRY: TelemetryD1;
  PRODUCT_TELEMETRY_CLEANUP_TOKEN?: string;
}

export interface CleanupDeps {
  env: CleanupEnv;
  /** Raw Authorization header value. */
  authorization?: string;
  now?: () => number;
}

export interface CleanupResult {
  status: number;
  json: unknown;
}

/** Constant-time byte-string comparison (same construction as product-signals-core; WebCrypto has no timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

export async function handleTelemetryCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const now = deps.now ?? Date.now;
  const token = deps.env.PRODUCT_TELEMETRY_CLEANUP_TOKEN;
  // Token floor matches the signals-view runbook: ≥24 bytes as hex (48+ hex chars).
  if (token === undefined || !/^[0-9a-f]{48,}$/i.test(token)) {
    return { status: 500, json: { error: 'cleanup_misconfigured', reason: 'PRODUCT_TELEMETRY_CLEANUP_TOKEN must be >=24 bytes as hex (48+ hex chars)' } };
  }
  const expected = `Bearer ${token}`;
  const provided = deps.authorization ?? '';
  if (!constantTimeEqual(provided, expected)) {
    return { status: 401, json: { error: 'unauthorized' } };
  }

  const cutoff = retentionCutoffDate(now());
  try {
    const result = await deps.env.PD_PRODUCT_TELEMETRY
      .prepare('DELETE FROM product_telemetry_daily WHERE bucket_date < ?')
      .bind(cutoff)
      .run();
    const deleted = typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
    return { status: 200, json: { ok: true, deleted, cutoff } };
  } catch (error) {
    // Fixed coarse reason only — backend error text never reaches the responder.
    console.error('[telemetry-cleanup] delete failed:', error instanceof Error ? error.message : String(error));
    return { status: 500, json: { error: 'storage_unavailable', reason: 'retention cleanup could not run' } };
  }
}
