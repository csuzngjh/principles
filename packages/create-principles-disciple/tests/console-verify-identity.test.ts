/**
 * P0-1 / P0-2 (PRI-1069/1070, G1, SPEC v1.2 §7/§14): real-subprocess tests
 * for the console verification probe.
 *
 * Fail-closed identity contract under test — a probe passes ONLY when the
 * responder proves it is THIS launch's child by echoing the one-shot nonce
 * through the PD health shape:
 *   - a healthy-looking responder WITHOUT the nonce (old console / another
 *     local service / proxy 200 JSON) must be REJECTED (identity_mismatch);
 *   - a 502 must be recorded as an observed fact with no guessed attribution;
 *   - a genuinely matching responder must pass;
 *   - no orphan child may survive a failed attempt (real exit join).
 *
 * Probe targets are in-process responders occupying the whole shifted port
 * window (the probe's shuffled 3-port sample must hit them); the spawn side
 * is a REAL child process (alive-on-random-port / instant-exit), so child
 * lifecycle facts (exit join, premature-exit classification) stay real.
 * Everything runs under a redirected HOME and a shifted port base so the
 * real ~/.pd and real console ports are never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'node:net';
import type { verifyConsole as verifyConsoleType, ConsoleVerifyAttempt as ConsoleVerifyAttemptType } from '../src/installer.js';

// The installer resolves PD_CONSOLE_PORT_BASE into a module-level constant at
// import time, so the env must be pinned BEFORE the first dynamic import of
// the module under test (below) — a static top-level import would freeze the
// REAL 3100-3199 window and the probe would hit unrelated local services.
let installerModule: typeof import('../src/installer.js') | null = null;
const verifyConsole = (...args: Parameters<typeof verifyConsoleType>) => installerModule!.verifyConsole(...args);
type ConsoleVerifyAttempt = ConsoleVerifyAttemptType;

let tmpHome: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedPortBase: string | undefined;
const PORT_BASE = 34710; // far from the real 3100-3199 window and product ports
const WINDOW = 100;
const responders: http.Server[] = [];

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-verify-id-test-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedPortBase = process.env.PD_CONSOLE_PORT_BASE;
  // HOME+USERPROFILE both pinned (harness lesson: os.homedir() on Windows
  // follows USERPROFILE; pinning HOME alone leaks into the real ~/.pd).
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.PD_CONSOLE_PORT_BASE = String(PORT_BASE);
  if (installerModule === null) {
    installerModule = await import('../src/installer.js');
  }
});

afterEach(async () => {
  await closeResponders();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  if (savedPortBase === undefined) delete process.env.PD_CONSOLE_PORT_BASE; else process.env.PD_CONSOLE_PORT_BASE = savedPortBase;
  delete process.env.PD_CONSOLE_VERIFY_NONCE;
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Static response bodies (module constants — nothing request-derived). */
function nonceEchoBody(): string {
  // Reads the CURRENT attempt nonce the installer placed in the parent env —
  // exactly the fact the real child proves by echoing it from its own env.
  const nonce = process.env.PD_CONSOLE_VERIFY_NONCE ?? '';
  return JSON.stringify({ success: true, data: { overall: 'healthy', authenticationMode: 'no_auth', verifyNonce: nonce } });
}
const NONCELESS_BODY = JSON.stringify({ success: true, data: { overall: 'healthy', authenticationMode: 'no_auth' } });

async function occupyWindow(handler: (res: http.ServerResponse) => void): Promise<void> {
  for (let i = 0; i < WINDOW; i++) {
    const server = http.createServer((_req, res) => handler(res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT_BASE + i, '127.0.0.1', () => resolve());
    });
    responders.push(server);
  }
}

async function closeResponders(): Promise<void> {
  await Promise.all(responders.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

function respondJson(body: () => string): (res: http.ServerResponse) => void {
  return (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body());
  };
}

/** Lays down a fake deployed console whose dist/server.js is `scriptBody`. */
function deployFakeConsole(scriptBody: string): { workspace: string } {
  const consoleDest = path.join(tmpHome, '.pd', 'runtime', 'console');
  fs.mkdirSync(path.join(consoleDest, 'dist', 'web'), { recursive: true });
  fs.writeFileSync(path.join(consoleDest, 'dist', 'web', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(consoleDest, 'dist', 'server.js'), scriptBody);
  const workspace = path.join(tmpHome, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace };
}

// REAL child fixture: alive but listening on an OS-assigned port — the child
// exists and must be terminated+joined, while the probe's HTTP GETs are
// answered by the in-window responders above.
const ALIVE_CHILD = `
const http = require('node:http');
http.createServer(() => {}).listen(0, '127.0.0.1');
setInterval(() => {}, 1000);
`;

const INSTANT_EXIT_CHILD = 'process.exit(3);';

function findAttempt(attempts: readonly ConsoleVerifyAttempt[], outcome: ConsoleVerifyAttempt['outcome']): ConsoleVerifyAttempt | undefined {
  return attempts.find((a) => a.outcome === outcome);
}

describe('verifyConsole identity binding (P0-1)', () => {
  it('VERIFIES a responder that echoes this launch\'s nonce through the PD health shape', { timeout: 120_000 }, async () => {
    await occupyWindow(respondJson(nonceEchoBody));
    const { workspace } = deployFakeConsole(ALIVE_CHILD);
    const result = await verifyConsole(workspace);
    expect(result.ok).toBe(true);
    expect(result.attempts.some((a) => a.outcome === 'verified')).toBe(true);
    // no orphan: the verified child is the caller's responsibility — kill+join here
    if (result.process) {
      result.process.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        result.process!.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });

  it('REJECTS a healthy responder without the nonce (old console / other service) — fail closed', { timeout: 180_000 }, async () => {
    await occupyWindow(respondJson(() => NONCELESS_BODY));
    const { workspace } = deployFakeConsole(ALIVE_CHILD);
    const result = await verifyConsole(workspace);
    expect(result.ok).toBe(false);
    const mismatch = findAttempt(result.attempts, 'identity_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.httpStatus).toBe(200); // it LOOKED healthy — and was still rejected
    // every failed attempt's child was terminated + joined (no orphans):
    expect(result.attempts.some((a) => a.outcome === 'join_failed')).toBe(false);
  });

  it('RECORDS a 502 as an observed fact with unknown attribution (http_error_status)', { timeout: 180_000 }, async () => {
    await occupyWindow((res) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('bad gateway'); });
    const { workspace } = deployFakeConsole(ALIVE_CHILD);
    const result = await verifyConsole(workspace);
    expect(result.ok).toBe(false);
    const httpErr = findAttempt(result.attempts, 'http_error_status');
    expect(httpErr).toBeDefined();
    expect(httpErr!.httpStatus).toBe(502);
  });

  it('CLASSIFIES premature child exit with exit code and diagnostics', { timeout: 120_000 }, async () => {
    const { workspace } = deployFakeConsole(INSTANT_EXIT_CHILD);
    const result = await verifyConsole(workspace);
    expect(result.ok).toBe(false);
    const early = findAttempt(result.attempts, 'child_exited_early');
    expect(early).toBeDefined();
    expect(early!.exitCode).toBe(3);
  });
});

describe('probe port window isolation', () => {
  it('the shifted window really is the probe target (sanity: responders answer)', { timeout: 30_000 }, async () => {
    await occupyWindow(respondJson(() => NONCELESS_BODY));
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${PORT_BASE}`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
    });
    expect(status).toBe(200);
    const addr = responders[0]?.address() as AddressInfo;
    expect(addr.port).toBe(PORT_BASE);
  });
});
