/**
 * PRI-966 G2 — PiAiRuntimeAdapter budget-contract additions:
 *   P1-01: config.fetch override is applied at EVERY completeSimple boundary
 *          (an external budget ledger must intercept the real outbound wire);
 *   P1-03: runtime_invocation_succeeded telemetry carries the ACTUAL usage
 *          from the provider response that produced the output (null fields —
 *          never guessed — when the provider surfaced nothing).
 *
 * Offline: the transport module is mocked (same interception point as the AC-6
 * wire harness); pi-ai itself is REAL. No network, no keys.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';

type CapturedRequest = { url: string; init: Parameters<FetchFunction>[1] };

const transportMock = vi.hoisted(() => {
  const state: { calls: CapturedRequest[]; handler: ((body: Record<string, unknown>, url: string) => Response) | null; defaultCalls: number } = {
    calls: [],
    handler: null,
    defaultCalls: 0,
  };
  return state;
});

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const capturing: FetchFunction = async (input, init) => {
    transportMock.calls.push({ url: String(input), init });
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: Record<string, unknown> = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    const {handler} = transportMock;
    if (!handler) throw new Error('g2-budget test bug: no wire handler armed');
    return handler(parsed, String(input));
  };
  return {
    ...actual,
    getPiAiFetchForApi: ((_api: string | undefined) => {
      transportMock.defaultCalls += 1;
      return capturing;
    }) as unknown,
  };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const API_KEY_ENV = 'G2_BUDGET_CONTRACT_KEY';
const DUMMY_KEY = 'offline-dummy-not-a-credential';

function sseText(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  const chunks: Record<string, unknown>[] = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
  ];
  chunks.push(
    usage
      ? { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
      : { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  );
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
    taskRef: { taskId: 'g2-budget-contract' },
    inputPayload: 'Respond with one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

interface AdapterBundle {
  adapter: PiAiRuntimeAdapter;
  events: TelemetryEvent[];
}

function makeAdapter(overrides: Record<string, unknown> = {}): AdapterBundle {
  const events: TelemetryEvent[] = [];
  const emitter = new StoreEventEmitter();
  emitter.onTelemetry((event) => events.push(event));
  const adapter = new PiAiRuntimeAdapter({
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKeyEnv: API_KEY_ENV,
    maxRetries: 0,
    outputPathStrategy: 'free_form_only',
    timeoutMs: 30_000,
    eventEmitter: emitter,
    ...overrides,
  });
  return { adapter, events };
}

beforeEach(() => {
  process.env[API_KEY_ENV] = DUMMY_KEY;
  transportMock.calls = [];
  transportMock.handler = null;
  transportMock.defaultCalls = 0;
});

describe('P1-01: config.fetch override at every completeSimple boundary', () => {
  it('the override runs the run’s requests INSTEAD of the default transport (ledger interception point)', async () => {
    transportMock.handler = () => sseText('{"policyText":"ok"}', { prompt_tokens: 11, completion_tokens: 4 });
    const overrideCalls: CapturedRequest[] = [];
    const override: FetchFunction = async (input, init) => {
      overrideCalls.push({ url: String(input), init });
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      void JSON.parse(rawBody);
      return sseText('{"policyText":"ok"}', { prompt_tokens: 11, completion_tokens: 4 });
    };
    const { adapter } = makeAdapter({ fetch: override, maxTokens: 512 });
    const handle = await adapter.startRun(makeInput({ maxTokens: 512 }));
    await adapter.fetchOutput(handle.runId);

    expect(overrideCalls).toHaveLength(1); // the override carried the request
    expect(transportMock.defaultCalls).toBe(0); // the default transport was NEVER consulted
    const [first] = overrideCalls;
    if (first === undefined) throw new Error('unreachable: overrideCalls.length === 1 asserted');
    const rawBody = String(first.init?.body ?? '{}');
    expect(JSON.parse(rawBody).max_tokens).toBe(512); // budget reaches the wire through the override
  });
});

describe('P1-03: success telemetry carries actual provider usage (honest nulls)', () => {
  it('free-form path: usage from the producing response lands in runtime_invocation_succeeded', async () => {
    transportMock.handler = () => sseText('{"policyText":"measured"}', { prompt_tokens: 42, completion_tokens: 17 });
    const { adapter, events } = makeAdapter();
    const handle = await adapter.startRun(makeInput());
    await adapter.fetchOutput(handle.runId);
    const succeeded = events.find((event) => event.eventType === 'runtime_invocation_succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded?.payload.usage).toEqual({ inputTokens: 42, outputTokens: 17, source: 'adapter_response_usage' });
  });

  it('a response without usage surfaces null — never a guessed number', async () => {
    transportMock.handler = () => sseText('{"policyText":"no counts"}');
    const { adapter, events } = makeAdapter();
    const handle = await adapter.startRun(makeInput());
    await adapter.fetchOutput(handle.runId);
    const succeeded = events.find((event) => event.eventType === 'runtime_invocation_succeeded');
    expect(succeeded?.payload.usage).toBeNull();
  });
});
