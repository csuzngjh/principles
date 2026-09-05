/**
 * PRI-683 — pdStreamSimple fetch-injection unit test.
 *
 * The L2 wiring is exercised end-to-end by l2-agent-loop-adapter.test.ts with
 * runAgentLoop mocked, but the `pdStreamSimple` helper itself is a one-line
 * streamer wrapper whose contract — "fetch is injected into the call to
 * streamSimple and the caller's options pass through" — is worth locking with
 * a direct test so codecov's patch gate sees the new line and a future
 * refactor cannot silently drop the fetch binding.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', async (importActual) => {
  const actual = await importActual<typeof import('@earendil-works/pi-ai/compat')>();
  return {
    ...actual,
    streamSimple: vi.fn(),
  };
});

import { streamSimple } from '@earendil-works/pi-ai/compat';
import { pdStreamSimple } from '../l2-agent-loop-adapter.js';
import { getPiAiFetch } from '../pi-ai-http-transport.js';

describe('PRI-683: pdStreamSimple injects the transport fetch', () => {
  it('always passes the PD transport fetch and preserves the caller options', () => {
    const fakeStream = { result: vi.fn() };
    vi.mocked(streamSimple).mockReturnValue(fakeStream as never);

    const callerOptions = {
      signal: new AbortController().signal,
      temperature: 0.2,
      maxTokens: 1234,
    };
    const model = { provider: 'test', id: 'test' } as never;
    const context = { messages: [] } as never;

    const result = pdStreamSimple(model, context, callerOptions);
    expect(result).toBe(fakeStream);

    const call = vi.mocked(streamSimple).mock.calls[0]!;
    expect(call[0]).toBe(model);
    expect(call[1]).toBe(context);
    const forwarded = call[2]!;
    expect(forwarded.fetch).toBe(getPiAiFetch());
    expect(forwarded.signal).toBe(callerOptions.signal);
    expect(forwarded.temperature).toBe(0.2);
    expect(forwarded.maxTokens).toBe(1234);
  });
});
