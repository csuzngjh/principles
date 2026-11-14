import type { completeSimple } from '@earendil-works/pi-ai/compat';
import { describe, expect, it } from 'vitest';
import { listProviderPresets } from '../pi-ai-catalog.js';
import { probeProviderConnection } from '../pi-ai-connection-probe.js';

const preset = listProviderPresets().find(
  (item) => item.api === 'openai-completions' && item.models.length > 0,
);
if (preset === undefined) {
  throw new Error('pi-ai catalog exposed no openai-completions provider to test against');
}
const [firstModel] = preset.models;
if (firstModel === undefined) {
  throw new Error('pi-ai catalog exposed no models for the chosen provider');
}

const SECRET = 'sk-probe-secret-value-9876';

function resolveWithSecret(_envName: string) {
  return { value: SECRET, source: 'file' as const };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const completeOk = (async () => ({ stopReason: 'stop' })) as unknown as typeof completeSimple;

describe('probeProviderConnection (PRI-1213)', () => {
  it('reports a missing credential without making a request', async () => {
    let called = false;
    const result = await probeProviderConnection(
      {
        provider: preset.id,
        model: firstModel.id,
        apiKeyEnv: 'PROBE_TEST_API_KEY',
      },
      {
        resolveApiKey: () => ({ value: null, source: 'none' }),
        fetchImpl: async () => {
          called = true;
          return jsonResponse(200, {});
        },
      },
    );
    expect(result.kind).toBe('missing_credential');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    expect(result.message).not.toContain(SECRET);
  });

  it('rejects an unknown model on a built-in provider', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: 'definitely-not-a-catalog-model', apiKeyEnv: 'PROBE_TEST_API_KEY' },
      { resolveApiKey: resolveWithSecret },
    );
    expect(result.kind).toBe('invalid_target');
    expect(result.stage).toBe('target');
  });

  it('accepts a 200 model list', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () => jsonResponse(200, { data: [{ id: firstModel.id }] }),
      },
    );
    expect(result).toMatchObject({ ok: true, kind: 'ok', stage: 'models', httpStatus: 200 });
  });

  it('classifies 401 as an invalid credential and redacts the key', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () =>
          jsonResponse(401, {
            error: { message: `Incorrect API key provided: ${SECRET}` },
          }),
      },
    );
    expect(result.kind).toBe('invalid_credential');
    expect(result.httpStatus).toBe(401);
    expect(result.message).not.toContain(SECRET);
    expect(result.message).toContain('[REDACTED]');
  });

  it('classifies 5xx as an upstream error with the real message', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () =>
          jsonResponse(503, { error: { message: 'upstream exploded' } }),
      },
    );
    expect(result.kind).toBe('upstream');
    expect(result.httpStatus).toBe(503);
    expect(result.message).toContain('upstream exploded');
  });

  it('distinguishes an unreachable host from a server error', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' },
          });
        },
      },
    );
    expect(result.kind).toBe('network');
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('falls back to a minimal chat when the model-list endpoint is unsupported', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () => jsonResponse(404, { error: { message: 'not found' } }),
        completeSimpleImpl: completeOk,
      },
    );
    expect(result).toMatchObject({ ok: true, kind: 'ok', stage: 'chat' });
  });

  it('reports an auth error surfaced by the chat fallback', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () => jsonResponse(405, {}),
        completeSimpleImpl: (async () => ({
          stopReason: 'error',
          errorMessage: `401 Unauthorized: bad key ${SECRET}`,
        })) as unknown as typeof completeSimple,
      },
    );
    expect(result.kind).toBe('invalid_credential');
    expect(result.message).not.toContain(SECRET);
  });

  it('does not treat a 2xx HTML page as a verified model list', async () => {
    let chatCalls = 0;
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () =>
          new Response('<html><body>sign in</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        completeSimpleImpl: (async () => {
          chatCalls += 1;
          return { stopReason: 'stop' };
        }) as unknown as typeof completeSimple,
      },
    );
    // The 2xx page proves the host answered, not that the key is valid; the
    // probe must spend the bounded chat request instead of reporting success.
    expect(result).toMatchObject({ ok: true, kind: 'ok', stage: 'chat' });
    expect(chatCalls).toBe(1);
  });

  it('classifies an aborted chat as a network failure', async () => {
    const result = await probeProviderConnection(
      { provider: preset.id, model: firstModel.id, apiKeyEnv: 'PROBE_TEST_API_KEY' },
      {
        resolveApiKey: resolveWithSecret,
        fetchImpl: async () => jsonResponse(404, {}),
        completeSimpleImpl: (async () => ({
          stopReason: 'aborted',
          errorMessage: `aborted ${SECRET}`,
        })) as unknown as typeof completeSimple,
      },
    );
    expect(result.kind).toBe('network');
    expect(result.message).not.toContain(SECRET);
  });
});
