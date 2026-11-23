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
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

// ─── Public types ────────────────────────────────────────────────────────────

export type ConsoleStatus = 'reused' | 'started' | 'failed' | 'refused';
/**
 * The Console has no application-level credential any more, so this value is
 * always `no_auth`. It is still reported on the launch result because the
 * already-shipped Companion builds (before the token removal) compare it with
 * their own expectation; omitting it makes them report
 * `console_authentication_mode_mismatch: expected=no_auth, actual=unverified`
 * and refuse to attach. New code must not use it for any decision.
 */
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
  /**
   * Authentication posture reported by the server's `/api/health`, echoed back
   * for older Companion builds. Present for successful launch/reuse.
   */
  authenticationMode?: ConsoleAuthenticationMode;
  /**
   * PID of the freshly spawned console server process. Present only when
   * status === 'started'; absent on 'reused' (the server was started by
   * another process, so this launcher cannot know its PID).
   */
  serverPid?: number;
  /**
   * Set when a stale console process was evicted from the bound port before
   * this launch — surfaced so the user knows a leftover process was replaced.
   */
  replacedStale?: StaleConsoleVerdict;
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

/** Default port and fallback window — the single authority `pd health`'s console scan also derives from. */
export const DEFAULT_PORT = 3100;
const DEFAULT_HOST = '127.0.0.1';
export const PORT_FALLBACK_LIMIT = 20; // try 3100..3119 before giving up

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
}

/**
 * Instance identity a PD console reports on /api/health. Absent on consoles
 * built before the field existed — treat those as opaque (legacy reuse).
 */
export interface ConsoleInstanceInfo {
  pid: number | null;
  serverEntry: string | null;
  webIndexExists: boolean | null;
}

/** Probe a port to see if it serves a healthy PD Console. */
export interface ConsoleHealthProbeResult {
  healthy: boolean;
  authenticationMode?: ConsoleAuthenticationMode;
  instance?: ConsoleInstanceInfo;
  reason?: string;
  failureKind?: 'invalid_response' | 'unreachable';
}

