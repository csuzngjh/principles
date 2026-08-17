// functions/api/feedback/health.ts
// Cloudflare Pages Function entry — GET /api/feedback/health, spec §9.1.
// Returns 200 { ok:true }; no bindings required.
import { handleFeedbackHealth } from '../../_lib/health.js';

export async function onRequestGet(): Promise<Response> {
  const result = await handleFeedbackHealth();
  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
}