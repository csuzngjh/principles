import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleFailedTasksRoute,
  disposeFailedTasksModels,
} from '../../../src/server/routes/failed-tasks.js';
import type { SqliteTaskStore } from '@principles/core/runtime-v2';

// ---------------------------------------------------------------------------
// Test utilities
//
// Mock req/res objects are constructed as plain objects and cast via
// `as unknown as T` — this is the standard pattern for mocking Node.js http
// module types (which are classes with internal prototype state that cannot be
// satisfied by a plain object literal). This is test infrastructure only; no
// `as` cast is used to bypass runtime validation of untrusted data (rc-2
// applies to production code paths, not test double construction).
// ---------------------------------------------------------------------------

function createMockRequest(method: string, url: string): IncomingMessage {
  const req = {
    method,
    url,
  };
  return req as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: unknown, statusCode: number, headers?: Record<string, string>) {
      (res as unknown as { statusCode: number }).statusCode = statusCode;
      if (headers) {
        Object.assign(res._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (res as unknown as { _body: string })._body = data;
      }
      return this;
    }),
  };
  return res as unknown as ServerResponse;
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

function errorEnvelope(res: ServerResponse): { success: false; error: string; message: string } {
  return parseResponseBody<{ success: false; error: string; message: string }>(res);
}

// ---------------------------------------------------------------------------
// Mock SqliteTaskStore — only the 3 methods the route handler calls
// ---------------------------------------------------------------------------

interface MockStoreOverrides {
  listFailedTasks?: ReturnType<typeof vi.fn>;
  countFailedTasks?: ReturnType<typeof vi.fn>;
  getFailedTaskDetail?: ReturnType<typeof vi.fn>;
}

function createMockStore(overrides: MockStoreOverrides = {}): SqliteTaskStore {
  const store = {
    listFailedTasks: overrides.listFailedTasks ?? vi.fn().mockResolvedValue([]),
    countFailedTasks: overrides.countFailedTasks ?? vi.fn().mockResolvedValue(0),
    getFailedTaskDetail: overrides.getFailedTaskDetail ?? vi.fn().mockResolvedValue(null),
  };
  return store as unknown as SqliteTaskStore;
}

// ---------------------------------------------------------------------------
// Setup: temporary workspace with a state.db file (so stateDbExists() returns true)
// ---------------------------------------------------------------------------

let workspaceDir: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-failed-tasks-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  // Create an empty state.db file so the route's stateDbExists() check passes
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'state.db'), '');
});

