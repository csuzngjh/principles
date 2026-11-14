/**
 * S6 — one shared request budget per logical run.
 *
 * Characterization first: the three output paths keep their current
 * single-request success behavior and the tool → JSON → free-form fallback
 * chain keeps spending exactly one request per attempted path.
 *
 * Then the bounded behavior: a run whose three paths all fail must not spend
 * another three requests on the schema repair loop. D-01 later reserved exactly
 * one request for that loop (3 paths + 1 repair = 4), because the original cap
 * of 3 made the field-level repair prompt unreachable in the very case it was
 * written for. The budget is local to startRun (no new adapter config, no new
 * public interface); pi-ai's own transport retries are S2's and are
 * deliberately NOT counted here.
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
    /** PRI-1189: delay the NEXT wire request (used to walk the run clock past
     * the repair time budget). */
    delayMs: number;
  } = { requests: [], handler: null, delayMs: 0 };
  return state;
});

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const fetchingFetch: FetchFunction = async (input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const parsed: Record<string, unknown> = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    wire.requests.push({ url: String(input), body: parsed });
    if (wire.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, wire.delayMs));
    }
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
import { buildRootCauseProtocolInstruction } from '../../diagnostician/rootcause-prompt-builder.js';
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
  wire.delayMs = 0;
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
  wire.handler = null;
  wire.delayMs = 0;
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
  it('three failing paths still reserve one repair request (worst case 4, never 6)', async () => {
    let calls = 0;
    wire.handler = () => {
      calls += 1;
      // Paths 1 and 2 fail upstream of parsing; path 3 parses but violates
      // the schema, which is what starts the repair loop.
      return calls === 3 ? sseTextResponse('{}') : sseTextResponse('not json at all');
    };
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'tool_call_first', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });

    // D-01 (PD-NATIVE-STRICT-PRINCIPLE-CLOSURE-001): 3 output paths + exactly
    // one reserved repair request. Before the reserve, the repair loop always
    // saw `requestsLeft === 0` and the field-level feedback was unreachable;
    // before S6 the worst case was 6.
    expect(wire.requests).toHaveLength(4);
    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({
      repaired: false,
      attemptsUsed: 1,
      repairSkipReason: 'request_budget_exhausted',
      repairAttemptsSkippedByRequestBudget: 2,
    });
  });

  it('D-01: the persisted failure pack says why repair was skipped, not just "exhausted"', async () => {
    let calls = 0;
    wire.handler = () => {
      calls += 1;
      return calls === 3 ? sseTextResponse('{}') : sseTextResponse('not json at all');
    };
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });
    // `repair_exhausted` with an empty attempt list used to be the only record,
    // which reads as "we tried and failed". The skip reason must be persisted
    // with it so an operator can tell the two apart without reading telemetry.
    expect((error as { details?: { evidencePack?: Record<string, unknown> } }).details?.evidencePack).toMatchObject({
      repairSkipReason: 'request_budget_exhausted',
      repairAttemptsConfigured: 3,
      repairAttemptsSkippedByRequestBudget: 2,
    });
  });

  it('free-form path + the full configured repair ladder now fits exactly (1 + 3 = 4)', async () => {
    // D-01: the repair reserve moved the ceiling from 3 to 4, so a single
    // output path plus the maximum configured repair ladder is affordable and
    // no attempt is skipped for lack of a request.
    wire.handler = () => sseTextResponse('{}');
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput()).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });
    expect(wire.requests).toHaveLength(4); // 1 original + 3 repairs

    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({ repaired: false, attemptsUsed: 3 });
    expect(repairEvent?.payload).not.toHaveProperty('repairSkipReason');
    expect(repairEvent?.payload).not.toHaveProperty('repairAttemptsSkippedByRequestBudget');
  });

  it('PRI-1189: a repair request skipped by the remaining run time is not counted or sent', async () => {
    // 2500ms run budget. The initial free-form request fails schema validation;
    // the first repair response is delayed 1800ms, so the second repair window
    // sees < MIN_REPAIR_BUDGET_MS (1000ms) and must not send or consume.
    let calls = 0;
    wire.handler = () => {
      calls += 1;
      if (calls === 1) {
        // Let the initial request return immediately; delay the FIRST repair
        // response so the next repair window falls below the time budget.
        wire.delayMs = 1800;
        return sseTextResponse('{}');
      }
      return sseTextResponse('{}');
    };
    const { adapter, events } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput({ timeoutMs: 2500 })).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });
    // 1 original + 1 repair; the second repair was never sent.
    expect(wire.requests).toHaveLength(2);

    const repairEvent = events.find((event) => event.eventType === 'output_repair_attempted');
    expect(repairEvent?.payload).toMatchObject({
      repaired: false,
      attemptsUsed: 1,
      repairStoppedBeforeSend: true,
      repairSkipReason: 'budget_exhausted',
    });
  });

  it('D-01: a run without repair time persists `repair_skipped`, not `repair_exhausted`', async () => {
    // 2000ms run budget; the initial request takes 1300ms, leaving less than
    // MIN_REPAIR_BUDGET_MS (1000) when the repair decision is made. The loop is
    // skipped before sending, so the persisted reason must say "skipped" —
    // `repair_exhausted` with an empty attempt list reads as "tried and failed".
    wire.handler = () => sseTextResponse('{}');
    wire.delayMs = 1300; // delay the initial request, not a repair
    const { adapter } = makeAdapter({ outputPathStrategy: 'free_form_only', maxRepairAttempts: 3 });

    const error = await adapter.startRun(makeInput({ timeoutMs: 2000 })).catch((err: unknown) => err);

    expect(error).toMatchObject({ category: 'output_invalid' });
    expect(wire.requests).toHaveLength(1); // no repair request was sent
    expect((error as { details?: { evidencePack?: Record<string, unknown> } }).details?.evidencePack).toMatchObject({
      finalFailureReason: 'repair_skipped',
      repairSkipped: true,
      repairSkipReason: 'budget_exhausted',
      repairAttempts: [],
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

/**
 * D-01 regression — PD-NATIVE-STRICT-PRINCIPLE-CLOSURE-001.
 *
 * The malformed object below is the shape a real installed-runtime run emitted
 * for `diag-rootcause-output-v1` (lab evidence:
 * `evidence/pain/gate1-state-tasks.json`, `validationErrors` six missing
 * sub-fields + one unexpected `description`). It is replayed through the real
 * adapter → HTTP wire → validation → repair boundary, not through a helper.
 */
const DIAG_TASK_ID = 'diag_rootcause-diagnosis_pain_host_ebd93fb1254b625d5a1736fd10ab451999a10c7cfc16af58a1ac6428cd00c353';

const VALID_DIAG_ROOTCAUSE = {
  valid: true,
  diagnosisId: 'diagnosis_pain_host_ebd93fb1254b625d5a1736fd10ab451999a10c7cfc16af58a1ac6428cd00c353',
  taskId: DIAG_TASK_ID,
  summary: 'Agent 在未提供实测证据、未说明影响、未获 Owner 确认的情况下直接修改了 config/app.yaml 的 max_retries。',
  causalChain: [{
    why: 1,
    statement: '表面现象：Agent 直接写入了 config/app.yaml 的 max_retries。',
    evidenceRefs: ['signal_collector'],
  }],
  rootCause: 'Design: the Stage A prompt advertised intentTension as an untyped optional object.',
  rootCauseCategory: 'Design',
  evidence: [{ sourceRef: 'signal_collector', note: 'Owner correction captured by the automatic hook.' }],
  confidence: 0.9,
};

/** Verbatim shape from the failing run — the only defect is `intentTension`. */
const REAL_D01_MALFORMED_OUTPUT = {
  ...VALID_DIAG_ROOTCAUSE,
  intentTension: {
    description:
      "Agent 自主推断'修改配置即解决问题'与 Owner 要求的'证据先行 + 影响说明 + 明确确认后才可写入'存在张力；Owner 的决策权与确认权优先于 Agent 的自主行动偏好。",
  },
};

function makeDiagInput(): StartRunInput {
  return makeInput({
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    outputSchemaRef: 'diag-rootcause-output-v1',
  });
}

describe('D-01 — nested optional object shape and repair feedback', () => {
  it('the Stage A prompt advertises every sub-field the validator enforces on intentTension', async () => {
    // The production Stage A prompt builder is the boundary that actually
    // carries the schema description to the model.
    const prompt = buildRootCauseProtocolInstruction();

    // Before the fix the prompt said only `intentTension: object (optional)`.
    expect(prompt).toContain('intentTension: object (optional)');
    expect(prompt).toContain('.source: enum(none | action_drift | intent_suspect | healthy_tension) (required)');
    expect(prompt).toContain('.evidenceStrength: enum(weak | moderate | strong) (required)');
    // D-01 review: the validator constrains this to five literal values; the
    // prompt used to say `unknown[]` and hide all five.
    expect(prompt).toContain(
      '.relatedIntentFields: enum(why | desired_outcome | non_negotiables | stop_escalation | current_strategic_focus)[] (required)',
    );
    // D-01 review: array bounds are part of the enforced shape.
    expect(prompt).toContain('.evidence: string[] {maxItems: 3} (required)');
    expect(prompt).toMatch(/\.explanation: string\b[^\n]*\(required\)/);
    expect(prompt).toContain(
      '.suggestedOwnerAction: enum(confirm_drift | revise_intent | observe | dismiss | promote_to_principle | promote_to_rulehost) (required)',
    );
    // D-01 review: array-of-object fields must not collapse to `object[]`.
    // `causalChain` items are objects with required sub-fields; the prompt now
    // expands them at the same depth bound instead of pretending `object[]`
    // is the shape.
    expect(prompt).toContain('causalChain: object[] (required)');
    expect(prompt).toContain('.why: number {min: 1, max: 5} (required)');
    expect(prompt).toContain('.evidenceRefs: string[] {minItems: 1} (required)');
  });

  it('replays the real malformed output and repairs it with field-level feedback', async () => {
    let call = 0;
    wire.handler = () => {
      call += 1;
      // Paths 1–3 all reproduce the recorded wrong shape; path 4 is the repair.
      return call <= 3
        ? sseTextResponse(JSON.stringify(REAL_D01_MALFORMED_OUTPUT))
        : sseTextResponse(JSON.stringify(VALID_DIAG_ROOTCAUSE));
    };
    const { adapter } = makeAdapter({ outputPathStrategy: 'tool_call_first', maxRepairAttempts: 3 });

    const handle = await adapter.startRun(makeDiagInput());
    const output = await adapter.fetchOutput(handle.runId);

    expect(output?.payload).toMatchObject({ rootCauseCategory: 'Design', confidence: 0.9 });
    expect(wire.requests).toHaveLength(4);

    // The repair request must carry the concrete field errors — this is the
    // feedback the old budget made unreachable.
    const repairPrompt = JSON.stringify(wire.requests[3]?.body);
    expect(repairPrompt).toContain('- /intentTension/source: Expected required property');
    expect(repairPrompt).toContain('/intentTension/description');
    expect(repairPrompt).toContain('Unexpected property');
  });
});
