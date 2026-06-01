import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import { checkEnvironment, detectWorkspace, getOpenClawConfigDir, getPluginExtDir } from '../src/utils/env.js';

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

  describe('detectWorkspace', () => {
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

      expect(result.detectedPath).toBe('/home/user/clawd');
      expect(result.exists).toBe(false);
      expect(result.isFirstInstall).toBe(true);
    });

    it('detects existing workspace with principles', () => {
      delete process.env.OPENCLAW_WORKSPACE;
      delete process.env.PD_WORKSPACE_DIR;
      mockExistsSync.mockImplementation((p: string) => {
        if (p.toString() === '/home/user/clawd') return true;
        if (p.toString() === '/home/user/clawd/.principles/PRINCIPLES.md') return true;
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
        if (p.toString() === '/home/user/clawd') return true;
        if (p.toString() === '/home/user/clawd/.principles/PRINCIPLES.md') return false;
        if (p.toString() === '/home/user/clawd/AGENTS.md') return true;
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
      expect(getOpenClawConfigDir()).toBe('/home/user/.openclaw');
    });
  });

  describe('getPluginExtDir', () => {
    it('returns correct plugin extension directory', () => {
      expect(getPluginExtDir()).toBe('/home/user/.openclaw/extensions/principles-disciple');
    });
  });
});
