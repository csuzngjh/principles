/**
 * Bounded Console Owner E2E HTTP probe. AbortSignal covers both response
 * headers and a partially transmitted response body.
 */
export async function getJson(url, timeoutMs = 5_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  return { status: res.status, body, parsed };
}