export async function probeConsoleHealth(opts: HealthProbeOptions): Promise<ConsoleHealthProbeResult> {
  const { host, port, timeoutMs = 1500 } = opts;

  if (Object.hasOwn(globalThis, '__mockProbeConsoleHealth')) {
    const mock = Reflect.get(globalThis, '__mockProbeConsoleHealth') as (
      o: HealthProbeOptions
    ) => Promise<ConsoleHealthProbeResult>;
    return mock(opts);
  }
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/api/health', method: 'GET', timeout: timeoutMs },
      (res) => {
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
                const rawInstance = Reflect.get(payloadRecord, 'instance');
                const instance: ConsoleInstanceInfo | undefined = isRecord(rawInstance)
                  ? {
                      pid: typeof rawInstance.pid === 'number' ? rawInstance.pid : null,
                      serverEntry: typeof rawInstance.serverEntry === 'string' ? rawInstance.serverEntry : null,
                      webIndexExists: typeof rawInstance.webIndexExists === 'boolean' ? rawInstance.webIndexExists : null,
                    }
                  : undefined;
                resolve({
                  healthy: true,
                  ...(mode === 'authenticated' || mode === 'no_auth' ? { authenticationMode: mode } : {}),
                  ...(instance !== undefined ? { instance } : {}),
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

// ─── Stale console detection & eviction ──────────────────────────────────────

/**
 * A healthy-answering console process can still be unusable: an orphaned
 * test/dev instance whose files were deleted underneath it (fixture cleanup,
 * interrupted update) serves /api/health from memory but 404s every page —
 * the "Run npm run build:ui first" trap. Reuse must only happen when the
 * responder proves its on-disk deployment is intact.
 */
export type StaleConsoleKind = 'orphaned_entry_removed' | 'web_bundle_missing';
export interface StaleConsoleVerdict {
  kind: StaleConsoleKind;
  pid: number;
  serverEntry: string;
}

/**
 * Entry-path sanity bound for auto-kill: only processes whose reported entry
 * looks like a pd-console server are ever terminated. Dev-mode (tsx
 * src/server/index.ts under packages/pd-console) and installed/legacy
 * layouts (…/console/dist/server.js) both match; a foreign local service
 * that happens to mimic the instance JSON shape does not.
 */
const CONSOLE_SERVER_ENTRY_PATTERN = /(?:pd-console[\\/]|[\\/]console[\\/]dist[\\/]server\.js$)/i;

/**
 * The reported entry is a self-reported string from loopback JSON — before it
 * is passed to fs calls it must be a local absolute path. A UNC or scheme
 * path (`\\host\share`, `//host/share`, `file://…`) would let a local service
 * trigger outbound SMB access and implicit network authentication on Windows
 * (CWE-73); a relative path is unverifiable and equally refused.
 */
function isLocalAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || (p.startsWith('/') && !p.startsWith('//'));
}

export function classifyStaleConsoleInstance(
  instance: ConsoleInstanceInfo | undefined,
  ownPid: number = process.pid,
): StaleConsoleVerdict | null {
  if (instance === undefined) return null;
  const { pid } = instance;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === ownPid) return null;
  const entry = typeof instance.serverEntry === 'string' && instance.serverEntry.length > 0
    ? instance.serverEntry
    : null;
  if (entry === null || !CONSOLE_SERVER_ENTRY_PATTERN.test(entry) || !isLocalAbsolutePath(entry)) return null;
  if (!fs.existsSync(entry)) {
    return { kind: 'orphaned_entry_removed', pid, serverEntry: entry };
  }
  if (instance.webIndexExists === false) {
    return { kind: 'web_bundle_missing', pid, serverEntry: entry };
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * PowerShell 5.1 emits OEM-codepage output by default (cp936 on zh-CN hosts),
 * which would mangle non-ASCII install paths before comparison. Follow the
 * uninstaller's convention (create-principles-disciple/src/uninstaller.ts):
 * pin the pipeline to UTF-8 and pass the script via -EncodedCommand
 * (UTF-16LE base64) so embedded quotes survive argv handling.
 */
function runEncodedPowerShell(scriptBody: string): Promise<string | null> {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${scriptBody}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    childProcess.execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 5000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * Tokenize a concatenated command-line string the way Windows / `ps` hand it
 * to us — quoted segments keep their inner spaces, everything else splits on
 * whitespace. Only used where raw argv is unavailable (win32 CIM, macOS ps).
 */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  for (const m of commandLine.matchAll(/"([^"]+)"|'([^']+)'/g)) tokens.push(m[1] ?? m[2] ?? '');
  for (const t of commandLine.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/)) {
    if (t.length > 0) tokens.push(t);
  }
  return tokens;
}

export interface ProcessIdentity {
  /** Raw argv elements when the OS preserves boundaries, else tokenized. */
  argv: string[];
  /** Live process cwd — lets a relative entry arg be resolved to an absolute
   * path instead of trusted as a loose suffix. null when the OS cannot tell us. */
  cwd: string | null;
}

/**
 * Read the live argv + cwd of a process we might evict. The `instance` block
 * is self-reported over loopback HTTP — before signaling `pid` we must prove
 * it is the console process it claims to be, not an arbitrary victim pid a
 * crafted responder named (verifyNonce covers installer children; this covers
 * every other leftover). Linux reads `/proc/<pid>/cmdline` (NUL-separated, so
 * spaces in install paths keep their argument boundaries) and
 * `/proc/<pid>/cwd`; win32/macOS fall back to a tokenized command line.
 * Returns null when identity cannot be obtained — callers must treat that as
 * unverified and refuse to kill.
 */
async function getProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (Object.hasOwn(globalThis, '__mockGetProcessIdentity')) {
    const mock = Reflect.get(globalThis, '__mockGetProcessIdentity') as (
      p: number
    ) => Promise<ProcessIdentity | null>;
    return mock(pid);
  }
  if (process.platform === 'win32') {
    const out = await runEncodedPowerShell(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    );
    if (out === null) return null;
    const trimmed = out.trim();
    return trimmed.length > 0 ? { argv: tokenizeCommandLine(trimmed), cwd: null } : null;
  }
  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`);
      const argv = raw.toString('utf8').split('\0').filter((s) => s.length > 0);
      if (argv.length === 0) return null;
      const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
      return { argv, cwd };
    } catch {
      return null;
    }
  }
  // Other POSIX (macOS): `ps` joins argv into one string and can replace
  // non-ASCII bytes with '?' under LC_ALL=C — best effort, boundaries lost.
  return new Promise((resolve) => {
    childProcess.execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out = stdout.trim();
      resolve(out.length > 0 ? { argv: tokenizeCommandLine(out), cwd: null } : null);
    });
  });
}

/**
 * Does the socket's local address answer connections aimed at `host`?
 * The same PORT can be bound on several addresses (127.0.0.1, ::1, another
 * loopback alias, wildcards) by different processes — matching only the port
 * would let a responder donate a victim listening on a neighbouring address.
 */
export function socketAddrAnswersHost(addr: string, host: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.+$/, '');
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === h) return true;
  if (h === 'localhost') return a === '127.0.0.1' || a === '::1';
  // Wildcards: '0.0.0.0' is IPv4-only; '::' is IPv6 wildcard and — under the
  // default dual-stack binding node uses — also answers IPv4 probes.
  if (a === '0.0.0.0' || a === '*') return !h.includes(':');
  if (a === '::' || a === '0:0:0:0:0:0:0:0' || a === '::ffff:0.0.0.0') return true;
  return false;
}

/** Parse `ss -ltnpH 'sport = :PORT'` output → pids whose listener answers `host`. */
export function parseSsListenOwners(ssOut: string, port: number, host: string): number[] {
  const pids: number[] = [];
  for (const line of ssOut.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // LISTEN <RecvQ> <SendQ> <LocalAddr:Port> <PeerAddr:Port> users:(...)
    const [, , , local] = fields;
    if (fields.length < 6 || fields[0] !== 'LISTEN' || local === undefined) continue;
    const sep = local.lastIndexOf(':');
    if (sep < 0 || Number(local.slice(sep + 1)) !== port) continue;
    if (!socketAddrAnswersHost(local.slice(0, sep), host)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
  }
  return [...new Set(pids)];
}

/** Parse `lsof -nP -iTCP:PORT -sTCP:LISTEN` output → pids whose listener answers `host`. */
export function parseLsofListenOwners(lsofOut: string, port: number, host: string): number[] {
  const pids: number[] = [];
  for (const line of lsofOut.split(/\r?\n/)) {
    const m = /^\S+\s+(\d+)\s+.*?\sTCP\s+(\S+):(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (Number(m[3]) !== port) continue;
    if (!socketAddrAnswersHost(m[2], host)) continue;
    pids.push(Number(m[1]));
  }
  return [...new Set(pids)];
}

/** Parse `Get-NetTCPConnection | Select LocalAddress,OwningProcess | ConvertTo-Csv` output. */
export function parseNetTcpOwners(csvOut: string, host: string): number[] {
  const pids: number[] = [];
  for (const line of csvOut.split(/\r?\n/)) {
    const m = /^"([^"]*)","?(\d+)"?\s*$/.exec(line) ?? /^([^,"]+),(\d+)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (!socketAddrAnswersHost(m[1], host)) continue;
    pids.push(Number(m[2]));
  }
  return [...new Set(pids)];
}

/**
 * Pids owning a LISTEN socket that answers on `host:port`. Verification, not
 * convenience: the reported pid must own the socket it answered on — matching
 * only the port would let a responder donate a victim bound on a different
 * local address of the same port (CWE-863). null = the OS did not tell us
 * (tool missing/failed) — refuse to kill.
 */
async function getListenPortOwnerPids(port: number, host: string): Promise<number[] | null> {
  if (Object.hasOwn(globalThis, '__mockGetListenPortOwnerPids')) {
    const mock = Reflect.get(globalThis, '__mockGetListenPortOwnerPids') as (
      p: number, h: string
    ) => Promise<number[] | null>;
    return mock(port, host);
  }
  if (process.platform === 'win32') {
    const out = await runEncodedPowerShell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess | ConvertTo-Csv -NoTypeInformation`,
    );
    if (out === null) return null;
    return parseNetTcpOwners(out, host);
  }
  const runQuery = (cmd: string, args: string[]): Promise<string | null> => new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout));
  });
  const ssOut = await runQuery('ss', ['-ltnpH', `sport = :${port}`]);
  if (ssOut !== null) {
    const pids = parseSsListenOwners(ssOut, port, host);
    if (pids.length > 0) return pids;
    // ss ran but showed no owners for this address — port free or owned by
    // another user; fall through to lsof before deciding "unverifiable".
  }
  const lsofOut = await runQuery('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (lsofOut !== null) {
    return parseLsofListenOwners(lsofOut, port, host);
  }
  return null;
}

