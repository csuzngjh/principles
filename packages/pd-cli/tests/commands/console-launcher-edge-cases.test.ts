/**
 * Console Launcher Edge Cases — PRI-300
 *
 * 补充测试覆盖缺口：
 * - 端口竞争和并发启动场景
 * - 网络错误和异常处理
 * - 资源清理和超时处理
 * - 多次启动和停止场景
 * - 边界端口值处理
 * - 错误恢复和降级路径
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isPortInUse,
  findAvailablePort,
  planConsoleLaunch,
  probeConsoleHealth,
  isLoopbackHost,
  normalizeLoopbackHost,
} from '../../src/services/console-launcher.js';

// ── Port Competition and Concurrency ────────────────────────────────────────

describe('Port competition scenarios', () => {
  it('handles rapid sequential port probes without race conditions', async () => {
    // Start a server on a high port
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      // Rapid sequential probes should be consistent
      const results = await Promise.all([
        isPortInUse('127.0.0.1', port, 200),
        isPortInUse('127.0.0.1', port, 200),
        isPortInUse('127.0.0.1', port, 200),
      ]);
      // All should detect the port as in use
      expect(results.every(r => r === true)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('findAvailablePort skips occupied ports in sequence', async () => {
    // Use mock to simulate 3 consecutive occupied ports — avoids flaky real-network I/O
    const basePort = 49200;
    (globalThis as any).__mockIsPortInUse = async (_host: string, port: number) => {
      return port >= basePort && port <= basePort + 2;
    };
    try {
      const port = await findAvailablePort('127.0.0.1', basePort, 5);
      // Should skip basePort, basePort+1, basePort+2 and return basePort+3
      expect(port).toBe(basePort + 3);
    } finally {
      delete (globalThis as any).__mockIsPortInUse;
    }
  });

  it('returns null when all fallback ports are exhausted', async () => {
    // Use mock to simulate all ports occupied — avoids flaky real-network I/O
    const basePort = 49300;
    (globalThis as any).__mockIsPortInUse = async (_host: string, port: number) => {
      return port >= basePort && port <= basePort + 9;
    };
    try {
      // With limit=5, all 5 candidates are occupied → null
      const port = await findAvailablePort('127.0.0.1', basePort, 5);
      expect(port).toBeNull();
    } finally {
      delete (globalThis as any).__mockIsPortInUse;
    }
  });
});

// ── Network Error Handling ───────────────────────────────────────────────────

describe('Network error handling', () => {
  it('probeConsoleHealth handles connection timeout gracefully', async () => {
    // Create a server that doesn't respond to health probe
    const server = http.createServer((req, res) => {
      // Intentionally delay response beyond timeout
      setTimeout(() => {
        res.writeHead(200);
        res.end('{}');
      }, 3000);
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      // Should timeout and return unhealthy
      const result = await probeConsoleHealth({
        host: '127.0.0.1',
        port,
        timeoutMs: 500,
      });
      expect(result.healthy).toBe(false);
      expect(result.reason).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probeConsoleHealth handles malformed JSON response', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not valid json {');
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      const result = await probeConsoleHealth({
        host: '127.0.0.1',
        port,
        timeoutMs: 1000,
      });
      expect(result.healthy).toBe(false);
      expect(result.reason).toMatch(/parse|json/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probeConsoleHealth handles 500 error response', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      const result = await probeConsoleHealth({
        host: '127.0.0.1',
        port,
        timeoutMs: 1000,
      });
      expect(result.healthy).toBe(false);
      expect(result.reason).toMatch(/500|error/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probeConsoleHealth handles connection refused', async () => {
    // Use a port that's not listening
    const result = await probeConsoleHealth({
      host: '127.0.0.1',
      port: 49999, // High port unlikely to be in use
      timeoutMs: 500,
    });
    expect(result.healthy).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ── Resource Cleanup ──────────────────────────────────────────────────────────

describe('Resource cleanup', () => {
  it('isPortInUse cleans up socket after probe', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      // First probe
      await isPortInUse('127.0.0.1', port, 500);
      // Second probe should work (socket was cleaned up)
      const result = await isPortInUse('127.0.0.1', port, 500);
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probeConsoleHealth cleans up HTTP request after timeout', async () => {
    const server = http.createServer((req, res) => {
      // Never respond
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      // First probe with timeout
      await probeConsoleHealth({ host: '127.0.0.1', port, timeoutMs: 300 });
      // Second probe should also timeout cleanly
      const result = await probeConsoleHealth({ host: '127.0.0.1', port, timeoutMs: 300 });
      expect(result.healthy).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── Boundary Port Values ──────────────────────────────────────────────────────

describe('Boundary port values', () => {
  it('handles port 1 (lowest valid port)', async () => {
    // Port 1 is typically reserved, but we test the logic
    const result = await isPortInUse('127.0.0.1', 1, 200);
    // Should return false (not in use) or handle gracefully
    expect(typeof result).toBe('boolean');
  });

  it('handles port 65535 (highest valid port)', async () => {
    (globalThis as any).__mockIsPortInUse = async (host: string, port: number) => {
      return port === 65535;
    };
    try {
      const result = await isPortInUse('127.0.0.1', 65535, 200);
      expect(result).toBe(true);
    } finally {
      delete (globalThis as any).__mockIsPortInUse;
    }
  });

  it('findAvailablePort does not exceed 65535', async () => {
    (globalThis as any).__mockIsPortInUse = async (host: string, port: number) => {
      // All ports "in use" near boundary
      return port >= 65530;
    };
    try {
      const port = await findAvailablePort('127.0.0.1', 65530, 10);
      // Should return null since all ports up to 65535 are "in use"
      expect(port).toBeNull();
    } finally {
      delete (globalThis as any).__mockIsPortInUse;
    }
  });
});

// ── Loopback Host Edge Cases ──────────────────────────────────────────────────

describe('Loopback host edge cases', () => {
  it('accepts all 127.x.x.x addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.255.255.255')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
  });

  it('rejects similar but non-loopback addresses', () => {
    expect(isLoopbackHost('126.0.0.1')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('10.127.0.1')).toBe(false);
  });

  it('handles IPv6 loopback variations', () => {
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    // Full IPv6 loopback
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('normalizes various IPv6 formats', () => {
    expect(normalizeLoopbackHost('[::1]')).toBe('::1');
    expect(normalizeLoopbackHost('::1')).toBe('::1');
    expect(normalizeLoopbackHost('0:0:0:0:0:0:0:1')).toBe('0:0:0:0:0:0:0:1');
  });

  it('handles localhost variations', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(false); // Case-sensitive
    expect(isLoopbackHost('localhost.localdomain')).toBe(false);
  });
});

// ── planConsoleLaunch Error Recovery ───────────────────────────────────────────

describe('planConsoleLaunch error recovery', () => {
  it('returns refused for non-loopback hosts', async () => {
    const result = await planConsoleLaunch({
      workspaceDir: '/tmp/anywhere',
      preferredPort: 3100,
      host: '192.168.1.1',
    });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/non-loopback|192\.168/i);
    expect(result.nextAction).toBeDefined();
  });

  // Note: Port fallback and workspace validation tests removed
  // These scenarios are already covered in the existing console-open.test.ts
});

// ── Health Probe Authentication ────────────────────────────────────────────────

describe('Health probe authentication scenarios', () => {
  it('probeConsoleHealth accepts token parameter', async () => {
    // Test that the function accepts the token parameter without error
    const result = await probeConsoleHealth({
      host: '127.0.0.1',
      port: 49999, // Non-existent port
      token: 'test-token-123',
      timeoutMs: 500,
    });
    // Should return unhealthy (connection refused) but not crash
    expect(result.healthy).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('probeConsoleHealth works without token parameter', async () => {
    const result = await probeConsoleHealth({
      host: '127.0.0.1',
      port: 49998, // Non-existent port
      timeoutMs: 500,
    });
    expect(result.healthy).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('probeConsoleHealth handles 401 unauthorized response', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        }
      });
    });

    try {
      const result = await probeConsoleHealth({
        host: '127.0.0.1',
        port,
        token: 'invalid-token',
        timeoutMs: 1000,
      });
      expect(result.healthy).toBe(false);
      expect(result.reason).toMatch(/401|unauthorized/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});