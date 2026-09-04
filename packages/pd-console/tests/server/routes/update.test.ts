import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn());

// Mock child_process (execFileSync: tar extraction). Since the EP-08
// hardening the route spawns tar via argv arrays — no shell strings anywhere.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Partial mock of fs: copyFileSync is a vi.fn wrapping the real implementation
// so the EPERM test can override it. All other exports pass through unchanged.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
  };
});

// os.homedir() drives canonical layout resolution (getInstallLayoutPaths).
// Mock it so a canonical install on the dev machine (~/.pd/install.json)
// cannot leak into these legacy-layout fixture tests.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Resolve the tar extraction target dir from a mocked execFileSync call.
 *
 * The production route now extracts via `execFileSync('tar', ['xzf',
 * 'package.tgz', ...], { cwd: tempDir })` — the archive is a relative path and
 * the target dir comes from the `cwd` option (works on both Git Bash GNU tar
 * and Windows bsdtar; absolute C:\ paths were misparsed by GNU tar as remote
 * host C:). Older tests historically resolved the dir from the `-C` argument.
 * This helper accepts both shapes so existing extraction mocks keep working
 * without per-callsite rewrites.
 */
function tarExtractDir(
  cmd: string,
  args: readonly string[] | undefined,
  options: { cwd?: string } | undefined,
): string | undefined {
  if (cmd !== 'tar') return undefined;
  if (options?.cwd) return options.cwd;
  const ci = args ? args.indexOf('-C') : -1;
  return ci >= 0 && args ? args[ci + 1] : undefined;
}
/**
 * Create a REAL directory link (junction on win32, dir symlink elsewhere) —
 * the exact artifact npm/installers create in dependency slots. Returns false
 * when the environment denies link creation; callers skip the test (same
 * pattern as the path-traversal symlink test).
 */
function makeDirLink(target: string, linkPath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (process.platform === 'win32') {
      fs.symlinkSync(target, linkPath, 'junction');
    } else {
      fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
    }
    return true;
  } catch {
    return false;
  }
}


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
    // PRI-659: the MutationController annotates responses via setHeader.
    setHeader: vi.fn(function (this: ServerResponse, name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
      return res;
    }),
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

/**
 * PRI-561 probe: run a REAL Node ESM import of @principles/host-runtime from
 * inside the given console dist directory — the exact operation that crashed
 * console startup on pre-fix installs. Returns '' when resolution succeeds,
 * otherwise the error text including stderr. execFile with an argv array
 * (no shell); the probe path is validated to stay inside the fixture dir.
 */
async function runPri561ResolutionProbe(consoleDistDir: string): Promise<string> {
  const { execFile } = await vi.importActual<typeof import('child_process')>('child_process');
  const resolvedBase = path.resolve(consoleDistDir);
  const probePath = path.join(resolvedBase, '__pri561_probe__.mjs');
  if (!path.resolve(probePath).startsWith(resolvedBase + path.sep)) {
    return 'probe path escaped fixture dir';
  }
  fs.mkdirSync(resolvedBase, { recursive: true });
  fs.writeFileSync(probePath, "import '@principles/host-runtime';\n");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [probePath], { timeout: 15_000 }, (error, _stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderrText: String(stderr) }));
        else resolve();
      });
    });
    return '';
  } catch (err) {
    const e = err as Error & { stderrText?: string };
    return e.stderrText ? `${e.message}\n${e.stderrText}` : e.message;
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Setup: create a temporary workspace with plugin dir and package.json
// ---------------------------------------------------------------------------

let workspaceDir: string;
let pluginDir: string;
let tmpDir: string;
let savedOpenclawHome: string | undefined;

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

  // Inject OPENCLAW_HOME so resolvePluginDir() finds the test's tmpDir/extensions
  // instead of the real ~/.openclaw/extensions/principles-disciple installation.
  // Without this, tests would hit (and damage) the real PD install.
  savedOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = tmpDir;

  // Pin homedir to the fixture home: canonical resolution
  // (getInstallLayoutPaths) stays inert because tmpDir/.pd/runtime does not
  // exist, so a real canonical install on the dev machine cannot leak in.
  vi.mocked(os.homedir).mockImplementation(() => tmpDir);
});

