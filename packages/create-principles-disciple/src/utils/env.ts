/**
 * 环境检测工具
 *
 * PRI-605: 跨平台 child_process 调用统一为数组形式 execFileSync（不走 shell）,
 * 并按平台路由二进制：
 *   - win32: 无 .exe 的 shim（openclaw/clawd/npm 等）经 cmd.exe /c 解析 PATH;
 *     python 探测 python3 → python; 网关 PID 用 netstat.exe 而非 PowerShell。
 *   - 非 win32: 直接 execFileSync 字面量二进制。
 * 语义与原 execSync 字符串形式一致（找不到命令 → 对应能力置 false / PID 留空,
 * rc-9 不静默抛出）。
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
  isNodeSupported: boolean;
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

const IS_WIN32 = process.platform === 'win32';

/** 探测超时：卡死的 .cmd shim / 挂起的二进制不应挂住安装器（rc-9 降级）。 */
const DETECT_TIMEOUT_MS = 5000;

/**
 * 探测工具版本。失败（未安装/退出非零/超时）返回 null，调用方据此降级
 * （能力置 false / 进入回退链），绝不抛出（rc-9）。探测函数由调用点以
 * 字面量二进制构造，保持 Mimosa 写门要求的 literal argv。
 */
function probeVersion(probe: () => string): string | null {
  try {
    return probe().trim();
  } catch {
    return null;
  }
}

/**
 * 检测运行环境
 */
export function checkEnvironment(): EnvCheckResult {
  const result: EnvCheckResult = {
    hasOpenClaw: false,
    hasNode: false,
    isNodeSupported: false,
    hasPython: false,
    hasGit: false,
  };

  // 检测 Node.js
  try {
    result.nodeVersion = execSync('node -v', { encoding: 'utf-8' }).trim();
    const major = Number(/^v?(\d+)/.exec(result.nodeVersion)?.[1]);
    result.hasNode = true;
    result.isNodeSupported = Number.isInteger(major) && major >= 22;
  } catch {
    result.hasNode = false;
    result.isNodeSupported = false;
  }

  // 检测 OpenClaw（win32 上 openclaw 是 .cmd shim，无 .exe，须经 cmd.exe /c）
  const openclawVersion = IS_WIN32
    ? probeVersion(() => execFileSync('cmd.exe', ['/c', 'openclaw', '--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }))
    : probeVersion(() => execFileSync('openclaw', ['--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
  if (openclawVersion !== null) {
    result.openclawVersion = openclawVersion;
    result.hasOpenClaw = true;
  } else {
    // 尝试 clawd 命令
    const clawdVersion = IS_WIN32
      ? probeVersion(() => execFileSync('cmd.exe', ['/c', 'clawd', '--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }))
      : probeVersion(() => execFileSync('clawd', ['--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
    if (clawdVersion !== null) {
      result.openclawVersion = clawdVersion;
      result.hasOpenClaw = true;
    }
  }

  // 检测 Python（win32 上 python.org 安装通常只提供 python.exe，python3 可能不在 PATH）
  let pythonVersion: string | null = probeVersion(() => execFileSync('python3', ['--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
  if (pythonVersion === null && IS_WIN32) {
    pythonVersion = probeVersion(() => execFileSync('python', ['--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
  }
  if (pythonVersion !== null) {
    const [, version] = pythonVersion.split(' ');
    result.pythonVersion = version;
    result.hasPython = true;
  }

  // 检测 Git
  const gitVersion = probeVersion(() => execFileSync('git', ['--version'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
  if (gitVersion !== null) {
    result.hasGit = true;
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

/**
 * 从 netstat -ano -p tcp 输出解析监听指定端口的 PID。
 * 行形如：TCP  0.0.0.0:135  0.0.0.0:0  LISTENING  1234（IPv6 本地地址为 [::]:port）。
 * rc-1/rc-5: 按 unknown 语义逐字段校验，键/列缺失即跳过，不信任列位置。
 */
export function parseNetstatPid(output: string, port: number): number | undefined {
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    // parts.length >= 5 已守卫，[0],[1],[3],[4] 存在；`?? ''` 仅为满足严格类型
    const proto = parts[0] ?? '';
    const local = parts[1] ?? '';
    const state = parts[3] ?? '';
    const pidField = parts[4] ?? '';
    if (proto !== 'TCP' || state !== 'LISTENING') continue;
    if (!local.endsWith(`:${port}`)) continue;
    if (!/^\d+$/.test(pidField)) continue;
    const pid = parseInt(pidField, 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

export async function checkOpenClawGateway(): Promise<OpenClawGatewayStatus> {
  const port = readOpenClawPort();
  if (!port) return { isRunning: false };

  const listening = await checkPortListening(port);
  if (!listening) return { isRunning: false };

  let pid: number | undefined = undefined;
  try {
    if (IS_WIN32) {
      // netstat.exe 在 Windows 全系自带，避免依赖 PowerShell
      const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', timeout: 5000 }).trim();
      pid = parseNetstatPid(output, port);
    } else {
      const output = execFileSync('lsof', ['-i', `:${port}`, '-t', '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (output) {
        const [firstLine] = output.split('\n');
        if (firstLine) pid = parseInt(firstLine.trim(), 10);
      }
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
 * rc-9: never throws — returns {ok:false, error} so callers can degrade with a
 * structured reason + nextAction instead of crashing mid-install.
 */
function runGatewayServiceCommand(subcommand: 'stop' | 'start'): GatewayControlResult {
  try {
    if (IS_WIN32) {
      execFileSync('cmd.exe', ['/c', 'openclaw', 'gateway', subcommand], { stdio: 'pipe', encoding: 'utf-8', timeout: 15000 });
    } else {
      execFileSync('openclaw', ['gateway', subcommand], { stdio: 'pipe', encoding: 'utf-8', timeout: 15000 });
    }
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
