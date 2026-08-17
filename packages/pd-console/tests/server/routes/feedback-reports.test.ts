import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  handleFeedbackReportsRoute,
  handleFeedbackChannelsRoute,
  disposeFeedbackReportModels,
} from '../../../src/server/routes/feedback-reports.js';

function makeJsonResponse(body?: unknown): Response {
  return {
    status: 202,
    json: async () => body ?? {},
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test utilities (mirrors tests/server/routes/update.test.ts pattern)
// ---------------------------------------------------------------------------

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const req = {
    method,
    url: '/api/feedback/reports',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && body !== undefined) {
        handler(Buffer.from(bodyStr));
      }
      if (event === 'end') {
        handler();
      }
    }),
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

function parseResponseBody<T>(res: ServerResponse): T {
  const mockRes = res as unknown as { _body: string };
  return JSON.parse(mockRes._body) as T;
}

function okEnvelope<T>(res: ServerResponse): T {
  const body = parseResponseBody<{ success: true; data: T }>(res);
  expect(body.success).toBe(true);
  return body.data;
}

// ---------------------------------------------------------------------------
// Setup: temporary workspace
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-feedback-reports-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Pre-create .pd so the model can write under it
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
});

afterEach(() => {
  disposeFeedbackReportModels();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFeedbackReportsRoute', () => {
  describe('POST /api/feedback/reports', () => {
    it('creates a local draft and returns the report envelope', async () => {
      const req = createMockRequest('POST', {
        input: {
          type: 'bug',
          title: 'Console crashes when opening approvals',
          description: 'Steps to repro: open the approvals page and click any row.',
        },
        diagnostics: {},
      });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ id: string; createdAt: string; report: { id: string; type: string; title: string } }>(res);
      expect(data.id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(data.report.type).toBe('bug');
      expect(data.report.title).toBe('Console crashes when opening approvals');
      expect(data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify draft was actually written to disk
      const draftsDir = path.join(workspaceDir, '.pd', 'feedback', 'drafts');
      const files = fs.readdirSync(draftsDir);
      expect(files).toContain(`${data.id}.json`);
    });

    it('rejects malformed input with reason in response (does not write draft)', async () => {
      const req = createMockRequest('POST', {
        input: { type: 'invalid_type', title: 'X', description: 'Y' },
        diagnostics: {},
      });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();

      const draftsDir = path.join(workspaceDir, '.pd', 'feedback', 'drafts');
      const exists = fs.existsSync(draftsDir);
      expect(exists).toBe(false);
    });

    it('rejects invalid JSON body with 400', async () => {
      const req = {
        method: 'POST',
        url: '/api/feedback/reports',
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'data') {
            handler(Buffer.from('{not valid json'));
          }
          if (event === 'end') {
            handler();
          }
        }),
      } as unknown as IncomingMessage;
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 405 for unsupported methods on the collection path', async () => {
      const req = createMockRequest('PUT', { input: {}, diagnostics: {} });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });
      expect(res.statusCode).toBe(405);
    });
  });

  describe('GET /api/feedback/reports', () => {
    it('returns empty drafts list when nothing has been created', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });
      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ drafts: unknown[] }>(res);
      expect(data.drafts).toEqual([]);
    });

    it('returns draft summaries after creation', async () => {
      // Create one draft first
      const createReq = createMockRequest('POST', {
        input: { type: 'feature_request', title: 'Add dark mode', description: 'Please add dark mode.' },
        diagnostics: {},
      });
      const createRes = createMockResponse();
      await handleFeedbackReportsRoute(createReq, createRes, { workspaceDir, subPath: '' });

      // Now list
      const listReq = createMockRequest('GET');
      const listRes = createMockResponse();
      await handleFeedbackReportsRoute(listReq, listRes, { workspaceDir, subPath: '' });

      expect(listRes.statusCode).toBe(200);
      const data = okEnvelope<{ drafts: { id: string; type: string; title: string }[] }>(listRes);
      expect(data.drafts).toHaveLength(1);
      expect(data.drafts[0]?.title).toBe('Add dark mode');
    });
  });

  describe('GET /api/feedback/reports/:id', () => {
    it('returns a single previously created draft', async () => {
      const createReq = createMockRequest('POST', {
        input: { type: 'confusing', title: 'Sidebar labels unclear', description: 'What does "Zone" mean?' },
        diagnostics: {},
      });
      const createRes = createMockResponse();
      await handleFeedbackReportsRoute(createReq, createRes, { workspaceDir, subPath: '' });
      const created = okEnvelope<{ id: string; report: { id: string } }>(createRes);

      const getReq = createMockRequest('GET');
      const getRes = createMockResponse();
      await handleFeedbackReportsRoute(getReq, getRes, { workspaceDir, subPath: `/${created.id}` });

      expect(getRes.statusCode).toBe(200);
      const data = okEnvelope<{ report: { id: string; type: string } }>(getRes);
      expect(data.report.id).toBe(created.id);
    });

    it('returns 404 for unknown draft id', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '/nonexistent-id' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/feedback/reports/:id', () => {
    it('deletes a draft and returns deleted:true', async () => {
      const createReq = createMockRequest('POST', {
        input: { type: 'privacy_concern', title: 'Console shows full paths', description: 'I see /Users/me/secrets' },
        diagnostics: {},
      });
      const createRes = createMockResponse();
      await handleFeedbackReportsRoute(createReq, createRes, { workspaceDir, subPath: '' });
      const created = okEnvelope<{ id: string }>(createRes);

      const delReq = createMockRequest('DELETE');
      const delRes = createMockResponse();
      await handleFeedbackReportsRoute(delReq, delRes, { workspaceDir, subPath: `/${created.id}` });

      expect(delRes.statusCode).toBe(200);
      const data = okEnvelope<{ deleted: boolean }>(delRes);
      expect(data.deleted).toBe(true);

      // Verify file gone
      const draftsDir = path.join(workspaceDir, '.pd', 'feedback', 'drafts');
      const files = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir) : [];
      expect(files).not.toContain(`${created.id}.json`);
    });

    it('rejects id with path traversal characters', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '/..%2Fetc%2Fpasswd' });
      // The id validator should reject; expect 4xx
      expect([400, 404]).toContain(res.statusCode);
    });
  });

  describe('disposeFeedbackReportModels', () => {
    it('clears the per-workspace model cache', () => {
      expect(typeof disposeFeedbackReportModels).toBe('function');
      expect(() => disposeFeedbackReportModels()).not.toThrow();
    });
  });

  describe('feature flag gate', () => {
    it('POST returns 403 when feedback_channel flag is disabled', async () => {
      const req = createMockRequest('POST', {
        input: {
          type: 'bug',
          title: 'Should be blocked',
          description: 'This draft must not be written.',
        },
        diagnostics: {},
      });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: '',
        featureFlags: { feedback_channel: { enabled: false } },
      });

      expect(res.statusCode).toBe(403);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.error).toContain('feedback_channel');
      expect(body.message).toContain('feedback_channel');

      // Verify no draft was written
      const draftsDir = path.join(workspaceDir, '.pd', 'feedback', 'drafts');
      const exists = fs.existsSync(draftsDir);
      expect(exists).toBe(false);
    });

    it('GET list still works when feedback_channel flag is disabled', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: '',
        featureFlags: { feedback_channel: { enabled: false } },
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ drafts: unknown[] }>(res);
      expect(data.drafts).toEqual([]);
    });

    it('DELETE still works when feedback_channel flag is disabled', async () => {
      // First create a draft without flag restriction
      const createReq = createMockRequest('POST', {
        input: { type: 'bug', title: 'Temp', description: 'Delete me' },
        diagnostics: {},
      });
      const createRes = createMockResponse();
      await handleFeedbackReportsRoute(createReq, createRes, { workspaceDir, subPath: '' });
      const created = okEnvelope<{ id: string }>(createRes);

      // Now delete with flag disabled
      const delReq = createMockRequest('DELETE');
      const delRes = createMockResponse();
      await handleFeedbackReportsRoute(delReq, delRes, {
        workspaceDir,
        subPath: `/${created.id}`,
        featureFlags: { feedback_channel: { enabled: false } },
      });

      expect(delRes.statusCode).toBe(200);
      const data = okEnvelope<{ deleted: boolean }>(delRes);
      expect(data.deleted).toBe(true);
    });
  });

  describe('POST /api/feedback/reports/:id/submit', () => {
    const ingestConfig = {
      ingestUrl: 'https://example.com/api/feedback',
      ingestToken: 'tok',
      githubRepo: '',
      githubProxy: '',
    };

    async function createDraft(type = 'bug', title = 'Submit me'): Promise<string> {
      const req = createMockRequest('POST', { input: { type, title, description: 'describe' }, diagnostics: {} });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, { workspaceDir, subPath: '' });
      const data = okEnvelope<{ id: string }>(res);
      return data.id;
    }

    it('submits the saved (server-side) draft via ingest and writes back status', async () => {
      const id = await createDraft('bug', 'Peers never finish');
      const fetchFn = vi.fn(async () =>
        makeJsonResponse({ trackingId: 'fb-99', issueUrl: 'https://linear.app/i/1', duplicate: false }),
      );
      const req = createMockRequest('POST', { channel: 'ingest' });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: `/${id}/submit`,
        featureFlags: { feedback_channel: { enabled: true } },
        channelConfig: ingestConfig,
        submitDeps: { fetchFn },
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ status: string; submittedVia: string; trackingId: string }>(res);
      expect(data.status).toBe('submitted');
      expect(data.submittedVia).toBe('ingest');
      expect(data.trackingId).toBe('fb-99');

      // Client-injected content is ignored: body only carried { channel }, so
      // no report content ever reached the transport — only the disk draft.
      const body = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
      const sent = JSON.parse(String(body?.body)) as { report: { title: string }; fingerprint: string };
      expect(sent.report.title).toBe('Peers never finish');

      // Receipt persisted to disk.
      const raw = fs.readFileSync(path.join(workspaceDir, '.pd', 'feedback', 'drafts', `${id}.json`), 'utf8');
      const onDisk = JSON.parse(raw) as { status: string; trackingId: string };
      expect(onDisk.status).toBe('submitted');
      expect(onDisk.trackingId).toBe('fb-99');
    });

    it('is idempotent — resubmitting an already-submitted draft returns alreadySubmitted', async () => {
      const id = await createDraft('bug', 'Once only');
      const fetchFn = vi.fn(async () =>
        makeJsonResponse({ trackingId: 'fb-77', issueUrl: 'u', duplicate: false }),
      );
      const ctx = {
        workspaceDir,
        featureFlags: { feedback_channel: { enabled: true } },
        channelConfig: ingestConfig,
        submitDeps: { fetchFn },
      };
      // First submit succeeds.
      await handleFeedbackReportsRoute(
        createMockRequest('POST', { channel: 'ingest' }),
        createMockResponse(),
        { ...ctx, subPath: `/${id}/submit` },
      );
      // Second submit is a no-op.
      const req2 = createMockRequest('POST', { channel: 'ingest' });
      const res2 = createMockResponse();
      await handleFeedbackReportsRoute(req2, res2, { ...ctx, subPath: `/${id}/submit` });

      expect(res2.statusCode).toBe(200);
      const data = okEnvelope<{ alreadySubmitted: boolean; trackingId: string }>(res2);
      expect(data.alreadySubmitted).toBe(true);
      expect(data.trackingId).toBe('fb-77');
      expect(fetchFn).toHaveBeenCalledTimes(1); // no second POST to relay
    });

    it('returns 403 when the feature flag is disabled', async () => {
      const id = await createDraft('bug', 'Flagged');
      const req = createMockRequest('POST', { channel: 'ingest' });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: `/${id}/submit`,
        featureFlags: { feedback_channel: { enabled: false } },
        channelConfig: ingestConfig,
      });
      expect(res.statusCode).toBe(403);
      const body = parseResponseBody<{ success: false; error: string }>(res);
      expect(body.error).toContain('feedback_channel');
    });

    it('returns 400 for an unknown channel value', async () => {
      const id = await createDraft('bug', 'Bad channel');
      const req = createMockRequest('POST', { channel: 'telepathy' });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: `/${id}/submit`,
        featureFlags: { feedback_channel: { enabled: true } },
        channelConfig: ingestConfig,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for a nonexistent draft id', async () => {
      const req = createMockRequest('POST', { channel: 'ingest' });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: '/fb-does-not-exist/submit',
        featureFlags: { feedback_channel: { enabled: true } },
        channelConfig: ingestConfig,
      });
      expect(res.statusCode).toBe(404);
    });

    it('keeps the draft as draft (+reason+nextAction) when the relay is unreachable', async () => {
      const id = await createDraft('bug', 'unreachable');
      const fetchFn = vi.fn(async () => {
        throw new Error('ENOTFOUND example.com');
      });
      const req = createMockRequest('POST', { channel: 'ingest' });
      const res = createMockResponse();
      await handleFeedbackReportsRoute(req, res, {
        workspaceDir,
        subPath: `/${id}/submit`,
        featureFlags: { feedback_channel: { enabled: true } },
        channelConfig: ingestConfig,
        submitDeps: { fetchFn },
      });

      expect(res.statusCode).toBe(502);
      const body = parseResponseBody<{ success: false; error: string; message: string; nextAction: string }>(res);
      expect(body.error).toContain('ingest_submit_failed');
      expect(body.nextAction).toBeTruthy();

      const raw = fs.readFileSync(path.join(workspaceDir, '.pd', 'feedback', 'drafts', `${id}.json`), 'utf8');
      const onDisk = JSON.parse(raw) as { status?: string };
      expect(onDisk.status).toBeUndefined(); // still draft
    });
  });

  describe('GET /api/feedback/submit/channels', () => {
    it('returns the four-ladder channel list without leaking the ingest token', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();
      const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
      await handleFeedbackChannelsRoute(req, res, {
        workspaceDir,
        channelConfig: {
          ingestUrl: 'https://example.com/api/feedback',
          ingestToken: 'should-not-leak',
          githubRepo: '',
          githubProxy: '',
        },
        maintainerEmail: 'maintainer@example.com',
        channelDeps: { fetchFn },
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ channels: { id: string }[] }>(res);
      expect(data.channels.map((c) => c.id)).toEqual(['ingest', 'github', 'email', 'file']);
      expect(JSON.stringify(data.channels)).not.toContain('should-not-leak');
    });

    it('returns 405 for non-GET methods', async () => {
      const req = createMockRequest('POST', {});
      const res = createMockResponse();
      await handleFeedbackChannelsRoute(req, res, { workspaceDir });
      expect(res.statusCode).toBe(405);
    });
  });
});
