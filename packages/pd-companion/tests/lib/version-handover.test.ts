/**
 * PRI-1012 P1 — version-change hand-over, real-process behavior.
 *
 * The review round found that the update path only flipped supervisor state:
 * the old managed Console survived on the port, `pd console open` answered
 * `reused`, and the Companion marked the upgrade done. These tests exercise
 * the hand-over seam against REAL child processes and REAL ports — old
 * console healthy and holding the port, kill, confirmed exit, new process on
 * the same port with a new PID — plus the acceptance matrix that decides
 * whether a launch result may ever complete a version switch.
 */
import { describe, expect, it } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SupervisorState } from '../../src/lib/supervisor.js';
import {
  judgeVersionChangeLaunch,
  killManagedServerAndWait,
  ownedManagedHandle,
  realProcessOps,
  type ProcessOps,
} from '../../src/lib/version-handover.js';

const HOST = '127.0.0.1';
let portCursor = 33210;

function nextPort(): number {
  portCursor += 1;
  return portCursor;
}

/**
 * Spawn a real long-lived fake Console that answers /api/health on the port.
 * Same fixture shape as the pd-cli real-process suites: a temp script file
 * launched as `node <script>` via an argv array, never a shell.
 */
function spawnFakeConsole(port: number): cp.ChildProcess {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-handover-console-'));
  const entry = path.join(dir, 'fake-console.cjs');
  fs.writeFileSync(entry, [
    'const http = require("http");',
    'const server = http.createServer((req, res) => {',
    '  if (req.url === "/api/health") {',
    '    res.writeHead(200, { "Content-Type": "application/json" });',
    '    res.end(JSON.stringify({ healthy: true }));',
    '  } else { res.writeHead(404); res.end(); }',
    '});',
    `server.listen(${port}, "${HOST}");`,
  ].join('\n'));
  const argv: string[] = [entry];
  return cp.spawn('node', argv, { stdio: 'ignore' });
}

function tcpConnect(port: number, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('timeout')));
    socket.once('error', (err) => finish(err));
    socket.connect(port, HOST);
  });
}

async function waitForPort(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await tcpConnect(port, 200); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`port ${port} never became available`);
}

async function waitForPortFree(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await tcpConnect(port, 200); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} never became free`);
}

function waitExit(child: cp.ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} never exited`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** waitExit for teardown paths: the listener MUST attach before the kill, or
 * the one-shot exit event fires unobserved and the await hangs (missed on fast
 * Linux CI where the process dies between two liveness polls). */
async function killAndAwaitExit(child: cp.ChildProcess): Promise<void> {
  const exited = waitExit(child);
  child.kill();
  await exited;
}

function managedRunning(serverPid: number): SupervisorState {
  return { kind: 'running', mode: 'managed', url: `http://${HOST}:3100`, port: 3100, serverPid };
}

describe('version-handover (PRI-1012 P1) — the killable-handle guard', () => {
  it('a managed, owned, PID-known server yields the handle (server + CLI wrapper)', () => {
    const handle = ownedManagedHandle(managedRunning(4242), true, 4243);
    expect(handle).toEqual({ serverPid: 4242, cliPid: 4243 });
  });

  it('an attached/reused external instance never yields a handle — no ownership, no kill', () => {
    const attached: SupervisorState = { kind: 'running', mode: 'attached', url: `http://${HOST}:3100`, port: 3100 };
    expect(ownedManagedHandle(attached, false, 4242)).toBeUndefined();
    expect(ownedManagedHandle(attached, true, 4242)).toBeUndefined();
  });

  it('a managed server without a reported PID yields no handle — killing the wrapper alone could orphan it', () => {
    const noPid: SupervisorState = { kind: 'running', mode: 'managed', url: `http://${HOST}:3100`, port: 3100 };
    expect(ownedManagedHandle(noPid, true, 4242)).toBeUndefined();
  });

  it('once the machine left `running`, no handle exists anymore', () => {
    expect(ownedManagedHandle({ kind: 'restarting', attempt: 1, reason: 'version_change' }, true, 4242)).toBeUndefined();
    expect(ownedManagedHandle({ kind: 'idle' }, true, 4242)).toBeUndefined();
    expect(ownedManagedHandle({ kind: 'degraded', reason: 'launch_failed' }, true, 4242)).toBeUndefined();
  });

  it('a REAL attached console survives the hand-over decision untouched', async () => {
    const port = nextPort();
    const external = spawnFakeConsole(port);
    try {
      await waitForPort(port);
      const attached: SupervisorState = { kind: 'running', mode: 'attached', url: `http://${HOST}:${port}`, port };
      expect(ownedManagedHandle(attached, false, external.pid)).toBeUndefined();
      // give any wrongly-wired kill a chance to land, then prove it did not
      await new Promise((r) => setTimeout(r, 250));
      expect(realProcessOps.isAlive(external.pid!)).toBe(true);
    } finally {
      await killAndAwaitExit(external).catch(() => undefined);
    }
  }, 15_000);
});

