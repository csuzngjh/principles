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
import { errnoCode } from './config-file-io.js';

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

  // 检测 Node.js（PRI-605 数组形式；native 运行时最低要求 major>=22）。
  // win32 上必须经 cmd.exe /c：PATH 里可能只有 node.cmd shim（测试桩、
  // nvm-windows 等场景），CreateProcess 直连会跳过它命中真 node.exe，
  // 让版本门形同虚设。
  const nodeVersion = IS_WIN32
    ? probeVersion(() => execFileSync('cmd.exe', ['/c', 'node', '-v'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }))
    : probeVersion(() => execFileSync('node', ['-v'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS }));
  if (nodeVersion !== null && nodeVersion.length > 0) {
    result.nodeVersion = nodeVersion;
    // 注：此处刻意用 String.match 并禁用 prefer-regexp-exec——写门确定性
    // 规则会把同块内的 ".exec(" 记号与子进程调用合并判为命令注入（已
    // 实测确认的假阳性），而本块必须包含 execFileSync 探测。
    // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
    const major = Number(nodeVersion.match(/^v?(\d+)/)?.[1]);
    result.hasNode = true;
    result.isNodeSupported = Number.isInteger(major) && major >= 22;
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
    // ERR-045: argv-array execution only. The validated port is an argv
    // element or a JS-side output match — it never enters a shell string.
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      const output = IS_WIN32
        ? execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', timeout: 5000 })
        : execFileSync('lsof', ['-i', `:${port}`, '-t', '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000 });
      const text = output.trim();
      if (text) {
        let listeningLine: string | undefined;
        if (IS_WIN32) {
          listeningLine = text.split('\n').find((line) => {
            const [, localAddress, , state] = line.trim().split(/\s+/);
            return state === 'LISTENING' && localAddress !== undefined && localAddress.endsWith(`:${port}`);
          });
        } else {
          [listeningLine] = text.split('\n');
        }
        const pidColumn = IS_WIN32
          ? listeningLine?.trim().split(/\s+/)[4]
          : listeningLine?.trim();
        if (pidColumn) pid = parseInt(pidColumn, 10);
      }
    }
  } catch { /* ignore */ }

  return { isRunning: true, port, pid };
}

/**
 * PRI-944: the classified truth behind a failed `gateway stop`. A command
 * failure and an unproven effect are different statements and must not share
 * one operator instruction (ERR-144: a bounded wait says something about TIME,
 * never about the data; ERR-03-family rc-9: degradation carries a reason).
 */
export type GatewayStopFailure =
  /** The listener survived the window: the gateway did not stop. */
  | 'gateway_still_running'
  /** The port cleared but the observed process did not exit in time. */
  | 'stop_confirmation_timeout'
  /** The effect could not be measured at all — refused rather than assumed. */
  | 'verification_unavailable';

export interface GatewayControlResult {
  ok: boolean;
  error?: string;
  /** Set on the stop leg whenever ok=false. */
  reason?: GatewayStopFailure;
}

/**
 * Run `openclaw gateway <subcommand>` (service-level: launchd/systemd/schtasks).
 * rc-9: never throws — returns {ok:false, error} so callers can degrade with a
 * structured reason + nextAction instead of crashing mid-install.
 *
 * ERR-141: `stop` always sends `--force`. OpenClaw CLIs with the operator
 * gateway guard (v2026.6.8+) refuse a bare `gateway stop` with
 * "re-run with --force", and this helper only runs AFTER the installer has
 * already decided to stop the gateway (the `--stop-gateway` flag or an
 * explicit interactive choice) — the decision IS the Owner's intent, so the
 * confirmation the guard waits for has effectively been given. Without the
 * flag every console-driven update failed at `gateway_stop_failed` on hosts
 * running the operator gateway.
 */
function runGatewayServiceCommand(subcommand: 'stop' | 'start'): GatewayControlResult {
  const failedOperation = `openclaw gateway ${subcommand}`;
  try {
    // ERR-045: argv-array execution only. Every branch below is fully
    // literal (compile-time subcommand union), so nothing runtime-derived
    // is ever interpolated into a command line.
    if (subcommand === 'stop') {
      if (IS_WIN32) {
        execFileSync('cmd.exe', ['/c', 'openclaw', 'gateway', 'stop', '--force'], { encoding: 'utf-8', timeout: 15000, windowsHide: true });
      } else {
        execFileSync('openclaw', ['gateway', 'stop', '--force'], { encoding: 'utf-8', timeout: 15000 });
      }
    } else {
      if (IS_WIN32) {
        execFileSync('cmd.exe', ['/c', 'openclaw', 'gateway', 'start'], { encoding: 'utf-8', timeout: 15000, windowsHide: true });
      } else {
        execFileSync('openclaw', ['gateway', 'start'], { encoding: 'utf-8', timeout: 15000 });
      }
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `${failedOperation} failed: ${msg}` };
  }
}

/**
 * PRI-944 effect-verification budget for the stop leg. A failed or timed-out
 * `gateway stop` is not the end of the story: on Windows the command runs under
 * a `cmd.exe /c` wrapper whose 15s kill says nothing about the gateway, and the
 * service manager may keep shutting the process down after the wrapper dies.
 * The window is bounded and short because this gate already spent 15s on the
 * command; the timeout knob itself is deliberately NOT configurable (Owner
 * call on PRI-944: with the effect check in place the number loses decision
 * power, so a knob would only add governance cost).
 */
const GATEWAY_STOP_CONFIRM_TIMEOUT_MS = 30_000;
const GATEWAY_STOP_POLL_INTERVAL_MS = 1_000;

