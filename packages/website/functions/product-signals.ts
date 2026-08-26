// functions/product-signals.ts
// Cloudflare Pages Function entry — GET /product-signals (PRI-601).
// Protected maintainer view: requires Authorization: Bearer <PRODUCT_SIGNALS_TOKEN>.
// All logic lives in the dependency-injected, vitest-tested
// _lib/product-signals-core.ts (EP-02).
import { handleProductSignals, type SignalsEnv } from './_lib/product-signals-core.js';

interface PagesEnv extends Record<string, unknown> {
  PD_PRODUCT_TELEMETRY: SignalsEnv['PD_PRODUCT_TELEMETRY'];
  PRODUCT_SIGNALS_TOKEN?: string;
}

export async function onRequestGet(context: {
  request: Request;
  env: PagesEnv;
}): Promise<Response> {
  const result = await handleProductSignals({
    env: context.env as SignalsEnv,
    authorization: context.request.headers.get('Authorization') ?? undefined,
  });
  return new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
