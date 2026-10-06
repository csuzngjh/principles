import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { checkEnvironment, detectWorkspace, getOpenClawConfigDir, getPluginExtDir, checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway, parseNetstatPid } from '../src/utils/env.js';

vi.mock('fs');
vi.mock('os');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(childProcess.execFileSync);

/**
 * PRI-605: env.ts 现以数组形式 execFileSync(binary, args) 探测工具。
 * win32 上 openclaw/clawd 经 cmd.exe /c 路由（`cmd.exe /c openclaw --version`），
 * 非 win32 直连（`openclaw --version`）。mock 按 "binary + args" 拼装后的子串
 * 路由，使同一断言在两平台都成立。
 */
function joinedCall(call: unknown[]): string {
  const [binary, args] = call as [string, string[]];
  return [binary, ...args].join(' ');
}

function routeByCommand(
  binary: string,
  args: string[],
  responses: Record<string, string | 'throw'>,
): string {
  const key = [binary, ...args].join(' ');
  for (const [needle, value] of Object.entries(responses)) {
    if (key.includes(needle)) {
      if (value === 'throw') throw new Error(`mocked failure: ${key}`);
      return value;
    }
  }
  throw new Error(`unmocked spawn: ${key}`);
}

describe('environment detection utilities', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockHomedir = vi.spyOn(os, 'homedir');
  let savedOpenClawWorkspace: string | undefined;
  let savedPdWorkspaceDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/home/user');
    mockExecFileSync.mockImplementation(() => '');
    savedOpenClawWorkspace = process.env.OPENCLAW_WORKSPACE;
    savedPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedOpenClawWorkspace !== undefined) {
      process.env.OPENCLAW_WORKSPACE = savedOpenClawWorkspace;
    } else {
      delete process.env.OPENCLAW_WORKSPACE;
    }
    if (savedPdWorkspaceDir !== undefined) {
      process.env.PD_WORKSPACE_DIR = savedPdWorkspaceDir;
    } else {
      delete process.env.PD_WORKSPACE_DIR;
    }
  });

  describe('checkEnvironment', () => {
    it('detects all tools when available', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v22.0.0',
          'openclaw --version': 'OpenClaw 1.0.0',
          'python3 --version': 'Python 3.11.0',
          'git --version': 'git version 2.40.0',
        })
      );

      const result = checkEnvironment();

      expect(result.hasNode).toBe(true);
      expect(result.isNodeSupported).toBe(true);
      expect(result.nodeVersion).toBe('v22.0.0');
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('OpenClaw 1.0.0');
      expect(result.hasPython).toBe(true);
      expect(result.pythonVersion).toBe('3.11.0');
      expect(result.hasGit).toBe(true);
    });

    it('rejects Node.js below the native runtime minimum', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v20.19.0',
        })
      );

      const result = checkEnvironment();

      expect(result.hasNode).toBe(true);
      expect(result.isNodeSupported).toBe(false);
      expect(result.nodeVersion).toBe('v20.19.0');
    });

    it('detects clawd when openclaw is not available', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v20.0.0',
          'openclaw --version': 'throw',
          'clawd --version': 'clawd 2.0.0',
        })
      );

      const result = checkEnvironment();

      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('clawd 2.0.0');
    });

    it('returns false when tools are not available', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = checkEnvironment();

      expect(result.hasNode).toBe(false);
      expect(result.hasOpenClaw).toBe(false);
      expect(result.hasPython).toBe(false);
      expect(result.hasGit).toBe(false);
    });
  });

  describe('OpenClaw readiness check', () => {
    it('Given OpenClaw is installed, When checkEnvironment runs, Then hasOpenClaw is true with version', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'openclaw --version': 'openclaw 1.2.0',
        })
      );
      const result = checkEnvironment();
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('openclaw 1.2.0');
    });

    it('Given OpenClaw is missing, When checkEnvironment runs, Then hasOpenClaw is false and version is absent', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'openclaw --version': 'throw',
          'clawd --version': 'throw',
          'node -v': 'v18.0.0',
        })
      );
      const result = checkEnvironment();
      expect(result.hasOpenClaw).toBe(false);
      expect(result.openclawVersion).toBeUndefined();
    });

    it('Given only clawd alias is available, When checkEnvironment runs, Then hasOpenClaw is true via fallback', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'openclaw --version': 'throw',
          'clawd --version': 'clawd 2.1.3',
          'node -v': 'v20.0.0',
        })
      );
      const result = checkEnvironment();
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('clawd 2.1.3');
    });
  });

  describe('detectWorkspace', () => {
    const defaultWorkspace = path.join('/home/user', 'clawd');
    it('detects workspace from environment variable OPENCLAW_WORKSPACE', () => {
      process.env.OPENCLAW_WORKSPACE = '/custom/workspace';
      delete process.env.PD_WORKSPACE_DIR;
      mockExistsSync.mockReturnValue(true);

      const result = detectWorkspace();

      expect(result.detectedPath).toBe('/custom/workspace');
      expect(result.exists).toBe(true);
    });

    it('detects workspace from environment variable PD_WORKSPACE_DIR', () => {
      delete process.env.OPENCLAW_WORKSPACE;
      process.env.PD_WORKSPACE_DIR = '/pd/workspace';
      mockExistsSync.mockReturnValue(true);

      const result = detectWorkspace();

      expect(result.detectedPath).toBe('/pd/workspace');
      expect(result.exists).toBe(true);
    });

    it('returns default path when no workspace exists', () => {
      delete process.env.OPENCLAW_WORKSPACE;
      delete process.env.PD_WORKSPACE_DIR;
      mockExistsSync.mockReturnValue(false);

      const result = detectWorkspace();

      expect(result.detectedPath).toBe(defaultWorkspace);
      expect(result.exists).toBe(false);
      expect(result.isFirstInstall).toBe(true);
    });

    it('detects existing workspace with principles', () => {
      delete process.env.OPENCLAW_WORKSPACE;
      delete process.env.PD_WORKSPACE_DIR;
      mockExistsSync.mockImplementation((p: string) => {
        if (p.toString() === defaultWorkspace) return true;
        // Fix-8 (P1-BUG-2): installer creates THINKING_OS.md, not PRINCIPLES.md
        if (p.toString() === path.join(defaultWorkspace, '.principles', 'THINKING_OS.md')) return true;
        return false;
      });

      const result = detectWorkspace();

      expect(result.hasPrinciples).toBe(true);
      expect(result.isFirstInstall).toBe(false);
    });

    it('detects existing workspace without principles but with core files', () => {
      delete process.env.OPENCLAW_WORKSPACE;
      delete process.env.PD_WORKSPACE_DIR;
      mockExistsSync.mockImplementation((p: string) => {
        if (p.toString() === defaultWorkspace) return true;
        if (p.toString() === path.join(defaultWorkspace, '.principles', 'THINKING_OS.md')) return false;
        if (p.toString() === path.join(defaultWorkspace, 'AGENTS.md')) return true;
        return false;
      });

      const result = detectWorkspace();

      expect(result.hasPrinciples).toBe(false);
      expect(result.coreFiles).toContain('AGENTS.md');
      expect(result.isFirstInstall).toBe(false);
    });
  });

  describe('getOpenClawConfigDir', () => {
    it('returns correct config directory', () => {
      expect(getOpenClawConfigDir()).toBe(path.join('/home/user', '.openclaw'));
    });
  });

  describe('getPluginExtDir', () => {
    it('returns correct plugin extension directory', () => {
      expect(getPluginExtDir()).toBe(path.join('/home/user', '.openclaw', 'extensions', 'principles-disciple'));
    });
  });

  describe('gateway service control (stopOpenClawGateway / restartOpenClawGateway)', () => {
    it('stopOpenClawGateway returns ok:true and invokes "openclaw gateway stop --force"', async () => {
      mockExecFileSync.mockImplementation(() => '');
      const res = await stopOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(joinedCall(mockExecFileSync.mock.calls[0])).toContain('openclaw gateway stop');
      // ERR-141: the operator-gateway guard in OpenClaw CLI v2026.6.8+ refuses
      // a bare `gateway stop`; the installer only stops AFTER deciding to, so
      // the flag is always part of the literal argv.
      expect(joinedCall(mockExecFileSync.mock.calls[0])).toContain('--force');
      expect(mockExecFileSync.mock.calls[0][2]).toMatchObject({ timeout: 15000 });
    });

    it('restartOpenClawGateway returns ok:true and invokes "openclaw gateway start"', async () => {
      mockExecFileSync.mockImplementation(() => '');
      const res = await restartOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(joinedCall(mockExecFileSync.mock.calls[0])).toContain('openclaw gateway start');
      expect(mockExecFileSync.mock.calls[0][2]).toMatchObject({ timeout: 15000 });
    });

    // rc-9: control helpers must NEVER throw — they degrade with a structured
    // reason so the installer can emit nextAction instead of crashing.
    it('stopOpenClawGateway returns ok:false (does not throw) when spawn throws', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('service not found'); });
      const res = await stopOpenClawGateway();
      expect(res.ok).toBe(false);
      expect(res.error).toContain('openclaw gateway stop');
      expect(res.error).toMatch(/failed/);
    });

    it('restartOpenClawGateway returns ok:false (does not throw) when spawn throws', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('boom'); });
      const res = await restartOpenClawGateway();
      expect(res.ok).toBe(false);
      expect(res.error).toContain('openclaw gateway start');
      expect(res.error).toMatch(/failed/);
    });
  });

  /**
   * PRI-944: a failed `gateway stop` is a statement about the COMMAND; whether
   * the gateway actually released the extension dir is a separate fact, and the
   * old code conflated them (a signed-channel update died at `verified` on
   * `cmd.exe ETIMEDOUT` read as "the gateway refused to stop").
   *
   * Port truth comes from a REAL TCP listener (checkPortListening is not
   * mocked); pid-liveness and the poll wait are injected because the host
   * process table is not deterministic in tests.
   */
  describe('stopOpenClawGateway effect verification (PRI-944)', () => {
    const noWait = async () => {};

    async function openListener(): Promise<{ port: number; close: () => Promise<void> }> {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) throw new Error('listen failed');
      return { port: addr.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    }

    /** The stop command itself fails — every case below starts from there. */
    function stopCommandFails() {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, { 'gateway stop': 'throw' })
      );
    }

    // EP-09#2 negative control: RED before this fix (exit code alone returned
    // ok:false and voided the transaction), GREEN after.
    it('reports ok:true when the command failed but the gateway verifiably stopped', async () => {
      const gw = await openListener();
      await gw.close();
      stopCommandFails();

      const res = await stopOpenClawGateway(
        { isRunning: true, port: gw.port },
        { sleep: noWait, processAlive: () => false, confirmTimeoutMs: 50, pollIntervalMs: 1 },
      );

      expect(res).toEqual({ ok: true });
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('reports gateway_still_running when a listener survives the whole window', async () => {
      const gw = await openListener();
      stopCommandFails();
      try {
        const res = await stopOpenClawGateway(
          { isRunning: true, port: gw.port, pid: 4242 },
          { sleep: noWait, processAlive: () => true, confirmTimeoutMs: 20, pollIntervalMs: 1 },
        );

        expect(res.ok).toBe(false);
        expect(res.reason).toBe('gateway_still_running');
        expect(res.error).toContain('still listening');
        expect(res.error).toContain(`port ${gw.port} (pid 4242)`);
      } finally {
        await gw.close();
      }
    });

    it('reports stop_confirmation_timeout — not a refusal — when the port cleared but the process lingered', async () => {
      const gw = await openListener();
      await gw.close();
      stopCommandFails();

      const res = await stopOpenClawGateway(
        { isRunning: true, port: gw.port, pid: 4242 },
        { sleep: noWait, processAlive: () => true, confirmTimeoutMs: 20, pollIntervalMs: 1 },
      );

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('stop_confirmation_timeout');
      expect(res.error).toContain('statement about time, not a refusal');
    });

    it('accepts port-clear alone when the pre-flight never resolved a PID (backup rename is the terminal judge)', async () => {
      const gw = await openListener();
      await gw.close();
      stopCommandFails();

      const res = await stopOpenClawGateway(
        { isRunning: true, port: gw.port },
        { sleep: noWait, processAlive: () => true, confirmTimeoutMs: 20, pollIntervalMs: 1 },
      );

      expect(res).toEqual({ ok: true });
    });

    it('refuses with verification_unavailable instead of assuming success when nothing was observed', async () => {
      stopCommandFails();

      const res = await stopOpenClawGateway(undefined, { sleep: noWait });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('verification_unavailable');
      expect(res.error).toContain('openclaw gateway stop failed');
      expect(res.error).toContain('could not be verified');
    });

    // rc-1: the observed status crosses a trust boundary — a junk port must not
    // turn into an infinite/absurd wait or a fabricated verdict.
    it('refuses with verification_unavailable for a non-integer or out-of-range observed port', async () => {
      stopCommandFails();

      for (const port of [0, 70000, 1.5, Number.NaN]) {
        const res = await stopOpenClawGateway(
          { isRunning: true, port },
          { sleep: noWait, processAlive: () => false },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('verification_unavailable');
      }
    });

    // rc-9: a broken probe degrades loudly, never crashes the install.
    it('never throws when the verification probe itself fails', async () => {
      const gw = await openListener();
      await gw.close();
      stopCommandFails();

      const res = await stopOpenClawGateway(
        { isRunning: true, port: gw.port, pid: 4242 },
        { sleep: noWait, processAlive: () => { throw new Error('probe exploded'); } },
      );

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('verification_unavailable');
      expect(res.error).toContain('verification itself failed');
    });

    it('never runs the effect check on the success path (no new wait on healthy hosts)', async () => {
      const gw = await openListener();
      mockExecFileSync.mockImplementation(() => '');

      const res = await stopOpenClawGateway({ isRunning: true, port: gw.port, pid: 4242 });

      expect(res).toEqual({ ok: true });
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      await gw.close();
    });
  });

  describe('checkOpenClawGateway', () => {
    it('returns isRunning:false when openclaw.json is missing', async () => {
      mockExistsSync.mockReturnValue(false);
      const status = await checkOpenClawGateway();
      expect(status.isRunning).toBe(false);
    });

    it('returns isRunning:true with port when a gateway is listening on the configured port', async () => {
      // Spin up a real ephemeral TCP listener so checkPortListening connects.
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) throw new Error('listen failed');
      const port = addr.port;
      try {
        mockExistsSync.mockReturnValue(true); // openclaw.json present
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ gateway: { port } }));
        const status = await checkOpenClawGateway();
        expect(status.isRunning).toBe(true);
        expect(status.port).toBe(port);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('parseNetstatPid', () => {
    it('extracts the PID of a LISTENING TCP line matching the port', () => {
      const output = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
        '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       5678',
        '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       5678',
      ].join('\n');
      expect(parseNetstatPid(output, 8080)).toBe(5678);
    });

    it('matches IPv6 wildcard local addresses', () => {
      const output = '  TCP    [::]:443              [::]:0                LISTENING       999\n';
      expect(parseNetstatPid(output, 443)).toBe(999);
    });

    it('ignores non-TCP, non-LISTENING, and other-port lines', () => {
      const output = [
        '  UDP    0.0.0.0:135            0.0.0.0:0                          135',
        '  TCP    0.0.0.0:135            0.0.0.0:0              TIME_WAIT     1234',
        '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING     4321',
      ].join('\n');
      expect(parseNetstatPid(output, 8080)).toBeUndefined();
    });

    it('returns undefined when the port is not listening', () => {
      const output = '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       1\n';
      expect(parseNetstatPid(output, 8080)).toBeUndefined();
    });
  });

  describe('win32 专属路径（platform 注入，任意平台执行）', () => {
    let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
    let win32Env: typeof import('../src/utils/env.js');
    let win32ExecFileSync: typeof mockExecFileSync;
    let win32Fs: typeof fs;

    /**
     * env.ts 在模块加载时求值 IS_WIN32。先注入 process.platform='win32'，
     * 再 resetModules + 动态 import，使 win32 分支在任意平台（含 Linux CI）
     * 真实执行。resetModules 后重新取 child_process/fs 引用（mock 工厂可能重建）。
     */
    async function loadWin32Env(): Promise<typeof import('../src/utils/env.js')> {
      platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.resetModules();
      win32Env = await import('../src/utils/env.js');
      const freshChildProcess = await import('child_process');
      win32ExecFileSync = vi.mocked(freshChildProcess.execFileSync);
      win32Fs = await import('fs');
      return win32Env;
    }

    afterEach(() => {
      platformSpy?.mockRestore();
      vi.resetModules();
    });

    /** An ephemeral port that is provably NOT listening (bound, then released). */
    async function bindAndRelease(): Promise<number> {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) throw new Error('listen failed');
      const port = addr.port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }

    // PRI-605: win32 上 python.org 安装常只提供 python.exe，python3 不在 PATH。
    it('falls back to python when python3 is absent on win32', async () => {
      await loadWin32Env();
      win32ExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v20.0.0',
          'python3 --version': 'throw',
          'python --version': 'Python 3.12.0',
        })
      );
      const result = win32Env.checkEnvironment();
      expect(result.hasPython).toBe(true);
      expect(result.pythonVersion).toBe('3.12.0');
    });

    it('routes openclaw probes through cmd.exe on win32', async () => {
      await loadWin32Env();
      win32ExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v20.0.0',
          'openclaw --version': 'OpenClaw 1.0.0',
          'python3 --version': 'Python 3.11.0',
          'git --version': 'git version 2.40.0',
        })
      );
      const result = win32Env.checkEnvironment();
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('OpenClaw 1.0.0');
      const openclawCalls = win32ExecFileSync.mock.calls.filter((c) => joinedCall(c).includes('openclaw --version'));
      expect(openclawCalls.length).toBeGreaterThan(0);
      expect(joinedCall(openclawCalls[0])).toContain('cmd.exe /c openclaw --version');
    });

    it('routes gateway service commands through cmd.exe on win32', async () => {
      await loadWin32Env();
      win32ExecFileSync.mockImplementation(() => '');
      const res = await win32Env.stopOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(win32ExecFileSync).toHaveBeenCalledTimes(1);
      expect(joinedCall(win32ExecFileSync.mock.calls[0])).toContain('cmd.exe /c openclaw gateway stop');
      expect(joinedCall(win32ExecFileSync.mock.calls[0])).toContain('--force');
    });

    it('resolves gateway PID via netstat on win32', async () => {
      await loadWin32Env();
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) throw new Error('listen failed');
      const port = addr.port;
      try {
        vi.mocked(win32Fs.existsSync).mockReturnValue(true);
        vi.mocked(win32Fs.readFileSync).mockReturnValue(JSON.stringify({ gateway: { port } }));
        win32ExecFileSync.mockImplementation((binary: string, args: string[]) => {
          if (joinedCall([binary, args]).includes('netstat.exe -ano -p tcp')) {
            return `  TCP    127.0.0.1:${port}   0.0.0.0:0   LISTENING   4242`;
          }
          return '';
        });
        const status = await win32Env.checkOpenClawGateway();
        expect(status.isRunning).toBe(true);
        expect(status.port).toBe(port);
        expect(status.pid).toBe(4242);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    // PRI-944: win32 asks the SCM read-only via tasklist, because a medium-IL
    // installer that signals the high-IL gateway task gets EPERM — and
    // process.kill-based probes read that as "dead", which would confirm a stop
    // that never happened.
    it('confirms a stop via tasklist when the port cleared and the PID is gone', async () => {
      await loadWin32Env();
      const port = await bindAndRelease();

      win32ExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'gateway stop': 'throw',
          'tasklist.exe': 'INFO: No tasks are running which match the specified criteria.',
        })
      );

      const res = await win32Env.stopOpenClawGateway(
        { isRunning: true, port, pid: 4242 },
        { sleep: async () => {}, confirmTimeoutMs: 20, pollIntervalMs: 1 },
      );

      expect(res).toEqual({ ok: true });
      const tasklistCall = win32ExecFileSync.mock.calls.find((c) => joinedCall(c).includes('tasklist.exe'));
      expect(tasklistCall).toBeDefined();
      // ERR-045: the pid is an argv element, never interpolated into a shell string.
      expect(tasklistCall?.[1]).toContain('PID eq 4242');
      expect(tasklistCall?.[2]).toMatchObject({ windowsHide: true });
    });

    it('treats an unreadable tasklist probe as still-running, never as a confirmed stop', async () => {
      await loadWin32Env();
      const port = await bindAndRelease();

      win32ExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, { 'gateway stop': 'throw', 'tasklist.exe': 'throw' })
      );

      const res = await win32Env.stopOpenClawGateway(
        { isRunning: true, port, pid: 4242 },
        { sleep: async () => {}, confirmTimeoutMs: 20, pollIntervalMs: 1 },
      );

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('stop_confirmation_timeout');
    });

    it('refuses the stop when tasklist still lists the PID', async () => {
      await loadWin32Env();
      const port = await bindAndRelease();

      win32ExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'gateway stop': 'throw',
          'tasklist.exe': 'node.exe  4242 Console  1  12,340 K',
        })
      );

      const res = await win32Env.stopOpenClawGateway(
        { isRunning: true, port, pid: 4242 },
        { sleep: async () => {}, confirmTimeoutMs: 20, pollIntervalMs: 1 },
      );

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('stop_confirmation_timeout');
    });
  });
});
