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
          'node -v': 'v20.0.0',
          'openclaw --version': 'OpenClaw 1.0.0',
          'python3 --version': 'Python 3.11.0',
          'git --version': 'git version 2.40.0',
        })
      );

      const result = checkEnvironment();

      expect(result.hasNode).toBe(true);
      expect(result.nodeVersion).toBe('v20.0.0');
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('OpenClaw 1.0.0');
      expect(result.hasPython).toBe(true);
      expect(result.pythonVersion).toBe('3.11.0');
      expect(result.hasGit).toBe(true);
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

    // PRI-605: win32 上 python.org 安装常只提供 python.exe，python3 不在 PATH。
    // 该回退是 win32 专属行为，仅在本机（win32）验证，Linux CI 上跳过。
    it.skipIf(process.platform !== 'win32')('falls back to python when python3 is absent on win32', () => {
      mockExecFileSync.mockImplementation((binary: string, args: string[]) =>
        routeByCommand(binary, args, {
          'node -v': 'v20.0.0',
          'python3 --version': 'throw',
          'python --version': 'Python 3.12.0',
        })
      );

      const result = checkEnvironment();

      expect(result.hasPython).toBe(true);
      expect(result.pythonVersion).toBe('3.12.0');
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
    it('stopOpenClawGateway returns ok:true and invokes "openclaw gateway stop"', async () => {
      mockExecFileSync.mockImplementation(() => '');
      const res = await stopOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(joinedCall(mockExecFileSync.mock.calls[0])).toContain('openclaw gateway stop');
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
});
