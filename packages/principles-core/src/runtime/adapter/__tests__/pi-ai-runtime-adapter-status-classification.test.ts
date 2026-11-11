/**
 * Phase-1 stability (S3): provider failures are classified by HTTP status code,
 * not by keyword matching on the error body.
 *
 * pi-ai 1.2 drops the structured status when it converts a provider failure
 * into `stopReason:'error'`, but its `formatProviderError` composes the message
 * as `<status>: <body>`. The adapter therefore recovers the status from that
 * prefix and classifies:
 *   401/403 → input_invalid (configuration)
 *   400/422 → input_invalid (request)
 *   408     → timeout
 *   429     → rate_limit
 *   5xx     → execution_failed (upstream)
 *
 * Red-before-green evidence:
 *   - Before S3 a 401 whose body said "quota exceeded" matched the text rule
 *     `quota` and was misreported as `rate_limit`; a 429 whose body said
 *     "invalid request" was misreported as `execution_failed`.
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
    if (!entry) throw new Error(`status-classification test bug: no response planned for request #${index}`);
    return new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  };
  return { ...actual, getPiAiFetchForApi: () => plannedFetch };
});

import { PiAiRuntimeAdapter, extractProviderHttpStatus } from '../pi-ai-runtime-adapter.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const API_KEY_ENV = 'PI_AI_STATUS_CLASSIFICATION_TEST_KEY';

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
    taskRef: { taskId: 'status-classification-1' },
    inputPayload: 'Return one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

function errorEntry(status: number, message: string): { status: number; body: string } {
  return { status, body: JSON.stringify({ error: { message, type: 'invalid_request_error' } }) };
}

async function startAndCatch(adapter: PiAiRuntimeAdapter): Promise<PDRuntimeError> {
  try {
    await adapter.startRun(makeInput());
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

describe('PiAiRuntimeAdapter — S3 status-code error classification', () => {
  it('classifies a 401 as a configuration error even when the body says "quota exceeded"', async () => {
    wire.plan = [errorEntry(401, 'quota exceeded')];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter);

    // RED (before S3): the `quota` text rule won and reported rate_limit.
    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.httpStatus).toBe(401);
    expect(caught.details?.errorClassificationSource).toBe('status_code');
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('classifies a 400 as a request error and does not trigger a budget downshift', async () => {
    wire.plan = [errorEntry(400, 'invalid field: messages[0].content')];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter);

    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.httpStatus).toBe(400);
    expect(caught.details?.errorClassificationSource).toBe('status_code');
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('classifies a 429 as rate_limit even when the body looks like a request error', async () => {
    wire.plan = [errorEntry(429, 'invalid request')];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter);

    // RED (before S3): no rate-limit keyword matched, so this became
    // execution_failed.
    expect(caught.category).toBe('rate_limit');
    expect(caught.details?.httpStatus).toBe(429);
    expect(caught.details?.errorClassificationSource).toBe('status_code');
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('classifies a 5xx as an upstream execution failure even when the body says "quota exceeded"', async () => {
    wire.plan = [errorEntry(503, 'quota exceeded')];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter);

    // RED (before S3): misreported as rate_limit.
    expect(caught.category).toBe('execution_failed');
    expect(caught.details?.httpStatus).toBe(503);
    expect(caught.details?.errorClassificationSource).toBe('status_code');
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('does not treat a parenthesized number in free-form error text as an HTTP status', () => {
    // pi-ai normally prefixes the composed message with the status
    // (`"<status>: <body>"`), which the leading rule handles. The bug is only
    // reachable when a message arrives without that prefix — Anthropic-style
    // SDK errors return `message` verbatim — and the text happens to contain
    // something like "(500)". That number is not a provider status, so the
    // evidence must stay `status_unknown`/`text_fallback`.
    //
    // The wire-level suite above cannot construct this: every response path
    // through pi-ai carries the status prefix. The recovery function is
    // therefore exercised directly rather than pretending a reachable HTTP
    // fixture proves it.
    expect(extractProviderHttpStatus('socket closed (500) unexpectedly')).toBeUndefined();
    expect(extractProviderHttpStatus('API error (400): invalid field')).toBe(400);
    expect(extractProviderHttpStatus('429: rate limited')).toBe(429);
  });

  it('keeps the status-code category when the provider body also contains "timeout"', async () => {
    // The status-code path already classified this 400 as input_invalid. The
    // outer catch used to re-run the text heuristic on the composed message,
    // see "timeout", and overwrite the category.
    wire.plan = [errorEntry(400, 'invalid parameter: timeout')];

    const adapter = makeAdapter({ maxRetries: 0 });
    const caught = await startAndCatch(adapter);

    // RED (before reordering the catch): reported timeout, losing both the
    // status-code classification and the original details.
    expect(caught.category).toBe('input_invalid');
    expect(caught.details?.httpStatus).toBe(400);
    expect(caught.details?.errorClassificationSource).toBe('status_code');
    expect(wire.requests.length).toBe(1);
  }, 20_000);
});
