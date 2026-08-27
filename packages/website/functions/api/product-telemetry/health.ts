// functions/api/product-telemetry/health.ts
// Cloudflare Pages Function entry — GET /api/product-telemetry/health.
// Returns 200 {ok:true}; no bindings required (liveness only, mirrors
// /api/feedback/health).
export async function onRequestGet(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
