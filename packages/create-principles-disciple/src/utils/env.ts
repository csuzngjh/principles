/**
 * 环境检测工具
 * PRI-569 round: process spawning converted to array-form execFileSync —
 * no shell, no interpolated command strings (Mimosa hardening).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

export interface EnvCheckResult {
  hasOpenClaw: boolean;
  openclawVersion?: string;
  hasNode: boolean;
  nodeVersion?: string;
  hasPython: boolean;
  pythonVersion?: string;
  hasGit: boolean;
}

export interface WorkspaceInfo {
  detectedPath: string;
  exists: boolean;
  hasPrinciples: boolean;
  isFirstInstall: boolean;  // 是否首次安装
  coreFiles: string[];      // 已存在的核心文件列表
}

/**
 * 检测运行环境
 */
export function checkEnvironment(): EnvCheckResult {
  const result: EnvCheckResult = {
    hasOpenClaw: false,
    hasNode: false,
    hasPython: false,
    hasGit: false,
  };

  // 检测 Node.js — literal binary, array-form spawn.
  try {
    result.nodeVersion = execFileSync('node', ['-v'], { encoding: 'utf-8' }).trim();
    result.hasNode = true;
  } catch {
    result.hasNode = false;
  }

  // 检测 OpenClaw — openclaw/clawd are npm .cmd shims on Windows; direct
  // spawn fails with EINVAL/ENOENT, so route through cmd.exe with CONSTANT
  // argv elements (no interpolation → no injection surface).
  try {
    result.openclawVersion = execFileSync('cmd.exe', ['/c', 'openclaw', '--version'], { encoding: 'utf-8', windowsHide: true }).trim();
    result.hasOpenClaw = true;
  } catch {
    // 尝试 clawd 命令
    try {
      result.openclawVersion = execFileSync('cmd.exe', ['/c', 'clawd', '--version'], { encoding: 'utf-8', windowsHide: true }).trim();
      result.hasOpenClaw = true;
    } catch {
      result.hasOpenClaw = false;
    }
  }

  // 检测 Python
  try {
    const [, pythonVersion] = execFileSync('python3', ['--version'], { encoding: 'utf-8' }).trim().split(' ');
    result.pythonVersion = pythonVersion;
    result.hasPython = true;
  } catch {
    result.hasPython = false;
  }

  // 检测 Git
  try {
    execFileSync('git', ['--version'], { encoding: 'utf-8' });
    result.hasGit = true;
  } catch {
    result.hasGit = false;
  }

  return result;
}

/**
 * 检测 OpenClaw 工作区
 */
export function detectWorkspace(): WorkspaceInfo {
  const homeDir = os.homedir();
  const candidates: string[] = [];

  // 安全地添加候选路径
  if (process.env.OPENCLAW_WORKSPACE) {
    candidates.push(process.env.OPENCLAW_WORKSPACE);
  }
  if (process.env.PD_WORKSPACE_DIR) {
    candidates.push(process.env.PD_WORKSPACE_DIR);
  }
  candidates.push(path.join(homeDir, 'clawd'));
  candidates.push(path.join(homeDir, '.openclaw', 'workspace'));

  // 核心文件列表（用于检测是否已安装）
  const CORE_FILES = [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Fix-8 (P1-BUG-2): detect via THINKING_OS.md — the file the installer
      // actually creates under .principles/. The previous check for
      // PRINCIPLES.md never matched because the installer doesn't create
      // that file, so hasPrinciples was always false on reinstall.
      const principlesPath = path.join(candidate, '.principles', 'THINKING_OS.md');
      const hasPrinciples = fs.existsSync(principlesPath);

      // 检测已存在的核心文件
      const coreFiles: string[] = [];
      for (const file of CORE_FILES) {
        if (fs.existsSync(path.join(candidate, file))) {
          coreFiles.push(file);
        }
      }

      // 判断是否首次安装：没有 THINKING_OS.md 且没有核心文件
      const isFirstInstall = !hasPrinciples && coreFiles.length === 0;

      return {
        detectedPath: candidate,
        exists: true,
        hasPrinciples,
        isFirstInstall,
        coreFiles,
      };
    }
  }

  // 默认返回 ~/clawd（首次安装）
  const defaultPath = path.join(homeDir, 'clawd');
  return {
    detectedPath: defaultPath,
    exists: false,
    hasPrinciples: false,
    isFirstInstall: true,
    coreFiles: [],
  };
}

