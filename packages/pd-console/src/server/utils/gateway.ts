/**
 * OpenClaw gateway control utilities for the update flow.
 *
 * Ported from create-principles-disciple/src/utils/env.ts (PRI-230 / commit 6efc0afa).
 * Lives in pd-console so the Web UI update handler can stop/restart the gateway
 * around file mutations without cross-package imports.
 *
 * rc-9: every function returns a structured result instead of throwing.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenClawGatewayStatus {
  isRunning: boolean;
  port?: number;
  pid?: number;
}

export interface GatewayControlResult {
  ok: boolean;
  error?: string;
}

// rc-2: type guard instead of `as` cast on parsed JSON.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Gateway detection
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw config directory.
 * Priority: OPENCLAW_HOME env var > ~/.openclaw
 */
function resolveOpenClawConfigDir(): string {
  const envHome = process.env.OPENCLAW_HOME;
  if (envHome && envHome.trim().length > 0) return path.resolve(envHome);
  return path.join(os.homedir(), '.openclaw');
}

/**
 * Read the gateway port from ~/.openclaw/openclaw.json → { gateway: { port } }.
 * Returns null if the file or field is missing/malformed.
 */
function readOpenClawPort(): number | null {
  const configPath = path.join(resolveOpenClawConfigDir(), 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(raw);
    if (!isRecord(config)) return null;
    const gateway: unknown = config.gateway;
    if (!isRecord(gateway)) return null;
    const port: unknown = gateway.port;
    if (typeof port === 'number' && port > 0 && port < 65536) return port;
  } catch { /* ignore */ }
  return null;
}

function checkPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000;
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Check whether the OpenClaw gateway is currently running.
 * Reads the configured port from openclaw.json, probes 127.0.0.1:<port>,
 * and (best-effort) resolves the owning PID.
 */
export async function checkOpenClawGateway(): Promise<OpenClawGatewayStatus> {
  const port = readOpenClawPort();
  if (!port) return { isRunning: false };

  const listening = await checkPortListening(port);
  if (!listening) return { isRunning: false };

  let pid: number | undefined = undefined;
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (output) {
        const [firstLine] = output.split('\n');
        if (firstLine) pid = parseInt(firstLine.trim(), 10);
      }
    } else {
      const output = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (output) {
        const [firstLine] = output.split('\n');
        if (firstLine) pid = parseInt(firstLine.trim(), 10);
      }
    }
  } catch { /* ignore */ }

  return { isRunning: true, port, pid };
}

// ---------------------------------------------------------------------------
// Gateway stop / restart
// ---------------------------------------------------------------------------

/**
 * Run `openclaw gateway <subcommand>` (service-level: launchd/systemd/schtasks).
 * rc-9: never throws — returns {ok:false, error} so the caller can degrade
 * with a structured reason + nextAction instead of crashing mid-update.
 */
function runGatewayServiceCommand(subcommand: 'stop' | 'start'): GatewayControlResult {
  try {
    execSync(`openclaw gateway ${subcommand}`, { stdio: 'pipe', encoding: 'utf-8', timeout: 15000 });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `\`openclaw gateway ${subcommand}\` failed: ${msg}` };
  }
}

/**
 * Stop the OpenClaw gateway service. Call before mutating the plugin ext dir
 * to release file locks held on native modules (EPERM on backup copyfile).
 */
export function stopOpenClawGateway(): GatewayControlResult {
  return runGatewayServiceCommand('stop');
}

/**
 * Start the OpenClaw gateway service (inverse of stopOpenClawGateway).
 * Called after update completes (success or failure) to leave the gateway running.
 */
export function restartOpenClawGateway(): GatewayControlResult {
  return runGatewayServiceCommand('start');
}