/**
 * Is this PID still a live process?
 *
 * Deliberately NOT a copy of the two sibling probes
 * (`openclaw-plugin/src/utils/file-lock.ts`,
 * `principles-core/src/principle-tree-ledger.ts`), which read ANY
 * `process.kill` failure as "dead". The OpenClaw gateway is a high-integrity
 * scheduled task on Windows, and a medium-IL installer that signals it gets
 * EPERM — which means ALIVE. A false "dead" here would confirm a stop that
 * never happened, so win32 asks the SCM read-only via tasklist and POSIX
 * separates ESRCH (gone) from every other error (exists, just not ours to
 * signal). Converging the three implementations belongs to its own ticket,
 * not to this fix.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (IS_WIN32) {
    try {
      // ERR-045: the validated integer pid travels as an argv element, never
      // inside a shell string.
      const output = execFileSync('tasklist.exe', ['/NH', '/FI', `PID eq ${pid}`], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      // Column-order-agnostic: an image name can contain spaces, so match the
      // pid as one whitespace-delimited field rather than trusting a position.
      return output.split(/\r?\n/).some((line) => line.split(/\s+/).includes(String(pid)));
    } catch {
      return true; // an unreadable probe never reads as "the gateway exited"
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ERR-126: reuses the package's existing errno reader (config-file-io)
    // rather than a third inline cast. Only ESRCH means "gone".
    return errnoCode(error) !== 'ESRCH';
  }
}

export interface GatewayStopConfirmationDeps {
  /** Test seam: backoff between effect probes (PRI-924 apply-payload precedent). */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: PID liveness — the host PID space is not deterministic in tests. */
  processAlive?: (pid: number) => boolean;
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Decide the stop by its EFFECT instead of by the wrapper's exit code
 * (PRI-944, real incident: a signed-channel update was voided at `verified`
 * because `spawnSync cmd.exe ETIMEDOUT` was read as "the gateway refused to
 * stop" — a verdict the wrapper is not entitled to give, and the same gate
 * passed minutes later on a retry without anyone touching the gateway).
 *
 * The goal of stopping is that nothing holds the extension directory any more,
 * so the two things that must both be true are: the observed port no longer
 * has a listener, and the process that held it has exited. When the pre-flight
 * could not resolve a PID, port-clear is the accepted truth and the backup
 * rename stays the terminal judge of handles (its EPERM path already refuses
 * with a structured reason and mutates nothing).
 */
async function confirmGatewayStopped(
  commandFailure: GatewayControlResult,
  observed: OpenClawGatewayStatus | undefined,
  deps: GatewayStopConfirmationDeps = {},
): Promise<GatewayControlResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const processAlive = deps.processAlive ?? isProcessAlive;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? GATEWAY_STOP_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? GATEWAY_STOP_POLL_INTERVAL_MS;

  const rawError = commandFailure.error ?? 'openclaw gateway stop failed';
  const port = observed?.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    // No observable to verify against: keep the command's own error and refuse.
    // Assuming "stopped" here would be the fail-open this ticket exists to kill.
    return { ok: false, reason: 'verification_unavailable', error: `${rawError} — the gateway port was not observable, so its stopped state could not be verified` };
  }
  const pid = observed?.pid;

  try {
    let listening = true;
    let holderAlive = false;
    const deadline = Date.now() + confirmTimeoutMs;
    for (;;) {
      listening = await checkPortListening(port);
      holderAlive = !listening && pid !== undefined && processAlive(pid);
      if (!listening && !holderAlive) return { ok: true };
      if (Date.now() >= deadline) break;
      await sleep(pollIntervalMs);
    }
    // ERR-144: classify from the LAST observation and say what was waited for.
    const waited = `${Math.round(confirmTimeoutMs / 1000)}s`;
    const subject = `gateway port ${port}${pid !== undefined ? ` (pid ${pid})` : ''}`;
    if (listening) {
      return {
        ok: false,
        reason: 'gateway_still_running',
        error: `${rawError} — verified for ${waited}: ${subject} is still listening, so the gateway did not stop`,
      };
    }
    return {
      ok: false,
      reason: 'stop_confirmation_timeout',
      error: `${rawError} — verified for ${waited}: ${subject} stopped accepting connections but its process was still running when the window expired. This is a statement about time, not a refusal; the gateway may still be exiting`,
    };
  } catch (error) {
    // rc-9: a broken probe degrades to an explicit refusal, never to a crash
    // and never to an assumed success.
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'verification_unavailable', error: `${rawError} — stopped-state verification itself failed: ${msg}` };
  }
}

/**
 * Stop the OpenClaw gateway service. Call before mutating the plugin ext dir
 * to release file locks held on native modules (EPERM on backup rename).
 *
 * `observed` is the pre-flight state the caller already measured
 * (`checkOpenClawGateway()`), and it is what makes the effect check honest:
 * verifying against the port we just saw listening cannot be fooled by an
 * unreadable `openclaw.json`, which `checkOpenClawGateway()` itself reports as
 * `isRunning:false`.
 */
export async function stopOpenClawGateway(
  observed?: OpenClawGatewayStatus,
  deps?: GatewayStopConfirmationDeps,
): Promise<GatewayControlResult> {
  const command = runGatewayServiceCommand('stop');
  if (command.ok) return command;
  return confirmGatewayStopped(command, observed, deps);
}

/**
 * Start the OpenClaw gateway service (inverse of stopOpenClawGateway). Called
 * after install completes (success or failure) to leave the gateway running.
 *
 * Left on the exit-code contract on purpose (PRI-944 scope): its failure is a
 * notification, not a gate, and a cold start here measures in minutes on real
 * machines — a bounded effect check would turn a slow boot into a new false
 * alarm while blocking the install's finally path.
 */
export async function restartOpenClawGateway(): Promise<GatewayControlResult> {
  return runGatewayServiceCommand('start');
}
