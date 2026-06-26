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
    // P0 fix (PRI-471): response envelope is { record, created }
    expect(parsed.data.created).toBe(true);
    expect(parsed.data.record.id).toBe('idr-001');
    expect(parsed.data.record.painId).toBe('pain-001');
    expect(parsed.data.record.source).toBe('action_drift');
    expect(parsed.data.record.ownerAction).toBe('confirm_drift');
    expect(parsed.data.record.evidenceRefs).toEqual(['ev-1', 'ev-2']);
    expect(parsed.data.record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    expect(parsed.data.created).toBe(false);
    expect(parsed.data.record.id).toBe('idr-001');
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
    expect(parsed.data.record.evidenceRefs).toEqual(['ev-1', 'ev-2', 'ev-3']);
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

// ── PRI-471: POST /:id/follow-up (SPEC §22.1.4) ────────────────────────────

describe('IntentDecisions route — POST /:id/follow-up', () => {
  async function seedDecision(overrides: Partial<typeof VALID_INPUT> = {}): Promise<string> {
    const input = { ...VALID_INPUT, ...overrides };
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions', input),
      res,
      workspaceDir,
      '',
    );
    expect(getStatus(res)).toBe(201);
    const parsed = parseBody(res);
    // P0 fix (PRI-471): response envelope is { record, created }
    return parsed.data.record.id as string;
  }

  // ── guide_rulehost ──────────────────────────────────────────────────────
  it('guide_rulehost returns 200 with CLI command + note (no DB write)', async () => {
    const id = await seedDecision({ ownerAction: 'promote_to_rulehost' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { type: 'guide_rulehost' }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.success).toBe(true);
    expect(parsed.data.type).toBe('guide_rulehost');
    expect(parsed.data.decisionId).toBe(id);
    expect(typeof parsed.data.cliCommand).toBe('string');
    expect(parsed.data.cliCommand.length).toBeGreaterThan(0);
    expect(typeof parsed.data.note).toBe('string');
    // The note should mention that an approval will be created.
    expect(parsed.data.note.toLowerCase()).toContain('approval');
  });

  it('guide_rulehost returns 404 when the decision does not exist', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions/nonexistent/follow-up', { type: 'guide_rulehost' }),
      res,
      workspaceDir,
      '/nonexistent/follow-up',
    );
    expect(getStatus(res)).toBe(404);
  });

  // ── generate_patch_proposal ─────────────────────────────────────────────
  it('generate_patch_proposal returns 200 with markdown + sets patchProposalId on the record', async () => {
    const id = await seedDecision({ ownerAction: 'revise_intent' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { type: 'generate_patch_proposal' }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.success).toBe(true);
    expect(parsed.data.type).toBe('generate_patch_proposal');
    expect(parsed.data.decisionId).toBe(id);
    expect(parsed.data.record.id).toBe(id);
    // patchProposalId is set on the updated record (deterministic id from decisionId).
    expect(parsed.data.record.patchProposalId).toBe(`patch-${id}`);
    // The patch proposal markdown contains the SPEC §10 sections.
    expect(typeof parsed.data.patchProposal.markdown).toBe('string');
    expect(parsed.data.patchProposal.markdown).toContain('Intent Patch Proposal');
    expect(parsed.data.patchProposal.markdown).toContain('Display only');
    // The proposal id is deterministic.
    expect(parsed.data.patchProposal.id).toBe(`patch-${id}`);
  });

  it('generate_patch_proposal returns 404 when the decision does not exist', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions/nonexistent/follow-up', { type: 'generate_patch_proposal' }),
      res,
      workspaceDir,
      '/nonexistent/follow-up',
    );
    expect(getStatus(res)).toBe(404);
  });

  it('generate_patch_proposal persists patchProposalId across a fresh GET', async () => {
    const id = await seedDecision({ ownerAction: 'revise_intent' });
    // Dispatch follow-up
    const dispatchRes = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { type: 'generate_patch_proposal' }),
      dispatchRes,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(dispatchRes)).toBe(200);

    // Fresh GET — the persisted patchProposalId must be there (EP-07 / ERR-015).
    const getRes = makeRes();
    await handleIntentDecisionsRoute(
      makeGetReq(`/api/v1/intent-decisions/${id}`),
      getRes,
      workspaceDir,
      `/${id}`,
    );
    expect(getStatus(getRes)).toBe(200);
    const parsed = parseBody(getRes);
    expect(parsed.data.patchProposalId).toBe(`patch-${id}`);
  });

  // ── link_candidate ──────────────────────────────────────────────────────
  it('link_candidate returns 200 with the linked candidate id + sets resultingCandidateId', async () => {
    const id = await seedDecision({ ownerAction: 'confirm_drift' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, {
        type: 'link_candidate',
        candidateId: 'cand-from-evidence',
      }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(200);
    const parsed = parseBody(res);
    expect(parsed.success).toBe(true);
    expect(parsed.data.type).toBe('link_candidate');
    expect(parsed.data.decisionId).toBe(id);
    expect(parsed.data.record.id).toBe(id);
    expect(parsed.data.record.resultingCandidateId).toBe('cand-from-evidence');
    expect(parsed.data.linkedCandidateId).toBe('cand-from-evidence');
  });

  it('link_candidate returns 400 when candidateId is missing', async () => {
    const id = await seedDecision({ ownerAction: 'confirm_drift' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { type: 'link_candidate' }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(400);
    const body = parseError(res);
    expect(body.message).toContain('candidateId');
  });

  it('link_candidate returns 400 when candidateId is an empty string', async () => {
    const id = await seedDecision({ ownerAction: 'confirm_drift' });
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, {
        type: 'link_candidate',
        candidateId: '',
      }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(400);
  });

  it('link_candidate returns 404 when the decision does not exist', async () => {
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions/nonexistent/follow-up', {
        type: 'link_candidate',
        candidateId: 'cand-x',
      }),
      res,
      workspaceDir,
      '/nonexistent/follow-up',
    );
    expect(getStatus(res)).toBe(404);
  });

  // ── validation ──────────────────────────────────────────────────────────
  it('returns 400 when type is missing', async () => {
    const id = await seedDecision();
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { candidateId: 'c-1' }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('type');
  });

  it('returns 400 when type is an unknown value', async () => {
    const id = await seedDecision();
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, { type: 'bogus_type' }),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(400);
    expect(parseError(res).message).toContain('type');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const id = await seedDecision();
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, '{not valid'),
      res,
      workspaceDir,
      `/${id}/follow-up`,
    );
    expect(getStatus(res)).toBe(400);
  });

  // ── feature flag ────────────────────────────────────────────────────────
  it('returns 403 when intent_engineering is disabled', async () => {
    writeConfig(false);
    const res = makeRes();
    await handleIntentDecisionsRoute(
      makePostReq('/api/v1/intent-decisions/some-id/follow-up', { type: 'guide_rulehost' }),
      res,
      workspaceDir,
      '/some-id/follow-up',
    );
    expect(getStatus(res)).toBe(403);
    expect(parseError(res).reason).toBe('flag_disabled');
  });

  // ── degradation paths (EP-03: every degraded branch carries a reason) ──
  // These exercise sendFollowUpModelFailure + IntentDecisionModel.updateFollowUp
  // degradation returns that the happy-path tests above never reach.
  describe('degradation paths', () => {
    it('returns 409 workspace_not_initialized when state.db is absent (link_candidate)', async () => {
      // Remove state.db so stateDbExists() returns false. The link_candidate
      // branch calls model.updateFollowUp directly (no getById precheck), so it
      // reaches the model's state_db_not_found degradation → 409.
      fs.unlinkSync(path.join(pdDir, 'state.db'));
      const res = makeRes();
      await handleIntentDecisionsRoute(
        makePostReq('/api/v1/intent-decisions/any/follow-up', {
          type: 'link_candidate',
          candidateId: 'cand-1',
        }),
        res,
        workspaceDir,
        '/any/follow-up',
      );
      expect(getStatus(res)).toBe(409);
      const body = parseError(res);
      expect(body.reason).toBe('state_db_not_found');
      expect(body.nextAction).toMatch(/initialize/i);
    });

    it('returns 404 (not 409) for generate_patch_proposal when state.db is absent', async () => {
      // generate_patch_proposal prechecks existence via model.getById, which
      // returns null when state.db is absent → the route maps to 404, never
      // reaching the updateFollowUp degradation. This documents that contract.
      fs.unlinkSync(path.join(pdDir, 'state.db'));
      const res = makeRes();
      await handleIntentDecisionsRoute(
        makePostReq('/api/v1/intent-decisions/any/follow-up', { type: 'generate_patch_proposal' }),
        res,
        workspaceDir,
        '/any/follow-up',
      );
      expect(getStatus(res)).toBe(404);
    });

    // NOTE: the intent_decisions_table_missing degradation (model catch block →
    // route 500) is not reachable via the route because SqliteConnection
    // re-runs initSchema on open, re-creating the table. That branch is
    // defensive-only and is covered by the model's unit tests instead.
  });

  // ── EP-01: server-side trust-boundary normalization of candidateId ──
  describe('candidateId trust-boundary normalization (EP-01)', () => {
    it('trims and persists a candidateId with leading/trailing whitespace', async () => {
      const id = await seedDecision({ ownerAction: 'confirm_drift' });
      const res = makeRes();
      await handleIntentDecisionsRoute(
        makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, {
          type: 'link_candidate',
          candidateId: '  cand-trimmed  ',
        }),
        res,
        workspaceDir,
        `/${id}/follow-up`,
      );
      expect(getStatus(res)).toBe(200);
      const parsed = parseBody(res);
      // The audit trail must hold the trimmed value, not the raw input.
      expect(parsed.data.record.resultingCandidateId).toBe('cand-trimmed');
      expect(parsed.data.linkedCandidateId).toBe('cand-trimmed');
    });

    it('returns 400 when candidateId is whitespace-only', async () => {
      const id = await seedDecision({ ownerAction: 'confirm_drift' });
      const res = makeRes();
      await handleIntentDecisionsRoute(
        makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, {
          type: 'link_candidate',
          candidateId: '   ',
        }),
        res,
        workspaceDir,
        `/${id}/follow-up`,
      );
      expect(getStatus(res)).toBe(400);
      expect(parseError(res).message).toContain('candidateId');
    });

    it('returns 400 when candidateId is not a string', async () => {
      const id = await seedDecision({ ownerAction: 'confirm_drift' });
      const res = makeRes();
      await handleIntentDecisionsRoute(
        makePostReq(`/api/v1/intent-decisions/${id}/follow-up`, {
          type: 'link_candidate',
          candidateId: 123,
        }),
        res,
        workspaceDir,
        `/${id}/follow-up`,
      );
      expect(getStatus(res)).toBe(400);
      expect(parseError(res).message).toContain('candidateId');
    });
  });
});
