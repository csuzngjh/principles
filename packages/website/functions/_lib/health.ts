// health.ts
// Relay health endpoint (spec §9.1): GET /api/feedback/health → 200 { ok:true }.
// No data returned; used by the Console only to confirm a server exists
// (spec §8.1: any HTTP response counts as reachable / fail-open).
import type { RelayResult } from './relay-core.js';

export async function handleFeedbackHealth(): Promise<RelayResult> {
  return { status: 200, json: { ok: true } };
}