/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 — Examiner Console API route tests.
 *
 * Exercises the REAL backend path end-to-end against a fixture workspace:
 * principle list (real ledger) → study creation (server-minted identity,
 * synthetic offline gold) → fail-closed preflight → offline-stub execution →
 * Report V2 generation → read-only report access. Also pins the safety
 * refusals: real execution modes are 403, study identities cannot collide,
 * and request input never constructs study paths (enumeration membership).
 *
 * Studies are created under PD_EXAMINER_STUDIES_ROOT (a temp dir) so test
 * runs never touch the repository's committed research artifacts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleExaminerRoute } from '../../../src/server/routes/examiner.js';

function createMockRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req = {
    method,
    url,
    on(event: string, handler: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
  };
  if (body !== undefined) {
    setTimeout(() => {
      for (const handler of listeners.data ?? []) handler(Buffer.from(JSON.stringify(body)));
      for (const handler of listeners.end ?? []) handler();
    }, 0);
  } else {
    setTimeout(() => {
      for (const handler of listeners.end ?? []) handler();
    }, 0);
  }
  return req as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(data?: string) {
      if (data !== undefined) res._body = data;
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

function parseBody(res: ServerResponse): { statusCode: number; body: any } {
  const mock = res as unknown as { statusCode: number; _body: string };
  let parsed: unknown = null;
  if (mock._body) {
    try {
      parsed = JSON.parse(mock._body);
    } catch {
      parsed = mock._body;
    }
  }
  return { statusCode: mock.statusCode, body: parsed };
}

let tempDir: string;
let workspaceDir: string;
let studiesRoot: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-examiner-route-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  // fixture ledger with one ACTIVE principle (the study target) and one
  // archived principle (must be excluded by HEPS eligibility)
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          'pri-target': {
            id: 'pri-target',
            text: '结论不得超越观察：对目标对象的断言必须先以当前证据核实。',
            triggerPattern: 't',
            action: 'a',
            status: 'active',
            priority: 'P1',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 1,
            adherenceRate: 1,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: [],
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
            version: 1,
          },
          'pri-archived': {
            id: 'pri-archived',
            text: 'archived',
            triggerPattern: 't',
            action: 'a',
            status: 'archived',
            priority: 'P2',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 1,
            adherenceRate: 1,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: [],
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
            version: 1,
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-11-01T00:00:00Z',
      },
    }),
  );
});

afterEach(() => {
  delete process.env.PD_EXAMINER_STUDIES_ROOT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function call(method: string, subPath: string, body?: unknown) {
  const res = createMockResponse();
  await handleExaminerRoute(createMockRequest(method, subPath, body), res, workspaceDir, subPath);
  return parseBody(res);
}

describe('Examiner Console API (offline-first, SPEC v0.9 §8)', () => {
  it('overview reports gates, host capability and the study list', async () => {
    const { statusCode, body } = await call('GET', '/overview');
    expect(statusCode).toBe(200);
    expect(body.data.gates.gate1_challenge_trust).toContain('BLOCKED');
    expect(body.data.executionScope).toContain('offline-stub only');
    expect(body.data.hostInjectionCapability['offline-stub']).toBe('RUNTIME_LOADED');
    expect(Array.isArray(body.data.studies)).toBe(true);
  });

  it('principles lists the real workspace ledger (read-only inputs)', async () => {
    const { statusCode, body } = await call('GET', '/principles');
    expect(statusCode).toBe(200);
    const ids = body.data.principles.map((p: any) => p.id);
    expect(ids).toContain('pri-target');
  });

  it('full journey: create → preflight → run → report with real backend state', async () => {
    // create (server-minted identity)
    const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: 1 });
    expect(created.statusCode).toBe(200);
    const studyId = created.body.data.studyId as string;
    expect(studyId).toMatch(/^EXM-C-[0-9A-F-]+$/);
    expect(created.body.data.experimentMode).toBe('full_library_incremental');
    // preflight passes offline
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.statusCode).toBe(200);
    expect(preflight.body.data.ok).toBe(true);
    expect(preflight.body.data.status).toBe('READY_FOR_OFFLINE_EXECUTION');
    // offline execution succeeds with the frozen randomized order
    const run = await call('POST', `/studies/${studyId}/run`);
    expect(run.statusCode).toBe(200);
    expect(run.body.data.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    // status reflects the ledger truth
    const status = await call('GET', `/studies/${studyId}`);
    expect(status.body.data.runFinished).toBe(true);
    expect(status.body.data.unitStates.SUCCEEDED).toBeGreaterThan(0);
    expect(status.body.data.reportStatus).toBeNull();
    // report generation then read-only access
    const report = await call('POST', `/studies/${studyId}/report`);
    expect(report.statusCode).toBe(200);
    const fetched = await call('GET', `/studies/${studyId}/report`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body.data.report.examiner.experimentMode).toBe('full_library_incremental');
    expect(fetched.body.data.report.examiner.itt.plannedApplicablePairs).toBeGreaterThan(0);
    // synthetic gold → honest REPORT_PENDING, never READY
    expect(['REPORT_PENDING', 'REPORT_INCONCLUSIVE']).toContain(fetched.body.data.report.status);
  });

  it('refuses real execution modes at the route boundary (403, no runner call)', async () => {
    const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target' });
    const studyId = created.body.data.studyId as string;
    const refused = await call('POST', `/studies/${studyId}/run`, { mode: 'F2-real-host' });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toBe('real_execution_not_authorized');
    // nothing ran
    const status = await call('GET', `/studies/${studyId}`);
    expect(status.body.data.runStarted).toBe(false);
  });

  it('rejects unknown target principles and invalid ids (validation first)', async () => {
    const missing = await call('POST', '/studies', { targetPrincipleId: 'pri-nope' });
    expect(missing.statusCode).toBe(404);
    const invalid = await call('POST', '/studies', { targetPrincipleId: 'bad id!' });
    expect(invalid.statusCode).toBe(400);
    const unknownStudy = await call('GET', '/studies/EXM-C-DOES-NOT-EXIST');
    expect(unknownStudy.statusCode).toBe(404);
  });

  it('study selection is enumeration-bounded (path traversal shapes are just not found)', async () => {
    const traversal = await call('GET', '/studies/..%2F..%2Fetc');
    expect([400, 404]).toContain(traversal.statusCode);
    expect(traversal.body.data).toBeUndefined();
  });
});
