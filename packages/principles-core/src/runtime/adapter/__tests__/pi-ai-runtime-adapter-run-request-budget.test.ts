/**
 * S6 — one shared request budget per logical run.
 *
 * Characterization first: the three output paths keep their current
 * single-request success behavior and the tool → JSON → free-form fallback
 * chain keeps spending exactly one request per attempted path.
 *
 * Then the bounded behavior: a run whose three paths all fail must not spend
 * another three requests on the schema repair loop. The budget is local to
 * startRun (no new adapter config, no new public interface); pi-ai's own
 * transport retries are S2's and are deliberately NOT counted here.
 *
 * The wire is the real serialized HTTP body (same harness as
 * pi-ai-runtime-adapter-budget-wire.test.ts): transport module mocked, every
 * other layer real.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';

type WireHandler = (body: Record<string, unknown>, url: string) => Response;

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
    const { handler } = wire;
    if (!handler) throw new Error('run-request-budget test bug: no wire handler armed');
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
import { Value } from '@sinclair/typebox/value';
import type { StartRunInput } from '../../runtime-protocol.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';

const API_KEY_ENV = 'S6_RUN_REQUEST_BUDGET_KEY';
const DUMMY_KEY = 'offline-dummy-key-not-a-credential';

const VALID_ACTION_JSON = JSON.stringify({ type: 'proceed' });

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
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_s6_1', type: 'function', function: { name: toolName, arguments: argsJson } }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
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
    taskRef: { taskId: 's6-run-budget-1' },
    inputPayload: 'Respond with one action.',
    contextItems: [],
    timeoutMs: 20_000,
    outputSchemaRef: LEARNING_LAB_ACTOR_ACTION_REF,
    ...overrides,
  };
}

beforeEach(() => {
  process.env[API_KEY_ENV] = DUMMY_KEY;
  wire.requests = [];
  wire.handler = null;
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
  wire.handler = null;
});

describe('S6 characterization — one request per successful path', () => {
  it('tool-call path success costs 1 request', async () => {
    wire.handler = () => sseToolCallResponse('record_learning_lab_actor_action', VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first' });

    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('json-schema path success costs 1 request', async () => {
    wire.handler = () => sseTextResponse(VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'json_mode_first' });

    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('free-form path success costs 1 request', async () => {
    wire.handler = () => sseTextResponse(VALID_ACTION_JSON);
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only' });

    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(1);
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('tool → json → free-form fallback chain spends exactly 3 requests', async () => {
    // Path 1: plain text (no tool call) → fallback. Path 2: unparseable text
    // → fallback. Path 3: valid action JSON → success.
    let call = 0;
    wire.handler = () => {
      call += 1;
      if (call === 1) return sseTextResponse('no tool call here');
      if (call === 2) return sseTextResponse('not json at all');
      return sseTextResponse(VALID_ACTION_JSON);
    };
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first' });

    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(3);
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });

  it('repair still runs while budget remains (free-form: 1 original + 1 repair = 2 requests)', async () => {
    let call = 0;
    wire.handler = () => {
      call += 1;
      return call === 1 ? sseTextResponse('{}') : sseTextResponse(VALID_ACTION_JSON);
    };
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 1 });

    const handle = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(wire.requests).toHaveLength(2);
    expect(Value.Check(LearningLabActorActionV1Schema, output?.payload)).toBe(true);
  });
});

describe('S6 shared budgeting — worst case is capped for the whole run', () => {
  it('three failing paths + schema repair never exceed 3 PD requests', async () => {
    let calls = 0;
    wire.handler = () => {
      calls += 1;
      // Paths 1 and 2 fail upstream of parsing; path 3 parses but violates
      // the schema, which is what would normally start the repair loop.
      return calls === 3 ? sseTextResponse('{}') : sseTextResponse('not json at all');
    };
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first', maxRepairAttempts: 3 });

    await expect(adapter.startRun(makeInput())).rejects.toMatchObject({
      category: 'output_invalid',
    });

    // Before S6 this run sent 6 requests: 1 tool + 1 JSON + 1 free-form
    // + 3 repair attempts. The shared budget stops at 3.
    expect(wire.requests).toHaveLength(3);
  });

  it('exhausted budget reports a structured reason instead of a bare failure', async () => {
    let calls = 0;
    wire.handler = () => {
      calls += 1;
      return calls === 3 ? sseTextResponse('{}') : sseTextResponse('not json at all');
    };
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'tool_call_first', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });

    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({
      repaired: false,
      attemptsUsed: 0,
      repairSkipped: true,
      repairSkipReason: 'request_budget_exhausted',
      repairAttemptsSkippedByRequestBudget: 3,
    });
  });

  it('records the attempts skipped mid-repair by the request budget (configured 3, only 2 affordable)', async () => {
    // Budget 3, spent 1 on the free-form path → 2 left. Configured repair
    // attempts: 3. The loop can only start 2, so the 3rd is skipped for lack
    // of a request, not because repair was disabled.
    wire.handler = () => sseTextResponse('{}');
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });
    expect(wire.requests).toHaveLength(3); // 1 original + 2 repair

    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({
      repaired: false,
      attemptsUsed: 2,
      repairSkipReason: 'request_budget_exhausted',
      repairAttemptsSkippedByRequestBudget: 1,
    });
    // The loop did run, so "repair was skipped" stays false/absent.
    expect(repairEvent?.payload).not.toHaveProperty('repairSkipped');

    const exhaustedEvent = events.find((event) => event.eventType === 'output_repair_exhausted');
    expect(exhaustedEvent?.payload).toMatchObject({
      repairSkipReason: 'request_budget_exhausted',
      repairAttemptsSkippedByRequestBudget: 1,
    });
  });

  it('records no budget skip when repair completes inside the remaining budget', async () => {
    let call = 0;
    wire.handler = () => {
      call += 1;
      return call === 1 ? sseTextResponse('{}') : sseTextResponse(VALID_ACTION_JSON);
    };
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 3 });

    await adapter.startRun(makeInput());

    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({ repaired: true, attemptsUsed: 1 });
    expect(repairEvent?.payload).not.toHaveProperty('repairSkipReason');
    expect(repairEvent?.payload).not.toHaveProperty('repairAttemptsSkippedByRequestBudget');
    expect(events.some((event) => event.eventType === 'output_repair_exhausted')).toBe(false);
  });
});
