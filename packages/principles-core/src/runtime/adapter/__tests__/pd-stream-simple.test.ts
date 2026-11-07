/**
 * PRI-683 + PR #1524 review — pdStreamSimple fetch-injection contract.
 *
 * The L2 wiring is exercised end-to-end by l2-agent-loop-adapter.test.ts with
 * runAgentLoop mocked, but the `pdStreamSimple` helper itself is a one-line
 * streamer wrapper whose contract is worth locking directly so codecov's
 * patch gate sees the line and a future refactor cannot silently drop the
 * fetch binding.
 *
 * PR #1524 review follow-up: the contract is NOT "always pass the transport
 * fetch" — pi-ai 0.84.x's google-generative-ai / google-vertex adapters
 * reject any non-globalThis.fetch at entry, so those model APIs must receive
 * Node's global fetch. Both sides are pinned here: fetch-injectable APIs get
 * the dedicated undici transport; the Google pair gets globalThis.fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SimpleStreamOptions, Model, Context } from '@earendil-works/pi-ai';

vi.mock('@earendil-works/pi-ai/compat', async (importActual) => {
  const actual: Record<string, unknown> = await importActual();
  return {
    ...actual,
    streamSimple: vi.fn(),
  };
});

import { streamSimple } from '@earendil-works/pi-ai/compat';
import { pdStreamSimple } from '../l2-agent-loop-adapter.js';
import { getPiAiFetch } from '../pi-ai-http-transport.js';

type StreamCall = [Model<string>, Context, SimpleStreamOptions];

function calls(): StreamCall[] {
  return vi.mocked(streamSimple).mock.calls as unknown as StreamCall[];
}

function forwardedFetchFor(api: string): unknown {
  const fakeStream = { result: vi.fn() };
  vi.mocked(streamSimple).mockClear().mockReturnValue(fakeStream as never);
  const model = { provider: 'test', id: 'test', api } as unknown as Model<string>;
  const context = { messages: [] } as unknown as Context;
  const result = pdStreamSimple(model, context, { temperature: 0.2, maxTokens: 1234 });
  expect(result).toBe(fakeStream);
  const [first] = calls();
  expect(first).toBeDefined();
  expect(first?.[0]).toBe(model);
  expect(first?.[1]).toBe(context);
  return first?.[2].fetch;
}

describe('PRI-683: pdStreamSimple transport contract (PR #1524 review)', () => {
  it('fetch-injectable APIs get the dedicated undici transport, caller options preserved', () => {
    const { signal } = new AbortController();
    const fakeStream = { result: vi.fn() };
    vi.mocked(streamSimple).mockClear().mockReturnValue(fakeStream as never);
    const model = { provider: 'test', id: 'test', api: 'openai-completions' } as unknown as Model<string>;
    const context = { messages: [] } as unknown as Context;

    const result = pdStreamSimple(model, context, { signal, temperature: 0.2, maxTokens: 1234 });
    expect(result).toBe(fakeStream);

    const [first] = calls();
    const forwarded = first?.[2];
    expect(forwarded?.fetch).toBe(getPiAiFetch());
    expect(forwarded?.signal).toBe(signal);
    expect(forwarded?.temperature).toBe(0.2);
    expect(forwarded?.maxTokens).toBe(1234);
  });

  it('Google/Gemini and Vertex APIs keep globalThis.fetch — their adapters reject custom fetch', () => {
    // The exact L2 failure the review found: an unconditional transport fetch
    // made every google-generative-ai / google-vertex L2 call resolve with
    // stopReason=error ("Custom fetch is not supported…") before any request.
    expect(forwardedFetchFor('google-generative-ai')).toBe(globalThis.fetch);
    expect(forwardedFetchFor('google-vertex')).toBe(globalThis.fetch);
    // And the rest of the catalog keeps the cap-bypass transport.
    expect(forwardedFetchFor('openai-completions')).toBe(getPiAiFetch());
    expect(forwardedFetchFor('anthropic-messages')).toBe(getPiAiFetch());
    expect(forwardedFetchFor('openai-responses')).toBe(getPiAiFetch());
  });
});
