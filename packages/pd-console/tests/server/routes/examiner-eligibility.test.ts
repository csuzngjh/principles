/**
 * SPEC-PD-EXAMINER-001 — Phase C: Study eligibility pre-check.
 *
 * Pins the two contracts the mandate makes non-negotiable:
 *   1. `GET /principles/:id/eligibility` is READ-ONLY — it answers "would a
 *      study be creatable right now" without writing a single byte.
 *   2. The pre-check and `POST /studies` share ONE server-side authority, so
 *      "pre-check ELIGIBLE but creation fails" and "pre-check BLOCKED but
 *      creation succeeds" are both impossible.
 *
 * The fixtures use the REAL workspace ledger and the REAL lab modules (no
 * mocks): status eligibility comes from `buildHostEffectivePrincipleSet`, and
 * RuleCode identifiability from `buildRuleCodePolicy`.
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

function ledgerPrinciple(id: string, status: string, ruleIds: string[]): Record<string, unknown> {
  return {
    id,
    text: `fixture ${id}`,
    triggerPattern: 't',
    action: 'a',
    status,
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 1,
    adherenceRate: 1,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    version: 1,
  };
}

let tempDir: string;
let workspaceDir: string;
let studiesRoot: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-examiner-eligibility-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          // active, no RuleCode → the happy path
          'pri-target': ledgerPrinciple('pri-target', 'active', []),
          // non-active → status eligibility must refuse
          'pri-archived': ledgerPrinciple('pri-archived', 'archived', []),
          // active but the workspace attributes a RuleCode with no runtime row
          // → the lab cannot identify the principle's independent effect
          'pri-coupled': ledgerPrinciple('pri-coupled', 'active', ['rc-fixture-1']),
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
  // The real server strips the query string before routing; the request URL
  // keeps it (routes read `?mode=`/`?suite=` from there).
  const queryIndex = subPath.indexOf('?');
  const pathOnly = queryIndex === -1 ? subPath : subPath.slice(0, queryIndex);
  await handleExaminerRoute(createMockRequest(method, subPath, body), res, workspaceDir, pathOnly);
  return parseBody(res);
}

function listStudiesRoot(): string[] {
  return fs.readdirSync(studiesRoot).sort();
}

describe('GET /principles/:id/eligibility — read-only pre-check (Phase C1)', () => {
  it('reports a usable verdict for an active, identifiable principle without creating anything', async () => {
    const before = listStudiesRoot();
    const { statusCode, body } = await call('GET', '/principles/pri-target/eligibility');
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(['ELIGIBLE', 'DEGRADED']).toContain(body.data.status);
    expect(body.data.principleId).toBe('pri-target');
    expect(body.data.blockingReasonCode).toBeNull();
    expect(body.data.reasonCode).toBeNull();
    // ELIGIBLE means "nothing to act on"; a DEGRADED verdict must explain the
    // degraded production condition instead of silently reading as healthy.
    if (body.data.status === 'ELIGIBLE') {
      expect(body.data.nextAction).toBeNull();
    } else {
      expect(typeof body.data.nextAction).toBe('string');
      expect(body.data.nextAction.length).toBeGreaterThan(0);
    }
    expect(typeof body.data.summary).toBe('string');
    expect(body.data.summary.length).toBeGreaterThan(0);
    expect(body.data.experimentMode).toBe('full_library_incremental');
    expect(body.data.suiteKey).toBe('didactic-pair');
    expect(Array.isArray(body.data.checks)).toBe(true);

    const ids = body.data.checks.map((check: any) => check.id);
    // One row per documented check, in the documented order — a repeated id
    // would make the panel ambiguous and hide which condition was evaluated.
    expect(ids).toEqual([
      'experiment_mode',
      'principle_exists',
      'principle_status',
      'production_snapshot',
      'activation_evidence',
      'rulecode_identifiability',
      'experiment_configuration',
      'suite_available',
      'study_root_writable',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(body.data.checks.find((check: any) => check.id === 'principle_status').status).toBe('PASS');
    // Evidence that could not be read is never reported as a PASS.
    const activation = body.data.checks.find((check: any) => check.id === 'activation_evidence');
    if (activation.status !== 'PASS') {
      expect(activation.reasonCode).not.toBe('activation_evidence_present');
    }

    // The pre-check is read-only by contract: no study directory appeared.
    expect(listStudiesRoot()).toEqual(before);
    // No workspace path or stack leaks into the operator payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(tempDir);
  });

  it('refuses a non-active principle with an actionable reason (Phase C3/C4)', async () => {
    const { statusCode, body } = await call('GET', '/principles/pri-archived/eligibility');
    expect(statusCode).toBe(200);
    expect(body.data.status).toBe('BLOCKED');
    expect(body.data.blockingReasonCode).toBe('principle_not_active');
    const statusCheck = body.data.checks.find((check: any) => check.id === 'principle_status');
    expect(statusCheck.status).toBe('BLOCKED');
    expect(statusCheck.reasonCode).toBe('principle_not_active');
    expect(statusCheck.evidence).toContain('status:archived');
    expect(typeof statusCheck.nextAction).toBe('string');
    expect(statusCheck.nextAction.length).toBeGreaterThan(0);
    expect(listStudiesRoot()).toEqual([]);
  });

  it('refuses an unknown principle id even though the id is well-formed', async () => {
    const { statusCode, body } = await call('GET', '/principles/pri-missing/eligibility');
    expect(statusCode).toBe(200);
    expect(body.data.status).toBe('BLOCKED');
    expect(body.data.blockingReasonCode).toBe('principle_not_found');
  });

  it('refuses a target whose RuleCode baseline is unresolved (intervention not identifiable)', async () => {
    const { statusCode, body } = await call('GET', '/principles/pri-coupled/eligibility');
    expect(statusCode).toBe(200);
    expect(body.data.status).toBe('BLOCKED');
    expect(body.data.blockingReasonCode).toBe('intervention_not_identifiable');
    const ruleCodeCheck = body.data.checks.find((check: any) => check.id === 'rulecode_identifiability');
    expect(ruleCodeCheck.status).toBe('BLOCKED');
    // The explanation is about attribution, never a bare internal enum.
    expect(ruleCodeCheck.detail).toContain('RuleCode');
    expect(typeof ruleCodeCheck.nextAction).toBe('string');
  });

  it('runs the same refusal in the isolated-principle mode', async () => {
    const { body } = await call('GET', '/principles/pri-coupled/eligibility?mode=isolated_principle');
    expect(body.data.status).toBe('BLOCKED');
    expect(body.data.experimentMode).toBe('isolated_principle');
    expect(body.data.blockingReasonCode).toBe('intervention_not_identifiable');
  });

  it('falls back to the v0.9 default suite exactly like creation does', async () => {
    const { body } = await call('GET', '/principles/pri-target/eligibility?suite=not-a-suite');
    expect(body.data.suiteKey).toBe('didactic-pair');
    const suiteCheck = body.data.checks.find((check: any) => check.id === 'suite_available');
    expect(suiteCheck.status).toBe('PASS');
  });

  it('does not answer for a malformed principle id (route membership, not substring)', async () => {
    const { statusCode } = await call('GET', '/principles/bad%20id!/eligibility');
    expect(statusCode).not.toBe(200);
  });
});

describe('POST /studies re-runs the same eligibility authority (Phase C2)', () => {
  it('refuses creation for a BLOCKED principle with a structured reason and writes nothing', async () => {
    const before = listStudiesRoot();
    const refused = await call('POST', '/studies', { targetPrincipleId: 'pri-archived' });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe('study_creation_refused');
    expect(refused.body.reason).toBe('principle_not_active');
    expect(typeof refused.body.nextAction).toBe('string');
    expect(refused.body.nextAction.length).toBeGreaterThan(0);
    expect(refused.body.blockingReasonCode).toBe('principle_not_active');
    expect(refused.body.eligibility.status).toBe('BLOCKED');
    expect(listStudiesRoot()).toEqual(before);
  });

  it('refuses creation for a coupled principle and never writes a study directory', async () => {
    const refused = await call('POST', '/studies', { targetPrincipleId: 'pri-coupled' });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.blockingReasonCode).toBe('intervention_not_identifiable');
    expect(listStudiesRoot()).toEqual([]);
  });

  it('pre-check verdict and creation outcome agree for every fixture principle', async () => {
    for (const principleId of ['pri-target', 'pri-archived', 'pri-coupled']) {
      const eligibility = await call('GET', `/principles/${principleId}/eligibility`);
      const created = await call('POST', '/studies', { targetPrincipleId: principleId });
      const preCheckBlocked = eligibility.body.data.status === 'BLOCKED';
      const creationRefused = created.statusCode === 422;
      expect({ principleId, preCheckBlocked }).toEqual({ principleId, preCheckBlocked: creationRefused });
    }
  });

  it('creates the study when the pre-check is not blocked, freezing the SAME snapshot facts', async () => {
    const eligibility = await call('GET', '/principles/pri-target/eligibility');
    expect(['ELIGIBLE', 'DEGRADED']).toContain(eligibility.body.data.status);

    const created = await call('POST', '/studies', {
      targetPrincipleId: 'pri-target',
      experimentMode: 'full_library_incremental',
    });
    expect(created.statusCode).toBe(200);
    const studyId = created.body.data.studyId as string;
    expect(created.body.data.productionSnapshotMarkers).toEqual(eligibility.body.data.productionSnapshotMarkers);

    // The frozen snapshot on disk agrees with the pre-check's reported facts.
    const frozen = JSON.parse(fs.readFileSync(path.join(studiesRoot, studyId, 'production-snapshot.json'), 'utf8'));
    expect(frozen.targetPrincipleId).toBe('pri-target');
    expect(frozen.schema).toBe('examiner-production-snapshot.v1');
  });
});
