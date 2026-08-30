import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleFailedTasksRoute,
  disposeFailedTasksModels,
} from '../../../src/server/routes/failed-tasks.js';
import {
  RuntimeStateManager,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  listRecoveryActions,
} from '@principles/core/runtime-v2';
import type { SqliteTaskStore, PITaskMetadata } from '@principles/core/runtime-v2';

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

  // ── POST /api/v1/failed-tasks/:id/recover (Governance Recovery Actions v1) ──
  //
  // These tests exercise the REAL recovery path: the route opens a writable
  // RecoverySweepService against the seeded temp workspace (EP-02/EP-09 — no
  // service mocks; assertions are on real DB rows and the real audit log).

  describe('POST /api/v1/failed-tasks/:id/recover', () => {
    let stateManager: RuntimeStateManager;

    const RECOVERY_FLAGS = {
      failed_tasks_observability: { enabled: true },
      failed_task_recovery_console: { enabled: true },
    };

    /** POST request double whose body stream emits the given JSON body. */
    function createMockPostRequest(url: string, body: string): IncomingMessage {
      const req = new EventEmitter() as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = url;
      setImmediate(() => {
        if (body.length > 0) {
          req.emit('data', Buffer.from(body, 'utf8'));
        }
        req.emit('end');
      });
      return req;
    }

    async function seedTask(opts: {
      taskId: string;
      taskKind?: string;
      status: 'pending' | 'leased' | 'succeeded' | 'retry_wait' | 'failed' | 'needs_human_review';
      attemptCount?: number;
      maxAttempts?: number;
      meta?: Partial<PITaskMetadata>;
      diagnosticJson?: string;
    }): Promise<void> {
      await stateManager.createTask({
        taskId: opts.taskId,
        taskKind: opts.taskKind ?? 'artificer',
        status: opts.status,
        attemptCount: opts.attemptCount ?? 1,
        maxAttempts: opts.maxAttempts ?? 3,
        diagnosticJson:
          opts.diagnosticJson ??
          createPITaskDiagnosticJson({
            dependencyTaskIds: [],
            channel: 'prompt',
            timeoutMs: 300_000,
            inputArtifactRefs: [],
            outputArtifactRefs: [],
            correlationId: 'recover-route-test',
            ...opts.meta,
          }),
      });
    }

    beforeEach(async () => {
      // Replace the empty state.db placeholder with a real initialized schema
      // and a writable manager the tests can seed through.
      stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();
    });

    afterEach(async () => {
      await stateManager.close();
    });

    it('403 failed_task_recovery_console_disabled when the recovery flag is explicitly disabled', async () => {
      const req = createMockPostRequest('/api/v1/failed-tasks/some-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/some-task/recover',
        featureFlags: { failed_tasks_observability: { enabled: true }, failed_task_recovery_console: { enabled: false } },
      });

      expect(res.statusCode).toBe(403);
      const body = errorEnvelope(res);
      expect(body.error).toBe('failed_task_recovery_console_disabled');
      expect(body.message).toContain('failed_task_recovery_console');
    });

    it('403 (fail-closed) when featureFlags context carries no recovery flag at all', async () => {
      const req = createMockPostRequest('/api/v1/failed-tasks/some-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/some-task/recover',
        featureFlags: { failed_tasks_observability: { enabled: true } },
      });

      expect(res.statusCode).toBe(403);
      expect(errorEnvelope(res).error).toBe('failed_task_recovery_console_disabled');
    });

    it('404 task_not_found for an unknown task id', async () => {
      const req = createMockPostRequest('/api/v1/failed-tasks/does-not-exist/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/does-not-exist/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(404);
      const body = errorEnvelope(res);
      expect(body.error).toBe('task_not_found');
    });

    it('409 task_not_recoverable for a leased (in-flight) task, row untouched', async () => {
      await seedTask({ taskId: 'leased-task', status: 'leased' });

      const req = createMockPostRequest('/api/v1/failed-tasks/leased-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/leased-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(409);
      const body = errorEnvelope(res);
      expect(body.error).toBe('task_not_recoverable');
      expect(body.message).toContain('leased');
      const row = await stateManager.getTask('leased-task');
      expect(row?.status).toBe('leased');
    });

    it('recovers failed → pending and appends a RecoveryAction audit record', async () => {
      await seedTask({ taskId: 'failed-task-1', status: 'failed', attemptCount: 1, maxAttempts: 3 });

      const req = createMockPostRequest(
        '/api/v1/failed-tasks/failed-task-1/recover',
        JSON.stringify({ reason: 'Owner approved retry after reviewing failure' }),
      );
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/failed-task-1/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ taskId: string; previousStatus: string; newStatus: string; result: string; nextAction: string }>(res);
      expect(data.taskId).toBe('failed-task-1');
      expect(data.previousStatus).toBe('failed');
      expect(data.newStatus).toBe('pending');
      expect(data.result).toBe('recovered');
      expect(data.nextAction).toContain('Recovery accepted');

      const row = await stateManager.getTask('failed-task-1');
      expect(row?.status).toBe('pending');
      expect(row?.attemptCount).toBe(0);

      const audit = listRecoveryActions(workspaceDir, { taskId: 'failed-task-1' });
      expect(audit.length).toBe(1);
      expect(audit[0]?.action).toBe('recover');
      expect(audit[0]?.previousStatus).toBe('failed');
      expect(audit[0]?.result).toBe('recovered');
      expect(audit[0]?.operator).toBe('console');
      expect(audit[0]?.reason).toBe('Owner approved retry after reviewing failure');
    });

    it('409 task_attempts_exhausted without force leaves the row untouched', async () => {
      await seedTask({ taskId: 'exhausted-task', status: 'failed', attemptCount: 3, maxAttempts: 3 });

      const req = createMockPostRequest('/api/v1/failed-tasks/exhausted-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/exhausted-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(409);
      const body = errorEnvelope(res) as { success: false; error: string; message: string; nextAction?: string };
      expect(body.error).toBe('task_attempts_exhausted');
      expect(body.nextAction).toContain('--force');
      const row = await stateManager.getTask('exhausted-task');
      expect(row?.status).toBe('failed');
      expect(listRecoveryActions(workspaceDir)).toEqual([]);
    });

    it('force: true recovers an exhausted task, raises maxAttempts, and audits forceApplied', async () => {
      await seedTask({ taskId: 'exhausted-force-task', status: 'failed', attemptCount: 3, maxAttempts: 3 });

      const req = createMockPostRequest(
        '/api/v1/failed-tasks/exhausted-force-task/recover',
        JSON.stringify({ force: true }),
      );
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/exhausted-force-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ taskId: string; previousStatus: string; newStatus: string; result: string; forceApplied: boolean }>(res);
      expect(data.taskId).toBe('exhausted-force-task');
      expect(data.previousStatus).toBe('failed');
      expect(data.newStatus).toBe('pending');
      expect(data.result).toBe('recovered');
      expect(data.forceApplied).toBe(true);

      // Core force semantics: attempt budget reset, budget raised by +3 (3 → 6)
      const row = await stateManager.getTask('exhausted-force-task');
      expect(row?.status).toBe('pending');
      expect(row?.attemptCount).toBe(0);
      expect(row?.maxAttempts).toBe(6);

      const audit = listRecoveryActions(workspaceDir, { taskId: 'exhausted-force-task' });
      expect(audit.length).toBe(1);
      expect(audit[0]?.result).toBe('recovered');
      expect(audit[0]?.forceApplied).toBe(true);
    });

    it('explicit force: false is refused like an omitted force (409, row untouched)', async () => {
      await seedTask({ taskId: 'exhausted-noforce-task', status: 'failed', attemptCount: 3, maxAttempts: 3 });

      const req = createMockPostRequest(
        '/api/v1/failed-tasks/exhausted-noforce-task/recover',
        JSON.stringify({ force: false }),
      );
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/exhausted-noforce-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(409);
      const body = errorEnvelope(res) as { success: false; error: string };
      expect(body.error).toBe('task_attempts_exhausted');
      const row = await stateManager.getTask('exhausted-noforce-task');
      expect(row?.status).toBe('failed');
      expect(row?.attemptCount).toBe(3);
      expect(listRecoveryActions(workspaceDir)).toEqual([]);
    });

    it('400 when force is not a boolean (rc-3 fail loud, no silent coercion)', async () => {
      await seedTask({ taskId: 'force-type-task', status: 'failed', attemptCount: 3, maxAttempts: 3 });

      for (const badForce of ['"yes"', 'null', '1']) {
        const req = createMockPostRequest(
          '/api/v1/failed-tasks/force-type-task/recover',
          `{"force": ${badForce}}`,
        );
        const res = createMockResponse();
        await handleFailedTasksRoute(req, res, {
          workspaceDir,
          subPath: '/force-type-task/recover',
          featureFlags: RECOVERY_FLAGS,
        });

        expect(res.statusCode).toBe(400);
        const body = errorEnvelope(res) as { success: false; error: string; message?: string };
        expect(body.error).toBe('bad_request');
        expect(body.message).toBe('force must be a boolean');
      }

      const row = await stateManager.getTask('force-type-task');
      expect(row?.status).toBe('failed');
      expect(listRecoveryActions(workspaceDir)).toEqual([]);
    });

    it('force is ignored for needs_human_review (owner reset path, forceApplied false)', async () => {
      await seedTask({ taskId: 'review-force-task', status: 'needs_human_review', attemptCount: 2, maxAttempts: 3 });

      const req = createMockPostRequest(
        '/api/v1/failed-tasks/review-force-task/recover',
        JSON.stringify({ force: true }),
      );
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/review-force-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ result: string; forceApplied: boolean; newStatus: string }>(res);
      expect(data.result).toBe('requeued');
      expect(data.forceApplied).toBe(false);
      expect(data.newStatus).toBe('pending');

      const audit = listRecoveryActions(workspaceDir, { taskId: 'review-force-task' });
      expect(audit.length).toBe(1);
      expect(audit[0]?.result).toBe('requeued');
      // Non-forced recoveries omit the field entirely (writer only emits it when true)
      expect(audit[0]?.forceApplied).toBeUndefined();
    });

    it('recovers needs_human_review → pending, clears completionIntent/runnerDecision, audits requeued', async () => {
      await seedTask({
        taskId: 'review-task-1',
        taskKind: 'rollout_reviewer',
        status: 'needs_human_review',
        attemptCount: 2,
        meta: {
          runnerDecision: 'needs_revision',
          completionIntent: {
            decision: 'needs_revision',
            sourceRunId: 'run-1',
            revisionEpoch: 1,
            status: 'applied',
            effect: 'needs_human_review',
          },
        },
      });

      const req = createMockPostRequest('/api/v1/failed-tasks/review-task-1/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/review-task-1/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(200);
      const data = okEnvelope<{ taskId: string; previousStatus: string; newStatus: string; result: string }>(res);
      expect(data.previousStatus).toBe('needs_human_review');
      expect(data.newStatus).toBe('pending');
      expect(data.result).toBe('requeued');

      const row = await stateManager.getTask('review-task-1');
      expect(row?.status).toBe('pending');
      expect(row?.attemptCount).toBe(0);
      // Owner authority reset: both intent fields must be gone (SPEC §6.2)
      const meta = row ? hydratePITaskRecord(row) : null;
      expect(meta?.runnerDecision).toBeUndefined();
      expect(meta?.completionIntent).toBeUndefined();

      const audit = listRecoveryActions(workspaceDir, { taskId: 'review-task-1' });
      expect(audit.length).toBe(1);
      expect(audit[0]?.result).toBe('requeued');
      expect(audit[0]?.previousStatus).toBe('needs_human_review');
    });

    it('PRI-629: decision-capable NHR recover → 409 owner_decision_required, task untouched (SPEC §17)', async () => {
      // decision-capable: evaluator + dep artificer repairPayload.repairIteration=2
      // + needs_revision + intent + 决策 artifact (legacy 推断路径)
      await seedTask({
        taskId: 'artificer-r2',
        taskKind: 'artificer',
        status: 'succeeded',
        meta: {
          dependencyTaskIds: [],
          repairPayload: {
            requiredChanges: ['fix'], concerns: [], previousScore: 0.7, repairIteration: 2,
            sourceArtificerArtifactId: 'pi-art-old', sourceEvaluatorTaskId: 'decision-task-1',
          },
        },
      });
      await seedTask({
        taskId: 'decision-task-1',
        taskKind: 'evaluator',
        status: 'needs_human_review',
        meta: {
          dependencyTaskIds: ['artificer-r2'],
          runnerDecision: 'needs_revision',
          completionIntent: { decision: 'needs_revision', sourceRunId: 'run-d1', revisionEpoch: 0, status: 'pending' },
        },
      });
      await stateManager.piArtifactStore.upsertArtifact({
        artifactId: 'pi-art-decision-task-1-run-d1',
        artifactKind: 'principle',
        sourceTaskId: 'decision-task-1',
        lineageArtifactIds: [],
        validationStatus: 'pending',
        contentJson: JSON.stringify({ evaluation: { decision: 'needs_revision' } }),
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      });

      const req = createMockPostRequest('/api/v1/failed-tasks/decision-task-1/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/decision-task-1/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(409);
      const body = errorEnvelope(res);
      expect(body.error).toBe('owner_decision_required');
      expect(body.nextAction).toContain('governance focus');
      // core guard: 任务原样保留 — 无 authority reset
      const row = await stateManager.getTask('decision-task-1');
      expect(row?.status).toBe('needs_human_review');
      const meta = row ? hydratePITaskRecord(row) : null;
      expect(meta?.runnerDecision).toBe('needs_revision');
    });

    it('409 metadata_invalid (fail closed) leaves a corrupt-metadata needs_human_review row untouched', async () => {
      await seedTask({
        taskId: 'corrupt-meta-task',
        status: 'needs_human_review',
        diagnosticJson: JSON.stringify({ note: 'not pi metadata' }),
      });

      const req = createMockPostRequest('/api/v1/failed-tasks/corrupt-meta-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/corrupt-meta-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(409);
      const body = errorEnvelope(res) as { success: false; error: string; nextAction?: string };
      expect(body.error).toBe('metadata_invalid');
      expect(body.nextAction).toContain('integrity');
      const row = await stateManager.getTask('corrupt-meta-task');
      expect(row?.status).toBe('needs_human_review');
      expect(listRecoveryActions(workspaceDir)).toEqual([]);
    });

    it('400 bad_request when reason is not a string', async () => {
      const req = createMockPostRequest(
        '/api/v1/failed-tasks/some-task/recover',
        JSON.stringify({ reason: 42 }),
      );
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/some-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(400);
      expect(errorEnvelope(res).message).toContain('reason');
    });

    it('400 bad_request for a non-JSON body', async () => {
      const req = createMockPostRequest('/api/v1/failed-tasks/some-task/recover', 'not json');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/some-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts an empty body (reason is optional)', async () => {
      await seedTask({ taskId: 'failed-empty-body', status: 'failed' });

      const req = createMockPostRequest('/api/v1/failed-tasks/failed-empty-body/recover', '');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/failed-empty-body/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(200);
      const audit = listRecoveryActions(workspaceDir, { taskId: 'failed-empty-body' });
      expect(audit.length).toBe(1);
      expect(audit[0]?.reason).toBeNull();
    });

    it('405 for GET on the recover subpath', async () => {
      const req = createMockRequest('GET', '/api/v1/failed-tasks/some-task/recover');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/some-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(405);
    });

    it('400 bad_request when reason exceeds 2000 characters', async () => {
      const req = createMockPostRequest('/api/v1/failed-tasks/x/recover', JSON.stringify({ reason: 'x'.repeat(2001) }));
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/x/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(400);
      expect(errorEnvelope(res).message).toContain('reason must be at most 2000 characters');
    });

    it('405 for a POST with no task id (recover regex requires an id segment)', async () => {
      // The recover matcher /^\/([^/]+)\/recover$/ requires a task id; an
      // empty-id request falls through to the detail route → 405.
      const req = createMockPostRequest('/api/v1/failed-tasks//recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(405);
    });

    it('404 not_found when the workspace has no state.db', async () => {
      const emptyWorkspace = path.join(tmpDir, 'empty-workspace');
      fs.mkdirSync(path.join(emptyWorkspace, '.pd'), { recursive: true });

      const req = createMockPostRequest('/api/v1/failed-tasks/some-task/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir: emptyWorkspace,
        subPath: '/some-task/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(404);
      expect(errorEnvelope(res).error).toBe('not_found');
    });

    it('400 bad_request when the request body stream errors', async () => {
      const req = new EventEmitter() as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/v1/failed-tasks/x/recover';
      setImmediate(() => req.emit('error', new Error('stream broke')));

      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir,
        subPath: '/x/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(400);
      expect(errorEnvelope(res).message).toContain('stream broke');
    });

    it('500 failed_task_recovery_error when the recovery service fails unexpectedly', async () => {
      const corruptWorkspace = path.join(tmpDir, 'corrupt-workspace');
      fs.mkdirSync(path.join(corruptWorkspace, '.pd'), { recursive: true });
      // state.db exists but is not a valid SQLite database → open/query throws
      fs.writeFileSync(path.join(corruptWorkspace, '.pd', 'state.db'), 'this is not a sqlite database');

      const req = createMockPostRequest('/api/v1/failed-tasks/x/recover', '{}');
      const res = createMockResponse();
      await handleFailedTasksRoute(req, res, {
        workspaceDir: corruptWorkspace,
        subPath: '/x/recover',
        featureFlags: RECOVERY_FLAGS,
      });

      expect(res.statusCode).toBe(500);
      expect(errorEnvelope(res).error).toBe('failed_task_recovery_error');
    });

    it('reports success even when the audit append fails (best-effort, rc-9)', async () => {
      await seedTask({ taskId: 'failed-audit-err', status: 'failed' });
      // `.state` exists as a FILE → appendRecoveryAction fails (ENOTDIR)
      fs.writeFileSync(path.join(workspaceDir, '.state'), 'blocking-file');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const req = createMockPostRequest('/api/v1/failed-tasks/failed-audit-err/recover', '{}');
        const res = createMockResponse();
        await handleFailedTasksRoute(req, res, {
          workspaceDir,
          subPath: '/failed-audit-err/recover',
          featureFlags: RECOVERY_FLAGS,
        });

        expect(res.statusCode).toBe(200);
        const body = okEnvelope<{ taskId: string; result: string }>(res);
        expect(body.taskId).toBe('failed-audit-err');
        expect(body.result).toBe('recovered');
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
