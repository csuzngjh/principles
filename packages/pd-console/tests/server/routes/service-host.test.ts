/**
 * SPEC-PD-SERVICE-HOST-001 §7/§8.2 (PRI-1281 Phase 3) — GET
 * /api/service-host/status: read-only wiring, the lifecycle-ownership
 * boundary (non-GET refused; only /status exists) and the honest failure
 * mapping through an injected CLI runtime.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleServiceHostRoute, type ServiceHostStatusRuntime } from '../../../src/server/routes/service-host.js';

function createMockRequest(method: string): IncomingMessage {
  return { method, url: '/api/service-host/status' } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: (statusCode: number) => {
      (res as unknown as { statusCode: number }).statusCode = statusCode;
      return res;
    },
    end: (data?: string) => {
      if (data !== undefined) (res as unknown as { _body: string })._body = data;
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

const okRuntime: ServiceHostStatusRuntime = {
  async readStatus() {
    return {
      ok: true,
      document: { schemaVersion: 'pd.service-status.v1', scheduler: { registered: true, enabled: false } },
    };
  },
};

describe('GET /api/service-host/status (read-only contract)', () => {
  it('returns the unified status document verbatim (the Console adds no second interpretation)', async () => {
    const res = createMockResponse();
    await handleServiceHostRoute(createMockRequest('GET'), res, { subPath: '/status', runtime: okRuntime });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse((res as unknown as { _body: string })._body) as { schemaVersion: string; scheduler: { registered: boolean } };
    expect(parsed.schemaVersion).toBe('pd.service-status.v1');
    expect(parsed.scheduler.registered).toBe(true);
  });

  it('non-GET methods are refused — the Console never owns Service Host lifecycle (SPEC §7)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = createMockResponse();
      await handleServiceHostRoute(createMockRequest(method), res, { subPath: '/status', runtime: okRuntime });
      expect(res.statusCode).toBe(405);
      const parsed = JSON.parse((res as unknown as { _body: string })._body) as { error: string };
      expect(parsed.error).toBe('method_not_allowed');
    }
  });

  it('unknown sub-paths 404 (no enable/disable/uninstall surface exists here)', async () => {
    const res = createMockResponse();
    await handleServiceHostRoute(createMockRequest('GET'), res, { subPath: '/enable', runtime: okRuntime });
    expect(res.statusCode).toBe(404);
  });

  it('a failed CLI status maps to 503 with the structured reason + nextAction (never fabricated data)', async () => {
    const failing: ServiceHostStatusRuntime = {
      async readStatus() {
        return { ok: false, reason: 'service_host_status_failed:exit_1:access denied', nextAction: 'Run pd service status in a terminal.' };
      },
    };
    const res = createMockResponse();
    await handleServiceHostRoute(createMockRequest('GET'), res, { subPath: '/status', runtime: failing });
    expect(res.statusCode).toBe(503);
    const parsed = JSON.parse((res as unknown as { _body: string })._body) as { error: string; message: string };
    expect(parsed.error).toContain('service_host_status_failed');
    expect(parsed.message).toContain('pd service status');
  });
});
