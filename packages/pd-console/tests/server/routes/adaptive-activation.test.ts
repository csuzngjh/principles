/**
 * PR #2641 review — REAL HTTP route tests for the Adaptive Activation entry.
 *
 * These exercise `handleConfigRoute` (not only the store/model helpers):
 * GET/PATCH happy paths, validation 400s, append-only 409, body-size limit,
 * cross-workspace isolation, zero-network saves and credential non-disclosure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { handleConfigRoute } from '../../../src/server/routes/config.js';
import { getDefaultPdConfig } from '@principles/core/runtime';
import { ADAPTIVE_ACTIVATION_SERVICE_PRESET } from '../../../src/server/config/pd-config-store.js';

function createMockRequest(
  method: string,
  options?: { rawBody?: string },
): IncomingMessage {
  const bodyStr = options?.rawBody ?? '';
  return {
    method,
    url: '/api/config/adaptive-activation',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && bodyStr.length > 0) handler(Buffer.from(bodyStr));
      if (event === 'end') handler();
    }),
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, statusCode: number) {
      res.statusCode = statusCode;
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
      if (data !== undefined) res._body = data;
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function bodyOf<T>(res: ServerResponse): T {
  return JSON.parse((res as unknown as { _body: string })._body) as T;
}

function okData<T>(res: ServerResponse): T {
  const body = bodyOf<{ success: true; data: T }>(res);
  expect(body.success).toBe(true);
  return body.data;
}

function errBody(res: ServerResponse): { success: false; error: string; message: string } {
  const body = bodyOf<{ success: false; error: string; message: string }>(res);
  expect(body.success).toBe(false);
  return body;
}

let tmpDir: string;
let workspaceA: string;
let workspaceB: string;

function writeConfig(workspace: string, mutate?: (config: ReturnType<typeof getDefaultPdConfig>) => void): void {
  fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  mutate?.(config);
  fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-aa-route-'));
  workspaceA = path.join(tmpDir, 'ws-a');
  workspaceB = path.join(tmpDir, 'ws-b');
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  writeConfig(workspaceA);
  writeConfig(workspaceB);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function call(
  method: 'GET' | 'PATCH' | 'POST',
  workspace: string,
  rawBody?: string,
): Promise<ServerResponse> {
  const req = createMockRequest(method, rawBody === undefined ? {} : { rawBody });
  const res = createMockResponse();
  await handleConfigRoute(req, res, { workspaceDir: workspace, subPath: '/adaptive-activation' });
  return res;
}

describe('GET /api/config/adaptive-activation', () => {
  it('returns THIS workspace state, including the evidence tri-state', async () => {
    const res = await call('GET', workspaceA);
    expect(res.statusCode).toBe(200);
    const data = okData<{
      workspaceDir: string;
      codex: { enabled: boolean; serviceConfigured: boolean; saved: boolean };
      evidence: { status: string; reason: string; parseFailures: number; logFilesRead: number };
    }>(res);
    expect(data.workspaceDir).toBe(workspaceA);
    // No injection logs exist for this workspace yet: a PROVEN absence.
    expect(data.evidence).toEqual({
      status: 'not_observed',
      reason: 'no_adaptive_fact',
      parseFailures: 0,
      logFilesRead: 0,
    });
    expect(data.codex.enabled).toBe(false);
  });

  it('does not leak another workspace config or logs', async () => {
    writeConfig(workspaceB, (config) => {
      config.features['host.codex.adaptive_activation'].enabled = true;
      config.adaptiveActivation = {
        endpoint: 'https://b.example.test/decisions',
        model: 'b-model',
        apiKeyEnv: 'B_KEY',
      };
    });
    const logsB = path.join(workspaceB, '.state', 'logs');
    fs.mkdirSync(logsB, { recursive: true });
    fs.writeFileSync(path.join(logsB, 'events_2026-11-14.jsonl'), JSON.stringify({
      ts: '2026-11-14T05:00:00.000Z',
      type: 'runtime_v2_prompt_activations_injected',
      sessionId: 'b-session',
      data: {
        sessionId: 'b-session',
        workspaceDir: workspaceB,
        runId: 'b-run',
        hostKind: 'codex',
        activationIds: ['act-B'],
        adaptive: { resultCode: 'selected:selected', scored: true, appendedActivationId: 'act-B' },
      },
    }), 'utf8');

    const resA = await call('GET', workspaceA);
    const dataA = okData<{
      service: { endpoint: string };
      evidence: { status: string };
      lastRecord: unknown;
    }>(resA);
    expect(dataA.service.endpoint).toBe(ADAPTIVE_ACTIVATION_SERVICE_PRESET.endpoint);
    expect(dataA.evidence.status).toBe('not_observed');
    expect(dataA.lastRecord).toBeNull();

    const resB = await call('GET', workspaceB);
    const dataB = okData<{
      service: { endpoint: string };
      evidence: { status: string };
      lastRecord: { appendedActivationId: string } | null;
    }>(resB);
    expect(dataB.service.endpoint).toBe('https://b.example.test/decisions');
    expect(dataB.evidence.status).toBe('observed');
    expect(dataB.lastRecord?.appendedActivationId).toBe('act-B');
  });

  it('reports UNKNOWN (not "not observed") when the log path cannot be read', async () => {
    fs.mkdirSync(path.join(workspaceA, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceA, '.state', 'logs'), 'not a directory', 'utf8');
    const res = await call('GET', workspaceA);
    const data = okData<{ evidence: { status: string; reason: string } }>(res);
    expect(data.evidence.status).toBe('unknown');
    expect(data.evidence.reason).toBe('logs_unreadable');
  });

  it('never returns the credential VALUE, only the environment variable name', async () => {
    const secret = 'sk-live-should-never-leak-1234567890';
    vi.stubEnv('OPENROUTER_API_KEY', secret);
    try {
      const res = await call('GET', workspaceA);
      const raw = (res as unknown as { _body: string })._body;
      expect(raw).not.toContain(secret);
      const data = okData<{ service: { apiKeyEnv: string; credentialSeenInConsoleProcess: boolean } }>(res);
      expect(data.service.apiKeyEnv).toBe('OPENROUTER_API_KEY');
      expect(data.service.credentialSeenInConsoleProcess).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('PATCH /api/config/adaptive-activation', () => {
  it('persists the preset and returns the re-read state, with zero scoring requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await call('PATCH', workspaceA, JSON.stringify({ service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id }));

    expect(res.statusCode).toBe(200);
    const data = okData<{ codex: { serviceConfigured: boolean; saved: boolean }; service: { model: string } }>(res);
    expect(data.codex.serviceConfigured).toBe(true);
    expect(data.codex.saved).toBe(false); // service saved, switch still off
    expect(data.service.model).toBe(ADAPTIVE_ACTIVATION_SERVICE_PRESET.model);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Persisted, not just echoed: a fresh GET sees the same thing.
    const reread = okData<{ codex: { serviceConfigured: boolean } }>(await call('GET', workspaceA));
    expect(reread.codex.serviceConfigured).toBe(true);
  });

  it('enables the switch after the service exists', async () => {
    await call('PATCH', workspaceA, JSON.stringify({ service: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id }));
    const res = await call('PATCH', workspaceA, JSON.stringify({ enabled: true }));
    expect(res.statusCode).toBe(200);
    const data = okData<{ codex: { enabled: boolean; saved: boolean } }>(res);
    expect(data.codex.enabled).toBe(true);
    expect(data.codex.saved).toBe(true);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await call('PATCH', workspaceA, '{not json');
    expect(res.statusCode).toBe(400);
    expect(errBody(res).error).toBe('bad_request');
  });

  it('rejects an unknown field with 400', async () => {
    const res = await call('PATCH', workspaceA, JSON.stringify({ enabled: true, endpoint: 'https://evil.test' }));
    expect(res.statusCode).toBe(400);
    expect(errBody(res).error).toBe('unknown_field');
  });

  it('rejects an unsupported service with 400', async () => {
    const res = await call('PATCH', workspaceA, JSON.stringify({ service: 'some-other-service' }));
    expect(res.statusCode).toBe(400);
    expect(errBody(res).error).toBe('unknown_service');
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const res = await call('PATCH', workspaceA, JSON.stringify({ enabled: 'yes' }));
    expect(res.statusCode).toBe(400);
    expect(errBody(res).error).toBe('bad_request');
  });

  it('refuses append-only enablement on a replacement-mode config with 409', async () => {
    writeConfig(workspaceA, (config) => {
      config.features['host.codex.adaptive_activation'].enabled = true;
      config.adaptiveActivation = {
        endpoint: 'https://legacy.example.test/decisions',
        model: 'legacy',
        apiKeyEnv: 'LEGACY_KEY',
        replaceableActivationIds: ['act-legacy'],
      };
    });
    const res = await call('PATCH', workspaceA, JSON.stringify({ enabled: true }));
    expect(res.statusCode).toBe(409);
    expect(errBody(res).error).toBe('append_only_conflict');

    // The Owner's configuration is preserved.
    const view = okData<{ replaceableActivationIds: string[]; service: { model: string } }>(await call('GET', workspaceA));
    expect(view.replaceableActivationIds).toEqual(['act-legacy']);
    expect(view.service.model).toBe('legacy');
  });

  it('rejects an oversized body with 400', async () => {
    const huge = JSON.stringify({ enabled: true, padding: 'x'.repeat(70 * 1024) });
    const res = await call('PATCH', workspaceA, huge);
    expect(res.statusCode).toBe(400);
    expect(errBody(res).message).toContain('exceeds maximum allowed size');
  });

  it('rejects a non-AA method on this sub-path', async () => {
    const res = await call('POST', workspaceA, '{}');
    expect(res.statusCode).toBe(405);
  });
});