const normalizeEntryPath = (s: string): string => {
  let p = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  p = p.normalize('NFC');
  // Case-fold only when the path is Windows-shaped (drive letter; UNC entries
  // never reach matching — the classifier refuses them before existence
  // checks). POSIX filesystems are case-sensitive.
  if (/^[a-z]:\//i.test(p)) p = p.toLowerCase();
  return p;
};

/**
 * Does the live argv prove `pid` actually runs `serverEntry`?
 * A path-bearing argv element must EQUAL the reported entry after
 * normalization. `npm run dev`-style launches keep a RELATIVE script arg
 * (`src/server/index.ts`) while health reports the absolute argv[1] — when
 * the process cwd is known (Linux `/proc/<pid>/cwd`) the arg is resolved to
 * an absolute path and compared exactly. Only when the OS cannot report the
 * cwd do we fall back to accepting the arg as a strict suffix path of the
 * entry — never a bare basename, and always alongside socket ownership.
 */
export function argvMatchesServerEntry(argv: string[], serverEntry: string, cwd: string | null): boolean {
  const nse = normalizeEntryPath(serverEntry);
  const normCwd = cwd === null ? null : normalizeEntryPath(cwd);
  for (const raw of argv) {
    const stripped = raw.replace(/^["']|["']$/g, '');
    const tok = normalizeEntryPath(stripped);
    if (!tok.includes('/')) continue;
    const isAbsolute = tok.startsWith('/') || /^[a-z]:\//i.test(tok);
    if (isAbsolute) {
      if (tok === nse) return true;
      continue;
    }
    if (normCwd !== null) {
      if (path.posix.resolve(normCwd, tok) === nse) return true;
      continue;
    }
    if (nse.endsWith(`/${tok}`)) return true;
  }
  return false;
}

/**
 * Terminate a stale console process and wait for its port to free up.
 * Fails closed: no signal is sent unless BOTH the live argv proves the pid
 * runs the reported entry AND that pid owns the listen socket answering on
 * the probed host:port — self-reported instance JSON alone is never enough
 * to kill on, and a victim bound on a different local address of the same
 * port does not qualify. Returns true only when the port accepts no further
 * connections.
 */
async function evictStaleConsole(host: string, port: number, stale: StaleConsoleVerdict): Promise<boolean> {
  if (!(await isPortInUse(host, port, 300))) return true;
  const [identity, ownerPids] = await Promise.all([
    getProcessIdentity(stale.pid),
    getListenPortOwnerPids(port, host),
  ]);
  if (identity === null || !argvMatchesServerEntry(identity.argv, stale.serverEntry, identity.cwd)) {
    return false;
  }
  if (ownerPids === null || !ownerPids.includes(stale.pid)) {
    return false;
  }
  const waitFree = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!(await isPortInUse(host, port, 300))) return true;
      await sleep(150);
    }
    return !(await isPortInUse(host, port, 300));
  };
  try { process.kill(stale.pid, 'SIGTERM'); } catch { /* already gone or no handle — still wait for the port */ }
  if (await waitFree(3000)) return true;
  try { process.kill(stale.pid, 'SIGKILL'); } catch { /* same reasoning as above */ }
  return waitFree(2000);
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
 * already serves a console. Side effect: when the process answering on the
 * preferred port proves itself a stale PD console (deployment gone/broken)
 * whose live command line confirms the reported entry, this function
 * terminates that process so the port can be rebound — the verdict is
 * reported via `replacedStale`, never silently.
 */
export interface OrchestratorResult {
  status: ConsoleStatus;
  url: string;
  port: number;
  host: string;
  reused: boolean;
  reason?: string;
  nextAction?: string;
  /**
   * Set when a stale console process was evicted from the chosen port before
   * the 'started' verdict — the caller should surface this to the user.
   */
  replacedStale?: StaleConsoleVerdict;
}

export interface OrchestratorInput {
  workspaceDir: string;
  preferredPort?: number;
  host?: string;
}

export async function planConsoleLaunch(input: OrchestratorInput): Promise<OrchestratorResult> {
  if (Object.hasOwn(globalThis, '__mockPlanConsoleLaunch')) {
    const mock = Reflect.get(globalThis, '__mockPlanConsoleLaunch') as (
      i: OrchestratorInput
    ) => Promise<OrchestratorResult>;
    return mock(input);
  }
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
  const health = await probeConsoleHealth({ host, port: preferredPort });
  let staleHolder: StaleConsoleVerdict | null = null;
  if (health.healthy) {
    const stale = classifyStaleConsoleInstance(health.instance);
    if (stale === null) {
      return {
        status: 'reused',
        url: buildConsoleUrl(host, preferredPort),
        port: preferredPort,
        host,
        reused: true,
      };
    }
    // Stale PD console: provably broken deployment (its entry file is gone or
    // its web bundle is missing) — it can only ever serve 404s, so evict it
    // and let the caller bind a healthy console on the preferred port.
    if (await evictStaleConsole(host, preferredPort, stale)) {
      return {
        status: 'started',
        url: buildConsoleUrl(host, preferredPort),
        port: preferredPort,
        host,
        reused: false,
        replacedStale: stale,
        reason: `replaced stale console process pid ${stale.pid} (${stale.kind})`,
      };
    }
    // Eviction failed (identity unverifiable or port refused to free) — the
    // holder must still be named in the outcome, then fall through to the
    // busy-port path rather than reusing a console that can only return 404.
    staleHolder = stale;
  }

  // Step 2: Is the preferred port simply occupied by something else?
  const preferredInUse = await isPortInUse(host, preferredPort);

  if (preferredInUse) {
    const holder = staleHolder;
    const staleNote = holder !== null
      ? `stale console process pid ${holder.pid} (${holder.kind}) holds port ${preferredPort} and resisted automatic termination`
      : null;
    // Try to find a free port in the fallback range.
    const freePort = await findAvailablePort(host, preferredPort + 1, PORT_FALLBACK_LIMIT - 1);
    if (freePort === null) {
      return {
        status: 'failed',
        url: '',
        port: preferredPort,
        host,
        reused: false,
        reason: staleNote !== null
          ? `${staleNote}; no available port in ${preferredPort + 1}..${preferredPort + PORT_FALLBACK_LIMIT}`
          : `No available port in ${preferredPort + 1}..${preferredPort + PORT_FALLBACK_LIMIT}`,
        nextAction: holder !== null
          ? `Stop the stale console manually (kill pid ${holder.pid}) or free a port in the fallback range.`
          : `Stop the process holding port ${preferredPort} (e.g., another Console instance), or free a port in the fallback range.`,
      };
    }
    return {
      status: 'started',
      url: buildConsoleUrl(host, freePort),
      port: freePort,
      host,
      reused: false,
      reason: staleNote !== null
        ? `${staleNote}; using ${freePort} instead`
        : `Preferred port ${preferredPort} was busy; using ${freePort} instead`,
      ...(holder !== null
        ? { nextAction: `Stop the stale console manually (kill pid ${holder.pid}) to reclaim port ${preferredPort}.` }
        : {}),
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
