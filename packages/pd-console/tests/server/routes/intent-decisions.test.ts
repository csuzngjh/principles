import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import * as yaml from 'js-yaml';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { handleIntentDecisionsRoute, disposeIntentDecisionModels } from '../../../src/server/routes/intent-decisions.js';

let workspaceDir: string;
let pdDir: string;

// ── Mock req/res helpers ────────────────────────────────────────────────────

function makeGetReq(url: string): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url });
  return req as unknown as IncomingMessage;
}

function makePostReq(url: string, body: unknown): IncomingMessage {
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', url });
  // Defer emit so readBody's listeners attach first.
  setImmediate(() => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    req.emit('data', Buffer.from(bodyStr, 'utf8'));
    req.emit('end');
  });
  return req as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: unknown, code: number) {
      (res as { statusCode: number }).statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (res as { _body: string })._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function getBody(res: ServerResponse): string {
  return (res as unknown as { _body: string })._body;
}

function getStatus(res: ServerResponse): number {
  return (res as unknown as { statusCode: number }).statusCode;
}

function parseBody(res: ServerResponse): { success: boolean; data: Record<string, unknown> } {
  return JSON.parse(getBody(res)) as { success: boolean; data: Record<string, unknown> };
}

function parseError(res: ServerResponse): {
  success: boolean;
  error: string;
  message: string;
  reason?: string;
  nextAction?: string;
} {
  return JSON.parse(getBody(res)) as {
    success: boolean;
    error: string;
    message: string;
    reason?: string;
    nextAction?: string;
  };
}

// ── Workspace setup ─────────────────────────────────────────────────────────

function writeConfig(intentEnabled: boolean): void {
  const config = {
    version: 1,
    features: { intent_engineering: { category: 'quiet', enabled: intentEnabled } },
    runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yaml.dump(config), 'utf8');
}

/** Pre-create state.db with the full schema (incl. intent_decisions table). */
function initStateDb(): void {
  const conn = new SqliteConnection({ workspaceDir });
  conn.getDb(); // triggers lazy open + initSchema
  conn.close();
}

const VALID_INPUT = {
  id: 'idr-001',
  painId: 'pain-001',
  taskId: 'task-001',
  runId: 'run-001',
  intentDocHash: 'sha256:abc123',
  source: 'action_drift',
  evidenceStrength: 'moderate',
  relatedIntentFields: ['why', 'desired_outcome'],
  ownerAction: 'confirm_drift',
  evidenceRefs: ['ev-1', 'ev-2'],
  note: 'test note',
};

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-decisions-'));
  pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  writeConfig(true);
  initStateDb();
});

afterEach(() => {
  disposeIntentDecisionModels();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Feature flag gate ───────────────────────────────────────────────────────

describe('IntentDecisions route — flag gate', () => {
  it('returns 403 when intent_engineering is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentDecisionsRoute(makeGetReq('/api/v1/intent-decisions'), res, workspaceDir, '');
    expect(getStatus(res)).toBe(403);
    const body = parseError(res);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('flag_disabled');
    expect(body.nextAction).toContain('intent_engineering');
  });

  it('returns 403 when no config exists (defaults)', async () => {
    fs.unlinkSync(path.join(pdDir, 'config.yaml'));
    const res = makeRes();
    await handleIntentDecisionsRoute(makeGetReq('/api/v1/intent-decisions'), res, workspaceDir, '');
    expect(getStatus(res)).toBe(403);
    expect(parseError(res).reason).toBe('flag_disabled');
  });
});

// ── POST create ─────────────────────────────────────────────────────────────

describe('IntentDecisions route — POST create', () => {
  it('returns 201 with the created record', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(201);
    const parsed = parseBody(res);
    expect(parsed.success).toBe(true);
    expect(parsed.data.id).toBe('idr-001');
    expect(parsed.data.painId).toBe('pain-001');
    expect(parsed.data.source).toBe('action_drift');
    expect(parsed.data.ownerAction).toBe('confirm_drift');
    expect(parsed.data.evidenceRefs).toEqual(['ev-1', 'ev-2']);
    expect(parsed.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 200 with created=false on idempotent replay', async () => {
    // First POST → 201
    const res1 = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      res1,
      workspaceDir,
      '',
    );
    expect(getStatus(res1)).toBe(201);

    // Second POST with same painId + intentDocHash + ownerAction → 200, created=false
    const replayInput = { ...VALID_INPUT, id: 'idr-002-different-id' };
    const res2 = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', replayInput),
      res2,
      workspaceDir,
      '',
    );
    expect(getStatus(res2)).toBe(200);
    const parsed = parseBody(res2);
    expect(parsed.success).toBe(true);
    // Idempotent replay returns the ORIGINAL record (idr-001), not the new id.
    expect(parsed.data.id).toBe('idr-001');
  });

  it('truncates evidenceRefs to 3 items', async () => {
    const input = {
      ...VALID_INPUT,
      id: 'idr-trunc',
      evidenceRefs: ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
    };
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', input),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(201);
    const parsed = parseBody(res);
    expect(parsed.data.evidenceRefs).toEqual(['ev-1', 'ev-2', 'ev-3']);
  });
});