describe('version-handover (PRI-1012 P1) — real stop-and-confirm against real processes', () => {
  it('old console healthy and holding the port: stop is confirmed, port frees, new process takes it with a NEW PID', async () => {
    const port = nextPort();
    const old = spawnFakeConsole(port);
    try {
      await waitForPort(port); // the old managed Console is up and holding the port
      const handle = ownedManagedHandle(managedRunning(old.pid!), true);
      expect(handle).toBeDefined();

      // attach BEFORE the kill: the exit event is one-shot and the lib's
      // liveness poll may observe death a tick before the event delivers
      const oldExited = waitExit(old);
      const confirmed = await killManagedServerAndWait(handle!, realProcessOps, { timeoutMs: 5_000 });
      expect(confirmed).toBe(true);
      await oldExited;
      await waitForPortFree(port);
      expect(realProcessOps.isAlive(old.pid!)).toBe(false);

      // the new version's Console binds the SAME port as a NEW process
      const fresh = spawnFakeConsole(port);
      try {
        await waitForPort(port);
        expect(fresh.pid).not.toBe(old.pid);
        expect(realProcessOps.isAlive(fresh.pid!)).toBe(true);
      } finally {
        await killAndAwaitExit(fresh).catch(() => undefined);
      }
    } catch (err) {
      old.kill();
      throw err;
    }
  }, 20_000);

  it('a refused kill resolves false instead of hanging or throwing the hand-over away', async () => {
    const ops: ProcessOps = {
      kill: () => { throw new Error('EPERM'); },
      isAlive: () => true,
    };
    const confirmed = await killManagedServerAndWait({ serverPid: 999_999, cliPid: 999_998 }, ops, { timeoutMs: 250, pollMs: 50 });
    expect(confirmed).toBe(false);
  });

  it('a stubborn process that survives the kill window is reported unconfirmed', async () => {
    const ops: ProcessOps = { kill: () => { /* ignored by the process */ }, isAlive: () => true };
    const confirmed = await killManagedServerAndWait({ serverPid: 999_999 }, ops, { timeoutMs: 250, pollMs: 50 });
    expect(confirmed).toBe(false);
  });

  it('exit is confirmed only when EVERY owned PID is gone', async () => {
    const ops: ProcessOps = { kill: () => {}, isAlive: (pid) => pid === 1111 }; // server alive, wrapper gone
    const confirmed = await killManagedServerAndWait({ serverPid: 1111, cliPid: 2222 }, ops, { timeoutMs: 200, pollMs: 40 });
    expect(confirmed).toBe(false);
  });

  it('confirms a real kill of a server whose CLI wrapper already exited', async () => {
    const port = nextPort();
    const server = spawnFakeConsole(port);
    try {
      await waitForPort(port);
      // cliPid undefined — the wrapper is already gone (old pd-cli shape)
      // attach BEFORE the kill (same one-shot event race as above)
      const serverExited = waitExit(server);
      const confirmed = await killManagedServerAndWait({ serverPid: server.pid! }, realProcessOps, { timeoutMs: 5_000 });
      expect(confirmed).toBe(true);
      await serverExited;
    } catch (err) {
      server.kill();
      throw err;
    }
  }, 15_000);
});

describe('version-handover (PRI-1012 P1) — may a launch result complete the switch?', () => {
  const started = (port = 3100) => ({ status: 'started' as const, port });
  const reused = (port = 3100) => ({ status: 'reused' as const, port });

  it('outside a hand-over every successful result is normal handling', () => {
    expect(judgeVersionChangeLaunch(undefined, started(), '2.0.0')).toEqual({ action: 'accept' });
    expect(judgeVersionChangeLaunch(undefined, reused(), '2.0.0')).toEqual({ action: 'accept' });
  });

  it('a reused result during a hand-over NEVER completes it — that is the old Console on the port', () => {
    expect(judgeVersionChangeLaunch('2.0.0', reused(), '2.0.0')).toEqual({ action: 'keep_waiting_stale_reused', port: 3100 });
  });

  it('a started result completes the hand-over only at the target version', () => {
    expect(judgeVersionChangeLaunch('2.0.0', started(), '2.0.0')).toEqual({ action: 'accept_pending_new_version' });
  });

  it('a started result at any other (or unreadable) version is rejected, not claimed as upgraded', () => {
    expect(judgeVersionChangeLaunch('2.0.0', started(), '1.9.0')).toEqual({ action: 'reject_version_mismatch', expected: '2.0.0', got: '1.9.0' });
    expect(judgeVersionChangeLaunch('2.0.0', started(), undefined)).toEqual({ action: 'reject_version_mismatch', expected: '2.0.0', got: undefined });
  });

  it('failed and refused results stay terminal during a hand-over', () => {
    expect(judgeVersionChangeLaunch('2.0.0', { status: 'failed', port: 3100 }, '2.0.0')).toEqual({ action: 'fail_terminal' });
    expect(judgeVersionChangeLaunch('2.0.0', { status: 'refused', port: 3100 }, '2.0.0')).toEqual({ action: 'fail_terminal' });
  });
});
