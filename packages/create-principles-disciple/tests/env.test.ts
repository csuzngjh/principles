import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { checkEnvironment, detectWorkspace, getOpenClawConfigDir, getPluginExtDir, checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';

vi.mock('fs');
vi.mock('os');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('environment detection utilities', () => {
  const mockExecSync = vi.mocked(childProcess.execSync);
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockHomedir = vi.spyOn(os, 'homedir');
  let savedOpenClawWorkspace: string | undefined;
  let savedPdWorkspaceDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/home/user');
    mockExecSync.mockImplementation(() => '');
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
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('node')) return 'v20.0.0';
        if (cmd.includes('openclaw')) return 'OpenClaw 1.0.0';
        if (cmd.includes('python3')) return 'Python 3.11.0';
        if (cmd.includes('git')) return 'git version 2.40.0';
        throw new Error('not found');
      });

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
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('node')) return 'v20.0.0';
        if (cmd.includes('openclaw')) throw new Error('not found');
        if (cmd.includes('clawd')) return 'clawd 2.0.0';
        throw new Error('not found');
      });

      const result = checkEnvironment();

      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('clawd 2.0.0');
    });

    it('returns false when tools are not available', () => {
      mockExecSync.mockImplementation(() => {
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
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('openclaw --version') || cmd.includes('clawd --version')) {
          return 'openclaw 1.2.0';
        }
        return '';
      });
      const result = checkEnvironment();
      expect(result.hasOpenClaw).toBe(true);
      expect(result.openclawVersion).toBe('openclaw 1.2.0');
    });

    it('Given OpenClaw is missing, When checkEnvironment runs, Then hasOpenClaw is false and version is absent', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('openclaw --version') || cmd.includes('clawd --version')) {
          throw new Error('command not found');
        }
        return 'v18.0.0';
      });
      const result = checkEnvironment();
      expect(result.hasOpenClaw).toBe(false);
      expect(result.openclawVersion).toBeUndefined();
    });

    it('Given only clawd alias is available, When checkEnvironment runs, Then hasOpenClaw is true via fallback', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('openclaw --version')) {
          throw new Error('not found');
        }
        if (cmd.includes('clawd --version')) {
          return 'clawd 2.1.3';
        }
        return 'v20.0.0';
      });
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
      mockExecSync.mockImplementation(() => '');
      const res = await stopOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('openclaw gateway stop', expect.objectContaining({ timeout: 15000 }));
    });

    it('restartOpenClawGateway returns ok:true and invokes "openclaw gateway start"', async () => {
      mockExecSync.mockImplementation(() => '');
      const res = await restartOpenClawGateway();
      expect(res.ok).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('openclaw gateway start', expect.objectContaining({ timeout: 15000 }));
    });

    // rc-9: control helpers must NEVER throw — they degrade with a structured
    // reason so the installer can emit nextAction instead of crashing.
    it('stopOpenClawGateway returns ok:false (does not throw) when execSync throws', async () => {
      mockExecSync.mockImplementation(() => { throw new Error('service not found'); });
      const res = await stopOpenClawGateway();
      expect(res.ok).toBe(false);
      expect(res.error).toContain('openclaw gateway stop');
      expect(res.error).toMatch(/failed/);
    });

    it('restartOpenClawGateway returns ok:false (does not throw) when execSync throws', async () => {
      mockExecSync.mockImplementation(() => { throw new Error('boom'); });
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
});
