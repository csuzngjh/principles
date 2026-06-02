/**
 * PD Console Launcher — seed-friendly Console startup with port detection,
 * reuse, and browser opening.
 *
 * PRI-300 MVP UX:
 *   - Default port 3100; auto-falls back to next available if 3100 is busy
 *   - Reuses a running Console if one is already serving on the chosen port
 *   - Refuses non-loopback hosts (ERR-049 loopback safety)
 *   - Opens the system browser on success (skipped under --json)
 *   - Emits `reason` + `nextAction` for every failure
 *
 * Constraints (no daemonization, no public bind, no manual port):
 *   - Does NOT start a background service
 *   - Does NOT bind to non-loopback hosts
 *   - Does NOT require user-configured ports (uses 3100 then 3101..)
 */

import * as net from 'net';
import * as http from 'http';

// ─── Public types ────────────────────────────────────────────────────────────

export type ConsoleStatus = 'reused' | 'started' | 'failed' | 'refused';

export interface ConsoleLaunchResult {
  status: ConsoleStatus;
  url: string;
  port: number;
  host: string;
  workspaceDir: string;
  reason?: string;
  nextAction?: string;
  /** True when an existing console was detected and reused. */
  reused: boolean;
  /** True when a browser should/has been opened (skipped in --json mode). */
  browserOpened: boolean;
}

export interface ConsoleLaunchOptions {
  workspaceDir: string;
  /** Preferred port. Defaults to 3100. */
  preferredPort?: number;
  /** Optional override host. Must be loopback; non-loopback is refused. */
  host?: string;
  /** When true, the launcher does not open the browser. */
  skipBrowser?: boolean;
  /** Timeout in ms to wait for a freshly-spawned console to become ready. */
  readyTimeoutMs?: number;
}

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = '127.0.0.1';
const PORT_FALLBACK_LIMIT = 20; // try 3100..3119 before giving up

// ─── Loopback safety (ERR-049) ──────────────────────────────────────────────

/** Returns true if the host resolves to a loopback address. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  // Reject any IPv4 host that doesn't start with 127.
  if (/^127\./.test(host)) return true;
  return false;
}

// ─── Port detection (ERR-022: bounded) ───────────────────────────────────────

/** Returns true if the port on the given host accepts a TCP connection. */
export async function isPortInUse(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', (err: { code?: string; message?: string }) => {
      // ECONNREFUSED → port is free; EHOSTUNREACH/ENETUNREACH → also free.
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
        done(false);
      } else {
        done(false);
      }
    });
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** Probe a port to see if it serves a healthy PD Console. */
export async function probeConsoleHealth(host: string, port: number, timeoutMs = 1500): Promise<{ healthy: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/api/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        if (!res.statusCode || res.statusCode >= 500) {
          resolve({ healthy: false, reason: `console health endpoint returned ${res.statusCode ?? 'no-status'}` });
          return;
        }
        resolve({ healthy: true });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, reason: 'console health probe timed out' });
    });
    req.on('error', (err) => {
      resolve({ healthy: false, reason: `console health probe error: ${err.message}` });
    });
    req.end();
  });
}

/** Find the first available port in [preferred..preferred+limit]. */
export async function findAvailablePort(
  host: string,
  preferred: number,
  limit = PORT_FALLBACK_LIMIT,
): Promise<number | null> {
  for (let i = 0; i <= limit; i++) {
    const candidate = preferred + i;
    if (!(await isPortInUse(host, candidate))) return candidate;
  }
  return null;
}

// ─── Browser opener (best-effort, no throw) ──────────────────────────────────

/**
 * Open the system browser. Best-effort — failures are reported but do not
 * crash the launcher.
 */
export async function openBrowser(url: string): Promise<{ opened: boolean; reason?: string }> {
  const { spawn } = await import('child_process');
  const { platform } = process;

  try {
    if (platform === 'win32') {
      // Use `cmd /c start` so the process detaches and we don't hang.
      const child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
      child.unref();
      return { opened: true };
    }
    if (platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return { opened: true };
    }
    // Linux / others
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: true };
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Main launcher orchestrator ──────────────────────────────────────────────

/**
 * Orchestrates the seed-friendly Console launch:
 *   1. Validate the host is loopback (refuse otherwise)
 *   2. If a healthy console is already running on the preferred port, reuse it
 *   3. Otherwise find the next available port starting at the preferred one
 *
 * NOTE: This function does NOT spawn the server. The caller (CLI command) is
 * responsible for actually launching the child process; the result returned
 * here tells the caller which port to bind to and whether the existing port
 * already serves a console.
 */
export interface OrchestratorResult {
  status: ConsoleStatus;
  url: string;
  port: number;
  host: string;
  reused: boolean;
  reason?: string;
  nextAction?: string;
}

export interface OrchestratorInput {
  workspaceDir: string;
  preferredPort?: number;
  host?: string;
}

export async function planConsoleLaunch(input: OrchestratorInput): Promise<OrchestratorResult> {
  const host = input.host ?? DEFAULT_HOST;
  const preferredPort = input.preferredPort ?? DEFAULT_PORT;

  if (!isLoopbackHost(host)) {
    return {
      status: 'refused',
      url: '',
      port: preferredPort,
      host,
      reused: false,
      reason: `Non-loopback host refused: '${host}'. Only 127.0.0.1, ::1, and 'localhost' are allowed.`,
      nextAction: 'Use the default loopback host (do not pass --host 0.0.0.0 or any LAN address).',
    };
  }

  // Step 1: Is there already a healthy console on the preferred port?
  const health = await probeConsoleHealth(host, preferredPort);
  if (health.healthy) {
    return {
      status: 'reused',
      url: `http://${host}:${preferredPort}`,
      port: preferredPort,
      host,
      reused: true,
    };
  }

  // Step 2: Is the preferred port simply occupied by something else?
  const preferredInUse = await isPortInUse(host, preferredPort);

  if (preferredInUse) {
    // Try to find a free port in the fallback range.
    const freePort = await findAvailablePort(host, preferredPort + 1, PORT_FALLBACK_LIMIT - 1);
    if (freePort === null) {
      return {
        status: 'failed',
        url: '',
        port: preferredPort,
        host,
        reused: false,
        reason: `No available port in ${preferredPort + 1}..${preferredPort + PORT_FALLBACK_LIMIT}`,
        nextAction: `Stop the process holding port ${preferredPort} (e.g., another Console instance), or free a port in the fallback range.`,
      };
    }
    return {
      status: 'started',
      url: `http://${host}:${freePort}`,
      port: freePort,
      host,
      reused: false,
      reason: `Preferred port ${preferredPort} was busy; using ${freePort} instead`,
    };
  }

  // Preferred port is free → bind there.
  return {
    status: 'started',
    url: `http://${host}:${preferredPort}`,
    port: preferredPort,
    host,
    reused: false,
  };
}
