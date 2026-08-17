// functions/api/feedback/index.ts
// Cloudflare Pages Function entry — POST /api/feedback (submit), spec §9.
// Thin adapter: extracts request fields, delegates the whole decision to the
// injected, testable core in `_lib/relay-core.js` (EP-02: the same code path
// is exercised by relay tests, not a copy).
import { handleFeedbackSubmit, type RelayEnv, type RelayResult } from '../../_lib/relay-core.js';

interface PagesEnv extends Record<string, unknown> {
  FEEDBACK_KV: RelayEnv['FEEDBACK_KV'];
  INGEST_TOKEN?: string;
  LIN_API_KEY?: string;
  LIN_TEAM_ID?: string;
}

export async function onRequestPost(context: {
  request: Request;
  env: PagesEnv;
}): Promise<Response> {
  const ip =
    context.request.headers.get('CF-Connecting-IP') ??
    'unknown';
  const body = await context.request.text();
  const result: RelayResult = await handleFeedbackSubmit({
    env: context.env as RelayEnv,
    authToken: context.request.headers.get('Authorization') ?? undefined,
    ip,
    body,
  });
  return jsonResponse(result);
}

function jsonResponse(result: RelayResult): Response {
  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', ...result.headers },
  });
}