/**
 * PR #2563 review round 2: /api/health/ingestion cache contract.
 *
 * The page has an explicit Refresh button. Before the fix, a plain GET was
 * served from a 5-minute cache with NO bypass, so clicking Refresh re-rendered
 * the SAME snapshot under a spinning icon. This suite exercises the real route
 * handler with the collector model mocked (no subprocess) and pins:
 *   - plain GET is cached;
 *   - `?refresh=1` forces a fresh collection;
 *   - an unknown/degraded result is never cached (existing rc-9 discipline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { mockCollect } = vi.hoisted(() => ({ mockCollect: vi.fn() }));

vi.mock('../../../src/server/models/HealthCheckModel.js', () => ({
  HealthCheckModel: class {},
}));

vi.mock('../../../src/server/models/CodexGovernanceHealthModel.js', () => ({
  CodexGovernanceHealthModel: class {},
  resolvePdCliEntry: () => ({ ok: true, entry: 'fake-pd-cli' }),
}));

vi.mock('../../../src/server/models/IngestionHealthModel.js', () => {
  class IngestionHealthModel {
    async collect(): Promise<unknown> {
      return mockCollect();
    }
  }
  return { IngestionHealthModel };
});

import { handleIngestionHealthRoute, disposeHealthModels } from '../../../src/server/routes/health.js';

const WORKSPACE = '/synthetic/workspace';

const OK_RESULT = {
  status: 'ok',
  snapshot: {
    generatedAt: '2026-11-12T00:00:00.000Z',
    workspace: WORKSPACE,
    ingestion: { codex: { status: 'monitored' }, workbuddy: { status: 'monitored' }, openclaw: { status: 'not_wired' } },
  },
};

const UNKNOWN_RESULT = {
  status: 'unknown',
  reason: 'health_collection_failed',
  nextAction: 'run manually',
  productClaim: 'degraded',
};

function createMockRes(): { res: ServerResponse; payload: () => Record<string, unknown> | null } {
  let captured: Record<string, unknown> | null = null;
  const res = {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn((body?: string) => {
      try {
        captured = body !== undefined ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        captured = null;
      }
    }),
  } as unknown as ServerResponse;
  return { res, payload: () => captured };
}

function get(url: string): IncomingMessage {
  return { method: 'GET', url } as unknown as IncomingMessage;
}

beforeEach(() => {
  disposeHealthModels();
  mockCollect.mockReset();
  mockCollect.mockResolvedValue(OK_RESULT);
});

afterEach(() => {
  disposeHealthModels();
});

describe('GET /api/health/ingestion cache contract', () => {
  it('caches a plain GET but re-collects when the Refresh button sends ?refresh=1', async () => {
    const first = createMockRes();
    await handleIngestionHealthRoute(get('/api/health/ingestion'), first.res, { workspaceDir: WORKSPACE });
    expect(mockCollect).toHaveBeenCalledTimes(1);
    expect(first.payload()?.data).toMatchObject({ status: 'ok' });

    const cached = createMockRes();
    await handleIngestionHealthRoute(get('/api/health/ingestion'), cached.res, { workspaceDir: WORKSPACE });
    expect(mockCollect).toHaveBeenCalledTimes(1);
    expect(cached.payload()?.data).toMatchObject({ status: 'ok' });

    const refreshed = createMockRes();
    await handleIngestionHealthRoute(get('/api/health/ingestion?refresh=1'), refreshed.res, { workspaceDir: WORKSPACE });
    expect(mockCollect).toHaveBeenCalledTimes(2);
    expect(refreshed.payload()?.data).toMatchObject({ status: 'ok' });
  });

  it('never caches an unknown result — a transient CLI outage recovers on the next GET', async () => {
    mockCollect.mockResolvedValueOnce(UNKNOWN_RESULT);
    const first = createMockRes();
    await handleIngestionHealthRoute(get('/api/health/ingestion'), first.res, { workspaceDir: WORKSPACE });
    expect(first.payload()?.data).toMatchObject({ status: 'unknown' });

    const second = createMockRes();
    await handleIngestionHealthRoute(get('/api/health/ingestion'), second.res, { workspaceDir: WORKSPACE });
    expect(mockCollect).toHaveBeenCalledTimes(2);
    expect(second.payload()?.data).toMatchObject({ status: 'ok' });
  });

  it('refuses non-GET methods', async () => {
    const { res, payload } = createMockRes();
    await handleIngestionHealthRoute({ method: 'POST', url: '/api/health/ingestion' } as unknown as IncomingMessage, res, { workspaceDir: WORKSPACE });
    expect(payload()?.success).toBe(false);
    expect(mockCollect).not.toHaveBeenCalled();
  });
});
