/**
 * Phase-1 stability (S5): the adaptive principle selector's output contract is
 * registered in OUTPUT_SCHEMA_REGISTRY, so the runtime adapter validates the
 * selector answer like every other structured runner instead of returning
 * whatever JSON the model produced.
 *
 * Red-before-green: before S5 `adaptive-selection-output` was not registered,
 * so this ref failed as `Unknown outputSchemaRef`; after S5 the same ref
 * resolves to a union schema and a `{status:'selected'}` answer without
 * id/digest is rejected as a schema violation (repair exhausted), while a
 * complete answer passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';

const wire = vi.hoisted(() => ({
  requests: [] as { url: string }[],
  plan: [] as { status: number; body: string }[],
}));

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const plannedFetch: FetchFunction = async (input) => {
    const index = wire.requests.length;
    wire.requests.push({ url: String(input) });
    const entry = wire.plan[index];
    if (!entry) throw new Error(`selection-schema test bug: no response planned for request #${index}`);
    return new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.status < 300 ? 'text/event-stream' : 'application/json' },
    });
  };
  return { ...actual, getPiAiFetchForApi: () => plannedFetch };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import { PDRuntimeError } from '../../error-categories.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import { resolveOutputSchema } from '../output-schema-registry.js';

const API_KEY_ENV = 'PI_AI_SELECTION_SCHEMA_TEST_KEY';

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

function makeAdapter(): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKeyEnv: API_KEY_ENV,
    maxRetries: 0,
    maxRepairAttempts: 0,
    timeoutMs: 30_000,
    outputPathStrategy: 'free_form_only',
  });
}

function makeInput(): StartRunInput {
  return {
    agentSpec: { agentId: 'adaptive-principle-selector', schemaVersion: 'current' },
    taskRef: { taskId: 'selection-schema-1' },
    inputPayload: 'Return one selection.',
    contextItems: [],
    outputSchemaRef: 'adaptive-selection-output',
    timeoutMs: 20_000,
  };
}

beforeEach(() => {
  process.env[API_KEY_ENV] = 'offline-dummy-key-not-a-credential';
  wire.requests = [];
  wire.plan = [];
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
});

describe('PiAiRuntimeAdapter — S5 adaptive selection schema', () => {
  it('registers the ref instead of failing it as unknown', () => {
    // RED (before S5): undefined → the adapter threw Unknown outputSchemaRef.
    expect(resolveOutputSchema('adaptive-selection-output')).toBeDefined();
  });

  it('rejects a "selected" answer that is missing id and digest', async () => {
    wire.plan = [sseAnswer('{"status":"selected"}')];

    const adapter = makeAdapter();
    let caught: PDRuntimeError | undefined;
    try {
      await adapter.startRun(makeInput());
    } catch (err) {
      if (err instanceof PDRuntimeError) caught = err;
      else throw err;
    }

    expect(caught).toBeDefined();
    expect(caught?.category).toBe('output_invalid');
    // The failure must come from schema validation, not from an unregistered ref.
    expect(caught?.details?.parseFailureReason).not.toBe('unknown_output_schema_ref');
    expect(caught?.details?.evidencePack).toMatchObject({
      schemaRef: 'adaptive-selection-output',
      finalFailureReason: 'repair_exhausted',
    });
    expect(wire.requests.length).toBe(1);
  }, 20_000);

  it('accepts a complete selection answer', async () => {
    const payload = {status: 'selected', id: 'candidate-ref-1', digest: 'd'.repeat(64)};
    wire.plan = [sseAnswer(JSON.stringify(payload))];

    const adapter = makeAdapter();
    const run = await adapter.startRun(makeInput());
    const output = await adapter.fetchOutput(run.runId);

    expect(output?.payload).toEqual(payload);
  }, 20_000);
});
