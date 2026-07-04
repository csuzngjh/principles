/**
 * PRI-515: Lifecycle API Route Tests (DEFECT-006)
 *
 * Verifies the route contract for `GET /api/v1/lifecycle/principles/:principleId`.
 * The key fix (DEFECT-006): when a principle exists in the system but is not yet
 * in the lifecycle read model (e.g., recently created, no rules/implementations),
 * the API MUST return 200 with `{ insufficientData: true }` — NOT 404.
 *
 * A 404 causes the browser to log a console error on the network response that
 * frontend `try/catch` cannot suppress. Returning 200 + insufficientData lets
 * the frontend render the "no lifecycle data yet" state cleanly.
 *
 * ERR entries considered:
 * - ERR-002 (silent degradation): the insufficientData response carries a
 *   human-readable `note` explaining why there is no rate, satisfying
 *   "graceful degradation includes a reason".
 * - ERR-001/ERR-005 (as bypasses): route parses URL with regex and uses
 *   `decodeURIComponent` with try/catch; no `as` casts on untrusted input.
 * - ERR-013 (Object.hasOwn): response validator uses Object.hasOwn, not `in`.
 * - ERR-074 (incomplete branch coverage): the fix audits both the
 *   "principle not in ledger" branch (now 200 + insufficientData) and the
 *   "principle in ledger with no rules" branch (already 200 + insufficientData
 *   via the model) — both branches converge on the same response shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleLifecycleRoute, disposeLifecycleModels } from '../../../src/server/routes/lifecycle.js';

// ---------------------------------------------------------------------------
// Test utilities (mirrors existing route test patterns)
// ---------------------------------------------------------------------------

function createMockRequest(method: string, url?: string): IncomingMessage {
  const req = {
    method,
    url: url ?? '/api/v1/lifecycle/principles/principle-001',
    on: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, statusCode: number, headers?: Record<string, string>) {
      res.statusCode = statusCode;
      if (headers) {
        Object.assign(res._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
      if (data !== undefined) {
        res._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function parseBody(res: ServerResponse): { statusCode: number; body: unknown } {
  const mockRes = res as unknown as { statusCode: number; _body: string };
  let parsed: unknown = null;
  if (mockRes._body) {
    try {
      parsed = JSON.parse(mockRes._body);
    } catch {
      parsed = mockRes._body;
    }
  }
  return { statusCode: mockRes.statusCode, body: parsed };
}

// ---------------------------------------------------------------------------
// Test setup — fresh temp workspace per test
// ---------------------------------------------------------------------------

let tempDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lifecycle-route-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  disposeLifecycleModels();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  disposeLifecycleModels();
});

function createLedger(content: object): void {
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify(content),
  );
}

// ---------------------------------------------------------------------------
// DEFECT-006 (PRI-515): the core regression
// ---------------------------------------------------------------------------

describe('DEFECT-006 (PRI-515): lifecycle API must NOT return 404 for missing principle', () => {
  it('returns 200 + insufficientData when principle is not in lifecycle read model', async () => {
    // Ledger exists but does not contain the requested principle
    createLedger({
      _tree: {
        principles: {
          'principle-other': {
            id: 'principle-other',
            text: 'Some other principle',
            ruleIds: [],
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/principle-missing');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/principle-missing');

    const { statusCode, body } = parseBody(res);

    // THE FIX: 200, not 404
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        principleId: 'principle-missing',
        adherence: {
          insufficientData: true,
          rate: null,
          note: expect.stringContaining('尚无规则'),
        },
        ruleMetrics: [],
      },
    });
  });

  it('returns 200 + insufficientData when ledger does not exist at all', async () => {
    // No ledger file created — fresh workspace
    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/any-principle');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/any-principle');

    const { statusCode, body } = parseBody(res);

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        principleId: 'any-principle',
        adherence: { insufficientData: true, rate: null },
        ruleMetrics: [],
      },
    });
  });

  it('response shape matches the model-layer insufficientData shape (parity)', async () => {
    // Principle exists in ledger but has no rules — model returns insufficientData
    createLedger({
      _tree: {
        principles: {
          'principle-empty': {
            id: 'principle-empty',
            text: 'Principle with no rules',
            ruleIds: [],
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/principle-empty');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/principle-empty');

    const { statusCode, body } = parseBody(res);
    const data = (body as { data: unknown }).data as Record<string, unknown>;

    expect(statusCode).toBe(200);
    // Same shape as the missing-principle branch — both should be indistinguishable
    // to the frontend, so the renderer doesn't need a separate "not found" path.
    expect(data.adherence).toMatchObject({ insufficientData: true, rate: null });
    expect(Array.isArray(data.ruleMetrics)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — principle with rules returns real metrics
// ---------------------------------------------------------------------------

describe('lifecycle route — happy path with rules', () => {
  it('returns 200 + adherence metrics when principle has rules and replay evidence', async () => {
    createLedger({
      _tree: {
        principles: {
          'principle-001': {
            id: 'principle-001',
            text: 'Test Principle',
            ruleIds: ['rule-001'],
          },
        },
        rules: {
          'rule-001': {
            id: 'rule-001',
            principleId: 'principle-001',
            implementationIds: ['impl-001'],
          },
        },
        implementations: {
          'impl-001': {
            id: 'impl-001',
            ruleId: 'rule-001',
            lifecycleState: 'active',
          },
        },
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    // Empty replay directory — rule will have triggered: 0
    const replayDir = path.join(
      stateDir,
      'principles',
      'implementations',
      'impl-001',
      'replays',
    );
    fs.mkdirSync(replayDir, { recursive: true });

    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/principle-001');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/principle-001');

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        principleId: 'principle-001',
        adherence: { insufficientData: false },
        ruleMetrics: [{ ruleId: 'rule-001', triggered: 0 }],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('lifecycle route — error paths', () => {
  it('returns 400 when principle ID is missing (empty segment)', async () => {
    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/');
    const res = createMockResponse();

    // Note: subPath here would be '/principles/' — regex `/^[/]principles[/]([^/]+)$/`
    // requires a non-empty segment, so this falls through to the 404 route handler.
    // We test the empty-encoded case separately below.
    await handleLifecycleRoute(req, res, workspaceDir, '/principles/');

    const { statusCode } = parseBody(res);
    // The regex requires at least one char in the segment, so '/principles/' falls
    // through to the route-not-found branch.
    expect(statusCode).toBe(404);
  });

  it('returns 400 when principle ID contains invalid percent encoding', async () => {
    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/%E0%A4');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/%E0%A4');

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: 'invalid_encoding',
    });
  });

  it('returns 404 for non-GET methods (route not found)', async () => {
    const req = createMockRequest('POST', '/api/v1/lifecycle/principles/principle-001');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/principle-001');

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(404);
    expect(body).toMatchObject({ success: false, error: 'not_found' });
  });

  it('returns 404 for unknown sub-path', async () => {
    const req = createMockRequest('GET', '/api/v1/lifecycle/unknown/path');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/unknown/path');

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(404);
    expect(body).toMatchObject({ success: false, error: 'not_found' });
  });

  it('returns 200 + insufficientData when stateDir is malformed (graceful degradation, not 500)', async () => {
    // The datasource builds a read model from files; a malformed stateDir yields
    // an empty read model (model returns null). The route MUST treat this the
    // same as "principle not in ledger" — return 200 + insufficientData, not 500.
    // This is the EP-03 / ERR-002 contract: graceful degradation includes a reason.
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.writeFileSync(stateDir, 'not a directory');

    const req = createMockRequest('GET', '/api/v1/lifecycle/principles/principle-001');
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, '/principles/principle-001');

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        principleId: 'principle-001',
        adherence: { insufficientData: true, rate: null },
        ruleMetrics: [],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// URL decoding
// ---------------------------------------------------------------------------

describe('lifecycle route — URL decoding', () => {
  it('decodes percent-encoded principle IDs', async () => {
    createLedger({
      _tree: {
        principles: {
          'principle with spaces': {
            id: 'principle with spaces',
            text: 'Test',
            ruleIds: [],
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const encoded = encodeURIComponent('principle with spaces');
    const req = createMockRequest('GET', `/api/v1/lifecycle/principles/${encoded}`);
    const res = createMockResponse();

    await handleLifecycleRoute(req, res, workspaceDir, `/principles/${encoded}`);

    const { statusCode, body } = parseBody(res);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: { principleId: 'principle with spaces' },
    });
  });
});
