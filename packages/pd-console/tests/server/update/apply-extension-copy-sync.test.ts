/**
 * PR #1526 review P1 regression: the incremental /apply route must keep BOTH
 * physical plugin trees on the same version.
 *
 * Root cause (2026-09-06 review): the runtime-root path allow-list newly
 * lets /apply target the canonical plugin tree (~/.pd/runtime/plugin), but
 * doApplyUpdate only wrote that one tree. OpenClaw loads the extension copy
 * (~/.openclaw/extensions/principles-disciple) — a separate physical copy —
 * so an incremental update reported success while the gateway kept running
 * the old code. Rollback and apply-full already enforce the sync (CP-5);
 * this pins the same invariant on /apply through the PRODUCTION route:
 *
 *   initial: canonical tree v1 + extension copy v1
 *   after POST /apply: BOTH trees report v2 and carry the same dist content
 *
 * No network and no gateway: the registry/tarball fetches are stubbed with a
 * real locally-built tar.gz (extracted by the route through the real system
 * tar, matching production), and the gateway controls are mocked so a live
 * gateway on the dev machine is never touched.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';

// homedir drives the installed-layout resolution (~/.pd/...) — pin it to the
// fixture so a real install on the dev machine cannot leak in (same pattern
// as release-manager-authority-wiring.test.ts).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

// NEVER touch a live OpenClaw gateway from a test: apply stops/restarts the
// gateway around file mutations. Mock the controls; the code treats a
// non-running gateway as a no-op.
vi.mock('../../../src/server/utils/gateway.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(async () => ({ isRunning: false })),
    stopOpenClawGateway: vi.fn(() => ({ ok: true })),
    restartOpenClawGateway: vi.fn(() => ({ ok: true })),
  };
});

let routes: typeof import('../../../src/server/routes/update.js');
let fixtureRoot: string;

function createV1PluginTree(dir: string): void {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'principles-disciple', version: '1.0.0' }),
  );
  fs.writeFileSync(path.join(dir, 'dist', 'update.js'), 'module.exports = "v1";');
}

/** Build a REAL principles-disciple v2 tarball with the system tar (same extractor the route uses). */
function buildV2Tarball(stageRoot: string): Buffer {
  const packageDir = path.join(stageRoot, 'package');
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'principles-disciple', version: '2.0.0' }),
  );
  fs.writeFileSync(path.join(packageDir, 'dist', 'update.js'), 'module.exports = "v2";');
  const tgzPath = path.join(stageRoot, 'principles-disciple-2.0.0.tgz');
  // cwd + relative names only — the same EP-08 discipline as the production
  // extraction: GNU tar (Git Bash) misreads absolute C:\ paths as host:path.
  execFileSync('tar', ['-czf', path.basename(tgzPath), 'package'], { cwd: stageRoot });
  return fs.readFileSync(tgzPath);
}

function createMockRequest(method: string, jsonBody: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(jsonBody));
  return {
    method,
    url: '/api/update/apply',
    on: vi.fn(function (this: unknown, event: string, callback: (chunk?: Buffer) => void) {
      if (event === 'data') setImmediate(() => callback(payload));
      if (event === 'end') setImmediate(callback);
    }),
    headers: { 'content-type': 'application/json' },
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { _body: string } {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    setHeader: vi.fn(),
    writeHead: vi.fn(function (this: unknown, statusCode: number) {
      res.statusCode = statusCode;
      return res;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) res._body += data;
      return res;
    }),
  } as unknown as ServerResponse & { _body: string };
  return res;
}

