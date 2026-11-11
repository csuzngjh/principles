/**
 * Phase-1 stability (S4): context overflow is identified, never guessed.
 *
 * Two layers:
 *   1. pre-flight — the assembled request is estimated against the model's own
 *      context window before a request is spent, and an oversized request fails
 *      loud with `contextOverflow` + `nextAction` instead of being sent;
 *   2. post-failure — pi-ai's `isContextOverflow` patterns classify a provider
 *      rejection as an input-size problem rather than a transient/upstream one.
 *
 * Red-before-green evidence: before S4 an oversized payload was sent to the
 * wire (the adapter had no budget at all) and a provider "prompt is too long"
 * rejection surfaced as `execution_failed`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';

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
    if (!entry) throw new Error(`context-budget test bug: no response planned for request #${index}`);
    return new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  };
  return { ...actual, getPiAiFetchForApi: () => plannedFetch };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import { resolveContextBudget } from '../context-budget.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const API_KEY_ENV = 'PI_AI_CONTEXT_BUDGET_TEST_KEY';

function makeAdapter(overrides: Record<string, unknown> = {}): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'custom-openai-compatible',
    // Unknown model id → resolveModel falls back to contextWindow 128000.
    model: 'unknown-context-budget-test-model',
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnv: API_KEY_ENV,
    timeoutMs: 30_000,
    outputPathStrategy: 'free_form_only',
    ...overrides,
  });
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
    taskRef: { taskId: 'context-budget-1' },
    inputPayload: 'Return one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

async function startAndCatch(adapter: PiAiRuntimeAdapter, input: StartRunInput): Promise<PDRuntimeError> {
  try {
    await adapter.startRun(input);
  } catch (err) {
    if (err instanceof PDRuntimeError) return err;
    throw err;
  }
  throw new Error('expected startRun to reject');
}

beforeEach(() => {
  process.env[API_KEY_ENV] = 'offline-dummy-key-not-a-credential';
  wire.requests = [];
  wire.plan = [];
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
});

describe('PiAiRuntimeAdapter — S4 context budget', () => {
  it('rejects an oversized request before spending it, with a structured overflow reason', async () => {
    // ~142_857 estimated tokens vs a 115_200 budget (128k window * 0.9).
    const input = makeInput({ inputPayload: 'x'.repeat(500_000) });

    const adapter = makeAdapter();
    const caught = await startAndCatch(adapter, input);

    // RED (before S4): the request was sent (1 wire request) and the provider
    // would have been the one to reject it.
    expect(wire.requests.length).toBe(0);
    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.contextOverflow).toBe(true);
    expect(caught.details?.contextWindowTokens).toBe(128_000);
    expect(caught.details?.nextAction).toBe('reduce_context');
    expect(Number(caught.details?.estimatedInputTokens)).toBeGreaterThan(
      Number(caught.details?.budgetTokens),
    );
  }, 20_000);

  it('classifies a provider "prompt is too long" rejection as a context overflow, not execution_failed', async () => {
    wire.plan = [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: 'prompt is too long: 200000 tokens > 128000 maximum' },
        }),
      },
    ];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter, makeInput());

    // RED (before S4): surfaced as execution_failed with no next action.
    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.contextOverflow).toBe(true);
    expect(caught.details?.contextWindowTokens).toBe(128_000);
    expect(caught.details?.nextAction).toBe('reduce_context');
    expect(caught.details?.finalFailureReason).toBe('context_overflow');
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('does not call an unrelated provider rejection a context overflow', async () => {
    wire.plan = [
      {
        status: 400,
        body: JSON.stringify({ error: { message: 'invalid field: messages[0].content' } }),
      },
    ];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter, makeInput());

    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.contextOverflow).toBeUndefined();
    expect(caught.details?.nextAction).toBeUndefined();
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('subtracts the output reservation from the window before applying the soft ratio', () => {
    // 128k window with 115.2k reserved for output leaves 12.8k input tokens,
    // 90% of which is 11_520. Taking 90% of the window first (115_200) and
    // subtracting the reservation collapses to 0 and then gets clamped to the
    // 1_024 floor — a budget that rejects requests the window can hold.
    expect(resolveContextBudget(128_000, 115_200)).toEqual({
      contextWindowTokens: 128_000,
      reserveOutputTokens: 115_200,
      budgetTokens: 11_520,
    });

    // A reservation that consumes the whole window leaves no input budget. It
    // must be reported as 0, not disguised as 1_024.
    expect(resolveContextBudget(128_000, 128_000).budgetTokens).toBe(0);
  });

  it('does not reject a 4k-char request when the window still has input tokens', async () => {
    // Guard for the adapter-level consequence of the budget arithmetic: with
    // a 115.2k output reservation the model ceiling (32k for an unknown model)
    // caps the reservation, so this request must reach the wire.
    const input = makeInput({ inputPayload: 'x'.repeat(4_000), maxTokens: 115_200 });
    wire.plan = [{ status: 500, body: JSON.stringify({ error: { message: 'planned stop' } }) }];

    const adapter = makeAdapter({ maxRetries: 0 });
    let caught: PDRuntimeError | undefined;
    try {
      await adapter.startRun(input);
    } catch (err) {
      caught = err instanceof PDRuntimeError ? err : undefined;
    }

    expect(caught?.details?.contextOverflow).toBeUndefined();
    expect(wire.requests.length).toBe(1);
  }, 20_000);
});