// ── POST validation ─────────────────────────────────────────────────────────

describe('IntentDecisions route — POST validation', () => {
  it('returns 400 when body is invalid JSON', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', '{not valid json'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
  });

  it('returns 400 when id is missing', async () => {
    const { id: _omit, ...noId } = VALID_INPUT;
    void _omit;
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', noId),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    const body = parseError(res);
    expect(body.message).toContain('id');
  });

  it('returns 400 when source is invalid', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, source: 'bogus' }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('source');
  });

  it('returns 400 when evidenceStrength is invalid', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, evidenceStrength: 'bogus' }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('evidenceStrength');
  });

  it('returns 400 when ownerAction is invalid', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, ownerAction: 'bogus' }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('ownerAction');
  });

  it('returns 400 when relatedIntentFields contains an invalid field', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, relatedIntentFields: ['why', 'bogus'] }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('relatedIntentFields');
  });

  it('returns 400 when evidenceRefs is not an array', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, evidenceRefs: 'not-an-array' }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('evidenceRefs');
  });

  it('returns 400 when an optional field has the wrong type', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', { ...VALID_INPUT, note: 123 }),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('note');
  });
});

// ── GET list ────────────────────────────────────────────────────────────────

describe('IntentDecisions route — GET list', () => {
  it('returns 400 when neither painId nor taskId is provided', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('painId or taskId');
  });

  it('returns 400 when both painId and taskId are provided', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions?painId=p1&taskId=t1'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('not both');
  });

  it('lists records by painId', async () => {
    // Seed a record
    const seedRes = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      seedRes,
      workspaceDir,
      '',
    );
    expect(getStatus(seedRes)).toBe(201);

    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions?painId=pain-001'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.id).toBe('idr-001');
  });

  it('lists records by taskId', async () => {
    const seedRes = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      seedRes,
      workspaceDir,
      '',
    );
    expect(getStatus(seedRes)).toBe(201);

    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions?taskId=task-001'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.taskId).toBe('task-001');
  });

  it('returns empty array for unknown painId', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions?painId=nonexistent'),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.data).toEqual([]);
  });
});

// ── GET /:id ────────────────────────────────────────────────────────────────

describe('IntentDecisions route — GET /:id', () => {
  it('returns 200 with the record when found', async () => {
    const seedRes = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      seedRes,
      workspaceDir,
      '',
    );
    expect(getStatus(seedRes)).toBe(201);

    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/idr-001'),
      res,
      workspaceDir,
      '/idr-001',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.data.id).toBe('idr-001');
  });

  it('returns 404 when the record is not found', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/nonexistent'),
      res,
      workspaceDir,
      '/nonexistent',
    );
    expect(getStatus(res)).toBe(404);
  });
});

// ── GET /summary + route precedence ─────────────────────────────────────────

describe('IntentDecisions route — GET /summary and route precedence', () => {
  it('returns 200 with empty summary when no records exist', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/summary'),
      res,
      workspaceDir,
      '/summary',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.data.counts).toBeDefined();
    const counts = parsed.data.counts as Record<string, number>;
    expect(counts.confirm_drift).toBe(0);
    expect(counts.observe).toBe(0);
    expect(parsed.data.lastDecisionAt).toBeNull();
  });

  it('returns tallied counts after records are created', async () => {
    // Seed two records with different ownerActions
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', VALID_INPUT),
      makeRes(),
      workspaceDir,
      '',
    );
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', {
        ...VALID_INPUT,
        id: 'idr-002',
        painId: 'pain-002',
        ownerAction: 'observe',
      }),
      makeRes(),
      workspaceDir,
      '',
    );

    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/summary'),
      res,
      workspaceDir,
      '/summary',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    const counts = parsed.data.counts as Record<string, number>;
    expect(counts.confirm_drift).toBe(1);
    expect(counts.observe).toBe(1);
    expect(parsed.data.lastDecisionAt).not.toBeNull();
  });

  it('matches /summary BEFORE /:id (route precedence)', async () => {
    // If /:id matched first, GET /summary would 404 ("Intent decision summary not found").
    // Since /summary matches first, it returns the summary object.
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/summary'),
      res,
      workspaceDir,
      '/summary',
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    // The summary has a `counts` field; a 404 /:id response would not.
    expect(parsed.data.counts).toBeDefined();
  });
});

// ── Unknown route ───────────────────────────────────────────────────────────

describe('IntentDecisions route — unknown sub-path', () => {
  it('returns 404 for an unmatched sub-path', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq('/api/v1/intent-decisions/foo/bar'),
      res,
      workspaceDir,
      '/foo/bar',
    );
    expect(getStatus(res)).toBe(404);
  });

  it('returns 404 for PUT (unmatched method falls through)', async () => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'PUT', url: '/api/v1/intent-decisions' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      req as unknown as IncomingMessage,
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(404);
  });
});
