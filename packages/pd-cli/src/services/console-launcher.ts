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

/**
 * Normalize loopback host for safe use in listen/http.request.
 * - [::1] → ::1 (strip brackets; Node net/http don't want brackets in host field)
 * - localhost, 127.x.x.x, ::1 → pass through
 * - non-loopback → return as-is (caller must reject via isLoopbackHost first)
 */
export function normalizeLoopbackHost(host: string): string {
  if (host === '[::1]') return '::1';
  return host;
}

/**
 * Build a valid Console URL from a normalized loopback host and port.
 * - IPv6 ::1 → http://[::1]:port (brackets required for valid URL)
 * - IPv4/localhost → http://host:port (unchanged)
 */
export function buildConsoleUrl(host: string, port: number): string {
  if (host === '::1') return `http://[::1]:${port}`;
  return `http://${host}:${port}`;
}

// ─── Port detection (ERR-022: bounded) ───────────────────────────────────────

/** Returns true if the port on the given host accepts a TCP connection. */
export async function isPortInUse(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  if (Object.hasOwn(globalThis, '__mockIsPortInUse')) {
    const mock = Reflect.get(globalThis, '__mockIsPortInUse') as (
      h: string,
      p: number,
      t?: number
    ) => Promise<boolean>;
    return mock(host, port, timeoutMs);
  }
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

export interface HealthProbeOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Optional auth token (PD_CONSOLE_TOKEN) for authenticated health probes. */
  token?: string;
}

/** Probe a port to see if it serves a healthy PD Console. */
export async function probeConsoleHealth(opts: HealthProbeOptions): Promise<{ healthy: boolean; reason?: string }> {
  const { host, port, timeoutMs = 1500, token } = opts;

  if (Object.hasOwn(globalThis, '__mockProbeConsoleHealth')) {
    const mock = Reflect.get(globalThis, '__mockProbeConsoleHealth') as (
      o: HealthProbeOptions
    ) => Promise<{ healthy: boolean; reason?: string }>;
    return mock(opts);
  }
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = http.request(
      { host, port, path: '/api/health', method: 'GET', timeout: timeoutMs, headers },
      (res) => {
        // 401 means auth required — treat as unhealthy, not a generic error
        if (res.statusCode === 401) {
          resolve({ healthy: false, reason: 'console health endpoint returned 401 (unauthorized) — check PD_CONSOLE_TOKEN' });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ healthy: false, reason: `console health endpoint returned status ${res.statusCode ?? 'no-status'}` });
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(data) as unknown;
            if (body && typeof body === 'object') {
              const isHealthy =
                (Object.hasOwn(body, 'healthy') && Reflect.get(body, 'healthy') === true) ||
                (Object.hasOwn(body, 'success') && Reflect.get(body, 'success') === true);
              if (isHealthy) {
                resolve({ healthy: true });
              } else {
                resolve({ healthy: false, reason: 'console health JSON was missing healthy/success markers' });
              }
            } else {
              resolve({ healthy: false, reason: 'console health endpoint returned non-object JSON' });
            }
          } catch (err) {
            resolve({ healthy: false, reason: `failed to parse console health JSON: ${err instanceof Error ? err.message : String(err)}` });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, reason: 'console health probe timed out' });
    });
    req.on('error', (err: Error) => {
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
  for (let i = 0; i < limit; i++) {
    const candidate = preferred + i;
    if (candidate > 65535 || candidate < 1) {
      break;
    }
    if (!(await isPortInUse(host, candidate))) return candidate;
  }
  return null;
}

// ─── Browser opener (best-effort, no throw) ──────────────────────────────────

/**
 * Open the system browser. Best-effort — failures are reported but do not
 * crash the launcher.
 */
export async function openBrowser(url: string): Promise<{ opened: boolean; reason?: string; nextAction?: string }> {
  const { spawn } = await import('child_process');
  const { platform } = process;

  let cmd: string;
  let args: string[];

  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.unref();
          resolve({ opened: true });
        }
      }, 100);

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({
            opened: false,
            reason: `Failed to spawn browser process: ${err.message}`,
            nextAction: `Ensure your system has '${cmd}' available in PATH or open the URL manually.`
          });
        }
      });
    } catch (err) {
      resolve({
        opened: false,
        reason: err instanceof Error ? err.message : String(err),
        nextAction: 'Ensure child_process is available or open the URL manually.'
      });
    }
  });
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
  /** Optional auth token for health probes (PD_CONSOLE_TOKEN). */
  token?: string;
}

export async function planConsoleLaunch(input: OrchestratorInput): Promise<OrchestratorResult> {
  if (Object.hasOwn(globalThis, '__mockPlanConsoleLaunch')) {
    const mock = Reflect.get(globalThis, '__mockPlanConsoleLaunch') as (
      i: OrchestratorInput
    ) => Promise<OrchestratorResult>;
    return mock(input);
  }
  const { token } = input;
  const rawHost = input.host ?? DEFAULT_HOST;
  const host = normalizeLoopbackHost(rawHost);
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
  const health = await probeConsoleHealth({ host, port: preferredPort, token });
  if (health.healthy) {
    return {
      status: 'reused',
      url: buildConsoleUrl(host, preferredPort),
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
      url: buildConsoleUrl(host, freePort),
      port: freePort,
      host,
      reused: false,
      reason: `Preferred port ${preferredPort} was busy; using ${freePort} instead`,
    };
  }

  // Preferred port is free → bind there.
  return {
    status: 'started',
    url: buildConsoleUrl(host, preferredPort),
    port: preferredPort,
    host,
    reused: false,
  };
}
