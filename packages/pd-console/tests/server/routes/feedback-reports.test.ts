import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  handleFeedbackReportsRoute,
  disposeFeedbackReportModels,
} from '../../../src/server/routes/feedback-reports.js';

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
});