describe('POST /apply keeps the canonical tree AND the OpenClaw extension copy in sync (PR #1526 review P1)', () => {
  let savedOpenclawHome: string | undefined;
  let stageRoot: string;
  let tgz: Buffer;
  let canonicalTree: string;
  let extensionTree: string;

  beforeAll(async () => {
    routes = await import('../../../src/server/routes/update.js');
  }, 60_000);

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pd-apply-sync-'));
    savedOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = fixtureRoot;
    // Pin homedir to the fixture — canonical-layout resolution
    // (~/.pd/install.json + ~/.pd/runtime) MUST resolve inside the fixture,
    // never at the real user install.
    vi.mocked(os.homedir).mockImplementation(() => fixtureRoot);
    // Canary: the resolution must now land inside the fixture before any
    // mutation-capable route runs.
    expect(os.homedir()).toBe(fixtureRoot);

    // Canonical layout: manifest + runtime tree the route resolves as targetDir.
    fs.mkdirSync(path.join(fixtureRoot, '.pd', 'runtime', 'plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [] }),
    );
    canonicalTree = path.join(fixtureRoot, '.pd', 'runtime', 'plugin');
    createV1PluginTree(canonicalTree);

    // The separate physical copy OpenClaw actually loads.
    extensionTree = path.join(fixtureRoot, 'extensions', 'principles-disciple');
    createV1PluginTree(extensionTree);

    // Real v2 tarball served through the stubbed fetch.
    stageRoot = path.join(fixtureRoot, 'stage');
    fs.mkdirSync(stageRoot, { recursive: true });
    tgz = buildV2Tarball(stageRoot);

    const registryUrl = 'https://registry.npmjs.org/principles-disciple/latest';
    const tarballUrl = 'https://registry.npmjs.org/principles-disciple/-/principles-disciple-2.0.0.tgz';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url) === registryUrl) {
        return {
          ok: true,
          json: async () => ({ version: '2.0.0', dist: { tarball: tarballUrl } }),
        };
      }
      if (String(url) === tarballUrl) {
        return { ok: true, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength) };
      }
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedOpenclawHome;
    if (fixtureRoot && fs.existsSync(fixtureRoot)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('upgrades both trees from v1 to v2 (package + dist consistent)', async () => {
    const res = createMockResponse();
    const req = createMockRequest('POST', { mergeStrategy: 'overwrite', createBackup: false });

    await routes.handleUpdateRoute(req, res, fixtureRoot, '/apply');

    const body = JSON.parse(res._body) as { success?: boolean; data?: { newVersion?: string; message?: string } };
    expect(body.success, `apply failed: ${res._body}`).toBe(true);
    expect(body.data?.newVersion).toBe('2.0.0');

    // Canonical tree moved to v2...
    const canonicalPkg = JSON.parse(fs.readFileSync(path.join(canonicalTree, 'package.json'), 'utf-8')) as { version: string };
    expect(canonicalPkg.version).toBe('2.0.0');
    expect(fs.readFileSync(path.join(canonicalTree, 'dist', 'update.js'), 'utf-8')).toContain('v2');

    // ...and the extension copy OpenClaw loads moved with it — the exact
    // split-brain the review found must not exist.
    const extPkg = JSON.parse(fs.readFileSync(path.join(extensionTree, 'package.json'), 'utf-8')) as { version: string };
    expect(extPkg.version).toBe('2.0.0');
    expect(fs.readFileSync(path.join(extensionTree, 'dist', 'update.js'), 'utf-8')).toContain('v2');

    // The response is honest about the sync.
    expect(body.data?.message ?? '').toMatch(/extension copy/i);
  });

  it('leaves the extension copy alone in legacy mode (target IS the extension dir — no double write)', async () => {
    // Remove the canonical manifest + runtime: the install resolves legacy,
    // pluginDir === extension dir, and the sync must be a no-op (paths equal).
    fs.rmSync(path.join(fixtureRoot, '.pd', 'install.json'));
    fs.rmSync(path.join(fixtureRoot, '.pd', 'runtime'), { recursive: true, force: true });

    const res = createMockResponse();
    const req = createMockRequest('POST', { mergeStrategy: 'overwrite', createBackup: false });
    await routes.handleUpdateRoute(req, res, fixtureRoot, '/apply');

    const body = JSON.parse(res._body) as { success?: boolean; data?: { newVersion?: string } };
    expect(body.success, `apply failed: ${res._body}`).toBe(true);
    expect(body.data?.newVersion).toBe('2.0.0');
    // Single physical tree: upgraded once, still intact.
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionTree, 'package.json'), 'utf-8')) as { version: string };
    expect(pkg.version).toBe('2.0.0');
    expect(fs.readFileSync(path.join(extensionTree, 'dist', 'update.js'), 'utf-8')).toContain('v2');
  });
});
