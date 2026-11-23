/**
 * Console /api/health `instance` block: the launcher-side stale-process
 * detector (console-launcher classifyStaleConsoleInstance) reads pid,
 * serverEntry and webIndexExists to decide whether a healthy-answering
 * console can actually serve. This test pins the REAL route handler —
 * dropping or renaming a field must fail here.
 *
 * The health models are stubbed: the subject is the instance contract,
 * not system health.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('../../../src/server/models/HealthCheckModel.js', () => ({
  HealthCheckModel: class {
    async checkSystemHealth() {
      return { overall: 'healthy' };
    }
    dispose() { /* nothing to dispose in the stub */ }
  },
}));
vi.mock('../../../src/server/models/CodexGovernanceHealthModel.js', () => ({
  CodexGovernanceHealthModel: class {
    async collect() {
      return {
        status: 'ok' as const,
        health: { status: 'ok', ready: true },
      };
    }
  },
}));

function createMockResponse(): ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    setHeader: vi.fn(function setHeader(name: string, value: unknown) {
      res.headers[name] = value;
    }),
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      res.statusCode = statusCode;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') res.body += chunk;
      return res;
    },
  } as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  return res;
}

async function importHealthRoute(): Promise<typeof import('../../../src/server/routes/health.js')> {
  vi.resetModules();
  return import('../../../src/server/routes/health.js');
}

function healthRequest(): IncomingMessage {
  return { method: 'GET', on: vi.fn() } as unknown as IncomingMessage;
}

describe('health route instance identity block', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports pid, serverEntry, workspaceDir and the passed webIndexExists flag', async () => {
    const { handleHealthRoute } = await importHealthRoute();
    const res = createMockResponse();
    await handleHealthRoute(healthRequest(), res, {
      workspaceDir: '/w/instance',
      authenticationMode: 'no_auth',
      webIndexExists: false,
    });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as {
      success: boolean;
      data: { instance: { pid: unknown; serverEntry: unknown; webIndexExists: unknown } };
    };
    expect(payload.success).toBe(true);
    const instance = payload.data.instance;
    expect(instance.pid).toBe(process.pid);
    expect(typeof instance.serverEntry === 'string' || instance.serverEntry === null).toBe(true);
    expect(instance.webIndexExists).toBe(false);
  });

  it('passes webIndexExists through as true when the bundle is present', async () => {
    const { handleHealthRoute } = await importHealthRoute();
    const res = createMockResponse();
    await handleHealthRoute(healthRequest(), res, {
      workspaceDir: '/w/instance',
      authenticationMode: 'no_auth',
      webIndexExists: true,
    });
    const payload = JSON.parse(res.body) as { data: { instance: { webIndexExists: unknown } } };
    expect(payload.data.instance.webIndexExists).toBe(true);
  });
});
