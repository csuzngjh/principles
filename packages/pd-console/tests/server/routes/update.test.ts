import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn());

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';

  const req = {
    method,
    url: '/api/update/test',
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

// ---------------------------------------------------------------------------
// Setup: create a temporary workspace with plugin dir and package.json
// ---------------------------------------------------------------------------

let workspaceDir: string;
let pluginDir: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const extensionsDir = path.join(tmpDir, 'extensions', 'principles-disciple');
  fs.mkdirSync(extensionsDir, { recursive: true });
  pluginDir = extensionsDir;

  const packageJson = { name: 'principles-disciple', version: '1.0.0' };
  fs.writeFileSync(path.join(extensionsDir, 'package.json'), JSON.stringify(packageJson));
});

afterEach(() => {
  // Cleanup temp dir
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Import after mocks are set up
const { handleUpdateRoute } = await import('../../../src/server/routes/update.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleUpdateRoute', () => {
  // ── GET /check ──────────────────────────────────────────────────────

  describe('GET /check', () => {
    it('should return update info when newer version exists', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      } as Response);

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

    it('should return hasUpdate false when current is latest', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      } as Response);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ success: boolean; data: { hasUpdate: boolean } }>(res);
      expect(body.data.hasUpdate).toBe(false);
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
      const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-noplugin-'));
      const emptyWorkspace = path.join(emptyTmpDir, 'workspace');
      fs.mkdirSync(emptyWorkspace, { recursive: true });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, emptyWorkspace, '/check');

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.error).toBe('version_not_found');

      fs.rmSync(emptyTmpDir, { recursive: true, force: true });
    });
  });

  // ── POST /apply ─────────────────────────────────────────────────────

  describe('POST /apply', () => {
    it('should apply update and return result', async () => {
      // Mock fetch for package info
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
      } as Response);

      // Create a real target dir with package.json
      const targetDir = path.join(tmpDir, 'target');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const req = createMockRequest('POST', {
        targetDir,
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
      const req = createMockRequest('POST', { mergeStrategy: 'smart' });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('targetDir');
    });

    it('should return 400 for invalid mergeStrategy', async () => {
      const req = createMockRequest('POST', { targetDir: '/some/target', mergeStrategy: 'invalid' });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
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
      // Create real backup and target dirs
      const targetDir = path.join(tmpDir, 'target');
      const backupDir = path.join(tmpDir, 'backup');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
      fs.writeFileSync(path.join(backupDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const req = createMockRequest('POST', { targetDir, backupDir });
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
      const req = createMockRequest('POST', { backupDir: '/some/backup' });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should return 400 for missing backupDir', async () => {
      const req = createMockRequest('POST', { targetDir: '/some/target' });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
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
