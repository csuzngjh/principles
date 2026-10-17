import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planConsoleLaunch } from '../../src/services/console-launcher.js';

const HOST = '127.0.0.1';
let PORT = 33101;
let fakeConsole: ChildProcess | undefined;

/** Write and spawn a minimal Console look-alike that answers /api/health. */
async function startFakeConsole(port: number): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fake-console-'));
  const entry = path.join(dir, 'fake-console.cjs');
  fs.writeFileSync(
    entry,
    [
      'const http = require("http");',
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/api/health") {',
      '    res.writeHead(200, { "Content-Type": "application/json" });',
      '    res.end(JSON.stringify({ healthy: true }));',
      '  } else { res.writeHead(404); res.end(); }',
      '});',
      `server.listen(${port}, "127.0.0.1");`,
      'process.on("uncaughtException", (err) => { process.stderr.write("UNCAUGHT: " + err.stack); process.exit(1); });',
    ].join('\n'),
  );
  let stderr = '';
  fakeConsole = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  fakeConsole.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  fakeConsole.on('exit', (code) => {
    if (code !== 0) {
      void undefined; // surface via waitForPort error below
    }
  });
  try {
    await waitForPort(port, 5000, stderr);
  } catch (err) {
    throw new Error(
      `port ${port} never became available; fake console exited/stderr: ${stderr}`,
      { cause: err },
    );
  }
}

async function stopFakeConsole(): Promise<void> {
  if (fakeConsole) {
    try {
      fakeConsole.kill();
    } catch {
      /* ignore */
    }
    fakeConsole = undefined;
  }
  await waitForPortFree(PORT, 5000);
}

function tcpConnect(port: number, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('timeout')));
    socket.once('error', (err) => finish(err));
    socket.connect(port, HOST);
  });
}

async function waitForPort(port: number, timeoutMs: number, stderr?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await tcpConnect(port, 200);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`port ${port} never became available${stderr ? `\nstderr: ${stderr}` : ''}`);
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await tcpConnect(port, 200);
      // still in use — keep waiting
    } catch {
      return; // refused / unreachable → free
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} never became free`);
}

/** A TCP server that accepts connections but never speaks HTTP — mimics a
 * foreign process holding the port. probeConsoleHealth must treat it as not-healthy. */
async function startForeignPortHolder(port: number): Promise<ChildProcess> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-foreign-'));
  const entry = path.join(dir, 'foreign.cjs');
  fs.writeFileSync(
    entry,
    [
      'const net = require("net");',
      'const server = net.createServer(() => { /* accept and do nothing */ });',
      `server.listen(${port}, "127.0.0.1");`,
    ].join('\n'),
  );
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForPort(port, 5000);
  return child;
}

describe('pd console open — port reuse semantics (PRI-1012 P1 regression)', () => {
  let held: ChildProcess | undefined;

  beforeEach(async () => {
    await stopFakeConsole();
    held = undefined;
  });

  afterEach(async () => {
    if (held) {
      try {
        held.kill();
      } catch {
        /* ignore */
      }
      held = undefined;
    }
    await stopFakeConsole();
    PORT += 1;
  });

  it('reports reused when a healthy console already holds the port', async () => {
    await startFakeConsole(PORT);
    const result = await planConsoleLaunch({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')),
      preferredPort: PORT,
      host: HOST,
    });
    expect(result.status).toBe('reused');
    expect(result.reused).toBe(true);
    expect(result.port).toBe(PORT);
    await stopFakeConsole();
  });

  it('reports started once the port is free again', async () => {
    await startFakeConsole(PORT);
    await stopFakeConsole();
    const result = await planConsoleLaunch({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')),
      preferredPort: PORT,
      host: HOST,
    });
    expect(result.status).toBe('started');
    expect(result.reused).toBe(false);
    expect(result.port).toBe(PORT);
  });

  it('falls back to another port when a foreign process holds the preferred port', async () => {
    held = await startForeignPortHolder(PORT);
    const result = await planConsoleLaunch({
      workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-')),
      preferredPort: PORT,
      host: HOST,
    });
    expect(result.status).toBe('started');
    expect(result.reused).toBe(false);
    expect(result.port).not.toBe(PORT);
    expect(result.reason).toContain('busy');
  });
});
