/**
 * Workspaces API Route Tests.
 *
 * Verifies the route contract for `GET/POST/PATCH/DELETE /api/workspaces` and
 * `POST /api/workspaces/:name/sync`. The workspaces route is the entry point
 * for multi-workspace management — incorrect validation here can lead to
 * invalid workspace names, path traversal, or broken config persistence.
 *
 * Coverage focus:
 * - Input validation (name length, slashes, path emptiness)
 * - CRUD lifecycle (list, get, create, update, delete)
 * - URI decoding edge cases (invalid percent-encoding)
 * - NotFound / error paths
 * - Sync endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createWorkspacesRoutes } from '../../../src/server/routes/workspaces.js';
import type { WorkspaceConfigStore } from '../../../src/server/config/WorkspaceConfigStore.js';
import type { WorkspaceService } from '../../../src/server/models/WorkspaceService.js';
import type { WorkspaceEntry, WorkspaceConfig } from '../../../src/server/types/index.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function createMockRequest(
  method: string,
  url: string,
  body?: string,
): IncomingMessage {
  let onDataCallback: ((chunk: Buffer) => void) | undefined;
  let onEndCallback: (() => void) | undefined;
  let onErrorCallback: ((err: Error) => void) | undefined;

  const req = {
    method,
    url,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'data') onDataCallback = cb as (chunk: Buffer) => void;
      if (event === 'end') onEndCallback = cb as () => void;
      if (event === 'error') onErrorCallback = cb as (err: Error) => void;
      return req;
    }),
  } as unknown as IncomingMessage;

  if (body !== undefined) {
    queueMicrotask(() => {
      onDataCallback?.(Buffer.from(body, 'utf8'));
      onEndCallback?.();
    });
  } else if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    queueMicrotask(() => {
      onEndCallback?.();
    });
  }

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
// Mock store + service
// ---------------------------------------------------------------------------

function makeEntry(name: string, wsPath: string, overrides?: Partial<WorkspaceEntry>): WorkspaceEntry {
  return {
    name,
    path: path.resolve(wsPath),
    lastSync: null,
    config: {
      workspaceName: name,
      enabled: true,
      displayName: null,
      syncEnabled: true,
    },
    ...overrides,
  };
}

function createMockStore(initial: WorkspaceEntry[] = []): {
  store: WorkspaceConfigStore;
  entries: WorkspaceEntry[];
} {
  const entries: WorkspaceEntry[] = [...initial];
  const store = {
    getWorkspaces: vi.fn(() => entries),
    getWorkspace: vi.fn((name: string) => entries.find(e => e.name === name) ?? null),
    addWorkspace: vi.fn((name: string, wsPath: string) => {
      if (!name || name.length > 128) {
        throw new Error('Workspace name must be between 1 and 128 characters');
      }
      if (name.includes('/') || name.includes('\\')) {
        throw new Error('Workspace name cannot contain slashes');
      }
      if (entries.some(e => e.name === name)) {
        throw new Error(`Workspace "${name}" already exists`);
      }
      entries.push(makeEntry(name, wsPath));
    }),
    updateWorkspace: vi.fn((name: string, updates: Partial<WorkspaceConfig>) => {
      const entry = entries.find(e => e.name === name);
      if (!entry) {
        throw new Error(`Workspace "${name}" not found`);
      }
      if (entry.config) {
        entry.config = { ...entry.config, ...updates };
      }
    }),
    removeWorkspace: vi.fn((name: string) => {
      const idx = entries.findIndex(e => e.name === name);
      if (idx === -1) {
        throw new Error(`Workspace "${name}" not found`);
      }
      entries.splice(idx, 1);
    }),
    updateSyncTime: vi.fn((name: string) => {
      const entry = entries.find(e => e.name === name);
      if (entry) {
        entry.lastSync = new Date().toISOString();
      }
    }),
  } as unknown as WorkspaceConfigStore;
  return { store, entries };
}

function createMockService(store: WorkspaceConfigStore): WorkspaceService {
  return {
    syncWorkspace: vi.fn(async (name: string) => {
      const entry = (store as unknown as { getWorkspace: (n: string) => WorkspaceEntry | null }).getWorkspace(name);
      if (!entry) {
        throw new Error(`Workspace "${name}" not found`);
      }
      (store as unknown as { updateSyncTime: (n: string) => void }).updateSyncTime(name);
      return {
        success: true,
        syncedAt: new Date().toISOString(),
        items: {},
      };
    }),
  } as unknown as WorkspaceService;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Workspaces API route', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workspaces-route-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/workspaces', () => {
    it('returns empty list when no workspaces exist', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      expect((body as { success: boolean; data: unknown[] }).data).toEqual([]);
    });

    it('returns all workspace entries', async () => {
      const ws1Path = path.join(tempDir, 'ws1');
      const ws2Path = path.join(tempDir, 'ws2');
      fs.mkdirSync(ws1Path, { recursive: true });
      fs.mkdirSync(ws2Path, { recursive: true });

      const { store } = createMockStore([
        makeEntry('workspace-one', ws1Path),
        makeEntry('workspace-two', ws2Path),
      ]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const data = (body as { success: boolean; data: WorkspaceEntry[] }).data;
      expect(data).toHaveLength(2);
      expect(data[0]?.name).toBe('workspace-one');
      expect(data[1]?.name).toBe('workspace-two');
    });
  });

  describe('POST /api/workspaces — create', () => {
    it('creates a workspace with valid name and path', async () => {
      const wsPath = path.join(tempDir, 'my-workspace');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store, entries } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: 'my-project', path: wsPath }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const entry = (body as { success: boolean; data: WorkspaceEntry }).data;
      expect(entry.name).toBe('my-project');
      expect(entry.path).toBe(path.resolve(wsPath));
      expect(entries).toHaveLength(1);
    });

    it('returns 400 when name is missing', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('POST', '/api/workspaces', JSON.stringify({ path: wsPath }));
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
      expect((body as { success: boolean; error: string }).success).toBe(false);
    });

    it('returns 400 when path is missing', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('POST', '/api/workspaces', JSON.stringify({ name: 'test' }));
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
      expect((body as { success: boolean; error: string }).success).toBe(false);
    });

    it('returns 400 when name contains forward slash', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: 'bad/name', path: wsPath }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
      expect((body as { success: boolean; error: string }).success).toBe(false);
    });

    it('returns 400 when name contains backslash', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: 'bad\\name', path: wsPath }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
    });

    it('returns 400 when name exceeds 128 characters', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });
      const longName = 'a'.repeat(129);

      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: longName, path: wsPath }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
    });

    it('returns 400 when path is empty string', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: 'test', path: '' }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
    });

    it('returns 409 when workspace with same name already exists', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore([makeEntry('duplicate', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'POST',
        '/api/workspaces',
        JSON.stringify({ name: 'duplicate', path: wsPath }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(409);
      expect((body as { success: boolean; error: string }).success).toBe(false);
    });

    it('returns 400 with non-JSON body (safeParse returns {})', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('POST', '/api/workspaces', 'not-json-at-all');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
    });
  });

  describe('GET /api/workspaces/:name', () => {
    it('returns a single workspace by name', async () => {
      const wsPath = path.join(tempDir, 'alpha');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore([makeEntry('alpha', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces/alpha');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/alpha');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const entry = (body as { success: boolean; data: WorkspaceEntry }).data;
      expect(entry.name).toBe('alpha');
    });

    it('returns 404 for non-existent workspace', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces/nope');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/nope');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(404);
    });

    it('decodes URI-encoded workspace names', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore([makeEntry('my project', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces/my%20project');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/my%20project');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const entry = (body as { success: boolean; data: WorkspaceEntry }).data;
      expect(entry.name).toBe('my project');
    });

    it('returns 400 for invalid URI encoding', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces/%ZZ');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/%ZZ');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(400);
    });
  });

  describe('PATCH /api/workspaces/:name — update', () => {
    it('updates workspace config', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store, entries } = createMockStore([makeEntry('patch-me', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'PATCH',
        '/api/workspaces/patch-me',
        JSON.stringify({ displayName: 'My Display', enabled: false }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/patch-me');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const entry = (body as { success: boolean; data: WorkspaceEntry }).data;
      expect(entry.config?.displayName).toBe('My Display');
      expect(entry.config?.enabled).toBe(false);
      expect(entries[0]?.config?.displayName).toBe('My Display');
    });

    it('returns 404 when updating non-existent workspace', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest(
        'PATCH',
        '/api/workspaces/ghost',
        JSON.stringify({ enabled: false }),
      );
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/ghost');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(404);
    });
  });

  describe('DELETE /api/workspaces/:name', () => {
    it('deletes an existing workspace', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store, entries } = createMockStore([makeEntry('delete-me', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      expect(entries).toHaveLength(1);

      const req = createMockRequest('DELETE', '/api/workspaces/delete-me');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/delete-me');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      expect((body as { success: boolean; data: { removed: string } }).data.removed).toBe('delete-me');
      expect(entries).toHaveLength(0);
    });

    it('returns 404 when deleting non-existent workspace', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('DELETE', '/api/workspaces/nope');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/nope');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(404);
    });
  });

  describe('POST /api/workspaces/:name/sync', () => {
    it('triggers sync for existing workspace', async () => {
      const wsPath = path.join(tempDir, 'ws');
      fs.mkdirSync(wsPath, { recursive: true });

      const { store } = createMockStore([makeEntry('sync-me', wsPath)]);
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('POST', '/api/workspaces/sync-me/sync');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/sync-me/sync');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const result = (body as { success: boolean; data: { success: boolean; syncedAt: string } }).data;
      expect(result.success).toBe(true);
      expect(result.syncedAt).toBeDefined();
    });

    it('returns 404 when syncing non-existent workspace', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('POST', '/api/workspaces/ghost/sync');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/ghost/sync');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(404);
    });
  });

  describe('Unknown routes / methods', () => {
    it('returns 404 for unknown sub-path', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('GET', '/api/workspaces/x/unknown/thing');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '/x/unknown/thing');

      const { statusCode } = parseBody(res);
      expect(statusCode).toBe(404);
    });

    it('returns 404 for PUT method on collection', async () => {
      const { store } = createMockStore();
      const service = createMockService(store);
      const { handleWorkspacesRoute } = createWorkspacesRoutes(store, service);

      const req = createMockRequest('PUT', '/api/workspaces');
      const res = createMockResponse();
      await handleWorkspacesRoute(req, res, '');

      const { statusCode } = parseBody(res);
      expect(statusCode).toBe(404);
    });
  });
});
