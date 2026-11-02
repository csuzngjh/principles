/**
 * PRI-1069 G1 P0-1: the console /api/health route must echo the launcher
 * nonce (PD_CONSOLE_VERIFY_NONCE) when present, and must NOT include the
 * field for consoles launched without it. The installer-side probe tests
 * exercise the probe against fake responders; this test pins the REAL route
 * handler — deleting the verifyNonce echo from health.ts must fail here.
 *
 * health.ts reads the env ONCE at module load, so each scenario re-imports
 * the module with vi.resetModules + dynamic import (review 2026-11-02
 * nitpick: no regression test covered the echo itself). The health models
 * are stubbed: the subject is the echo contract, not system health.
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

describe('health route verifyNonce echo (P0-1)', () => {
  afterEach(() => {
    delete process.env.PD_CONSOLE_VERIFY_NONCE;
    vi.restoreAllMocks();
  });

  it('echoes the launcher nonce when PD_CONSOLE_VERIFY_NONCE is set', async () => {
    process.env.PD_CONSOLE_VERIFY_NONCE = 'nonce-abc-123';
    const { handleHealthRoute } = await importHealthRoute();
    const res = createMockResponse();
    await handleHealthRoute(healthRequest(), res, {
      workspaceDir: process.cwd(),
      authenticationMode: 'no_auth',
    });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { success: boolean; data: Record<string, unknown> };
    expect(payload.success).toBe(true);
    expect(payload.data.verifyNonce).toBe('nonce-abc-123');
  });

  it('omits verifyNonce entirely for consoles launched without the env', async () => {
    delete process.env.PD_CONSOLE_VERIFY_NONCE;
    const { handleHealthRoute } = await importHealthRoute();
    const res = createMockResponse();
    await handleHealthRoute(healthRequest(), res, {
      workspaceDir: process.cwd(),
      authenticationMode: 'no_auth',
    });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { success: boolean; data: Record<string, unknown> };
    expect(payload.success).toBe(true);
    expect(Object.hasOwn(payload.data, 'verifyNonce')).toBe(false);
  });
});
