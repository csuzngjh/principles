/**
 * The transaction poll's request budget, at the real API boundary.
 *
 * UpdatePage polls `/api/update/transaction/:id` while an update runs and asks
 * `fetchUpdateTransaction` to bound each poll. These tests run the REAL
 * `fetchUpdateTransaction` + `request` (node environment) with only the global
 * `fetch` stubbed, so what is pinned is what the page really sends:
 *
 * - a poll is abandoned when the server stays silent past its budget, and the
 *   failure carries the abort reason (the page then simply polls again);
 * - the budget the page passes in production is accepted by the API it feeds;
 * - a missing or out-of-domain budget means "no bound", never a request that
 *   cannot be made (AbortSignal.timeout throws on such values).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchUpdateTransaction } from '../../src/ui/api.js';

/** The page's own poll budget (TRANSACTION_POLL_TIMEOUT_MS in UpdatePage). */
const PRODUCTION_POLL_TIMEOUT_MS = 15_000;

type FetchCall = (input: unknown, init?: RequestInit) => Promise<Response>;

function transactionResponse(transactionId: string, exists: boolean): Response {
  return new Response(JSON.stringify({ transactionId, exists }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A server that never answers; it only reacts to the client giving up. */
function silentServer(): ReturnType<typeof vi.fn<FetchCall>> {
  return vi.fn<FetchCall>((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
}

function answeringServer(): ReturnType<typeof vi.fn<FetchCall>> {
  return vi.fn<FetchCall>(async () => transactionResponse('update-1', false));
}

let timeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchUpdateTransaction poll budget', () => {
  it('gives up on a poll the server never answers, and reports why', async () => {
    vi.stubGlobal('fetch', silentServer());

    const result = await fetchUpdateTransaction('update-1', 40);

    expect(result.success).toBe(false);
    // rc-9 / ERR-206: the transport reason survives into the final message.
    expect(result.success === false && /abort|timeout/i.test(result.error)).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(40);
  });

  it('accepts the budget the page passes in production', async () => {
    const fetchMock = answeringServer();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUpdateTransaction('update-1', PRODUCTION_POLL_TIMEOUT_MS);

    expect(result).toMatchObject({ success: true, data: { transactionId: 'update-1', exists: false } });
    expect(timeoutSpy).toHaveBeenCalledWith(PRODUCTION_POLL_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 12.5],
    ['not a number', Number.NaN],
  ])('sends an unbounded poll when the budget is %s, instead of a request that cannot be made', async (_label, budget) => {
    const fetchMock = answeringServer();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUpdateTransaction('update-1', budget);

    expect(result).toMatchObject({ success: true, data: { transactionId: 'update-1', exists: false } });
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });
});