afterEach(() => {
  disposeFailedTasksModels();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFailedTasksRoute', () => {
  describe('GET /api/v1/failed-tasks (collection)', () => {
    it('returns failed task list with total', async () => {
      const mockTasks = [
        {
          taskId: 'task-001',
          taskKind: 'diagnostician',
          painId: 'pain-abc',
          status: 'failed' as const,
          lastError: 'runtime_unavailable',
          attemptCount: 3,
          createdAt: '2026-07-01T00:00:00.000Z',
          lastAttemptAt: '2026-07-03T12:00:00.000Z',
        },
        {
          taskId: 'task-002',
          taskKind: 'evaluator',
          painId: null,
          status: 'needs_human_review' as const,
          lastError: null,
          attemptCount: 1,
          createdAt: '2026-07-02T00:00:00.000Z',
          lastAttemptAt: '2026-07-04T08:00:00.000Z',
        },
      ];
      const listFn = vi.fn().mockResolvedValue(mockTasks);
      const countFn = vi.fn().mockResolvedValue(2);
      const store = createMockStore({
        listFailedTasks: listFn,
        countFailedTasks: countFn,
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ tasks: unknown[]; total: number }>(res);
      expect(data.tasks).toHaveLength(2);
      expect(data.total).toBe(2);

      // Verify the store was called with default limit=50, offset=0, no kind/since
      expect(listFn).toHaveBeenCalledWith({
        kind: undefined,
        since: undefined,
        limit: 50,
        offset: 0,
      });
      expect(countFn).toHaveBeenCalledWith({ kind: undefined, since: undefined });
    });

    it('filters by kind query parameter', async () => {
      const listFn = vi.fn().mockResolvedValue([]);
      const countFn = vi.fn().mockResolvedValue(0);
      const store = createMockStore({
        listFailedTasks: listFn,
        countFailedTasks: countFn,
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks?kind=diag_router');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      expect(listFn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'diag_router' }),
      );
      expect(countFn).toHaveBeenCalledWith({ kind: 'diag_router', since: undefined });
    });

    it('parses limit and offset pagination parameters', async () => {
      const listFn = vi.fn().mockResolvedValue([]);
      const countFn = vi.fn().mockResolvedValue(0);
      const store = createMockStore({
        listFailedTasks: listFn,
        countFailedTasks: countFn,
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks?limit=10&offset=20');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      expect(listFn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 }),
      );
    });

    it('returns nextAction field when task list is empty', async () => {
      const store = createMockStore({
        listFailedTasks: vi.fn().mockResolvedValue([]),
        countFailedTasks: vi.fn().mockResolvedValue(0),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ tasks: unknown[]; total: number; nextAction: string }>(res);
      expect(data.tasks).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.nextAction).toContain('No failed tasks');
    });

    it('rejects limit > 200 with 400', async () => {
      const store = createMockStore();

      const req = createMockRequest('GET', '/api/v1/failed-tasks?limit=500');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(400);
      const body = errorEnvelope(res);
      expect(body.error).toBe('bad_request');
      expect(body.message).toContain('limit');
    });

    it('rejects negative offset with 400', async () => {
      const store = createMockStore();

      const req = createMockRequest('GET', '/api/v1/failed-tasks?offset=-5');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(400);
      const body = errorEnvelope(res);
      expect(body.message).toContain('offset');
    });

    it('returns empty list with nextAction when state.db does not exist', async () => {
      // Remove state.db to simulate a fresh workspace
      fs.unlinkSync(path.join(workspaceDir, '.pd', 'state.db'));
      const store = createMockStore();

      const req = createMockRequest('GET', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ tasks: unknown[]; total: number; nextAction: string }>(res);
      expect(data.tasks).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.nextAction).toContain('state.db not yet initialized');
    });

    it('returns 500 when store throws', async () => {
      const store = createMockStore({
        listFailedTasks: vi.fn().mockRejectedValue(new Error('sqlite: disk I/O error')),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(500);
      const body = errorEnvelope(res);
      expect(body.error).toBe('failed_tasks_list_error');
      expect(body.message).toContain('disk I/O error');
    });
  });

  describe('GET /api/v1/failed-tasks/:id (detail)', () => {
    it('returns task detail with runs and lastError', async () => {
      const mockDetail = {
        task: {
          taskId: 'task-001',
          taskKind: 'diagnostician',
          status: 'failed',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-03T12:00:00.000Z',
          attemptCount: 3,
          maxAttempts: 3,
          lastError: 'runtime_unavailable',
        },
        runs: [
          {
            runId: 'run-001',
            taskId: 'task-001',
            startedAt: '2026-07-03T12:00:00.000Z',
            endedAt: '2026-07-03T12:01:00.000Z',
            status: 'failed',
          },
        ],
        lastError: 'runtime_unavailable',
        pendingAgentDraft: null,
      };
      const store = createMockStore({
        getFailedTaskDetail: vi.fn().mockResolvedValue(mockDetail),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '/task-001', sqliteTaskStore: store });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ task: { taskId: string }; runs: unknown[]; lastError: string; pendingAgentDraft: unknown }>(res);
      expect(data.task.taskId).toBe('task-001');
      expect(data.runs).toHaveLength(1);
      expect(data.lastError).toBe('runtime_unavailable');
      expect(data.pendingAgentDraft).toBeNull();
    });

    it('returns 404 when task does not exist', async () => {
      const store = createMockStore({
        getFailedTaskDetail: vi.fn().mockResolvedValue(null),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks/nonexistent');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '/nonexistent', sqliteTaskStore: store });

      expect(res.statusCode).toBe(404);
      const body = errorEnvelope(res);
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('nonexistent');
    });

    it('returns 500 when detail store throws', async () => {
      const store = createMockStore({
        getFailedTaskDetail: vi.fn().mockRejectedValue(new Error('connection lost')),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '/task-001', sqliteTaskStore: store });

      expect(res.statusCode).toBe(500);
      const body = errorEnvelope(res);
      expect(body.error).toBe('failed_tasks_detail_error');
      expect(body.message).toContain('connection lost');
    });
  });

  describe('feature flag gate', () => {
    it('returns 403 when failed_tasks_observability flag is disabled', async () => {
      const store = createMockStore();

      const req = createMockRequest('GET', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '',
        featureFlags: { failed_tasks_observability: { enabled: false } },
        sqliteTaskStore: store,
      });

      expect(res.statusCode).toBe(403);
      const body = errorEnvelope(res);
      expect(body.error).toBe('failed_tasks_observability_disabled');
      expect(body.message).toContain('failed_tasks_observability');

      // Verify store was never called (flag check short-circuits before DB access)
      expect(store.listFailedTasks).not.toHaveBeenCalled();
      expect(store.countFailedTasks).not.toHaveBeenCalled();
    });

    it('allows GET /:id when flag is enabled', async () => {
      const mockDetail = {
        task: { taskId: 'task-001', taskKind: 'diag', status: 'failed' },
        runs: [],
        lastError: null,
        pendingAgentDraft: null,
      };
      const store = createMockStore({
        getFailedTaskDetail: vi.fn().mockResolvedValue(mockDetail),
      });

      const req = createMockRequest('GET', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/task-001',
        featureFlags: { failed_tasks_observability: { enabled: true } },
        sqliteTaskStore: store,
      });

      expect(res.statusCode).toBe(200);
    });

    it('flag gate also blocks GET /:id when disabled', async () => {
      const store = createMockStore();

      const req = createMockRequest('GET', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/task-001',
        featureFlags: { failed_tasks_observability: { enabled: false } },
        sqliteTaskStore: store,
      });

      expect(res.statusCode).toBe(403);
      expect(store.getFailedTaskDetail).not.toHaveBeenCalled();
    });
  });

  describe('unsupported methods', () => {
    it('POST / returns 405', async () => {
      const store = createMockStore();

      const req = createMockRequest('POST', '/api/v1/failed-tasks');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '', sqliteTaskStore: store });

      expect(res.statusCode).toBe(405);
      const body = errorEnvelope(res);
      expect(body.error).toBe('method_not_allowed');
    });

    it('PUT /:id returns 405', async () => {
      const store = createMockStore();

      const req = createMockRequest('PUT', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '/task-001', sqliteTaskStore: store });

      expect(res.statusCode).toBe(405);
    });

    it('DELETE /:id returns 405', async () => {
      const store = createMockStore();

      const req = createMockRequest('DELETE', '/api/v1/failed-tasks/task-001');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, { workspaceDir, subPath: '/task-001', sqliteTaskStore: store });

      expect(res.statusCode).toBe(405);
    });
  });

  describe('disposeFailedTasksModels', () => {
    it('clears the per-workspace store cache without throwing', () => {
      expect(typeof disposeFailedTasksModels).toBe('function');
      expect(() => disposeFailedTasksModels()).not.toThrow();
    });
  });
});