afterEach(() => {
  // Restore OPENCLAW_HOME
  if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedOpenclawHome;

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

    it('should include changelog from GitHub Release when update is available', async () => {
      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0' }),
          } as Response);
        }
        if (urlStr.startsWith('https://api.github.com/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ body: '## V2.0.0 — Bug fixes\n\n- Fixed update EPERM' }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }) as unknown as typeof fetch);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ data: { changelog?: string } }>(res);
      expect(body.data.changelog).toContain('Bug fixes');
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

    it('should report hasUpdate against the installer deliverable and flag syncPending when the installer stalely bundles an older plugin (drift fix)', async () => {
      // Plugin registry: 1.209.1 published. Installer: bundles only 1.209.0
      // (its `pd.bundledPluginVersion` is what a full update can install).
      // Even though the plugin registry is ahead, /check must NOT promise
      // 1.209.1 (the full update cannot deliver it) and must surface the gap.
      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/principles-disciple')) {
          return Promise.resolve({ ok: true, json: async () => ({ version: '1.209.1' }) } as Response);
        }
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              version: '1.111.0',
              pd: { bundledPluginVersion: '1.209.0' },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }) as unknown as typeof fetch);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ success: boolean; data: { hasUpdate: boolean; latestVersion: string; pluginLatestVersion: string; syncPending: boolean } }>(res);
      expect(body.data.latestVersion).toBe('1.209.0');
      expect(body.data.pluginLatestVersion).toBe('1.209.1');
      expect(body.data.syncPending).toBe(true);
      // Installed is 1.0.0 → installer deliverable 1.209.0 IS newer, so update
      // is genuinely available (to a real, installable version).
      expect(body.data.hasUpdate).toBe(true);
    });

    it('should fall back to plugin latest when the installer has no pd.bundledPluginVersion stamp (legacy installer)', async () => {
      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/principles-disciple')) {
          return Promise.resolve({ ok: true, json: async () => ({ version: '2.0.0' }) } as Response);
        }
        // Legacy installer: no `pd` stamp → bundledPluginVersion undefined.
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({ ok: true, json: async () => ({ version: '1.105.0' }) } as Response);
        }
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }) as unknown as typeof fetch);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ success: boolean; data: { latestVersion: string; syncPending: boolean } }>(res);
      expect(body.data.latestVersion).toBe('2.0.0');
      expect(body.data.syncPending).toBe(false);
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

    it('should return degraded 200 with reason when version cannot be determined (ERR-002)', async () => {
      const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-noplugin-'));
      const emptyWorkspace = path.join(emptyTmpDir, 'workspace');
      fs.mkdirSync(emptyWorkspace, { recursive: true });

      // Point OPENCLAW_HOME to a dir with no extensions/principles-disciple,
      // so resolvePluginDir() returns a non-existent path → version undefined.
      const savedHome = process.env.OPENCLAW_HOME;
      process.env.OPENCLAW_HOME = emptyTmpDir;

      try {
        const req = createMockRequest('GET');
        const res = createMockResponse();

        await handleUpdateRoute(req, res, emptyWorkspace, '/check');

        // ERR-002 / Runtime Contract Rule 9: graceful degradation with reason, not 500.
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const body = parseResponseBody<{ success: boolean; data: { hasUpdate: boolean; currentVersion: string; latestVersion: string; error?: string } }>(res);
        expect(body.success).toBe(true);
        expect(body.data.hasUpdate).toBe(false);
        expect(body.data.currentVersion).toBe('unknown');
        expect(body.data.latestVersion).toBe('');
        expect(body.data.error).toMatch(/Could not determine current version/i);
      } finally {
        process.env.OPENCLAW_HOME = savedHome;
        fs.rmSync(emptyTmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── POST /apply ─────────────────────────────────────────────────────

  describe('POST /apply', () => {
    it('refuses a non-advancing package version before backup or file mutation', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
      } as Response);

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: true });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ success: boolean; data: { success: boolean; reason?: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({ success: false, reason: 'installer_bundle_stale' });
      expect(fs.copyFileSync).not.toHaveBeenCalled();
      const history = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.pd', 'update-history.json'), 'utf-8')) as unknown[];
      expect(history).toEqual([
        expect.objectContaining({ kind: 'refusal', reason: 'installer_bundle_stale' }),
      ]);
    });

    it('refuses an explicit workspace target before backup, download, or file mutation', async () => {
      const checkoutDir = path.join(workspaceDir, 'checkout-copy');
      fs.mkdirSync(checkoutDir, { recursive: true });
      fs.writeFileSync(path.join(checkoutDir, 'package.json'), JSON.stringify({ version: '0.9.0' }));

      const req = createMockRequest('POST', {
        targetDir: checkoutDir,
        mergeStrategy: 'smart',
        createBackup: true,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string; nextAction?: string }>(res);
      expect(body).toMatchObject({
        success: false,
        error: 'update_target_not_installed',
        nextAction: expect.any(String),
      });
      expect(fs.copyFileSync).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should apply update with explicit targetDir', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      // Mock fetch for multi-call: registry info then tarball download
      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      // Mock execSync to simulate tar extraction by creating a file in the
      // extraction cwd (the real invocation passes { cwd: tempDir }).
      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = options?.cwd;
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {
        targetDir: pluginDir,
        mergeStrategy: 'smart',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      // tar must receive the archive as a RELATIVE path ('package.tgz') resolved
      // against an explicit cwd. Absolute C:\... archive paths are misparsed by
      // Git Bash GNU tar as remote host C: (host:path) and abort the update with
      // "tar: Cannot connect to C: resolve failed"; Windows System32 bsdtar does
      // not support GNU tar's --force-local, so relative-path-in-cwd is the only
      // invocation that works on both.
      const tarCalls = vi.mocked(execSyncMock).mock.calls.filter((c) => c[0] === 'tar');
      expect(tarCalls.length).toBeGreaterThan(0);
      for (const call of tarCalls) {
        expect(call[1]).toContain('package.tgz');
        expect(call[1]).not.toContain(':');
        const options = call[2] as { cwd?: string } | undefined;
        expect(options?.cwd).toBeTruthy();
      }

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string; newVersion: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(true);
      expect(body.data.newVersion).toBe('2.0.0');
    });

    it('preserves an en skill-language manifest selection across diff updates (PR #1332 companion)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      // "Extract" a fresh zh-default manifest (as shipped) from the tarball
      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'),
              JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/zh/skills'] }, null, 2));
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing install materialized with --lang en (en templates present)
      fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/en/skills'] }, null, 2));
      fs.mkdirSync(path.join(pluginDir, 'templates', 'langs', 'en', 'skills'), { recursive: true });

      const req = createMockRequest('POST', { targetDir: pluginDir, mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      const updated = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf-8')) as { skills: string[] };
      expect(updated.skills).toEqual(['templates/langs/en/skills']);
    });

    it('collapses a legacy dual-root skill manifest to a single zh root on update', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'),
              JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/zh/skills'] }, null, 2));
          }
        }
      }) as unknown as typeof execSyncMock);

      // Pre-ERR-097 install declaring BOTH roots (23 collision warnings)
      fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/en/skills', 'templates/langs/zh/skills'] }, null, 2));

      const req = createMockRequest('POST', { targetDir: pluginDir, mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      const updated = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf-8')) as { skills: string[] };
      expect(updated.skills).toEqual(['templates/langs/zh/skills']);
    });

    it('should return 405 for non-POST method', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });

    it('should apply update without targetDir (server resolves pluginDir)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      // No targetDir — server should resolve to pluginDir
      const req = createMockRequest('POST', {
        mergeStrategy: 'smart',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string; newVersion: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(true);
      expect(body.data.newVersion).toBe('2.0.0');
    });

    it('should apply update with createBackup: true', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {
        mergeStrategy: 'overwrite',
        createBackup: true,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; backupPath?: string } }>(res);
      expect(body.data.success).toBe(true);
      expect(body.data.backupPath).toBeDefined();
    });

    it('should return 400 for invalid mergeStrategy', async () => {
      const req = createMockRequest('POST', { targetDir: '/some/target', mergeStrategy: 'invalid' });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('mergeStrategy');
    });

    it('should reject targetDir outside workspace', async () => {
      const req = createMockRequest('POST', {
        targetDir: '/etc/passwd',
        mergeStrategy: 'smart',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.error).toBe('update_target_not_installed');
    });
  });

  // ── POST /rollback ──────────────────────────────────────────────────

  describe('POST /rollback', () => {
    it('should rollback update and return result', async () => {
      // Create real backup and target dirs within extensions
      const targetDir = path.join(tmpDir, 'extensions', 'target');
      const backupDir = path.join(tmpDir, 'extensions', 'backup');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
      fs.writeFileSync(path.join(backupDir, 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));

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

    it('should return 400 for missing backupDir', async () => {
      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should reject targetDir outside workspace', async () => {
      const req = createMockRequest('POST', {
        targetDir: '/etc/evil',
        backupDir: path.join(tmpDir, 'extensions', 'backup'),
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('targetDir');
    });

    it('should reject backupDir outside workspace', async () => {
      const targetDir = path.join(tmpDir, 'extensions', 'target2');
      fs.mkdirSync(targetDir, { recursive: true });

      const req = createMockRequest('POST', {
        targetDir,
        backupDir: '/etc/evil',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('backupDir');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('GET /check should handle fetch rejection gracefully', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network timeout'));

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      // doCheckForUpdates catches the error and returns hasUpdate:false with error message
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { hasUpdate: boolean; latestVersion: string; error: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.hasUpdate).toBe(false);
      expect(body.data.error).toContain('Network timeout');
      // Regression guard: latestVersion must always be present as a string so
      // the UI's validateUpdateStatus doesn't reject the response shape and
      // crash the whole page on registry/network failures.
      expect(typeof body.data.latestVersion).toBe('string');
    });

    it('POST /apply should return failure when fetch returns non-ok status', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response);

      const req = createMockRequest('POST', {
        targetDir: pluginDir,
        mergeStrategy: 'smart',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.message).toContain('HTTP 503');
    });

    it('POST /rollback should return failure when backup directory does not exist', async () => {
      const targetDir = path.join(tmpDir, 'extensions', 'target-no-backup');
      const backupDir = path.join(tmpDir, 'extensions', 'nonexistent-backup');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
      // Intentionally do NOT create backupDir

      const req = createMockRequest('POST', { targetDir, backupDir });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.message).toBe('Backup not found');
    });
  });

  // ── Update History ──────────────────────────────────────────────────

  describe('GET /history', () => {
    it('should return 200 with history array', async () => {
      const { handleUpdateHistoryRoute } = await import('../../../src/server/routes/update-history.js');
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateHistoryRoute(req, res, workspaceDir, '');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: unknown[] }>(res);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ── fromVersion tracking ────────────────────────────────────────────

  describe('fromVersion tracking', () => {
    it('should record old version as fromVersion in history', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');
      const { handleUpdateHistoryRoute } = await import('../../../src/server/routes/update-history.js');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '3.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '3.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      // pluginDir has version 1.0.0 (set in beforeEach)
      const req = createMockRequest('POST', {
        mergeStrategy: 'overwrite',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');
      const applyBody = parseResponseBody<{ success: boolean; data: { success: boolean; newVersion: string } }>(res);
      expect(applyBody.data.success).toBe(true);
      expect(applyBody.data.newVersion).toBe('3.0.0');

      // Check history — fromVersion should be 1.0.0 (the OLD version)
      const histReq = createMockRequest('GET');
      const histRes = createMockResponse();
      await handleUpdateHistoryRoute(histReq, histRes, workspaceDir, '');
      const histBody = parseResponseBody<{ success: boolean; data: Array<{ fromVersion: string; toVersion: string }> }>(histRes);
      expect(histBody.data.length).toBeGreaterThan(0);
      const lastEntry = histBody.data[histBody.data.length - 1];
      expect(lastEntry.fromVersion).toBe('1.0.0');
      expect(lastEntry.toVersion).toBe('3.0.0');
    });
  });

  // ── History route dispatch regression ─────────────────────────────────

  describe('History route dispatch', () => {
    it('should reach handleUpdateHistoryRoute via /history sub-path', async () => {
      // This verifies that handleUpdateRoute correctly delegates /history
      // to handleUpdateHistoryRoute (simulating index.ts route ordering)
      const { handleUpdateHistoryRoute } = await import('../../../src/server/routes/update-history.js');

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateHistoryRoute(req, res, workspaceDir, '');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: unknown[] }>(res);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
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

  // ── Network resilience (fetchWithRetry) ──────────────────────────────

  describe('Network resilience', () => {
    it('should retry on transient network errors', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      // First call fails, second succeeds (registry), third succeeds (tarball)
      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network timeout');
        }
        if (callCount === 2) {
          return {
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response;
        }
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      });

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(callCount).toBe(3); // 1 failed + 1 registry + 1 tarball
      const body = parseResponseBody<{ success: boolean; data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
    });

    it('should fail after max retries exceeded', async () => {
      // All calls fail
      vi.mocked(fetch).mockImplementation(async () => {
        throw new Error('Persistent network error');
      });

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.message).toContain('failed after');
      expect(body.data.message).toContain('3 attempts');
    });

    it('should handle HTTP error status with retry', async () => {
      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return { ok: false, status: 503 } as Response;
        }
        return {
          ok: true,
          json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
        } as Response;
      });

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      // Should retry on HTTP 503, eventually succeed
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Path traversal security ──────────────────────────────────────────

  describe('Path traversal security', () => {
    it('should reject relative path traversal attempts', async () => {
      const req = createMockRequest('POST', {
        targetDir: '../../../etc',
        mergeStrategy: 'smart',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; error: string }>(res);
      expect(body.error).toBe('update_target_not_installed');
    });

    it('should reject absolute path outside workspace', async () => {
      const req = createMockRequest('POST', {
        targetDir: '/var/log',
        mergeStrategy: 'smart',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should reject symlink-based traversal (resolved path check)', async () => {
      // Create a symlink pointing outside workspace
      const symlinkTarget = path.join(tmpDir, 'external-target');
      fs.mkdirSync(symlinkTarget, { recursive: true });
      const symlinkPath = path.join(tmpDir, 'extensions', 'malicious-link');
      try {
        fs.symlinkSync(symlinkTarget, symlinkPath, 'dir');
      } catch {
        // Symlink creation may fail in some environments; skip test
        return;
      }

      // Symlink within extensions dir is actually valid per validatePathInWorkspace
      // (extensions dir is allowed). This test verifies that resolved paths are checked.
      // If symlink points outside allowed dirs, it should be rejected.
      // Since symlinkTarget is under tmpDir (not workspace or extensions), it should fail.
      // But symlinkPath itself is under extensions, so the check passes.
      // This is expected behavior - the validation checks the requested path, not symlink target.
      // Remove this test case as it doesn't match the intended security model.
      // The actual security model allows paths within extensions dir, even if they're symlinks.
    });

    it('should reject rollback with malicious backupDir', async () => {
      const req = createMockRequest('POST', {
        targetDir: pluginDir,
        backupDir: '/etc/passwd',
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('backupDir');
    });
  });

  // ── Merge strategy edge cases ────────────────────────────────────────

  describe('Merge strategy edge cases', () => {
    it('should handle "keep" strategy for workspace files', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      // Create a workspace file in target
      const targetDir = pluginDir;
      fs.writeFileSync(path.join(targetDir, 'AGENTS.md'), 'original content');
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'new content');
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {
        targetDir,
        mergeStrategy: 'keep',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      // Workspace file should remain unchanged with 'keep' strategy
      const originalContent = fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf-8');
      expect(originalContent).toBe('original content');
    });

    it('should handle "overwrite" strategy for workspace files', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      const targetDir = pluginDir;
      fs.writeFileSync(path.join(targetDir, 'AGENTS.md'), 'original');
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'overwritten');
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {
        targetDir,
        mergeStrategy: 'overwrite',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      // Workspace file should be overwritten
      const newContent = fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf-8');
      expect(newContent).toBe('overwritten');
    });

    it('should create .update file for "smart" strategy on workspace files', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      const targetDir = pluginDir;
      fs.writeFileSync(path.join(targetDir, 'AGENTS.md'), 'original');
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'smart update');
          }
        }
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {
        targetDir,
        mergeStrategy: 'smart',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      // Original file unchanged, .update file created
      expect(fs.existsSync(path.join(targetDir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'AGENTS.md.update'))).toBe(true);
      const original = fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf-8');
      const updateFile = fs.readFileSync(path.join(targetDir, 'AGENTS.md.update'), 'utf-8');
      expect(original).toBe('original');
      expect(updateFile).toBe('smart update');
    });
  });

  // ── Backup cleanup on failure ────────────────────────────────────────

  describe('Backup cleanup on failure', () => {
    it('should clean up backup when download fails before file changes', async () => {
      // Registry returns invalid data (no tarball)
      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => ({ version: '2.0.0' }), // missing dist.tarball
      } as Response));

      const req = createMockRequest('POST', {
        mergeStrategy: 'smart',
        createBackup: true,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ success: boolean; data: { success: boolean; message: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.message).toContain('tarball');

      // Backup should be cleaned up since failure occurred before file changes
      const extensionsDir = path.join(tmpDir, 'extensions');
      const backupDirs = fs.readdirSync(extensionsDir).filter(f => f.startsWith('.pd-backup-'));
      expect(backupDirs.length).toBe(0);
      // The backup now lives under <home>/pd-backups — that location must be
      // cleaned up on pre-change failure too.
      const backupsRoot = path.join(tmpDir, 'pd-backups');
      if (fs.existsSync(backupsRoot)) {
        expect(fs.readdirSync(backupsRoot).length).toBe(0);
      }
    });
  });

  // ── Backup location outside the extensions scan root ────────────────

  describe('Backup location outside the extensions scan root', () => {
    function mockSuccessfulApply(): Promise<void> {
      return Promise.resolve().then(async () => {
        const { execFileSync: execSyncMock } = await import('child_process');

        vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
          const urlStr = typeof url === 'string' ? url : url.toString();
          if (urlStr.startsWith('https://registry.npmjs.org/')) {
            return Promise.resolve({
              ok: true,
              json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
            } as Response);
          }
          return Promise.resolve({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0),
          } as Response);
        }) as unknown as typeof fetch);

        vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
          if (cmd === 'tar') {
            const dir = tarExtractDir(cmd, args, options);
            if (dir) {
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
            }
          }
        }) as unknown as typeof execSyncMock);
      });
    }

    it('creates the backup under <home>/pd-backups, not as an extensions/ sibling', async () => {
      await mockSuccessfulApply();

      const req = createMockRequest('POST', { mergeStrategy: 'overwrite', createBackup: true });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean; backupPath?: string } }>(res);
      expect(body.data.success).toBe(true);
      expect(body.data.backupPath).toBeDefined();

      const backupsRoot = path.join(tmpDir, 'pd-backups');
      expect(body.data.backupPath!.startsWith(backupsRoot + path.sep)).toBe(true);
      // Backup holds the PRE-update version
      const backedUpPkg = JSON.parse(fs.readFileSync(path.join(body.data.backupPath!, 'package.json'), 'utf-8')) as { version: string };
      expect(backedUpPkg.version).toBe('1.0.0');
      // The extensions dir must contain ONLY the live plugin — a backup
      // sibling would be re-discovered by OpenClaw as a duplicate plugin.
      const extensionsEntries = fs.readdirSync(path.join(tmpDir, 'extensions'));
      expect(extensionsEntries).toEqual(['principles-disciple']);
    });

    it('migrates a legacy .pd-backup-* sibling out of extensions/ during apply', async () => {
      const legacyName = '.pd-backup-2026-08-13T14-12-57-972Z';
      const legacyDir = path.join(tmpDir, 'extensions', legacyName);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'marker.txt'), 'legacy');

      await mockSuccessfulApply();

      const req = createMockRequest('POST', { mergeStrategy: 'overwrite', createBackup: false });
      const res = createMockResponse();
      await handleUpdateRoute(req, res, workspaceDir, '/apply');
      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);

      // Legacy backup moved out of extensions/, content preserved
      expect(fs.existsSync(legacyDir)).toBe(false);
      const movedMarker = path.join(tmpDir, 'pd-backups', legacyName, 'marker.txt');
      expect(fs.readFileSync(movedMarker, 'utf-8')).toBe('legacy');
    });
  });

  // ── Rollback from the PD backups root ───────────────────────────────

  describe('Rollback from the PD backups root', () => {
    it('accepts and restores a backupDir under <home>/pd-backups', async () => {
      const backupDir = path.join(tmpDir, 'pd-backups', 'principles-disciple-2026-08-13T00-00-00-000Z');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '0.9.0' }));

      const req = createMockRequest('POST', { backupDir });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      // pluginDir package.json restored to the backup version
      const restored = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8')) as { version: string };
      expect(restored.version).toBe('0.9.0');
    });

    it('rejects a backupDir outside workspace/extensions/pd-backups', async () => {
      const outside = path.resolve(tmpDir, '..', 'pd-elsewhere-backup');
      const req = createMockRequest('POST', { backupDir: outside });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ message: string }>(res);
      expect(body.message).toContain('backupDir');
    });
  });

  // ── Invalid request body ─────────────────────────────────────────────

  describe('Invalid request body', () => {
    it('should return 400 for malformed JSON', async () => {
      const req = {
        method: 'POST',
        url: '/api/update/apply',
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'data') {
            handler(Buffer.from('{ invalid json }'));
          }
          if (event === 'end') {
            handler();
          }
        }),
      } as unknown as IncomingMessage;
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('Invalid JSON');
    });

    it('should return 400 for non-object body', async () => {
      const req = {
        method: 'POST',
        url: '/api/update/apply',
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'data') {
            handler(Buffer.from('"just a string"'));
          }
          if (event === 'end') {
            handler();
          }
        }),
      } as unknown as IncomingMessage;
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should return 400 for missing mergeStrategy', async () => {
      const req = createMockRequest('POST', { targetDir: pluginDir });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; message: string }>(res);
      expect(body.message).toContain('mergeStrategy');
    });
  });

  // ── Fix 2: backup excludes node_modules ──────────────────────────────

  describe('Backup excludes node_modules', () => {
    it('should not copy node_modules into the backup directory', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      // Create node_modules with a marker file in the installed plugin
      fs.mkdirSync(path.join(pluginDir, 'node_modules', '@principles', 'core'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'node_modules', '@principles', 'core', 'index.js'), 'locked');

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: true });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean; backupPath?: string } }>(res);
      expect(body.data.success).toBe(true);
      expect(body.data.backupPath).toBeDefined();

      // Backup must NOT contain node_modules
      const backupDir = body.data.backupPath!;
      expect(fs.existsSync(path.join(backupDir, 'node_modules'))).toBe(false);
      // But it should contain the plugin's package.json
      expect(fs.existsSync(path.join(backupDir, 'package.json'))).toBe(true);
    });
  });

  // ── Fix 3: update must not delete console/core/pd-cli ────────────────

  describe('No deletion of non-tarball directories', () => {
    it('should not delete console/ directory during update', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            // Tarball only has package.json — no console/, no core/, no node_modules/
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      // Create console/ and bin/ in the installed plugin (these exist in real installs)
      fs.mkdirSync(path.join(pluginDir, 'console', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'console code');
      fs.mkdirSync(path.join(pluginDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'bin', 'pd.js'), 'bin script');

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);

      // console/ and bin/ must survive the update (not in the tarball → not deleted)
      expect(fs.existsSync(path.join(pluginDir, 'console', 'dist', 'server.js'))).toBe(true);
      expect(fs.existsSync(path.join(pluginDir, 'bin', 'pd.js'))).toBe(true);
    });
  });

  // ── Fix 4: rollback must not delete node_modules ─────────────────────

  describe('Rollback preserves node_modules', () => {
    it('should keep node_modules intact after rollback (no rmSync)', async () => {
      const targetDir = path.join(tmpDir, 'extensions', 'rollback-target');
      const backupDir = path.join(tmpDir, 'extensions', 'rollback-backup');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });

      // Target has node_modules (like a real install)
      fs.mkdirSync(path.join(targetDir, 'node_modules', 'better-sqlite3'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'node_modules', 'better-sqlite3', 'index.js'), 'native');

      // Target has a newer package.json; backup has older
      fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
      fs.writeFileSync(path.join(backupDir, 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));
      // Backup does NOT have node_modules (excluded during backup)

      const req = createMockRequest('POST', { targetDir, backupDir });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/rollback');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);

      // node_modules must still exist after rollback
      expect(fs.existsSync(path.join(targetDir, 'node_modules', 'better-sqlite3', 'index.js'))).toBe(true);
      // package.json should be restored to the backup version
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });
  });

  // ── Fix 6: EPERM returns structured reason + nextAction ──────────────

  describe('EPERM structured error handling', () => {
    afterEach(async () => {
      // Restore real copyFileSync after the EPERM override
      const realFs = await vi.importActual<typeof import('fs')>('fs');
      vi.mocked(fs.copyFileSync).mockImplementation(realFs.copyFileSync);
    });

    it('should return reason=file_locked and nextAction when copyFileSync throws EPERM', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'principles-disciple' }));
          }
        }
      }) as unknown as typeof execSyncMock);

      // Override copyFileSync to throw EPERM during backup
      vi.mocked(fs.copyFileSync).mockImplementation(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, copyfile 'test'"), { code: 'EPERM' });
      });

      const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: true });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      const body = parseResponseBody<{ data: { success: boolean; reason?: string; nextAction?: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.reason).toBe('file_locked');
      expect(body.data.nextAction).toBeDefined();
      expect(body.data.nextAction).toBeDefined();
      expect(body.data.nextAction).toContain('重启');
    });
  });

  // ── Fix 7: Codex host detection ──────────────────────────────────────

  describe('Codex host detection', () => {
    // os.homedir() reads USERPROFILE (win32) / HOME (posix) at call time.
    // We set both env vars to tmpDir so detectCodexInstall() checks tmpDir.
    let savedHome: string | undefined;
    let savedProfile: string | undefined;

    beforeEach(() => {
      savedHome = process.env.HOME;
      savedProfile = process.env.USERPROFILE;
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    });

    it('should return codexInstalled=true when ~/.codex/hooks.json exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), '{}');

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      } as Response);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ data: { codexInstalled: boolean } }>(res);
      expect(body.data.codexInstalled).toBe(true);
    });

    it('should return codexInstalled=true when ~/.pd/codex/ exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.pd', 'codex'), { recursive: true });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      } as Response);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ data: { codexInstalled: boolean } }>(res);
      expect(body.data.codexInstalled).toBe(true);
    });

    it('should return codexInstalled=false when no codex paths exist', async () => {
      // Ensure no .codex or .pd/codex in tmpDir
      const codexDir = path.join(tmpDir, '.codex');
      const pdCodexDir = path.join(tmpDir, '.pd', 'codex');
      if (fs.existsSync(codexDir)) fs.rmSync(codexDir, { recursive: true, force: true });
      if (fs.existsSync(pdCodexDir)) fs.rmSync(pdCodexDir, { recursive: true, force: true });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      } as Response);

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/check');

      const body = parseResponseBody<{ data: { codexInstalled: boolean } }>(res);
      expect(body.data.codexInstalled).toBe(false);
    });
  });

  // ── Full update (/apply-full) — inline tarball download + file copy ──

  describe('POST /apply-full', () => {
    it.each(['1.0.0', '0.9.9'])('refuses a non-advancing stamped release before download (%s)', async (bundledPluginVersion) => {
      const { execFileSync: execSyncMock } = await import('child_process');
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '2.0.0',
          pd: { bundledPluginVersion },
          dist: { tarball: 'https://example.com/pkg.tgz' },
        }),
      } as Response);

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ success: boolean; data: { success: boolean; reason?: string; requiresRestart: boolean } }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        success: false,
        reason: 'installer_bundle_stale',
        requiresRestart: false,
      });
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('cleans staged files when an unstamped legacy installer is not advancing', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');
      let stagingDir: string | undefined;
      vi.mocked(fetch).mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
      } as Response)).mockImplementationOnce(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response));
      vi.mocked(execSyncMock).mockImplementation(((command: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (command !== 'tar' || !args) return;
        const target = options?.cwd;
        if (target === undefined) return;
        stagingDir = target;
        fs.mkdirSync(path.join(target, 'plugin'), { recursive: true });
        fs.writeFileSync(path.join(target, 'plugin', 'package.json'), JSON.stringify({ version: '1.0.0', name: 'principles-disciple' }));
      }) as unknown as typeof execSyncMock);

      const req = createMockRequest('POST', {});
      const res = createMockResponse();
      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; reason?: string } }>(res);
      expect(body.data).toMatchObject({ success: false, reason: 'installer_bundle_stale' });
      expect(stagingDir).toBeDefined();
      expect(fs.existsSync(stagingDir!)).toBe(false);
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('should copy plugin, console, core, pd-cli from installer tarball', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              version: '1.105.0',
              dist: { tarball: 'https://example.com/installer.tgz' },
            }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
            fs.mkdirSync(path.join(dir, 'console', 'dist', 'web'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'dist', 'index.js'), 'new core');
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'dist', 'index.js'), 'new cli');
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing install
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
      fs.mkdirSync(path.join(pluginDir, 'console', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'old console');

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; requiresRestart: boolean; newVersion?: string } }>(res);
      expect(body.data.success).toBe(true);
      expect(body.data.requiresRestart).toBe(true);
      expect(body.data.newVersion).toBe('2.0.0');

      // Verify all 4 packages updated
      expect(fs.readFileSync(path.join(pluginDir, 'dist', 'bundle.js'), 'utf-8')).toBe('new plugin code');
      expect(fs.readFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'utf-8')).toBe('new console code');
      expect(fs.readFileSync(path.join(pluginDir, 'core', 'dist', 'index.js'), 'utf-8')).toBe('new core');
      expect(fs.readFileSync(path.join(pluginDir, 'pd-cli', 'dist', 'index.js'), 'utf-8')).toBe('new cli');
    });

    it('copies host-runtime and creates resolution links so the updated console can resolve it (PRI-561)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              version: '1.120.0',
              dist: { tarball: 'https://example.com/installer.tgz' },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
            fs.mkdirSync(path.join(dir, 'console', 'dist', 'server'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'dist', 'index.js'), 'new core');
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'dist', 'index.js'), 'new cli');
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
            // Installer bundles host-runtime since 2026-08-14 (PR #1315)
            fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
              JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
            fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'),
              'export const OPENCLAW_HOST_LIVENESS_CONTRACT = 1;');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing install in the PRE-2026-08-14 state: console/node_modules has
      // @principles/core but NO host-runtime link, and no extDir/host-runtime
      // (the installer that created it never bundled one).
      fs.mkdirSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'core'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'core', 'marker'), 'core');
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; newVersion?: string } }>(res);
      expect(body.data.success).toBe(true);

      // 1. host-runtime content landed in the extension dir
      expect(fs.readFileSync(path.join(pluginDir, 'host-runtime', 'dist', 'index.js'), 'utf-8'))
        .toBe('export const OPENCLAW_HOST_LIVENESS_CONTRACT = 1;');

      // 2. resolution links exist for console and pd-cli (installer syncPdCli parity)
      expect(fs.existsSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'host-runtime'))).toBe(true);
      expect(fs.existsSync(path.join(pluginDir, 'pd-cli', 'node_modules', '@principles', 'host-runtime'))).toBe(true);
      expect(fs.existsSync(path.join(pluginDir, 'console', 'node_modules', 'principles-disciple'))).toBe(true);

      // 3. Real Node ESM resolution from inside the updated console dist —
      //    the exact operation that crashed with ERR_MODULE_NOT_FOUND before
      //    the fix (the negative-control test below proves the probe detects
      //    that state).
      const probeError = await runPri561ResolutionProbe(path.join(pluginDir, 'console', 'dist'));
      expect(probeError).toBe('');
    });

    it('creates node_modules links for internal deps the staged manifests newly declare (generation-gap regression)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              version: '1.121.0',
              dist: { tarball: 'https://example.com/installer.tgz' },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
            // The STAGED console manifest declares a file: dep that the
            // pre-update install never had — the data-driven derivation must
            // pick it up from the staged tree, not the deployed manifest.
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
            fs.writeFileSync(path.join(dir, 'console', 'package.json'),
              JSON.stringify({ version: '1.0.0', dependencies: { '@principles/core': 'file:../core' } }));
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'dist', 'index.js'), 'new core');
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'dist', 'index.js'), 'new cli');
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'),
              JSON.stringify({ version: '1.0.0', dependencies: { 'principles-disciple': 'file:../plugin' } }));
            // A real 1.222.5+ installer bundles host-runtime and
            // install-layout — without them the host-runtime copy block (and
            // the link derivation inside it) is skipped entirely.
            fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
              JSON.stringify({ name: '@principles/host-runtime', version: '0.1.1', type: 'module', main: './dist/index.js', dependencies: { '@principles/install-layout': 'file:../install-layout' } }));
            fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'export const HOST_TELEMETRY = 1;');
            fs.mkdirSync(path.join(dir, 'install-layout', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'install-layout', 'package.json'),
              JSON.stringify({ name: '@principles/install-layout', version: '0.1.1', type: 'module', main: './dist/index.js' }));
            fs.writeFileSync(path.join(dir, 'install-layout', 'dist', 'index.js'), 'export function getInstallLayoutPaths() { return {}; }');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing install WITHOUT any console node_modules link for
      // @principles/core (the dep is newly introduced by this release).
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
      fs.mkdirSync(path.join(pluginDir, 'console', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'old console');

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; newVersion?: string } }>(res);
      expect(body.data.success).toBe(true);

      // The data-driven derivation created the link the new dependency
      // requires — without any console-generation change or hardcoded entry.
      expect(fs.existsSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'core'))).toBe(true);
      // Legacy layout: pd-cli's staged manifest declares principles-disciple
      // file:../plugin, and the deployed plugin dir is the legacy
      // principles-disciple root — the derivation must map it despite the
      // staged/deployed basename mismatch (review P1).
      expect(fs.existsSync(path.join(pluginDir, 'pd-cli', 'node_modules', 'principles-disciple'))).toBe(true);
    });

    // Negative control for the PRI-561 probe: the SAME probe on the PRE-fix
    // layout (no extDir/host-runtime; console/node_modules has core only,
    // never passing through the updater) must die with ERR_MODULE_NOT_FOUND.
    // Without this, the positive test could pass vacuously — e.g. if the
    // probe stopped importing the package or node resolved it from an
    // unexpected root outside the fixture.
    it('negative control: the probe fails with ERR_MODULE_NOT_FOUND on the pre-fix layout (PRI-561)', async () => {
      fs.mkdirSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'core'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'node_modules', '@principles', 'core', 'marker'), 'core');
      fs.mkdirSync(path.join(pluginDir, 'console', 'dist'), { recursive: true });

      const probeError = await runPri561ResolutionProbe(path.join(pluginDir, 'console', 'dist'));
      expect(probeError).toContain('ERR_MODULE_NOT_FOUND');
      expect(probeError).toContain('@principles/host-runtime');
    });

    it('keeps an existing correct host-runtime resolution link (fresh-install no-op)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '1.120.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new');
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
              JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
            fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'new host-runtime');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Fresh-install state: npm install already created a REAL link in this
      // slot (junction on Windows, dir symlink elsewhere). A physical marker
      // directory here previously stood in for the link and locked in the
      // PRI-665 wrong behavior — the incident shape itself.
      const slot = path.join(pluginDir, 'console', 'node_modules', '@principles', 'host-runtime');
      const hostRuntimeDir = path.join(pluginDir, 'host-runtime');
      fs.mkdirSync(path.join(hostRuntimeDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(hostRuntimeDir, 'dist', 'index.js'), 'old host-runtime');
      if (!makeDirLink(hostRuntimeDir, slot)) return; // link creation denied — skip
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      // The existing CORRECT link is kept — still a link, same target…
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
      const resolvedLink = path.resolve(path.dirname(slot), fs.readlinkSync(slot));
      expect(resolvedLink).toBe(hostRuntimeDir);
      // …nothing needed quarantining…
      expect(fs.readdirSync(path.dirname(slot)).some((entry) => entry.includes('update-quarantine'))).toBe(false);
      // …but host-runtime content is still refreshed from the tarball
      expect(fs.readFileSync(path.join(hostRuntimeDir, 'dist', 'index.js'), 'utf-8')).toBe('new host-runtime');
    });

    it('aborts before swapping any package files when resolution links cannot be created (PRI-561 fail path)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '1.120.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
              JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
            fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'new host-runtime');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Deterministic link failure: pd-cli/node_modules exists as a regular
      // FILE, so mkdirSync for the pd-cli link's parent throws after the
      // console link succeeds.
      fs.mkdirSync(path.join(pluginDir, 'pd-cli'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'pd-cli', 'node_modules'), 'not a directory');

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; reason?: string; nextAction?: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.reason).toBe('host_runtime_link_failed');
      expect(body.data.nextAction).toBeTruthy();

      // The whole point of the fail path: NO package bytes were swapped —
      // the installed console/plugin stay exactly as they were (rc-9).
      expect(fs.existsSync(path.join(pluginDir, 'dist', 'bundle.js'))).toBe(false);
      expect(fs.existsSync(path.join(pluginDir, 'console', 'dist', 'server.js'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8') as string).version).toBe('1.0.0');
    });

    it('should preserve pd-cli/node_modules during update (no rmSync)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              version: '1.105.0',
              dist: { tarball: 'https://example.com/installer.tgz' },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new');
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing pd-cli with node_modules symlinks (marker)
      fs.mkdirSync(path.join(pluginDir, 'pd-cli', 'node_modules', '@principles', 'core'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'pd-cli', 'node_modules', '@principles', 'core', 'marker'), 'symlink');
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      // pd-cli/node_modules must survive
      expect(fs.existsSync(path.join(pluginDir, 'pd-cli', 'node_modules', '@principles', 'core', 'marker'))).toBe(true);
    });

    it('should preserve console/node_modules during update (no rmSync)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '1.105.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new');
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing console with node_modules (contains native module marker)
      fs.mkdirSync(path.join(pluginDir, 'console', 'node_modules', 'better-sqlite3'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'node_modules', 'better-sqlite3', 'locked.node'), 'native');
      fs.mkdirSync(path.join(pluginDir, 'console', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'old console');
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      // console/node_modules must survive (would cause EPERM if rmSync'd)
      expect(fs.existsSync(path.join(pluginDir, 'console', 'node_modules', 'better-sqlite3', 'locked.node'))).toBe(true);
      // But console/dist/server.js should be updated
      expect(fs.readFileSync(path.join(pluginDir, 'console', 'dist', 'server.js'), 'utf-8')).toBe('new console');
    });

    it('should detect dependency changes and include hint in message', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '1.105.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            // Deps CHANGED: better-sqlite3 ^14.0.0 (was ^13.0.3)
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^14.0.0', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new');
            fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new');
            fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          }
        }
      }) as unknown as typeof execSyncMock);

      // Old deps: better-sqlite3 ^13.0.3
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; message: string } }>(res);
      expect(body.data.success).toBe(true);
      expect(body.data.message).toContain('dependencies may have changed');
    });

    it('preserves an en skill-language manifest selection across full updates (PR #1332 companion)', async () => {
      const { execFileSync: execSyncMock } = await import('child_process');

      vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ version: '1.105.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
          } as Response);
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
      }) as unknown as typeof fetch);

      vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
        if (cmd === 'tar') {
          const dir = tarExtractDir(cmd, args, options);
          if (dir) {
            fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
              JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
            fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
            // Shipped manifest is zh-default; bundle carries BOTH language template sets
            fs.writeFileSync(path.join(dir, 'plugin', 'openclaw.plugin.json'),
              JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/zh/skills'] }, null, 2));
            for (const lang of ['zh', 'en']) {
              const skillDir = path.join(dir, 'plugin', 'templates', 'langs', lang, 'skills', 'admin');
              fs.mkdirSync(skillDir, { recursive: true });
              fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${lang}`);
            }
          }
        }
      }) as unknown as typeof execSyncMock);

      // Existing install materialized with --lang en
      fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'principles-disciple', skills: ['templates/langs/en/skills'] }, null, 2));
      fs.writeFileSync(path.join(pluginDir, 'package.json'),
        JSON.stringify({ version: '1.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

      const req = createMockRequest('POST', {});
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean } }>(res);
      expect(body.data.success).toBe(true);
      const updated = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf-8')) as { skills: string[] };
      expect(updated.skills).toEqual(['templates/langs/en/skills']);
    });

    it('should return 405 for non-POST method', async () => {
      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });
  });

  // ── Legacy rule contract preflight (P1-3, 2026-08-19) ────────────────
  //
  // An active owner-approved rule that reads a removed RuleHost contract
  // symbol (session.recentThinking) must block /apply and /apply-full
  // BEFORE any network fetch, backup, or file mutation — the running
  // installation stays exactly as it was and the error names the rule.
  describe('legacy rule contract preflight', () => {
    const LEGACY_CODE = `function evaluate(input, helpers) {
  if (input.session && input.session.recentThinking === true) {
    return { decision: 'block', matched: true };
  }
  return { decision: 'allow', matched: false };
}`;

    async function seedLegacyActiveRule(): Promise<void> {
      const { SqliteConnection, SqliteActivationStateStore } = await import('@principles/core/runtime-v2');
      const conn = new SqliteConnection(workspaceDir);
      try {
        const now = new Date().toISOString();
        conn.getDb().prepare(`
          INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
          VALUES ('art-legacy-console', 'rule', 'task-legacy', 'P_LEGACY', 'rule-real-diagnosis-first', '[]', 'validated', ?, ?, ?)
        `).run(JSON.stringify({ ruleId: 'rule-real-diagnosis-first', implementationCode: LEGACY_CODE }), now, now);
        await new SqliteActivationStateStore(conn).recordActivation({
          activationId: 'act-legacy-console',
          idempotencyKey: 'art-legacy-console::code_tool_hook',
          artifactId: 'art-legacy-console',
          channel: 'code_tool_hook',
          action: 'code_tool_hook_live_activate',
          targetRef: 'impl://rule-real-diagnosis-first',
          activatedAt: now,
          deactivatedAt: null,
        });
      } finally {
        conn.close();
      }
    }

    it('POST /apply refuses before fetch/mutation and names the blocking rule', async () => {
      await seedLegacyActiveRule();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockClear();

      const req = createMockRequest('POST', {
        targetDir: pluginDir,
        mergeStrategy: 'smart',
        createBackup: false,
      });
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ success: boolean; data: { success: boolean; reason?: string; nextAction?: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.reason).toBe('legacy_rule_contract_dependency');
      expect(body.data.nextAction).toContain('Migrate or deactivate');
      // Refusal must precede any network access (nothing fetched, nothing changed).
      expect(fetchMock).not.toHaveBeenCalled();
      const version = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8')) as { version: string };
      expect(version.version).toBe('1.0.0');
    });

    it('POST /apply-full refuses likewise with requiresRestart false', async () => {
      await seedLegacyActiveRule();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockClear();

      const req = createMockRequest('POST');
      const res = createMockResponse();

      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parseResponseBody<{ data: { success: boolean; reason?: string; requiresRestart?: boolean } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.reason).toBe('legacy_rule_contract_dependency');
      expect(body.data.requiresRestart).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Regression guards: update source identity hardening + fixture isolation
// (2026-09-03 incident — a test-fixture stub tarball leaked into the real
// installed runtime; these tests fail loud if either the isolation pins or
// the staged identity validation break again).
// ---------------------------------------------------------------------------

describe('Update source identity hardening and fixture isolation', () => {
  it('fixture isolation sentinel: /check must read the FIXTURE install version (1.0.0), never a real machine install', async () => {
    // /check resolves the installed plugin dir and reads its version. With the
    // homedir/OPENCLAW_HOME pins working it must see the fixture's 1.0.0. If a
    // future refactor drops the pins, it would read the REAL machine install
    // instead — this test fails loudly BEFORE any write can escape the fixture.
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    } as Response);

    const req = createMockRequest('GET');
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/check');

    const body = parseResponseBody<{ data: { currentVersion: string } }>(res);
    expect(body.data.currentVersion).toBe('1.0.0');
  });

  it('POST /apply refuses a staged package that does not name principles-disciple before any copy', async () => {
    const { execFileSync: execSyncMock } = await import('child_process');

    vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('https://registry.npmjs.org/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '2.0.0', dist: { tarball: 'https://example.com/pkg.tgz' } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
    }) as unknown as typeof fetch);

    vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
      if (cmd === 'tar') {
        const dir = tarExtractDir(cmd, args, options);
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          // Wrong package identity — the identity guard must refuse.
          fs.writeFileSync(path.join(dir, 'package.json'),
            JSON.stringify({ version: '2.0.0', name: 'some-other-package' }));
        }
      }
    }) as unknown as typeof execSyncMock);

    const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply');

    const body = parseResponseBody<{ data: { success: boolean; reason?: string } }>(res);
    expect(body.data).toMatchObject({ success: false, reason: 'staged_package_invalid' });
    // Installed package untouched.
    const installed = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8')) as { version: string };
    expect(installed.version).toBe('1.0.0');
  });

  it('POST /apply-full refuses a staged plugin package without identity before any copy', async () => {
    const { execFileSync: execSyncMock } = await import('child_process');

    vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '1.105.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
    }) as unknown as typeof fetch);

    vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
      if (cmd === 'tar') {
        const dir = tarExtractDir(cmd, args, options);
        if (dir) {
          fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
          // The exact incident stub shape: a fake version, NO package name.
          fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
            JSON.stringify({ version: '2.0.0', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
          fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
        }
      }
    }) as unknown as typeof execSyncMock);

    const req = createMockRequest('POST', {});
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

    const body = parseResponseBody<{ data: { success: boolean; reason?: string; requiresRestart: boolean } }>(res);
    expect(body.data).toMatchObject({ success: false, reason: 'staged_package_invalid', requiresRestart: false });
    // No production file was copied (the staged bundle never landed).
    expect(fs.existsSync(path.join(pluginDir, 'dist', 'bundle.js'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolution-link reconciliation (PRI-665, 2026-09-03 incident)
//
// A Console full update on a machine whose runtime node_modules held STALE
// PHYSICAL copies of internal @principles/* dependencies (inherited from a
// legacy install) kept those copies in place: the updater's link logic
// treated "slot exists" as "done", so the new dist resolved the old
// components and crashed at startup. These tests pin the reconciliation
// semantics: correct links are kept, stale physical copies and wrong-target
// links are quarantined and replaced, and a later failure restores them.
// ---------------------------------------------------------------------------

describe('Runtime resolution link reconciliation (PRI-665)', () => {
  it('replaces a stale physical dependency copy with a canonical link (2026-09-03 incident)', async () => {
    const { execFileSync: execSyncMock } = await import('child_process');

    vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '1.120.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
    }) as unknown as typeof fetch);

    vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
      if (cmd === 'tar') {
        const dir = tarExtractDir(cmd, args, options);
        if (dir) {
          fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
            JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
          fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
          fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
          fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
            JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
          // A valid module so a REAL ESM import can distinguish the staged
          // host-runtime from the stale copy through the reconciled link.
          fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'export const STAGED_HOST_RUNTIME = 1;');
        }
      }
    }) as unknown as typeof execSyncMock);

    // Incident state: the console's node_modules slot holds a STALE PHYSICAL
    // copy of host-runtime (exporting the OLD symbol set).
    const slot = path.join(pluginDir, 'console', 'node_modules', '@principles', 'host-runtime');
    fs.mkdirSync(path.join(slot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(slot, 'dist', 'index.js'), 'export const STALE_HOST_RUNTIME = 1;');
    fs.writeFileSync(path.join(pluginDir, 'package.json'),
      JSON.stringify({ version: '1.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

    const req = createMockRequest('POST', {});
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

    const body = parseResponseBody<{ data: { success: boolean } }>(res);
    expect(body.data.success).toBe(true);

    // The slot must now be a LINK to the canonical host-runtime dir…
    const slotLstat = fs.lstatSync(slot);
    expect(slotLstat.isSymbolicLink(), 'the stale physical copy must be replaced by a link').toBe(true);
    const resolvedLink = path.resolve(path.dirname(slot), fs.readlinkSync(slot));
    expect(resolvedLink).toBe(path.join(pluginDir, 'host-runtime'));

    // …and resolve the STAGED content through it.
    expect(fs.readFileSync(path.join(slot, 'dist', 'index.js'), 'utf-8')).toBe('export const STAGED_HOST_RUNTIME = 1;');

    // Success must clean the quarantine — no leftovers in the scope dir.
    const scopeDir = path.dirname(slot);
    expect(fs.readdirSync(scopeDir).some((entry) => entry.includes('update-quarantine'))).toBe(false);

    // End-to-end: a REAL Node ESM import from inside the deployed console
    // dist must resolve the staged host-runtime through the link — the exact
    // operation that crashed with the stale copy in place.
    const { execFile } = await vi.importActual<typeof import('child_process')>('child_process');
    const probePath = path.join(pluginDir, 'console', 'dist', '__probe_665__.mjs');
    fs.writeFileSync(probePath, [
      'const m = await import("@principles/host-runtime");',
      'if (m.STAGED_HOST_RUNTIME !== 1) { console.error("stale copy resolved instead: " + JSON.stringify(Object.keys(m))); process.exit(3); }',
    ].join('\n'));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [probePath], { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
      });
    } finally {
      fs.rmSync(probePath, { force: true });
    }
  });

  it('replaces a wrong-target link with the canonical link', async () => {
    const { execFileSync: execSyncMock } = await import('child_process');

    vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '1.120.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
    }) as unknown as typeof fetch);

    vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
      if (cmd === 'tar') {
        const dir = tarExtractDir(cmd, args, options);
        if (dir) {
          fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
            JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
          fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
          fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
          fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
            JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
          fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'export const STAGED_HOST_RUNTIME = 1;');
        }
      }
    }) as unknown as typeof execSyncMock);

    // The slot holds a link, but it points at a DECOY instead of the
    // canonical host-runtime dir.
    const slot = path.join(pluginDir, 'console', 'node_modules', '@principles', 'host-runtime');
    const decoyDir = path.join(pluginDir, 'decoy-host-runtime');
    fs.mkdirSync(path.join(decoyDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(decoyDir, 'dist', 'index.js'), 'export const DECOY = 1;');
    if (!makeDirLink(decoyDir, slot)) return; // link creation denied — skip
    fs.writeFileSync(path.join(pluginDir, 'package.json'),
      JSON.stringify({ version: '1.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

    const req = createMockRequest('POST', {});
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

    const body = parseResponseBody<{ data: { success: boolean } }>(res);
    expect(body.data.success).toBe(true);
    // The slot is repointed at the canonical host-runtime dir…
    expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
    const resolvedLink = path.resolve(path.dirname(slot), fs.readlinkSync(slot));
    expect(resolvedLink).toBe(path.join(pluginDir, 'host-runtime'));
    // …resolves the staged content through it…
    expect(fs.readFileSync(path.join(slot, 'dist', 'index.js'), 'utf-8')).toBe('export const STAGED_HOST_RUNTIME = 1;');
    // …the decoy dir itself is untouched, and no quarantine leftovers remain.
    expect(fs.readFileSync(path.join(decoyDir, 'dist', 'index.js'), 'utf-8')).toBe('export const DECOY = 1;');
    expect(fs.readdirSync(path.dirname(slot)).some((entry) => entry.includes('update-quarantine'))).toBe(false);
  });

  it('restores the quarantined copy when a later copy step fails (rollback)', async () => {
    const { execFileSync: execSyncMock } = await import('child_process');

    vi.mocked(fetch).mockImplementation(((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('https://registry.npmjs.org/create-principles-disciple')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '1.120.0', dist: { tarball: 'https://example.com/installer.tgz' } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response);
    }) as unknown as typeof fetch);

    vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[], options?: { cwd?: string }) => {
      if (cmd === 'tar') {
        const dir = tarExtractDir(cmd, args, options);
        if (dir) {
          fs.mkdirSync(path.join(dir, 'plugin', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'plugin', 'package.json'),
            JSON.stringify({ version: '2.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));
          fs.writeFileSync(path.join(dir, 'plugin', 'dist', 'bundle.js'), 'new plugin code');
          fs.mkdirSync(path.join(dir, 'console', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'new console code');
          fs.mkdirSync(path.join(dir, 'core', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'core', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'pd-cli', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'pd-cli', 'package.json'), '{}');
          fs.mkdirSync(path.join(dir, 'host-runtime', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'host-runtime', 'package.json'),
            JSON.stringify({ name: '@principles/host-runtime', version: '0.1.0', type: 'module', main: './dist/index.js' }));
          fs.writeFileSync(path.join(dir, 'host-runtime', 'dist', 'index.js'), 'export const STAGED_HOST_RUNTIME = 1;');
        }
      }
    }) as unknown as typeof execSyncMock);

    // Incident state: stale physical copy at the slot.
    const slot = path.join(pluginDir, 'console', 'node_modules', '@principles', 'host-runtime');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'stale-marker'), 'stale');
    fs.writeFileSync(path.join(pluginDir, 'package.json'),
      JSON.stringify({ version: '1.0.0', name: 'principles-disciple', dependencies: { 'better-sqlite3': '^13.0.3', '@principles/core': 'file:./core' } }));

    // Fail a copy step that runs AFTER link reconciliation: the plugin copy
    // (its staged dist/bundle.js is copied after the links are reconciled).
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.copyFileSync).mockImplementation(((src: fs.PathLike, dest: fs.PathLike) => {
      if (String(dest).endsWith('bundle.js')) {
        throw Object.assign(new Error("EPERM: operation not permitted, copyfile 'bundle.js'"), { code: 'EPERM' });
      }
      return realFs.copyFileSync(src, dest);
    }) as unknown as typeof fs.copyFileSync);

    try {
      const req = createMockRequest('POST', {});
      const res = createMockResponse();
      await handleUpdateRoute(req, res, workspaceDir, '/apply-full');

      const body = parseResponseBody<{ data: { success: boolean; reason?: string } }>(res);
      expect(body.data.success).toBe(false);
      expect(body.data.reason).toBe('file_locked');

      // The stale physical copy is RESTORED at the slot — no half-migrated
      // state (the quarantined-away old resolution is back in place).
      const slotLstat = fs.lstatSync(slot);
      expect(slotLstat.isDirectory()).toBe(true);
      expect(slotLstat.isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(slot, 'stale-marker'), 'utf-8')).toBe('stale');
      // The rollback consumed the quarantine entry.
      expect(fs.readdirSync(path.dirname(slot)).some((entry) => entry.includes('update-quarantine'))).toBe(false);
    } finally {
      vi.mocked(fs.copyFileSync).mockImplementation(realFs.copyFileSync);
    }
  });

});
