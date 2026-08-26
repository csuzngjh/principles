// functions/api/product-telemetry/cleanup.ts
// Cloudflare Pages Function entry — POST /api/product-telemetry/cleanup
// (review remediation: scheduled retention enforcement). Protected by
// PRODUCT_TELEMETRY_CLEANUP_TOKEN; the retention cutoff is computed
// server-side (shared with the write-time sweep). All logic lives in the
// dependency-injected, vitest-tested _lib/telemetry-cleanup-core.ts (EP-02).
import { handleTelemetryCleanup, type CleanupEnv } from '../../_lib/telemetry-cleanup-core.js';

interface PagesEnv extends Record<string, unknown> {
  PD_PRODUCT_TELEMETRY: CleanupEnv['PD_PRODUCT_TELEMETRY'];
  PRODUCT_TELEMETRY_CLEANUP_TOKEN?: string;
}

export async function onRequestPost(context: {
  request: Request;
  env: PagesEnv;
}): Promise<Response> {
  const result = await handleTelemetryCleanup({
    env: context.env as CleanupEnv,
    authorization: context.request.headers.get('Authorization') ?? undefined,
  });
  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Non-POST methods are refused with a bounded response.
export function onRequestOther(): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
}