/**
 * 获取 OpenClaw 配置目录
 */
export function getOpenClawConfigDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

/**
 * 获取插件扩展目录
 */
export function getPluginExtDir(): string {
  return path.join(getOpenClawConfigDir(), 'extensions', 'principles-disciple');
}

export interface OpenClawGatewayStatus {
  isRunning: boolean;
  port?: number;
  pid?: number;
}

function readOpenClawPort(): number | null {
  const configPath = path.join(getOpenClawConfigDir(), 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(raw);
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const { gateway } = config as Record<string, unknown>;
      if (gateway && typeof gateway === 'object' && !Array.isArray(gateway)) {
        const { port } = gateway as Record<string, unknown>;
        if (typeof port === 'number' && port > 0 && port < 65536) return port;
      }
    }
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

export async function checkOpenClawGateway(): Promise<OpenClawGatewayStatus> {
  const port = readOpenClawPort();
  if (!port) return { isRunning: false };

  const listening = await checkPortListening(port);
  if (!listening) return { isRunning: false };

  let pid: number | undefined = undefined;
  try {
    // Windows: parse `netstat -ano` locally instead of embedding the port in
    // a PowerShell one-liner (literal binary, constant argv, no shell).
    if (process.platform === 'win32') {
      const output = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
      const localSuffix = ':' + String(port);
      for (const line of output.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const [, localAddr] = cols;
        const candidatePid = cols[cols.length - 1];
        if (localAddr && localAddr.endsWith(localSuffix) && candidatePid) {
          const parsed = parseInt(candidatePid, 10);
          if (Number.isFinite(parsed)) {
            pid = parsed;
            break;
          }
        }
      }
    } else {
      const [firstLine] = execFileSync('lsof', ['-i', ':' + String(port), '-t', '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n');
      if (firstLine) pid = parseInt(firstLine.trim(), 10);
    }
  } catch { /* ignore */ }

  return { isRunning: true, port, pid };
}

export interface GatewayControlResult {
  ok: boolean;
  error?: string;
}

/**
 * Run `openclaw gateway <subcommand>` (service-level: launchd/systemd/schtasks).
 * subcommand is a compile-time union ('stop' | 'start') passed as its own argv
 * element via cmd.exe /c (Windows npm shim resolution) — constant arguments,
 * no interpolation. rc-9: never throws — returns {ok:false, error} so callers
 * can degrade with a structured reason + nextAction instead of crashing
 * mid-install.
 */
function runGatewayServiceCommand(subcommand: 'stop' | 'start'): GatewayControlResult {
  try {
    execFileSync('cmd.exe', ['/c', 'openclaw', 'gateway', subcommand], { stdio: 'pipe', encoding: 'utf-8', timeout: 15000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `\`openclaw gateway ${subcommand}\` failed: ${msg}` };
  }
}

/**
 * Stop the OpenClaw gateway service. Call before mutating the plugin ext dir
 * to release file locks held on native modules (EPERM on backup rename).
 */
export async function stopOpenClawGateway(): Promise<GatewayControlResult> {
  return runGatewayServiceCommand('stop');
}

/**
 * Start the OpenClaw gateway service (inverse of stopOpenClawGateway). Called
 * after install completes (success or failure) to leave the gateway running.
 */
export async function restartOpenClawGateway(): Promise<GatewayControlResult> {
  return runGatewayServiceCommand('start');
}
