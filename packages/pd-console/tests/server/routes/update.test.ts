import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

// Mock the updater module
vi.mock('../../../../create-principles-disciple/src/updater.js', () => ({
  checkForUpdates: vi.fn(),
  applyUpdate: vi.fn(),
  rollbackUpdate: vi.fn(),
}));

// Import mocked functions for type-safe assertions
import { checkForUpdates, applyUpdate, rollbackUpdate } from '../../../../create-principles-disciple/src/updater.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const chunks: Buffer[] = [];
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';

  const req = {
    method,
    url: '/api/update/test',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && chunks.length > 0) {
        for (const chunk of chunks) {
          handler(chunk);
        }
      }
      if (event === 'data' && chunks.length === 0 && body !== undefined) {
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

// ---------------------------------------------------------------------------
// Setup: create a temporary workspace with plugin dir and package.json
// ---------------------------------------------------------------------------

let workspaceDir: string;
let pluginDir: string;

beforeEach(() => {
  vi.clearAllMocks();

  // Create a temp workspace structure:
  // tmpDir/
  //   workspace/          <- workspaceDir
  //   extensions/
  //     principles-disciple/
  //       package.json    <- { version: "1.0.0" }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const extensionsDir = path.join(tmpDir, 'extensions', 'principles-disciple');
  fs.mkdirSync(extensionsDir, { recursive: true });
  pluginDir = extensionsDir;

  const packageJson = { name: 'principles-disciple', version: '1.0.0' };
  fs.writeFileSync(path.join(extensionsDir, 'package.json'), JSON.stringify(packageJson));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleUpdateRoute', () => {
  // ── GET /check ──────────────────────────────────────────────────────

  describe('GET /check', () => {
    it('should return update info on success', async () => {
      vi.mocked(checkForUpdates).mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { hasUpdate: boolean; currentVersion: string; latestVersion?: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.hasUpdate).toBe(true);
      expect(body.data.currentVersion).toBe('1.0.0');
      expect(body.data.latestVersion).toBe('2.0.0');
    });

    it('should return 405 for non-GET method', async () => {
      const req = createMockRequest('POST');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.success).toBe(false);
      expect(body.error).toBe('method_not_allowed');
    });

    it('should return 500 when version cannot be determined', async () => {
      // Use a workspace dir that has no plugin dir
      const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-noplugin-'));
      const emptyWorkspace = path.join(emptyTmpDir, 'workspace');
      fs.mkdirSync(emptyWorkspace, { recursive: true });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, emptyWorkspace, '/check');

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.success).toBe(false);
      expect(body.error).toBe('version_not_found');
    });
  });

  // ── POST /apply ─────────────────────────────────────────────────────

  describe('POST /apply', () => {
    it('should apply update and return result', async () => {
      vi.mocked(applyUpdate).mockResolvedValue({
        success: true,
        message: 'Update applied successfully',
        updatedFiles: ['file1.ts'],
      });

      const req = createMockRequest('POST', {
        targetDir: '/some/target',
        mergeStrategy: 'smart',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(true);
    });

    it('should return 405 for non-POST method', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });

    it('should return 400 for missing targetDir', async () => {
      const req = createMockRequest('POST', {
        mergeStrategy: 'smart',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('targetDir');
    });

    it('should return 400 for invalid mergeStrategy', async () => {
      const req = createMockRequest('POST', {
        targetDir: '/some/target',
        mergeStrategy: 'invalid',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('mergeStrategy');
    });
  });

  // ── GET /status ─────────────────────────────────────────────────────

  describe('GET /status', () => {
    it('should return current update status', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/status');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { checking: boolean; updating: boolean; currentVersion: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.checking).toBe(false);
      expect(body.data.updating).toBe(false);
      expect(body.data.currentVersion).toBe('1.0.0');
    });

    it('should return 405 for non-GET method', async () => {
      const req = createMockRequest('POST');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/status');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });
  });

  // ── POST /rollback ──────────────────────────────────────────────────

  describe('POST /rollback', () => {
    it('should rollback update and return result', async () => {
      vi.mocked(rollbackUpdate).mockResolvedValue({
        success: true,
        message: 'Rollback completed successfully',
      });

      const req = createMockRequest('POST', {
        targetDir: '/some/target',
        backupDir: '/some/backup',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(true);
    });

    it('should return 405 for non-POST method', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });

    it('should return 400 for missing targetDir', async () => {
      const req = createMockRequest('POST', {
        backupDir: '/some/backup',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('targetDir');
    });

    it('should return 400 for missing backupDir', async () => {
      const req = createMockRequest('POST', {
        targetDir: '/some/target',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('backupDir');
    });
  });

  // ── Unknown sub-path ────────────────────────────────────────────────

  describe('Unknown sub-path', () => {
    it('should return 404 for unknown sub-path', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/unknown');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.success).toBe(false);
      expect(body.error).toBe('not_found');
    });
  });
});
