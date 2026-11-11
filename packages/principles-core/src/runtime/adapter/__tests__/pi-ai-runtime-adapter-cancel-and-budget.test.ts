/**
 * Phase-1 stability (S1): cancellation must actually stop the in-flight request,
 * and the structured-output repair call must inherit the run's remaining time
 * budget instead of getting a fresh fixed allowance.
 *
 * Everything except the HTTP wire is real: model resolution, the pi-ai facade,
 * SSE parsing, all output paths and the repair loop. The transport module is
 * mocked with a planned fetch that can hang until aborted — zero network.
 *
 * Red-before-green evidence for S1:
 *   - cancelRun() was a documented no-op, so a hung provider call never ended.
 *   - repairLLMCall() always used a fresh 60s allowance, so a run whose budget
 *     was nearly spent could still send another request.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';
import { PDRuntimeError } from '../../error-categories.js';

interface WirePlanEntry {
  /** Milliseconds to wait before answering (rejects if the request aborts first). */
  delayMs?: number;
  /** Never answer; reject only when the request aborts. */
  hang?: boolean;
  /** Response factory, evaluated after any delay. */
  response?: () => Response;
}

const wire = vi.hoisted(() => {
  const state: { requests: { url: string }[]; plan: WirePlanEntry[] } = {
    requests: [],
    plan: [],
  };
  return state;
});

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const plannedFetch: FetchFunction = async (input, init) => {
    const index = wire.requests.length;
    wire.requests.push({ url: String(input) });
    const entry = wire.plan[index] ?? {};

    if (entry.hang === true) {
      return rejectOnAbort(init?.signal);
    }
    if (typeof entry.delayMs === 'number' && entry.delayMs > 0) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, entry.delayMs)),
        rejectOnAbort(init?.signal),
      ]);
    }
    if (!entry.response) {
      throw new Error(`cancel-and-budget test bug: no response planned for request #${index}`);
    }
    return entry.response();
  };
  return {
    ...actual,
    getPiAiFetchForApi: () => plannedFetch,
  };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import {
  LEARNING_LAB_ACTOR_ACTION_REF,
} from '../../learning-lab/actor-action-output.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const API_KEY_ENV = 'PI_AI_CANCEL_BUDGET_TEST_KEY';

/** Minimal OpenAI-compatible SSE body carrying one assistant text chunk. */
function sseText(text: string): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeAdapter(overrides: Record<string, unknown> = {}): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKeyEnv: API_KEY_ENV,
    maxRetries: 0,
    timeoutMs: 30_000,
    outputPathStrategy: 'free_form_only',
    ...overrides,
  });
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
    taskRef: { taskId: 'cancel-budget-1' },
    inputPayload: 'Return one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Wait until the adapter has registered a run (i.e. the request is in flight). */
async function waitForRunId(adapter: PiAiRuntimeAdapter, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { runs } = adapter as unknown as { runs?: Map<string, unknown> };
    if (runs && runs.size > 0) {
      const [runId] = [...runs.keys()];
      if (runId) return runId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('adapter never registered a run');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached before timeout');
}

/** Resolve with the promise outcome, or report that it was still pending. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{ settled: true; error?: unknown } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const target: Promise<{ settled: true; error?: unknown }> = promise.then(
    () => ({ settled: true }),
    (error) => ({ settled: true, error }),
  );
  try {
    return await Promise.race([target, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(() => {
  process.env[API_KEY_ENV] = 'offline-dummy-key-not-a-credential';
  wire.requests = [];
  wire.plan = [];
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
});

describe('PiAiRuntimeAdapter — S1 cancellation and shared time budget', () => {
  it('cancelRun aborts the in-flight request and fails the run as cancelled', async () => {
    wire.requests.length = 0;
    wire.plan = [{ hang: true }];

    const adapter = makeAdapter({ timeoutMs: 10_000 });
    const pending = adapter.startRun(makeInput({ timeoutMs: 10_000 }));
    pending.catch(() => { /* drained below */ });

    const runId = await waitForRunId(adapter);
    await waitUntil(() => wire.requests.length === 1);

    const cancelStartedAt = Date.now();
    await adapter.cancelRun(runId);

    const outcome = await settlesWithin(pending, 1_500);
    // RED (before S1): cancelRun was a no-op, the run stayed blocked on the
    // hanging request and never settled inside the window.
    expect(outcome.settled).toBe(true);
    if (!outcome.settled) return;

    const elapsedSinceCancelMs = Date.now() - cancelStartedAt;
    expect(outcome.error).toBeInstanceOf(PDRuntimeError);
    expect((outcome.error as PDRuntimeError).category).toBe('cancelled');
    expect(elapsedSinceCancelMs).toBeLessThan(1_000);
    // Aborted before the provider could answer a second time (one request only).
    expect(wire.requests.length).toBe(1);

    const status = await adapter.pollRun(runId);
    expect(status.status).toBe('cancelled');
  }, 15_000);

  it('skips the repair request when less than 1s of the run budget is left', async () => {
    wire.requests.length = 0;
    // The first answer eats 2.4s of a 3s budget: only ~0.6s would remain for repair.
    wire.plan = [
      { delayMs: 2_400, response: () => sseText('{}') },
      { response: () => sseText('{}') },
    ];

    const adapter = makeAdapter({ timeoutMs: 30_000 });
    const startedAt = Date.now();

    let caught: unknown;
    try {
      await adapter.startRun(makeInput({
        timeoutMs: 3_000,
        outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF,
      }));
    } catch (err) {
      caught = err;
    }

    const elapsedMs = Date.now() - startedAt;
    // RED (before S1): the repair call got a fresh 60s allowance, so a second
    // request went out even though the run budget was almost spent.
    expect(wire.requests.length).toBe(1);
    expect(caught).toBeInstanceOf(PDRuntimeError);
    expect((caught as PDRuntimeError).category).toBe('output_invalid');
    expect(elapsedMs).toBeLessThan(3_000);
  }, 15_000);

  it('caps the repair request at the remaining run budget instead of a fresh 60s', async () => {
    wire.requests.length = 0;
    // Valid transport, invalid schema → repair; the repair request hangs.
    wire.plan = [
      { response: () => sseText('{}') },
      { hang: true },
    ];

    const adapter = makeAdapter({ timeoutMs: 30_000 });
    const startedAt = Date.now();
    const pending = adapter.startRun(makeInput({
      timeoutMs: 1_500,
      outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF,
    }));
    pending.catch(() => { /* drained below */ });

    const outcome = await settlesWithin(pending, 4_000);
    const elapsedMs = Date.now() - startedAt;

    // RED (before S1): repair used a fresh 60s allowance, so the run outlived
    // its own 1.5s budget by an order of magnitude.
    expect(outcome.settled).toBe(true);
    if (!outcome.settled) return;
    expect(outcome.error).toBeInstanceOf(PDRuntimeError);
    expect((outcome.error as PDRuntimeError).category).toBe('timeout');
    expect(elapsedMs).toBeLessThan(4_000);
    expect(wire.requests.length).toBe(2);
  }, 15_000);
});
