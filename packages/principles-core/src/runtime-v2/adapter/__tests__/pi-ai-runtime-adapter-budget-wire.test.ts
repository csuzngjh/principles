/**
 * PRI-966 G2 — per-request output-budget (StartRunInput.maxTokens) wire tests.
 *
 * Proves the per-request budget travels the FULL chain — transport options →
 * pi-ai request builder → SERIALIZED HTTP BODY — not merely that the options
 * bag reaches the pi-ai facade. The pi-ai HTTP transport module is mocked with
 * a capturing fetch (the same interception point the AC-6 wire harness uses);
 * everything else is REAL: model resolution (sensenova + baseUrl borrows the
 * catalog entry), SSE parsing, all three output paths, the repair loop and the
 * PRI-1011 budget-downshift ladder. Zero network, zero API keys, zero cost.
 *
 * Budget contract under test:
 *   effective = min(StartRunInput.maxTokens, profile config.maxTokens, model ceiling)
 *   - per-request value is a hard cap for the run's requests;
 *   - absent per-request value ⇒ byte-identical legacy behavior
 *     (profile value, or pi-ai native defaulting = model.maxTokens);
 *   - invalid values fail loud (input_invalid) BEFORE any request;
 *   - a provider rejection downshifts from the per-request value (no regression).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { FetchFunction } from '@earendil-works/pi-ai';

type WireHandler = (body: Record<string, unknown>, url: string) => Response;

// Module-level capture state, re-armed per test.
const wire = vi.hoisted(() => {
  const state: {
    requests: { url: string; body: Record<string, unknown> }[];
    handler: WireHandler | null;
  } = { requests: [], handler: null };
  return state;
});

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const fetchingFetch: FetchFunction = async (input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: Record<string, unknown> = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    wire.requests.push({ url: String(input), body: parsed });
    const {handler} = wire;
    if (!handler) throw new Error('budget-wire test bug: no wire handler armed');
    return handler(parsed, String(input));
  };
  return {
    ...actual,
    getPiAiFetchForApi: () => fetchingFetch,
  };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import {
  LearningLabActorActionV1Schema,
  LEARNING_LAB_ACTOR_ACTION_REF,
} from '../../learning-lab/actor-action-output.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';

const API_KEY_ENV = 'LAB_BUDGET_WIRE_TEST_KEY';
const DUMMY_KEY = 'offline-dummy-key-not-a-credential';

/** SSE response builders (the OpenAI SDK client inside pi-ai parses these). */
function sseTextResponse(text: string): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseToolCallResponse(toolName: string, argsJson: string): Response {
  const chunks = [
    {
      choices: [{
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_budget_1', type: 'function', function: { name: toolName, arguments: argsJson } }] },
        finish_reason: null,
      }],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A provider rejection of the requested output budget (PRI-1011 trigger). */
function budgetRejectionResponse(requested: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Invalid request: requested max_tokens (${requested}) exceeds the maximum output tokens allowed for this model`,
        type: 'invalid_request_error',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

interface StartedAdapter {
  adapter: PiAiRuntimeAdapter;
  events: TelemetryEvent[];
}

function makeAdapter(overrides: Record<string, unknown> = {}): StartedAdapter {
  const events: TelemetryEvent[] = [];
  const emitter = new StoreEventEmitter();
  emitter.onTelemetry((event) => events.push(event));
  const adapter = new PiAiRuntimeAdapter({
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKeyEnv: API_KEY_ENV,
    maxRetries: 0,
    timeoutMs: 30_000,
    eventEmitter: emitter,
    ...overrides,
  });
  return { adapter, events };
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'learning-lab-actor', schemaVersion: 'v1' },
    taskRef: { taskId: 'budget-wire-1' },
    inputPayload: 'Respond with one action.',
    contextItems: [],
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Canned valid Learning Lab actor action (matches the registered schema). */
const VALID_ACTION_JSON = JSON.stringify({ type: 'proceed' });

beforeEach(() => {
  process.env[API_KEY_ENV] = DUMMY_KEY;
  wire.requests = [];
  wire.handler = null;
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
  wire.handler = null;
});

describe('per-request output budget reaches the serialized HTTP wire (PRI-966 G2)', () => {
  it('actor action round: 512 lands on the tool-call path request (tool_choice required, registered tool declared)', async () => {
    wire.handler = () => sseToolCallResponse('record_learning_lab_actor_action_v1', VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first' });
    const handle = await adapter.startRun(makeInput({ outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF, maxTokens: 512 }));
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    const [{ url, body }] = wire.requests;
    expect(url.endsWith('/chat/completions')).toBe(true);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(512); // ← the wire value, not just the options bag
    expect(body.tool_choice).toBe('required'); // proof this is the tool-call path
    const tools = body.tools as { function?: { name?: string } }[];
    expect(tools?.[0]?.function?.name).toBe('record_learning_lab_actor_action_v1');
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('actor action round: 512 lands on the json_schema path request (response_format json_schema)', async () => {
    wire.handler = () => sseTextResponse(VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'json_mode_first' });
    const handle = await adapter.startRun(makeInput({ outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF, maxTokens: 512 }));
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    const [{ body }] = wire.requests;
    expect(body.max_tokens).toBe(512);
    const responseFormat = body.response_format as { type?: string };
    expect(responseFormat?.type).toBe('json_schema'); // proof this is the json path
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('I0 reflection: 1024 lands on the free-form path request (no outputSchemaRef)', async () => {
    wire.handler = () => sseTextResponse('{"policyText":"[EA] targeted check first."}');
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only' });
    const handle = await adapter.startRun(makeInput({ maxTokens: 1024 }));
    await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    const [{ body }] = wire.requests;
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format).toBeUndefined(); // free-form path, no structured-output rewrite
  });

  it('repair attempt carries the same per-request budget as the initial request', async () => {
    const responses = [
      sseTextResponse('{}'), // parses as JSON but fails the action schema → repair
      sseTextResponse(VALID_ACTION_JSON), // repair response
    ];
    let call = 0;
    wire.handler = () => responses[Math.min(call++, responses.length - 1)];
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only' });
    const handle = await adapter.startRun(makeInput({ outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF, maxTokens: 512 }));
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests.length).toBeGreaterThanOrEqual(2); // initial + at least one repair call
    for (const request of wire.requests) {
      expect(request.body.max_tokens).toBe(512); // every request of the run, repair included
    }
    const second = wire.requests[1].body.messages as { content: unknown }[];
    const first = wire.requests[0].body.messages as { content: unknown }[];
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first)); // genuinely the repair prompt
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('backward compat: absent per-request budget keeps legacy behavior — native ceiling 384000 on the borrowed catalog model', async () => {
    // deepseek-v4-flash via a custom baseUrl borrows the opencode-go catalog
    // entry (maxTokens 384000) — pi-ai native defaulting sends model.maxTokens.
    // This is exactly the AC-6 cost-guard finding, now pinned as a test.
    wire.handler = () => sseTextResponse('{"policyText":"legacy"}');
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only' });
    const handle = await adapter.startRun(makeInput()); // NO maxTokens, NO config.maxTokens
    await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0].body.max_tokens).toBe(384000);
  });

  it('backward compat: absent per-request budget still applies the profile config.maxTokens', async () => {
    wire.handler = () => sseTextResponse('{"policyText":"legacy-profile"}');
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only', maxTokens: 8000 });
    const handle = await adapter.startRun(makeInput()); // NO input.maxTokens
    await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0].body.max_tokens).toBe(8000);
  });

  it('priority: per-request caps the run even when the profile budget is larger (512 over config 4096)', async () => {
    wire.handler = () => sseTextResponse(VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'json_mode_first', maxTokens: 4096 });
    const handle = await adapter.startRun(makeInput({ outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF, maxTokens: 512 }));
    await adapter.fetchOutput(handle.runId);
    expect(wire.requests[0].body.max_tokens).toBe(512);
  });

  it('priority: the profile config still wins over a larger per-request value (config 4096 over 8192, free-form path)', async () => {
    wire.handler = () => sseTextResponse('{"policyText":"profile wins"}');
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only', maxTokens: 4096 });
    const handle = await adapter.startRun(makeInput({ maxTokens: 8192 }));
    await adapter.fetchOutput(handle.runId);
    expect(wire.requests[0].body.max_tokens).toBe(4096);
  });

  it('priority: the model output ceiling wins over a huge per-request value (384000 over 900000, tool-call path)', async () => {
    wire.handler = () => sseToolCallResponse('record_learning_lab_actor_action_v1', VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first' });
    const handle = await adapter.startRun(makeInput({ outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF, maxTokens: 900_000 }));
    await adapter.fetchOutput(handle.runId);
    expect(wire.requests[0].body.max_tokens).toBe(384000);
  });

  it.each([0, -5, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'invalid per-request budget %p fails loud as input_invalid BEFORE any request is built',
    async (bad) => {
      const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only' });
      await expect(adapter.startRun(makeInput({ maxTokens: bad }))).rejects.toMatchObject({
        category: 'input_invalid',
      });
      expect(wire.requests).toHaveLength(0); // nothing reached the wire
    },
  );

  it('a provider budget rejection downshifts from the per-request value (PRI-1011, no classification regression)', async () => {
    // 8192 sits above the PRI-1011 ladder floor (MIN_MAX_TOKENS_BUDGET = 4096),
    // so the halving step is legal: 8192 -> 4096 — and both values come from
    // the PER-REQUEST budget, not from the profile (unset) or the native
    // ceiling (384000 -> 192000, which would prove the ladder ignored it).
    let call = 0;
    wire.handler = (_body, _url) => {
      call += 1;
      return call === 1 ? budgetRejectionResponse(8192) : sseTextResponse('{"policyText":"after downshift"}');
    };
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRetries: 1, _testBackoffDelayMs: 0 });
    const handle = await adapter.startRun(makeInput({ maxTokens: 8192 }));
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(2);
    expect(wire.requests[0].body.max_tokens).toBe(8192); // original per-request value
    expect(wire.requests[1].body.max_tokens).toBe(4096); // halved by the ladder
    expect(output).toBeDefined();
    const downshift = events.find((event) => event.eventType === 'llm_max_tokens_downshift');
    expect(downshift).toBeDefined();
    expect(downshift?.payload.fromMaxTokens).toBe(8192);
    expect(downshift?.payload.toMaxTokens).toBe(4096);
    // Classification evidence stays on the budget-rejection signature (not rate_limit):
    expect(String(downshift?.payload.providerEvidence)).toContain('exceeds the maximum output tokens');
  });
});
