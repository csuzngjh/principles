/**
 * PRI-683 mechanism regression: the ~300s inner transport cap.
 *
 * Root cause: Node's global fetch (built-in undici dispatcher) applies
 * implicit default headersTimeout/bodyTimeout of 300s. LLM requests whose
 * server-side prefill exceeds that boundary are aborted at exactly the cap
 * — before the configured timeoutMs (600s/900s) can ever fire. Lab evidence
 * (pd-labs/pri653-r2b state.db): every repair-wave attempt died at
 * 300.02-300.04s with "Request was aborted"; the runner/profile layer
 * already aborts precisely at its own configured value (PRI-670 / PR #1512).
 *
 * This suite recreates that exact mechanism at 1s scale against a local
 * node:http slow server (no network, no real LLM):
 *   1. (bug fingerprint) an Agent WITH a small headersTimeout cap aborts at
 *      the cap while the outer AbortSignal budget is still far away;
 *   2. (fix) the production transport (caps disabled) survives the same
 *      delayed response the capped Agent dies on;
 *   3. (authority preserved) the outer AbortSignal.timeout still fires on
 *      schedule — disabling the transport caps does NOT disable the
 *      pipeline's own timeout authority.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import { createBoundPiAiFetch, getPiAiFetch } from '../pi-ai-http-transport.js';

/** Local slow server: delays response headers by `headerDelayMs`. */
function startSlowHeaderServer(headerDelayMs: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, headerDelayMs);
  });
  const port = 12700 + Math.floor(Math.random() * 200);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err?: Error | null) => (err ? rej2(err) : res2()));
          }),
      });
    });
  });
}

const servers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(servers.map((close) => close()));
});

describe('PRI-683: pi-ai HTTP transport inner timeout cap', () => {
  it('reproduces the fingerprint: a capped Agent aborts at its cap, not at the outer budget', async () => {
    // Server holds headers back for 1200ms — beyond the Agent's 300ms cap.
    const server = await startSlowHeaderServer(1200);
    servers.push(server.close);

    // Bug-shaped Agent: small headersTimeout, like Node's implicit 300s default.
    const cappedFetch = createBoundPiAiFetch({ headersTimeout: 300, bodyTimeout: 300 });

    const startedAt = Date.now();
    await expect(
      cappedFetch(server.url),
      'capped Agent must abort at its cap (this is the PRI-683 failure mode)',
    ).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // Aborted at ~300ms (retry loop can push it past 300 but it must stay
    // well short of the 1200ms delayed headers), far short of when the
    // headers would have arrived. The outer caller had no say — exactly the
    // "300.02s not 600s" lab fingerprint.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1200);
  }, 10_000);

  it('fix: the production transport (caps disabled) survives delayed headers', async () => {
    // Same 1200ms delayed-header server that killed the capped Agent.
    const server = await startSlowHeaderServer(1200);
    servers.push(server.close);

    const fetch = getPiAiFetch();
    const res = await fetch(server.url, {
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 10_000);

  it('authority preserved: the outer AbortSignal.timeout still fires on schedule', async () => {
    // Server delays 5000ms — long enough that only the outer 300ms budget can stop it.
    const server = await startSlowHeaderServer(5000);
    servers.push(server.close);

    const fetch = getPiAiFetch();
    const startedAt = Date.now();
    await expect(
      fetch(server.url, { signal: AbortSignal.timeout(300) }),
      'outer budget must remain the timeout authority after caps are disabled',
    ).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  }, 10_000);

  it('singleton: getPiAiFetch returns the same function across calls', () => {
    expect(getPiAiFetch()).toBe(getPiAiFetch());
  });
});
