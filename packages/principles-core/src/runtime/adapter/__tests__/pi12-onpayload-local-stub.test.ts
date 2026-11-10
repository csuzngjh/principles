/**
 * Wire-level `onPayload` coverage without a real provider.
 *
 * The faux provider sits ABOVE the per-API HTTP adapters, so it can never
 * observe `response_format` / `tool_choice` rewrites (README: wire-level
 * assertions). The existing real-provider tests only run when
 * `LLM_E2E_ENABLED` is set, which means the default suite never exercises
 * this surface.
 *
 * This test runs the REAL `PiAiRuntimeAdapter` → pi-ai `completeSimple` →
 * real undici HTTP transport against an in-process loopback server. The
 * server records the request body, so the assertion is on the payload the
 * adapter actually put on the wire — not on the existence of a callback.
 *
 * No network access, no API key, no environment switch: the server is
 * 127.0.0.1-only and the key is a local dummy value.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import { sanitizeSchemaName } from '../schema-json-converter.js';
import { DiagnosticianOutputV2Schema } from '../../diagnostician-output.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';

const API_KEY_ENV = 'PD_LOCAL_STUB_API_KEY';
const MODEL_ID = 'gpt-4o-mini';
const SCHEMA_REF = 'diagnostician-output';

const VALID_OUTPUT = {
  valid: true,
  diagnosisId: 'local-stub-diag-1',
  summary: 'Agent skipped verification under time pressure.',
  rootCause: 'Assumption: verification can be deferred because the deadline is closer than the risk.',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [
    { kind: 'defer', description: 'No actionable principle yet; keep observing the pattern.', recommendationRef: 'defer-1' },
  ],
  confidence: 0.6,
  schemaVersion: 'diagnostician-output-v2',
};

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
let server: Server;
let baseUrl: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** OpenAI chat-completions response, streaming or one-shot depending on the request. */
function respond(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const content = JSON.stringify(VALID_OUTPUT);
  if (body.stream !== true) {
    writeJson(res, 200, {
      id: 'chatcmpl-local-stub',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
    });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const base = { id: 'chatcmpl-local-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID };
  const half = Math.ceil(content.length / 2);
  for (const piece of [content.slice(0, half), content.slice(half)]) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

beforeAll(async () => {
  process.env[API_KEY_ENV] = 'local-stub-key';
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Recorded below as an empty body; the assertion fails loudly on the missing fields.
      }
      captured.push({
        url: req.url ?? '',
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        body,
      });
      respond(req, res, body);
    })().catch((err: unknown) => {
      writeJson(res, 500, { error: { message: err instanceof Error ? err.message : 'stub failure' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  delete process.env[API_KEY_ENV];
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('wire-level onPayload (loopback HTTP stub, default suite)', () => {
  it('json_mode_first puts a json_schema response_format on the real request', async () => {
    const events: TelemetryEvent[] = [];
    const emitter = new StoreEventEmitter();
    emitter.onTelemetry((event) => {
      events.push(event);
    });

    const adapter = new PiAiRuntimeAdapter({
      provider: 'local-stub',
      model: MODEL_ID,
      apiKeyEnv: API_KEY_ENV,
      baseUrl,
      maxRetries: 0,
      maxTokens: 256,
      maxRepairAttempts: 0,
      timeoutMs: 10_000,
      outputPathStrategy: 'json_mode_first',
      eventEmitter: emitter,
    });

    const input: StartRunInput = {
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      taskRef: { taskId: 'local-stub-onpayload-1' },
      inputPayload: 'Diagnose this pain signal: an agent skipped verification three times in one week.',
      contextItems: [],
      outputSchemaRef: SCHEMA_REF,
      timeoutMs: 10_000,
    };

    const handle = await adapter.startRun(input);
    const output = await adapter.fetchOutput(handle.runId);

    // 1. The rewrite actually reached the wire.
    expect(captured).toHaveLength(1);
    const [request] = captured;
    if (!request) throw new Error('unreachable: one request asserted');
    expect(request.url).toContain('/chat/completions');
    expect(request.authorization).toBe(`Bearer local-stub-key`);
    expect(request.body.model).toBe(MODEL_ID);

    const responseFormat = request.body.response_format as
      | { type?: unknown; json_schema?: { name?: unknown; schema?: unknown } }
      | undefined;
    expect(responseFormat).toBeTypeOf('object');
    if (!responseFormat) throw new Error('unreachable: responseFormat asserted defined');
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema?.name).toBe(sanitizeSchemaName(SCHEMA_REF));

    const wireSchema = responseFormat.json_schema?.schema as { required?: unknown; properties?: Record<string, unknown> } | undefined;
    expect(wireSchema?.required).toContain('diagnosisId');
    expect(wireSchema?.properties).toHaveProperty('rootCause');

    // 2. The path actually succeeded end-to-end with the stub's reply.
    expect(output).not.toBeNull();
    expect(Value.Check(DiagnosticianOutputV2Schema, output?.payload)).toBe(true);
    expect(events.map((event) => event.eventType)).toContain('runtime_invocation_succeeded');
  }, 30_000);
});
