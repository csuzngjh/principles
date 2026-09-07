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
export type ConsoleAuthenticationMode = 'authenticated' | 'no_auth';

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
  /** Verified for successful launch/reuse; omitted when no server was reached. */
  authenticationMode?: ConsoleAuthenticationMode;
  /**
   * PID of the freshly spawned console server process. Present only when
   * status === 'started'; absent on 'reused' (the server was started by
   * another process, so this launcher cannot know its PID).
   */
  serverPid?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Loopback safety (ERR-049) ──────────────────────────────────────────────

/** Returns true if the host resolves to a loopback address. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0:0:0:0:0:0:0:1' || host === '[0:0:0:0:0:0:0:1]') return true;
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
export interface ConsoleHealthProbeResult {
  healthy: boolean;
  authenticationMode?: ConsoleAuthenticationMode;
  reason?: string;
  failureKind?: 'unauthorized' | 'invalid_response' | 'unreachable';
}

export async function probeConsoleHealth(opts: HealthProbeOptions): Promise<ConsoleHealthProbeResult> {
  const { host, port, timeoutMs = 1500, token } = opts;

  if (Object.hasOwn(globalThis, '__mockProbeConsoleHealth')) {
    const mock = Reflect.get(globalThis, '__mockProbeConsoleHealth') as (
      o: HealthProbeOptions
    ) => Promise<ConsoleHealthProbeResult>;
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
          resolve({ healthy: false, failureKind: 'unauthorized', reason: 'console health endpoint returned 401 (unauthorized) — check PD_CONSOLE_TOKEN' });
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
            const body: unknown = JSON.parse(data);
            if (isRecord(body)) {
              const isHealthy =
                (Object.hasOwn(body, 'healthy') && Reflect.get(body, 'healthy') === true) ||
                (Object.hasOwn(body, 'success') && Reflect.get(body, 'success') === true);
              if (isHealthy) {
                const dataValue = Object.hasOwn(body, 'data') ? Reflect.get(body, 'data') : undefined;
                const payloadRecord = isRecord(dataValue) ? dataValue : body;
                const mode = Reflect.get(payloadRecord, 'authenticationMode');
                resolve({
                  healthy: true,
                  ...(mode === 'authenticated' || mode === 'no_auth' ? { authenticationMode: mode } : {}),
                });
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
 * Validate a browser URL before it is handed to a system opener.
 * Only http/https targets are allowed — other schemes (file:, javascript:,
 * custom protocols) could be abused. This is the primary defense for the
 * win32 opener path, which no longer routes through a shell.
 */
function assertSafeBrowserUrl(rawUrl: string): string {
  if (!rawUrl || rawUrl.trim().length === 0) {
    throw new Error('browser URL is empty');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid browser URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid browser URL: protocol must be http(s), got "${url.protocol}"`);
  }
  return url.toString();
}

/**
 * Open the system browser. Best-effort — failures are reported but do not
 * crash the launcher.
 *
 * Security: the URL is validated (http/https only) and every opener is
 * invoked with a parameterized `spawn` (no shell). In particular the win32
 * path uses `explorer.exe` with an argument array instead of the previous
 * `cmd.exe /c start "" <url>` form, which ran the URL through the cmd shell
 * and allowed shell metacharacters in the URL to be interpreted as commands
 * (command injection).
 */
export async function openBrowser(rawUrl: string): Promise<{ opened: boolean; reason?: string; nextAction?: string }> {
  const { spawn } = await import('child_process');
  const { platform } = process;

  let url: string;
  try {
    url = assertSafeBrowserUrl(rawUrl);
  } catch (err) {
    return {
      opened: false,
      reason: err instanceof Error ? err.message : String(err),
      nextAction: 'Use an http:// or https:// URL.',
    };
  }

  let cmd: string;
  let args: string[];

  if (platform === 'win32') {
    // Parameterized spawn (no shell): explorer.exe receives the validated
    // URL as a plain argument and opens it in the default browser.
    cmd = 'explorer.exe';
    args = [url];
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
      
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (result: { opened: boolean; reason?: string; nextAction?: string }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      timer = setTimeout(() => {
        child.unref();
        done({ opened: true });
      }, 1500);

      child.on('error', (err) => {
        done({
          opened: false,
          reason: `Failed to spawn browser process: ${err.message}`,
          nextAction: `Ensure your system has '${cmd}' available in PATH or open the URL manually.`
        });
      });

      child.on('close', (code) => {
        if (code === 0) {
          done({ opened: true });
        } else {
          done({
            opened: false,
            reason: `Browser command exited with code ${code}`,
            nextAction: `Open the URL manually: ${url}`
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
    if (token && health.authenticationMode !== 'authenticated') {
      // PRI-695: a token-bearing caller must not land on a no_auth server
      // (governance writes would be unauthenticated). The refusal stays, but
      // the guidance must tell the user WHAT is running and the two ways out —
      // the old text referenced "Companion", which a CLI-only user has never
      // configured.
      return {
        status: 'refused',
        url: '',
        port: preferredPort,
        host,
        reused: false,
        reason: 'console_authentication_mode_mismatch',
        nextAction:
          `A Console without authentication is already running on port ${preferredPort} ` +
          '(the post-install default). Reopen without a token to reuse it, or stop that ' +
          'Console and start with --token for authenticated access.',
      };
    }
    return {
      status: 'reused',
      url: buildConsoleUrl(host, preferredPort),
      port: preferredPort,
      host,
      reused: true,
    };
  }

  if (token && health.failureKind === 'unauthorized') {
    return {
      status: 'refused',
      url: '',
      port: preferredPort,
      host,
      reused: false,
      reason: 'console_authentication_failed',
      nextAction: 'Verify PD_CONSOLE_TOKEN matches the running Console, stop that Console, then retry.',
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
