// functions/api/product-telemetry/snapshot.ts
// Cloudflare Pages Function entry — POST /api/product-telemetry/snapshot
// (PRI-600). Thin adapter mirroring functions/api/feedback/index.ts: the whole
// decision lives in the dependency-injected, vitest-tested
// _lib/telemetry-core.ts (EP-02). Extracted here: the raw body text, and the
// single transport header CF-Connecting-IP. The source address is forwarded
// ONLY into the keyed abuse limiter — never logged, stored, or echoed (see
// telemetry-core.ts); no other headers or metadata are read or forwarded.
import { handleTelemetrySnapshot, type TelemetryEnv } from '../../_lib/telemetry-core.js';

interface PagesEnv extends Record<string, unknown> {
  PD_PRODUCT_TELEMETRY: TelemetryEnv['PD_PRODUCT_TELEMETRY'];
  FEEDBACK_KV: TelemetryEnv['FEEDBACK_KV'];
  TELEMETRY_HMAC_SECRET?: string;
  TELEMETRY_ABUSE_HMAC_SECRET?: string;
}

export async function onRequestPost(context: {
  request: Request;
  env: PagesEnv;
}): Promise<Response> {
  const body = await context.request.text();
  const sourceIp = context.request.headers.get('cf-connecting-ip') ?? undefined;
  const result = await handleTelemetrySnapshot({ env: context.env as TelemetryEnv, body, ...(sourceIp !== undefined ? { sourceIp } : {}) });
  if (result.status === 204) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', ...(result.headers ?? {}) },
  });
}

// Non-POST methods are refused with a bounded response.
export function onRequestOther(): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
}
