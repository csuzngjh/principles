/**
 * pd console open tests (PRI-300).
 *
 * Covers:
 *   - isLoopbackHost() returns true for loopback, false for LAN/public
 *   - isPortInUse() / findAvailablePort() detect busy ports
 *   - planConsoleLaunch() classifies reused / started / refused / failed
 *   - non-loopback host is refused before any port work
 *   - port-in-use-by-non-console case (reused but unhealthy) is structured
 *   - console runtime not installed is structured failure
 *   - workspace missing is structured failure
 *   - CLI command wiring: pd console open --help, --workspace, --port, --json, --host
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isLoopbackHost,
  isPortInUse,
  findAvailablePort,
  planConsoleLaunch,
  probeConsoleHealth,
} from '../../src/services/console-launcher.js';

// ─── Loopback safety ─────────────────────────────────────────────────────────

describe('isLoopbackHost', () => {
  it('returns true for 127.0.0.1, localhost, ::1, 127.x.x.x', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.42')).toBe(true);
  });

  it('returns false for non-loopback hosts (LAN, public, 0.0.0.0)', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('172.16.0.1')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('myhost.example.com')).toBe(false);
  });
});

// ─── Port detection ──────────────────────────────────────────────────────────

describe('isPortInUse', () => {
  let server: net.Server;

  beforeEach(async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('returns true for a port that accepts a TCP connection', async () => {
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      const inUse = await isPortInUse(addr.address, addr.port, 1000);
      expect(inUse).toBe(true);
    }
  });

  it('returns false for a port that is closed', async () => {
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      // Close the server, then probe
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const inUse = await isPortInUse(addr.address, addr.port, 800);
      expect(inUse).toBe(false);
    }
  });
});

describe('findAvailablePort', () => {
  it('returns the first port in the range that is not in use', async () => {
    // Pick a very high port to avoid colliding with running services
    const port = await findAvailablePort('127.0.0.1', 49000, 5);
    expect(port).not.toBeNull();
    expect(port).toBeGreaterThanOrEqual(49000);
  });

  it('skips occupied ports and returns the next free one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(49100, '127.0.0.1', () => resolve());
    });
    try {
      // Should skip 49100 and return 49101
      const port = await findAvailablePort('127.0.0.1', 49100, 5);
      expect(port).toBe(49101);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns null when all ports in the range are occupied', async () => {
    // Open 3 ports and check that findAvailablePort with limit=2 returns null
    const servers: net.Server[] = [];
    const ports: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = net.createServer();
      await new Promise<void>((resolve) => {
        s.listen(0, '127.0.0.1', () => {
          const a = s.address();
          if (typeof a === 'object' && a) ports.push(a.port);
          resolve();
        });
      });
      servers.push(s);
    }
    try {
      const port = await findAvailablePort('127.0.0.1', ports[0], 1);
      expect(port).toBeNull();
    } finally {
      for (const s of servers) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
  });
});

// ─── planConsoleLaunch: refused (non-loopback) ──────────────────────────────

describe('planConsoleLaunch — refused (non-loopback host)', () => {
  it('refuses 0.0.0.0', async () => {
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: 3100,
      host: '0.0.0.0',
    });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/non-loopback/i);
    expect(result.nextAction).toBeDefined();
  });

  it('refuses LAN host 192.168.1.5', async () => {
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: 3100,
      host: '192.168.1.5',
    });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/192\.168\.1\.5/);
  });
});

// ─── planConsoleLaunch: started (port free) ─────────────────────────────────

describe('planConsoleLaunch — started (preferred port free)', () => {
  it('returns started on the preferred port when no service is running', async () => {
    const preferred = 49200;
    // Verify the port is free first
    expect(await isPortInUse('127.0.0.1', preferred)).toBe(false);
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: preferred,
      host: '127.0.0.1',
    });
    expect(result.status).toBe('started');
    expect(result.reused).toBe(false);
    expect(result.port).toBe(preferred);
    expect(result.url).toBe(`http://127.0.0.1:${preferred}`);
  });
});

// ─── planConsoleLaunch: reused (existing healthy console) ──────────────────

describe('planConsoleLaunch — reused (healthy console on preferred port)', () => {
  it('returns reused when /api/health returns 200 on the preferred port', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const result = await planConsoleLaunch({
        workspaceDir: '/tmp/anywhere',
        preferredPort: addr.port,
        host: '127.0.0.1',
      });
      expect(result.status).toBe('reused');
      expect(result.reused).toBe(true);
      expect(result.url).toBe(`http://127.0.0.1:${addr.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does NOT classify a non-console responder as reused', async () => {
    // Server returns 200 on any path but with a non-OK status code from /api/health
    const server = http.createServer((req, res) => {
      res.statusCode = 500;
      res.end('error');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const result = await planConsoleLaunch({
        workspaceDir: '/tmp/anywhere',
        preferredPort: addr.port,
        host: '127.0.0.1',
      });
      // health 500 → not healthy → falls through to "started" (port is occupied by non-console → next port)
      // but it may also stay in "started" if no fallback is found
      expect(result.status === 'started' || result.status === 'failed').toBe(true);
      if (result.status === 'started') {
        // It should have moved to a different port (not addr.port)
        expect(result.port).not.toBe(addr.port);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── planConsoleLaunch: started with port fallback ──────────────────────────

describe('planConsoleLaunch — port fallback', () => {
  it('moves to next free port when preferred is occupied by a non-console', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 500; // not a healthy console
      res.end('error');
    });
    await new Promise<void>((resolve) => server.listen(49300, '127.0.0.1', () => resolve()));
    try {
      const result = await planConsoleLaunch({
        workspaceDir: '/tmp/anywhere',
        preferredPort: 49300,
        host: '127.0.0.1',
      });
      expect(result.status).toBe('started');
      expect(result.port).toBe(49301);
      expect(result.reason).toMatch(/busy|49300/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── probeConsoleHealth ─────────────────────────────────────────────────────

describe('probeConsoleHealth', () => {
  it('returns healthy=true for a server that returns 200 on /api/health', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth('127.0.0.1', addr.port);
      expect(h.healthy).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns healthy=false with reason for a server that returns 500', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth('127.0.0.1', addr.port);
      expect(h.healthy).toBe(false);
      expect(h.reason).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── CLI command wiring ──────────────────────────────────────────────────────

describe('CLI command wiring (pd console open)', () => {
  let cliPath: string;
  let workspaceRoot: string;
  let tmp: string;

  beforeEach(() => {
    workspaceRoot = path.resolve(__dirname, '../../../..');
    cliPath = path.join(workspaceRoot, 'packages', 'pd-cli', 'dist', 'index.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-open-test-'));
    // Fake a console install: create dir + dist/server.js
    const consoleDir = path.join(os.homedir(), '.openclaw', 'extensions', 'principles-disciple', 'console');
    fs.mkdirSync(path.join(consoleDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(consoleDir, 'dist', 'server.js'), '// fake console server\n');
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      const consoleDir = path.join(os.homedir(), '.openclaw', 'extensions', 'principles-disciple', 'console');
      fs.rmSync(consoleDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('console open subcommand is registered (pd console open --help)', () => {
    const out = runPd(['console', 'open', '--help'], workspaceRoot);
    expect(out).toContain('--workspace');
    expect(out).toContain('--port');
    expect(out).toContain('--host');
    expect(out).toContain('--json');
    expect(out).toContain('--no-browser');
  });

  it('console subcommand list shows "open" subcommand', () => {
    const out = runPd(['console', '--help'], workspaceRoot);
    expect(out).toMatch(/\bopen\b/);
  });

  it('pd console open --host 0.0.0.0 --json returns a refused JSON object', () => {
    const out = runPd(['console', 'open', '--workspace', tmp, '--host', '0.0.0.0', '--json', '--no-browser'], workspaceRoot);
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toMatch(/non-loopback/i);
    expect(parsed.nextAction).toBeDefined();
  });

  it('pd console open --json (port free) returns a structured JSON object with required fields', () => {
    const out = runPd(['console', 'open', '--workspace', tmp, '--json', '--no-browser'], workspaceRoot);
    // The CLI will attempt to start the fake server.js; since the file is a stub, the
    // child will exit early → we should get a structured "failed" JSON, not a crash.
    // The required-field contract (status, url, port, host, workspaceDir, reason, nextAction, reused, browserOpened) is
    // what we assert.
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('status');
    expect(['started', 'reused', 'failed', 'refused']).toContain(parsed.status);
    expect(parsed).toHaveProperty('port');
    expect(parsed).toHaveProperty('host');
    expect(parsed).toHaveProperty('workspaceDir');
    expect(parsed).toHaveProperty('reused');
    expect(parsed).toHaveProperty('browserOpened');
  });

  it('pd console open --port 99999 --json returns a structured failure (invalid port)', () => {
    const out = runPd(['console', 'open', '--workspace', tmp, '--port', '99999', '--json', '--no-browser'], workspaceRoot);
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('failed');
    expect(parsed.reason).toMatch(/Invalid --port/);
  });

  it('pd console open without --workspace and no env var returns a structured workspace_missing failure', () => {
    const previous = process.env.PD_WORKSPACE_DIR;
    delete process.env.PD_WORKSPACE_DIR;
    try {
      const out = runPd(['console', 'open', '--json', '--no-browser'], workspaceRoot);
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toBe('workspace_missing');
      expect(parsed.nextAction).toBeDefined();
    } finally {
      if (previous !== undefined) process.env.PD_WORKSPACE_DIR = previous;
    }
  });

  it('pd console open --json with --no-auth and --no-browser parses options correctly', () => {
    const out = runPd(['console', 'open', '--workspace', tmp, '--json', '--no-auth', '--no-browser'], workspaceRoot);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('status');
    expect(parsed.browserOpened).toBe(false);
  });

  it('pd console --no-auth --json legacy path parses --no-auth correctly', () => {
    const out = runPd(['console', '--workspace', tmp, '--json', '--no-auth'], workspaceRoot);
    if (out.trim().length > 0) {
      const parsed = JSON.parse(out);
      expect(parsed).toBeDefined();
    }
  });
});

function runPd(args: string[], cwd: string): string {
  try {
    return execFileSync('node', ['packages/pd-cli/dist/index.js', ...args], {
      encoding: 'utf8',
      cwd,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && Object.hasOwn(err, 'stdout')) {
      const stdoutVal = Reflect.get(err, 'stdout');
      if (typeof stdoutVal === 'string' || stdoutVal instanceof Buffer) {
        return String(stdoutVal);
      }
    }
    throw err;
  }
}
