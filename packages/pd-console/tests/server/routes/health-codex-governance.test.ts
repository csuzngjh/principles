/**
 * PRI-625 Slice D review round 2: /api/health codexGovernance contract tests.
 *
 * Governance consistency guarantees under test:
 * - a CodexGovernanceHealthModel failure is NEVER swallowed into
 *   "absent = healthy" — the response carries an explicit unknown block with
 *   `ready: false` and a `health_collection_failed` blocker (rc-9);
 * - a successful collection passes the CLI authority's report through
 *   verbatim, including `ready` exactly as the CLI computed it.
 *
 * The CodexGovernanceHealthModel is mocked so these tests exercise the ROUTE
 * wiring without spawning the real CLI subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { mockCollect, mockCheckSystemHealth } = vi.hoisted(() => ({
  mockCollect: vi.fn(),
  mockCheckSystemHealth: vi.fn().mockResolvedValue({ status: 'ok', database: true }),
}));

vi.mock('../../../src/server/models/HealthCheckModel.js', () => {
  class HealthCheckModel {
    async checkSystemHealth(): Promise<unknown> {
      return mockCheckSystemHealth();
    }

    dispose(): void {}
  }
  return { HealthCheckModel };
});

vi.mock('../../../src/server/models/CodexGovernanceHealthModel.js', () => {
  class CodexGovernanceHealthModel {
    async collect(): Promise<unknown> {
      return mockCollect();
    }
  }
  return { CodexGovernanceHealthModel };
});

import { handleHealthRoute, disposeHealthModels } from '../../../src/server/routes/health.js';

function createMockRes(): { res: ServerResponse; payload: () => Record<string, unknown> | null; statusOf: () => number } {
  let captured: Record<string, unknown> | null = null;
  let status = -1;
  const res = {
    setHeader: vi.fn(),
    writeHead: vi.fn((code: number) => {
      status = code;
    }),
    end: vi.fn((body?: string) => {
      try {
        captured = body !== undefined ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        captured = null;
      }
    }),
  } as unknown as ServerResponse;
  return { res, payload: () => captured, statusOf: () => status };
}

function createMockReq(): IncomingMessage {
  return { method: 'GET', url: '/api/health' } as unknown as IncomingMessage;
}

function okHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    ready: true,
    readyBlockers: [],
    ingestionEnabled: true,
    consent: { state: 'granted', disclosureStale: false },
    productClaim: 'rev2_automatic_closure',
    ...overrides,
  };
}

beforeEach(() => {
  mockCollect.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  disposeHealthModels();
  vi.restoreAllMocks();
});

describe('/api/health codexGovernance — explicit unknown is not healthy (review round 2)', () => {
  it('model failure ⇒ explicit unknown block with ready=false and health_collection_failed blocker', async () => {
    mockCollect.mockRejectedValue(new Error('cli subprocess crashed'));
    const { res, payload, statusOf } = createMockRes();

    try {
      await handleHealthRoute(createMockReq(), res, { workspaceDir: '/w', authenticationMode: 'no_auth' });
    } catch (error) {
      throw new Error('route threw: ' + String(error instanceof Error ? error.stack : error));
    }

    expect(statusOf()).toBe(200);
    const body = payload();
    expect(body).not.toBeNull();
    const envelope = body?.data as Record<string, unknown> | undefined;
    const block = envelope?.codexGovernance as Record<string, unknown>;
    expect(block).toBeDefined();
    expect(block.status).toBe('unknown');
    expect(block.ready).toBe(false);
    expect((block.readyBlockers as string[]).some((blocker) => blocker.startsWith('health_collection_failed'))).toBe(true);
  });

  it('successful collection passes the CLI report through verbatim (single authority)', async () => {
    mockCollect.mockResolvedValue({ status: 'ok', health: okHealth({ ready: false, readyBlockers: ['consent: not granted'] }) });
    const { res, payload } = createMockRes();

    await handleHealthRoute(createMockReq(), res, { workspaceDir: '/w', authenticationMode: 'no_auth' });

    const body = payload();
    const envelope = body?.data as Record<string, unknown> | undefined;
    const block = envelope?.codexGovernance as Record<string, unknown>;
    expect(block.status).toBe('ok');
    expect(block.ready).toBe(false);
    expect(block.readyBlockers).toEqual(['consent: not granted']);
  });

  it('ready=true passes through only when the CLI authority says so', async () => {
    mockCollect.mockResolvedValue({ status: 'ok', health: okHealth() });
    const { res, payload } = createMockRes();

    await handleHealthRoute(createMockReq(), res, { workspaceDir: '/w', authenticationMode: 'no_auth' });

    const envelope = payload()?.data as Record<string, unknown> | undefined;
    const block = envelope?.codexGovernance as Record<string, unknown>;
    expect(block.ready).toBe(true);
    expect(block.productClaim).toBe('rev2_automatic_closure');
  });
});
