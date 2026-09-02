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
import * as childProcessModule from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';
import {
  isLoopbackHost,
  normalizeLoopbackHost,
  buildConsoleUrl,
  isPortInUse,
  findAvailablePort,
  planConsoleLaunch,
  probeConsoleHealth,
  openBrowser,
} from '../../src/services/console-launcher.js';

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawn: (...args: any[]) => {
      if ((globalThis as any).__mockSpawn) {
        return (globalThis as any).__mockSpawn(...args);
      }
      return original.spawn(...args as [any, any]);
    },
  };
});

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

// ─── IPv6 loopback normalization ─────────────────────────────────────────────

describe('normalizeLoopbackHost', () => {
  it('strips brackets from [::1] → ::1', () => {
    expect(normalizeLoopbackHost('[::1]')).toBe('::1');
  });

  it('passes through 127.0.0.1 unchanged', () => {
    expect(normalizeLoopbackHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('passes through localhost unchanged', () => {
    expect(normalizeLoopbackHost('localhost')).toBe('localhost');
  });

  it('passes through ::1 unchanged (already normalized)', () => {
    expect(normalizeLoopbackHost('::1')).toBe('::1');
  });

  it('passes through non-loopback as-is (caller must reject)', () => {
    expect(normalizeLoopbackHost('0.0.0.0')).toBe('0.0.0.0');
  });
});

// ─── URL formatting for IPv6 ─────────────────────────────────────────────────

describe('buildConsoleUrl', () => {
  it('wraps ::1 in brackets for valid URL', () => {
    expect(buildConsoleUrl('::1', 3100)).toBe('http://[::1]:3100');
  });

  it('keeps 127.0.0.1 unchanged', () => {
    expect(buildConsoleUrl('127.0.0.1', 3100)).toBe('http://127.0.0.1:3100');
  });

  it('keeps localhost unchanged', () => {
    expect(buildConsoleUrl('localhost', 3100)).toBe('http://localhost:3100');
  });

  it('keeps 127.x.x.x unchanged', () => {
    expect(buildConsoleUrl('127.0.0.42', 3119)).toBe('http://127.0.0.42:3119');
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

  it('does not return ports above 65535 when fallback goes out of range', async () => {
    (globalThis as any).__mockIsPortInUse = async (host: string, port: number) => {
      if (port === 65535) return true;
      return false;
    };
    try {
      const port = await findAvailablePort('127.0.0.1', 65535, 2);
      expect(port).toBeNull();
    } finally {
      delete (globalThis as any).__mockIsPortInUse;
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

  it('normalizes [::1] to ::1 and uses it for port probing', async () => {
    // [::1] should be normalized to ::1 and NOT refused
    const preferred = 49250;
    expect(await isPortInUse('::1', preferred)).toBe(false);
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: preferred,
      host: '[::1]',
    });
    expect(result.status).toBe('started');
    expect(result.host).toBe('::1');
    // URL must have brackets for valid IPv6 URL format
    expect(result.url).toBe(`http://[::1]:${preferred}`);
  });

  it('formats ::1 URL with brackets (no raw IPv6 in URL)', async () => {
    const preferred = 49251;
    expect(await isPortInUse('::1', preferred)).toBe(false);
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: preferred,
      host: '::1',
    });
    expect(result.status).toBe('started');
    expect(result.host).toBe('::1');
    expect(result.url).toBe(`http://[::1]:${preferred}`);
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

  it('does not reuse a verified no-auth Console when a token is configured', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: { authenticationMode: 'no_auth' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const result = await planConsoleLaunch({
        workspaceDir: '/tmp/anywhere', preferredPort: addr.port,
        host: '127.0.0.1', token: 'configured-token',
      });
      expect(result.status).toBe('refused');
      expect(result.reason).toBe('console_authentication_mode_mismatch');
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });

  it('fails loud when the configured token is rejected by an existing Console', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const result = await planConsoleLaunch({
        workspaceDir: '/tmp/anywhere', preferredPort: addr.port,
        host: '127.0.0.1', token: 'wrong-token',
      });
      expect(result.status).toBe('refused');
      expect(result.reason).toBe('console_authentication_failed');
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
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
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port });
      expect(h.healthy).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns the verified authentication mode from the health contract', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: { authenticationMode: 'authenticated' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port, token: 'token' });
      expect(h).toMatchObject({ healthy: true, authenticationMode: 'authenticated' });
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
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
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port });
      expect(h.healthy).toBe(false);
      expect(h.reason).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends Authorization header when token is provided', async () => {
    let receivedAuth: string | undefined;
    const server = http.createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port, token: 'test-token-123' });
      expect(h.healthy).toBe(true);
      expect(receivedAuth).toBe('Bearer test-token-123');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does NOT send Authorization header when token is undefined', async () => {
    let receivedAuth: string | undefined;
    const server = http.createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port });
      expect(h.healthy).toBe(true);
      expect(receivedAuth).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns healthy=false with reason when server returns 401 (unauthorized)', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port });
      expect(h.healthy).toBe(false);
      expect(h.reason).toMatch(/401/);
      expect(h.reason).not.toMatch(/non-console/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('401 is NOT misclassified as healthy even with a valid token', async () => {
    const server = http.createServer((req, res) => {
      // Simulate a console that requires auth and rejects bad tokens
      if (req.headers.authorization !== 'Bearer correct-token') {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    try {
      // Wrong token → 401 → should NOT be healthy
      const h = await probeConsoleHealth({ host: '127.0.0.1', port: addr.port, token: 'wrong-token' });
      expect(h.healthy).toBe(false);
      expect(h.reason).toMatch(/401/);
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
  let originalConsoleToken: string | undefined;

  beforeEach(() => {
    originalConsoleToken = process.env.PD_CONSOLE_TOKEN;
    delete process.env.PD_CONSOLE_TOKEN;
    workspaceRoot = path.resolve(__dirname, '../../../..');
    cliPath = path.join(workspaceRoot, 'packages', 'pd-cli', 'dist', 'index.js');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-open-test-'));
    // Isolated fake HOME so the tests never read from — or rmSync-destroy — a
    // real ~/.openclaw install on developer machines. runPd() points the CLI
    // child at this home via __PD_CONSOLE_TEST_FAKE_HOME.
    const fakeHome = path.join(tmp, 'home');
    process.env.__PD_CONSOLE_TEST_FAKE_HOME = fakeHome;
    // Fake a console install: dir + ESM package.json + dist/server.js with a
    // minimal HTTP server. The package.json "type": "module" makes the fake
    // server's module system deterministic regardless of whether a real
    // extension-root package.json exists above the console dir.
    const consoleDir = path.join(fakeHome, '.openclaw', 'extensions', 'principles-disciple', 'console');
    fs.mkdirSync(path.join(consoleDir, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(consoleDir, 'package.json'), JSON.stringify({ name: 'fake-pd-console', version: '0.0.0', type: 'module' }, null, 2));
    // EP-06 regression guard: dist/web/index.html must exist (PR #1169 fix)
    fs.writeFileSync(path.join(consoleDir, 'dist', 'web', 'index.html'), '<!DOCTYPE html><html></html>');
    // Runtime dependency integrity check: fake console needs minimal node_modules
    // slots so the launcher passes the integrity gate and reaches spawn/health logic.
    const nm = path.join(consoleDir, 'node_modules');
    // principles-disciple: server imports principles-disciple/governance-audit
    fs.mkdirSync(path.join(nm, 'principles-disciple', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'principles-disciple', 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2));
    fs.writeFileSync(path.join(nm, 'principles-disciple', 'dist', 'governance-audit.js'), 'export {};\n');
    // @principles/core: server imports @principles/core/principle-tree-ledger
    fs.mkdirSync(path.join(nm, '@principles', 'core', 'dist', 'principle-tree-ledger'), { recursive: true });
    fs.writeFileSync(path.join(nm, '@principles', 'core', 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2));
    fs.writeFileSync(path.join(nm, '@principles', 'core', 'dist', 'principle-tree-ledger', 'index.js'), 'export {};\n');
    // @principles/host-runtime: uses root entry dist/index.js
    fs.mkdirSync(path.join(nm, '@principles', 'host-runtime', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(nm, '@principles', 'host-runtime', 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2));
    fs.writeFileSync(path.join(nm, '@principles', 'host-runtime', 'dist', 'index.js'), 'export {};\n');
    // @principles/install-layout: uses root entry dist/index.js
    fs.mkdirSync(path.join(nm, '@principles', 'install-layout', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(nm, '@principles', 'install-layout', 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2));
    fs.writeFileSync(path.join(nm, '@principles', 'install-layout', 'dist', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(consoleDir, 'dist', 'server.js'), `
      import http from 'node:http';
      const args = process.argv.slice(2);
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 3100;
      const hostIdx = args.indexOf('--host');
      const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';
      const server = http.createServer((req, res) => {
        if (req.url === '/api/health') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({success: true, data: {authenticationMode: 'no_auth'}}));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(port, host, () => {
        console.log(JSON.stringify({status: 'running', port, host}));
      });
    `);
  });

  afterEach(() => {
    if (originalConsoleToken === undefined) delete process.env.PD_CONSOLE_TOKEN;
    else process.env.PD_CONSOLE_TOKEN = originalConsoleToken;
    delete process.env.__PD_CONSOLE_TEST_FAKE_HOME;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
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
    // The real CLI spawns a long-lived Console server process and then prints
    // JSON *without exiting* (the child keeps running). execFileSync would
    // block forever waiting for the child to exit. Use a short timeout so the
    // test reads stdout before the process is killed.
    // Vitest timeout (10s) must exceed execFileSync timeout (8s) so the child
    // is killed by execFileSync first, allowing stdout to be read.
    const out = runPd(['console', 'open', '--workspace', tmp, '--json', '--no-browser'], workspaceRoot, 8_000);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('status');
    expect(['started', 'reused', 'failed', 'refused']).toContain(parsed.status);
    expect(parsed).toHaveProperty('port');
    expect(parsed).toHaveProperty('host');
    expect(parsed).toHaveProperty('workspaceDir');
    expect(parsed).toHaveProperty('reused');
    expect(parsed).toHaveProperty('browserOpened');
  }, 10_000);

  it('pd console open --json fresh spawn includes a positive integer serverPid (PRI-526)', async () => {
    // Async stream-parse + guaranteed teardown. execFileSync patterns are
    // unreliable here on Windows: the CLI keeps running after printing JSON
    // (fresh spawn) or may unexpectedly take another branch, and killing via
    // timeout can leave the grandchild server holding pipe handles.
    let run: CliJsonRun | undefined;
    try {
      run = await runPdUntilJson(
        ['console', 'open', '--workspace', tmp, '--port', '49390', '--json', '--no-browser'],
        workspaceRoot,
      );
      if (!isRecord(run.parsed)) throw new Error('CLI JSON output was not an object');
      expect(run.parsed.status).toBe('started');
      expect(run.parsed.reused).toBe(false);
      const serverPid = run.parsed.serverPid;
      expect(typeof serverPid === 'number' && Number.isInteger(serverPid) && serverPid > 0).toBe(true);
    } finally {
      await teardownCliTree(run);
    }
  }, 20_000);

  it('kills and refuses a fresh Console whose reported authentication mode mismatches the configured token', async () => {
    process.env.PD_CONSOLE_TOKEN = 'configured-token';
    let run: CliJsonRun | undefined;
    try {
      run = await runPdUntilJson(
        ['console', 'open', '--workspace', tmp, '--port', '49391', '--json', '--no-browser'],
        workspaceRoot,
      );
      if (!isRecord(run.parsed)) throw new Error('CLI JSON output was not an object');
      expect(run.parsed.status).toBe('refused');
      expect(run.parsed.reason).toBe('console_authentication_mode_mismatch');
      expect(run.parsed).not.toHaveProperty('serverPid');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await isPortInUse('127.0.0.1', 49391)).toBe(false);
    } finally {
      await teardownCliTree(run);
    }
  }, 20_000);

  it('pd console open --json reused path does NOT include serverPid (PRI-526)', async () => {
    // Stand up a fake healthy console in-process, then point the CLI at its
    // port: planConsoleLaunch probes /api/health → 200 → reused, no spawn.
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: { authenticationMode: 'no_auth' } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    let run: CliJsonRun | undefined;
    try {
      run = await runPdUntilJson(
        ['console', 'open', '--workspace', tmp, '--port', String(addr.port), '--json', '--no-browser'],
        workspaceRoot,
      );
      if (!isRecord(run.parsed)) throw new Error('CLI JSON output was not an object');
      expect(run.parsed.status).toBe('reused');
      expect(run.parsed.reused).toBe(true);
      expect(run.parsed.authenticationMode).toBe('no_auth');
      expect(run.parsed).not.toHaveProperty('serverPid');
    } finally {
      await teardownCliTree(run);
      server.close();
    }
  }, 20_000);

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
    // Same as port-free test: CLI spawns a long-lived server, use timeout.
    const out = runPd(['console', 'open', '--workspace', tmp, '--json', '--no-auth', '--no-browser'], workspaceRoot, 8_000);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('status');
    expect(parsed.browserOpened).toBe(false);
  }, 10_000);

  it('pd console --no-auth --json legacy path parses --no-auth correctly', () => {
    // Same: may spawn a long-lived server, use timeout.
    const out = runPd(['console', '--workspace', tmp, '--json', '--no-auth'], workspaceRoot, 8_000);
    expect(out.trim()).not.toBe('');
    const parsed = JSON.parse(out);
    expect(parsed).toBeDefined();
  }, 10_000);

  describe('openBrowser', () => {
    afterEach(() => {
      delete (globalThis as any).__mockSpawn;
    });

    it('returns opened: true when spawn does not emit error in the short window', async () => {
      const mockChild = new EventEmitter() as any;
      mockChild.unref = vi.fn();
      let spawnCalled = false;
      (globalThis as any).__mockSpawn = () => {
        spawnCalled = true;
        return mockChild;
      };

      const result = await openBrowser('http://127.0.0.1:3100');
      expect(result.opened).toBe(true);
      expect(spawnCalled).toBe(true);
    });

    it('returns opened: false when spawn emits an error within the short window', async () => {
      const mockChild = new EventEmitter() as any;
      mockChild.unref = vi.fn();
      let spawnCalled = false;
      (globalThis as any).__mockSpawn = () => {
        spawnCalled = true;
        process.nextTick(() => {
          mockChild.emit('error', new Error('spawn ENOENT'));
        });
        return mockChild;
      };

      const result = await openBrowser('http://127.0.0.1:3100');
      expect(result.opened).toBe(false);
      expect(result.reason).toContain('Failed to spawn browser process: spawn ENOENT');
      expect(spawnCalled).toBe(true);
    });

    it('returns opened: false when spawn throws synchronously', async () => {
      let spawnCalled = false;
      (globalThis as any).__mockSpawn = () => {
        spawnCalled = true;
        throw new Error('Sync spawn failure');
      };

      const result = await openBrowser('http://127.0.0.1:3100');
      expect(result.opened).toBe(false);
      expect(result.reason).toContain('Sync spawn failure');
      expect(spawnCalled).toBe(true);
    });
  });

  describe('handleConsoleOpen browser failure reporting', () => {
    afterEach(() => {
      delete (globalThis as any).__mockSpawn;
      delete (globalThis as any).__mockPlanConsoleLaunch;
      delete (globalThis as any).__mockProbeConsoleHealth;
    });

    it('sets browserOpened: false when browser fails to open', async () => {
      const { handleConsoleOpen } = await import('../../src/commands/console.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // The in-process handler resolves the console dir via getConsoleDir(),
      // which reads HOME/USERPROFILE directly. Point them at the isolated
      // fake home — a clean CI runner has no real ~/.openclaw console, and
      // relying on one (as this test implicitly did before) makes the result
      // machine-dependent.
      const fakeHome = process.env.__PD_CONSOLE_TEST_FAKE_HOME ?? '';
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      const mockChild = new EventEmitter() as any;
      mockChild.unref = vi.fn();
      let spawnCalled = false;
      (globalThis as any).__mockSpawn = () => {
        spawnCalled = true;
        process.nextTick(() => {
          mockChild.emit('error', new Error('mock spawn error'));
        });
        return mockChild;
      };

      (globalThis as any).__mockPlanConsoleLaunch = async () => {
        return {
          status: 'reused',
          url: 'http://127.0.0.1:3100',
          port: 3100,
          host: '127.0.0.1',
          reused: true
        };
      };

      (globalThis as any).__mockProbeConsoleHealth = async () => {
        return {
          healthy: true
        };
      };

      try {
        await handleConsoleOpen({
          workspace: tmp,
          json: false,
        });

        await new Promise(resolve => setTimeout(resolve, 150));

        const loggedOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(spawnCalled).toBe(true);

        expect(loggedOutput).not.toContain('Browser opened');
        expect(loggedOutput).toContain('Open http://127.0.0.1:3100 in your browser');
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedUserProfile;
        exitSpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('Strict port parsing and boundary validation', () => {
    it('rejects partial numeric strings like 3100abc', () => {
      const out = runPd(['console', 'open', '--workspace', tmp, '--port', '3100abc', '--json', '--no-browser'], workspaceRoot);
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toMatch(/Invalid --port/);
    });

    it('rejects port 0', () => {
      const out = runPd(['console', 'open', '--workspace', tmp, '--port', '0', '--json', '--no-browser'], workspaceRoot);
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toMatch(/Invalid --port/);
    });
  });

  describe('Non-loopback host checks before workspace resolution', () => {
    it('refuses non-loopback hosts even when workspace is missing', () => {
      const previous = process.env.PD_WORKSPACE_DIR;
      delete process.env.PD_WORKSPACE_DIR;
      try {
        const out = runPd(['console', 'open', '--host', '192.168.1.100', '--json', '--no-browser'], workspaceRoot);
        const parsed = JSON.parse(out);
        expect(parsed.status).toBe('refused');
        expect(parsed.reason).toMatch(/non-loopback/i);
        expect(parsed.workspaceDir).toBe('');
      } finally {
        if (previous !== undefined) process.env.PD_WORKSPACE_DIR = previous;
      }
    });

    it('[::1] is accepted and normalized to ::1 (not refused)', async (ctx) => {
      // PRI-581 / ERR-111: IPv6 loopback is an optional host capability — a
      // global TUN VPN / WFP filter driver can silently block ::1 connections
      // (bind succeeds, connect returns EACCES) while the IPv6 stack itself is
      // healthy. Probe-and-skip instead of hard-failing for 8s on such hosts.
      if (!(await isIpv6LoopbackUsable())) {
        ctx.skip({ reason: 'IPv6 loopback (::1) is filtered on this machine (VPN/WFP filter driver? — see ERR-111 / PRI-581)' });
        return;
      }
      // May spawn a long-lived server, use timeout.
      const out = runPd(['console', 'open', '--workspace', tmp, '--host', '[::1]', '--json', '--no-browser'], workspaceRoot, 8_000);
      if (out.trim() === '') {
        // The CLI was still in its 15s ready-poll when execFileSync timed out.
        // The capability probe above passed, so this is a genuine failure —
        // the health probe on ::1 never succeeded despite ::1 being reachable.
        throw new Error('CLI produced no JSON within 8s — ::1 health probe never succeeded (IPv6 loopback probe passed; this is a real failure)');
      }
      const parsed = JSON.parse(out);
      // Should NOT be refused — [::1] is loopback
      expect(parsed.status).not.toBe('refused');
      // Host should be normalized to ::1 (without brackets)
      expect(parsed.host).toBe('::1');
    }, 10_000);
  });

  describe('EP-06 regression guard: dist/web/index.html check (PR #1169)', () => {
    it('returns console_web_ui_missing when dist/web/index.html does not exist', () => {
      // beforeEach creates the fake console dir WITH dist/web/index.html.
      // Remove it to simulate a corrupted install (the PR #1169 regression).
      const fakeHome = process.env.__PD_CONSOLE_TEST_FAKE_HOME ?? '';
      const webIndex = path.join(fakeHome, '.openclaw', 'extensions', 'principles-disciple', 'console', 'dist', 'web', 'index.html');
      fs.rmSync(webIndex, { force: true });

      const out = runPd(['console', 'open', '--workspace', tmp, '--json', '--no-browser'], workspaceRoot, 5_000);
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toBe('console_web_ui_missing');
      expect(parsed.nextAction).toMatch(/create-principles-disciple/);
    }, 10_000);
  });
});

/**
 * Probe whether IPv6 loopback (::1) is actually usable on this machine.
 * Mirrors the production path (TCP connect), not ICMP ping: on hosts where a
 * VPN/WFP filter driver intercepts ::1 (bind OK + connect EACCES — ERR-111 /
 * PRI-581), the console health probe on ::1 can never succeed, so the CLI
 * test above must skip rather than hard-fail for environmental reasons.
 */
function isIpv6LoopbackUsable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1_500);
    server.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    server.listen(0, '::1', () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === 'object' ? addr.port : 0;
      if (port === 0) {
        clearTimeout(timer);
        finish(false);
        return;
      }
      const socket = net.connect({ port, host: '::1' }, () => {
        socket.destroy();
        clearTimeout(timer);
        finish(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  });
}

function runPd(args: string[], cwd: string, timeoutMs?: number): string {
  try {
    return execFileSync('node', [getBuiltPdCliPath(), ...args], {
      encoding: 'utf8',
      cwd,
      env: buildChildEnv(),
      timeout: timeoutMs,
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

/** Env for spawned CLI processes: isolated fake HOME, no workspace env leaks. */
function buildChildEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const fakeHome = process.env.__PD_CONSOLE_TEST_FAKE_HOME;
  if (fakeHome) {
    env.USERPROFILE = fakeHome;
    env.HOME = fakeHome;
    delete env.HOMEPATH;
    delete env.HOMEDRIVE;
    delete env.PD_WORKSPACE_DIR;
  }
  return env;
}

/** Runtime type guard for unknown CLI JSON output (rc-1/rc-2). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ─── Async CLI runner with guaranteed teardown (PRI-526 tests) ───────────────

interface CliJsonRun {
  parsed: unknown;
  child: childProcessModule.ChildProcess;
}

/**
 * Spawn the CLI and resolve as soon as stdout contains one parseable JSON
 * object. Fails fast (bounded timeout / early exit) with the collected
 * stdout in the error message. The caller MUST call teardownCliTree(run)
 * in a finally block — the CLI process may still be alive after the JSON
 * is emitted (fresh-spawn mode keeps the console server attached).
 */
async function runPdUntilJson(args: string[], cwd: string, timeoutMs = 12_000): Promise<CliJsonRun> {
  const child = childProcessModule.spawn('node', [getBuiltPdCliPath(), ...args], {
    cwd,
    env: buildChildEnv(),
  });
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });

  const parsed: unknown = await new Promise<unknown>((resolve, reject) => {
    let done = false;
    const fail = (msg: string): void => {
      if (done) return;
      done = true;
      reject(new Error(`${msg}; stdout so far: ${stdout.slice(0, 400)}`));
    };
    const timer = setTimeout(() => fail('timed out waiting for CLI JSON'), timeoutMs);
    const tryParse = (): boolean => {
      const trimmed = stdout.trim();
      if (!trimmed.startsWith('{')) return false;
      try {
        const value = JSON.parse(trimmed) as unknown;
        done = true;
        clearTimeout(timer);
        resolve(value);
        return true;
      } catch {
        return false; // partial pretty-printed JSON — wait for more chunks
      }
    };
    if (tryParse()) return;
    const onData = (): void => {
      if (tryParse()) child.stdout?.off('data', onData);
    };
    child.stdout?.on('data', onData);
    child.on('error', (err: Error) => fail(`CLI spawn error: ${err.message}`));
    child.on('exit', (code: number | null) => fail(`CLI exited with code ${code} before emitting JSON`));
  });

  return { parsed, child };
}

/**
 * Deterministic teardown of a runPdUntilJson run: kill the reported console
 * server PID (grandchild) first so the CLI can exit on its own, then wait a
 * bounded time, then force-kill the whole CLI tree. Safe to call multiple
 * times and with undefined.
 */
async function teardownCliTree(run: CliJsonRun | undefined): Promise<void> {
  if (!run) return;
  const record = isRecord(run.parsed) ? run.parsed : undefined;
  const serverPid = record !== undefined && typeof record.serverPid === 'number' ? record.serverPid : undefined;
  if (serverPid !== undefined) {
    try { process.kill(serverPid); } catch { /* already gone */ }
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { killTreeForce(run.child); resolve(); }, 4_000);
    run.child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  killTreeForce(run.child);
}

/**
 * Last-resort kill of the CLI child process. The console server grandchild is
 * reaped separately via its reported serverPid (see teardownCliTree), so a
 * plain signal kill suffices — no shell/argv command wrapper needed.
 */
function killTreeForce(child: childProcessModule.ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch { /* already gone */ }
}

import { checkConsoleRuntimeDependencies } from '../../src/commands/console.js';

describe('checkConsoleRuntimeDependencies', () => {
  it('returns undefined when all deps are intact', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-integ-'));
    try {
      // @principles/core: entry is dist/principle-tree-ledger/index.js
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger', 'index.js'), '');
      // @principles/host-runtime: entry is dist/index.js
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'dist', 'index.js'), '');
      // @principles/install-layout: entry is dist/index.js
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js'), '');
      // principles-disciple: entry is dist/governance-audit.js
      fs.mkdirSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist', 'governance-audit.js'), '');

      expect(checkConsoleRuntimeDependencies(tmp)).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns error when a dep is missing package.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-integ-'));
    try {
      // Create all deps intact except host-runtime (no package.json)
      // core
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger', 'index.js'), '');
      // install-layout
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js'), '');
      // principles-disciple
      fs.mkdirSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist', 'governance-audit.js'), '');
      // @principles/host-runtime without package.json — the broken-shell case
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'dist', 'index.js'), '');

      const err = checkConsoleRuntimeDependencies(tmp);
      expect(err).toContain('host-runtime');
      expect(err).toContain('package.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns error when a dep has package.json but no dist entry (empty shell)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-integ-'));
    try {
      // core intact
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger', 'index.js'), '');
      // install-layout intact
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js'), '');
      // principles-disciple intact
      fs.mkdirSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist', 'governance-audit.js'), '');
      // host-runtime exists but has no dist/index.js (root entry missing)
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime'));
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'host-runtime', 'package.json'), '{}');

      const err = checkConsoleRuntimeDependencies(tmp);
      expect(err).toContain('host-runtime');
      expect(err).toContain('dist/index.js');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns error when a dep junction is dangling (directory missing)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-integ-'));
    try {
      // Create core, install-layout, principles-disciple; leave host-runtime missing
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'core', 'dist', 'principle-tree-ledger', 'index.js'), '');
      fs.mkdirSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js'), '');
      fs.mkdirSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'node_modules', 'principles-disciple', 'dist', 'governance-audit.js'), '');

      const err = checkConsoleRuntimeDependencies(tmp);
      expect(err).toContain('host-runtime');
      expect(err).toContain('package.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
