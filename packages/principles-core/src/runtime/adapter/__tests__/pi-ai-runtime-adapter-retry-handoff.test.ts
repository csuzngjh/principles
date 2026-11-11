/**
 * Phase-1 stability (S2): transport retries are owned by pi-ai, not PD.
 *
 * Contract under test:
 *   1. A non-retryable provider failure (400) costs exactly ONE request at the
 *      PD layer — PD no longer runs its own retry loop on top of pi-ai's.
 *   2. `completeSimple` receives `maxRetries` and `maxRetryDelayMs` so pi-ai
 *      can actually retry the failures it classifies as retryable.
 *   3. A retryable 429 is still retried end-to-end (by pi-ai) and succeeds,
 *      proving the delegation keeps the old resilience.
 *
 * Red-before-green evidence:
 *   - Before S2 the adapter passed `maxRetries: 0` and looped itself, so a 400
 *     produced 3 wire requests and pi-ai retried nothing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';

const captured = vi.hoisted(() => ({
  options: [] as unknown[],
}));

// adapter-chain-mock-exempt: injection-tested — the faux provider bypasses the
// per-API HTTP adapters that consume maxRetries/maxRetryDelayMs, so retry
// ownership (the options PD hands over + the single PD-level request) is not
// observable from faux. Planting the pre-S2 implementation back makes this
// suite red (3 wire requests / maxRetries 0), which is the recorded evidence.

// Record what the adapter asks pi-ai to do, then run the REAL implementation
// so the wire-level assertions below stay honest.
vi.mock('@earendil-works/pi-ai/compat', async (importActual) => {
  const actual = await importActual<{
    completeSimple: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
  }>();
  return {
    ...actual,
    completeSimple: async (model: unknown, context: unknown, options: unknown) => {
      captured.options.push(options);
      return actual.completeSimple(model, context, options);
    },
  };
});

const wire = vi.hoisted(() => ({
  requests: [] as { url: string }[],
  plan: [] as { status: number; body: string; headers?: Record<string, string> }[],
}));

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const plannedFetch: FetchFunction = async (input) => {
    const index = wire.requests.length;
    wire.requests.push({ url: String(input) });
    const entry = wire.plan[index];
    if (!entry) throw new Error(`retry-handoff test bug: no response planned for request #${index}`);
    return new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.status < 300 ? 'text/event-stream' : 'application/json', ...(entry.headers ?? {}) },
    });
  };
  return { ...actual, getPiAiFetchForApi: () => plannedFetch };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const API_KEY_ENV = 'PI_AI_RETRY_HANDOFF_TEST_KEY';

function makeAdapter(overrides: Record<string, unknown> = {}): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKeyEnv: API_KEY_ENV,
    timeoutMs: 30_000,
    outputPathStrategy: 'free_form_only',
    ...overrides,
  });
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
    taskRef: { taskId: 'retry-handoff-1' },
    inputPayload: 'Return one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

function errorEntry(message: string, status = 400): { status: number; body: string } {
  return { status, body: JSON.stringify({ error: { message, type: 'invalid_request_error' } }) };
}

/** Minimal OpenAI-compatible SSE answer carrying one assistant text chunk. */
function sseAnswer(text: string): { status: number; body: string } {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return {
    status: 200,
    body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
  };
}

beforeEach(() => {
  process.env[API_KEY_ENV] = 'offline-dummy-key-not-a-credential';
  captured.options = [];
  wire.requests = [];
  wire.plan = [];
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
});

describe('PiAiRuntimeAdapter — S2 transport retry handoff', () => {
  it('sends exactly one request for a non-retryable provider error', async () => {
    // Three identical failures planned so the RED run can retry without
    // tripping the "no response planned" guard.
    wire.plan = [errorEntry('invalid request: bad shape'), errorEntry('invalid request: bad shape'), errorEntry('invalid request: bad shape')];

    const adapter = makeAdapter();
    let caught: unknown;
    try {
      await adapter.startRun(makeInput());
    } catch (err) {
      caught = err;
    }

    // RED (before S2): PD's own loop retried the 400 three times.
    expect(wire.requests.length).toBe(1);
    expect(caught).toBeInstanceOf(PDRuntimeError);
  }, 20_000);

  it('hands the retry budget to pi-ai instead of looping itself', async () => {
    wire.plan = [sseAnswer('{"ok":true}')];

    const adapter = makeAdapter();
    await adapter.startRun(makeInput());

    const options = captured.options.at(-1) as SimpleStreamOptions | undefined;
    expect(options).toBeDefined();
    // RED (before S2): maxRetries was 0 (PD looped) and no delay cap was sent.
    expect(options?.maxRetries).toBe(2);
    expect(options?.maxRetryDelayMs).toBe(30_000);
  }, 20_000);

  it('still recovers from a retryable 429 through pi-ai', async () => {
    wire.plan = [
      { status: 429, body: JSON.stringify({ error: { message: 'rate limit exceeded' } }), headers: { 'retry-after': '0' } },
      sseAnswer('{"ok":true}'),
    ];

    const adapter = makeAdapter();
    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    // One 429 + one success = pi-ai's retry did the work.
    expect(wire.requests.length).toBe(2);
    expect(output).toBeDefined();
  }, 20_000);
});
