import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * PRI-614 Gate A — gateway coordination characterization for the Console
 * update route.
 *
 * Gap being closed (Update Surface & Contract Map, 2026-08-27): update.test.ts
 * has ZERO gateway assertions — its fixture sets OPENCLAW_HOME to a dir with
 * no openclaw.json, so checkOpenClawGateway() always reports not-running and
 * the stop/restart coordination path is never exercised. These tests pin the
 * protected invariants (SPEC §16 host coordination):
 *
 *   1. When the gateway IS running, /apply stops it BEFORE the first
 *      mutation (tar extraction) and restarts it afterwards.
 *   2. The restart happens even when the update fails mid-apply.
 *   3. When the gateway is NOT running, no stop/start commands are spawned.
 */

vi.stubGlobal('fetch', vi.fn());

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  return {
    method,
    url: '/api/update/test',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data' && body !== undefined) handler(Buffer.from(bodyStr));
      if (event === 'end') handler();
    }),
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, statusCode: number) {
      res.statusCode = statusCode;
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
      if (data !== undefined) res._body = data;
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function bodyOf(res: ServerResponse): { data: { success: boolean } } {
  return JSON.parse((res as unknown as { _body: string })._body) as { data: { success: boolean } };
}

let workspaceDir: string;
let pluginDir: string;
let tmpDir: string;
let savedOpenclawHome: string | undefined;
let gatewayListener: net.Server | undefined;

/** Every execFileSync call, recorded for ordering assertions. */
const execLog: Array<{ cmd: string; args?: readonly string[] }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  execLog.length = 0;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gw-coord-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  pluginDir = path.join(tmpDir, 'extensions', 'principles-disciple');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '1.0.0' }));

  savedOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = tmpDir;
});

afterEach(async () => {
  if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedOpenclawHome;

  await new Promise<void>((resolve) => {
    if (gatewayListener) gatewayListener.close(() => resolve());
    else resolve();
  });
  gatewayListener = undefined;

  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows: tolerate EPERM on temp cleanup right after socket teardown.
    }
  }
});

// Import after mocks are set up.
const { handleUpdateRoute } = await import('../../../src/server/routes/update.js');

/** Start a real TCP listener so checkPortListening() sees a "gateway". */
async function startFakeGateway(): Promise<void> {
  gatewayListener = net.createServer();
  await new Promise<void>((resolve) => {
    gatewayListener?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = gatewayListener?.address() as net.AddressInfo;
  fs.writeFileSync(
    path.join(tmpDir, 'openclaw.json'),
    JSON.stringify({ gateway: { port: address.port } }),
  );
}

function mockSuccessfulApplyFetch(): void {
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
}

/** execFileSync mock: tar "extracts" a package.json; every call is logged. */
async function installExecMock(opts: { failTar?: boolean } = {}): Promise<void> {
  const { execFileSync: execSyncMock } = await import('child_process');
  vi.mocked(execSyncMock).mockImplementation(((cmd: string, args?: readonly string[]) => {
    execLog.push({ cmd, args });
    if (cmd === 'tar') {
      if (opts.failTar) throw new Error('tar: simulated extraction failure');
      const ci = args ? args.indexOf('-C') : -1;
      const dir = ci >= 0 ? args?.[ci + 1] : undefined;
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.0.0', name: 'test' }));
      }
    }
    return undefined;
  }) as unknown as typeof execSyncMock);
}

const gatewayCalls = (sub: 'stop' | 'start') =>
  execLog.filter((c) => c.cmd === 'openclaw' && c.args?.[0] === 'gateway' && c.args?.[1] === sub).length;

describe('PRI-614 Gate A: gateway coordination during POST /apply', () => {
  it('stops a running gateway BEFORE the first mutation and restarts it after success', async () => {
    await startFakeGateway();
    mockSuccessfulApplyFetch();
    await installExecMock();

    const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply');

    expect(bodyOf(res).data.success).toBe(true);

    const stopIndex = execLog.findIndex((c) => c.cmd === 'openclaw' && c.args?.[1] === 'stop');
    const tarIndex = execLog.findIndex((c) => c.cmd === 'tar');
    const startIndex = execLog.findIndex((c) => c.cmd === 'openclaw' && c.args?.[1] === 'start');

    expect(gatewayCalls('stop'), 'gateway stop must be issued when the gateway is running').toBe(1);
    expect(tarIndex, 'the apply flow must reach tar extraction').toBeGreaterThanOrEqual(0);
    expect(stopIndex, 'gateway stop must precede the first file mutation (tar extract)').toBeLessThan(tarIndex);
    expect(gatewayCalls('start'), 'gateway restart must run after the update finishes').toBe(1);
    expect(startIndex, 'gateway restart must follow the update mutation').toBeGreaterThan(tarIndex);
  });

  it('restarts the gateway even when the update fails mid-apply (finally semantics)', async () => {
    await startFakeGateway();
    mockSuccessfulApplyFetch();
    await installExecMock({ failTar: true });

    const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply');

    expect(bodyOf(res).data.success).toBe(false);
    expect(gatewayCalls('stop')).toBe(1);
    expect(gatewayCalls('start'), 'gateway restart MUST still run after a failed apply').toBe(1);
    const failedTarIndex = execLog.findIndex((c) => c.cmd === 'tar');
    const restartIndex = execLog.findIndex((c) => c.cmd === 'openclaw' && c.args?.[1] === 'start');
    expect(restartIndex, 'gateway restart must follow the failed mutation attempt').toBeGreaterThan(failedTarIndex);
  });

  it('spawns no gateway commands when the gateway is not running', async () => {
    // No openclaw.json in OPENCLAW_HOME and no listener — the pre-existing
    // condition under which update.test.ts has always run.
    mockSuccessfulApplyFetch();
    await installExecMock();

    const req = createMockRequest('POST', { mergeStrategy: 'smart', createBackup: false });
    const res = createMockResponse();
    await handleUpdateRoute(req, res, workspaceDir, '/apply');

    expect(bodyOf(res).data.success).toBe(true);
    expect(execLog.filter((c) => c.cmd === 'openclaw')).toEqual([]);
  });
});
