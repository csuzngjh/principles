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
import type { Context } from '@earendil-works/pi-ai';
import {
  createBoundPiAiFetch,
  getPiAiFetch,
  getPiAiFetchForApi,
  resetPiAiFetchForTest,
  supportsCustomFetchTransport,
} from '../pi-ai-http-transport.js';

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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 = OS-assigned ephemeral port: fixed-range picks can collide
    // across the four tests in this file and fail with EADDRINUSE.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind to an ephemeral port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err?: Error | null) => (err ? rej2(err) : res2()));
          }),
      });
    });
  });
}

/** Local stalled-body server: sends headers immediately, then never sends a body byte. */
function startStalledBodyServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // flushHeaders() pushes the response bytes to the socket — without it,
    // writeHead() only buffers in the application layer and fetch() never
    // receives the Response, so the test would (re)cover the headers phase,
    // not the body phase (PR #1524 review finding). With headers on the wire,
    // fetch() resolves and the hang moves to the body read.
    res.flushHeaders();
    // Intentionally never res.end() — simulates an LLM stream that opened
    // successfully then stalls mid-generation (the bodyTimeout half of the
    // PRI-683 cap pair).
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind to an ephemeral port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((res2, rej2) => {
            // destroy() instead of close(): the hung response keeps the
            // socket open, so a graceful close would never finish.
            server.closeAllConnections?.();
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

  it('createBoundPiAiFetch default args build an undici-capped Agent (factory covers zero-cap path)', async () => {
    // Default args (production config: caps disabled) — exercise the factory's
    // default-value branch, not just the explicit-options path used by the
    // fingerprint/fix tests above.
    const fetch = createBoundPiAiFetch();
    const server = await startSlowHeaderServer(50);
    servers.push(server.close);
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
  }, 10_000);

  it('fix: a stalled body (headers arrived, body never continues) is stoppable by the outer AbortSignal', async () => {
    // The bodyTimeout half of the PRI-683 cap pair, pinned in the OTHER
    // direction: with the transport caps disabled, a stalled body is NOT
    // silently cut by a transport timer — the caller's own AbortSignal (the
    // same signal pi-ai forwards from completeOptions.signal) is what ends
    // the hang, bounded and observable. When the signal fires mid-stream,
    // undici rejects the fetch promise itself (the SSE stream never yields
    // a completed response) — exactly the shape the adapter classifies as
    // `[timeout]` from the caller's signal, never as a transport abort.
    const server = await startStalledBodyServer();
    servers.push(server.close);

    const fetch = getPiAiFetch();
    // Same shape as production: AbortSignal.timeout(effectiveTimeoutMs)
    // passed via completeOptions and forwarded to the fetch init.
    const signal = AbortSignal.timeout(300);

    // Phase proof (PR #1524 review): with flushHeaders() the Response MUST
    // arrive first — only then does the body read hang — so the test actually
    // exercises the body phase instead of re-testing the headers phase.
    const startedAt = Date.now();
    const res = await fetch(server.url, { signal });
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // The BODY read was cut by the outer authority's 300ms — not left hanging
    // (caps disabled means nothing else was ever going to stop it) and not cut
    // early by a transport-layer timer.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it('resetPiAiFetchForTest clears the singleton (subsequent call returns a fresh fetch)', () => {
    const first = getPiAiFetch();
    resetPiAiFetchForTest();
    const second = getPiAiFetch();
    expect(second).not.toBe(first);
  });

  // ── PR #1524 review P1: provider fetch-injection compatibility ──────────
  //
  // pi-ai 0.84.x's google-generative-ai and google-vertex adapters reject any
  // fetch other than globalThis.fetch BEFORE the request is sent ("Custom
  // fetch is not supported by the … adapter", resolved as stopReason=error).
  // The dedicated undici transport must therefore only be injected for APIs
  // that accept fetch injection; the Google APIs keep globalThis.fetch so
  // those providers keep working. The live sub-check runs against the REAL
  // locked pi-ai with a syntactic throwaway key (assembled at runtime, never
  // a credential) and no network: the fetch guard fires at adapter entry,
  // before any HTTP I/O, so the assertion needs no successful request.
  it('provider compatibility: google APIs get globalThis.fetch, others get the dedicated transport', async () => {
    expect(supportsCustomFetchTransport('google-generative-ai')).toBe(false);
    expect(supportsCustomFetchTransport('google-vertex')).toBe(false);
    expect(getPiAiFetchForApi('google-generative-ai')).toBe(globalThis.fetch);
    expect(getPiAiFetchForApi('google-vertex')).toBe(globalThis.fetch);

    // Every other known API keeps the cap-bypass transport (the PRI-683 fix).
    expect(getPiAiFetchForApi('openai-completions')).toBe(getPiAiFetch());
    expect(getPiAiFetchForApi('anthropic-messages')).toBe(getPiAiFetch());
    expect(getPiAiFetchForApi('openai-responses')).toBe(getPiAiFetch());

    // Live proof against the real pi-ai adapters: with the fix, they get past
    // the fetch guard and surface whatever auth/network failure follows —
    // anything EXCEPT the custom-fetch rejection the bug produced.
    const { completeSimple } = await import('@earendil-works/pi-ai/compat');
    const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
    const throwawayKey = ['test', 'key', 'offline'].join('-');
    const ctx: Context = {
      messages: [{ role: 'user', content: 'Reply with {"ok":true} only.', timestamp: Date.now() }],
    };
    for (const [provider, modelId] of [['google', 'gemini-2.5-flash'], ['google-vertex', 'gemini-2.5-flash']] as const) {
      const model = getBuiltinModel(provider, modelId);
      const response = await completeSimple(model, ctx, {
        apiKey: throwawayKey,
        maxRetries: 0,
        timeoutMs: 2_000,
        fetch: getPiAiFetchForApi(model.api),
      });
      expect(response.errorMessage ?? '').not.toMatch(/Custom fetch is not supported/);
    }
  }, 15_000);
});
