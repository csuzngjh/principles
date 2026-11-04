import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAiRuntimeAdapter } from '@principles/core/runtime-v2';
import {
  createSignalLlmClassifier,
  SIGNAL_CLASSIFICATION_SCHEMA_REF,
} from '../src/signal-classifier.js';

/**
 * Real-adapter contract for the Stage-2 classifier (review finding P1).
 *
 * Before the fix the classifier requested the retired `signal-classification-output-v1`
 * ref; the registry only owns v2, so PiAiRuntimeAdapter failed loud with
 * `output_invalid` and the classifier's catch turned that into `null` — Stage 2
 * silently stopped classifying in production while unit tests stayed green.
 *
 * These assertions use the REAL PiAiRuntimeAdapter + REAL registry against a local
 * OpenAI-compatible endpoint (no adapter/registry mocks), and prove:
 *   1. the production request carries the v2 ref (response_format name == v2 ref),
 *   2. the retired v1 ref is rejected by the adapter (fail loud, no silent null),
 *   3. both contract outcomes (`correction` / `none`) resolve end to end.
 *
 * The OpenClaw plugin, the Codex worker and the WorkBuddy worker all consume this
 * same factory, so this one contract covers the shared production path.
 */

const API_KEY_ENV = 'PD_TEST_SIGNAL_CLASSIFIER_KEY';
const MODEL = 'pd-test-model';

interface FakeOpenAi {
  readonly baseUrl: string;
  readonly requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function startFakeOpenAi(responsePayloads: string[]): Promise<FakeOpenAi> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = [];
    let index = 0;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          requests.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          requests.push({ raw });
        }
        const content = responsePayloads[Math.min(index, responsePayloads.length - 1)] ?? '{}';
        index += 1;
        // pi-ai's completeSimple consumes the provider's SSE stream, so the
        // fake endpoint answers with the canonical chat.completion.chunk frames
        // (content delta, then a finish_reason=stop frame, then [DONE]).
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = {
          id: 'chatcmpl-pd-test',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: MODEL,
        };
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake OpenAI endpoint did not bind a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });
}

const CORRECTION_PAYLOAD = JSON.stringify({
  is_feedback: true,
  type: 'correction',
  confidence: 0.97,
  reason: '用户明确指出 AI 不应直接替其做决定',
});
const NONE_PAYLOAD = JSON.stringify({
  is_feedback: false,
  type: 'none',
  confidence: 0.9,
  reason: '普通任务指令',
});

describe('Stage-2 classifier schema contract (real adapter)', () => {
  let workspaceDir: string;
  let previousKey: string | undefined;

  beforeAll(() => {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'pd-signal-contract-'));
    previousKey = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = 'test-key';
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previousKey;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('production classifier requests the v2 ref and returns correction + none', async () => {
    const fake = await startFakeOpenAi([CORRECTION_PAYLOAD, NONE_PAYLOAD]);
    const logged: string[] = [];
    try {
      const classifier = createSignalLlmClassifier(
        {
          provider: 'pd-test-provider',
          model: MODEL,
          apiKeyEnv: API_KEY_ENV,
          timeoutMs: 5_000,
          baseUrl: fake.baseUrl,
        },
        workspaceDir,
        { log: (event, detail) => logged.push(`${event}:${detail}`) },
      );

      const correction = await classifier('这是错的，不要自作主张');
      expect(correction).toEqual({
        is_feedback: true,
        type: 'correction',
        confidence: 0.97,
        reason: '用户明确指出 AI 不应直接替其做决定',
      });

      const none = await classifier('把这份文件重命名一下');
      expect(none).toEqual({
        is_feedback: false,
        type: 'none',
        confidence: 0.9,
        reason: '普通任务指令',
      });

      // The adapter received the schema the classifier declared, not a stale v1.
      expect(fake.requests).toHaveLength(2);
      for (const request of fake.requests) {
        const responseFormat = request.response_format as
          | { json_schema?: { name?: string } }
          | undefined;
        expect(responseFormat?.json_schema?.name).toBe(SIGNAL_CLASSIFICATION_SCHEMA_REF);
        expect(JSON.stringify(request)).not.toContain('signal-classification-output-v1');
      }
      expect(logged.some((event) => event.startsWith('SIGNAL_LLM_FAILED'))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('the retired v1 ref fails loud in the real adapter instead of degrading silently', async () => {
    const adapter = new PiAiRuntimeAdapter({
      provider: 'pd-test-provider',
      model: MODEL,
      apiKeyEnv: API_KEY_ENV,
      timeoutMs: 5_000,
      baseUrl: 'http://127.0.0.1:1/v1',
      workspace: workspaceDir,
      outputPathStrategy: 'json_mode_first',
      maxRepairAttempts: 1,
    });

    await expect(adapter.startRun({
      agentSpec: { agentId: 'signal-collector', schemaVersion: '1' },
      inputPayload: { prompt: '分类这条消息' },
      contextItems: [],
      outputSchemaRef: 'signal-classification-output-v1',
    })).rejects.toThrow('Unknown outputSchemaRef: signal-classification-output-v1');
  });
});
