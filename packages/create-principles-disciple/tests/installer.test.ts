import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import { validateWorkspacePath, verifyNativeModules, rebuildNativeModules, checkBuiltPlugin } from '../src/installer.js';

vi.mock('fs');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}));

describe('validateWorkspacePath security guard', () => {
  it('accepts path within workspace', () => {
    const workspace = '/home/user/workspace';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });

  it('accepts workspace root itself', () => {
    const workspace = '/home/user/workspace';
    expect(() => validateWorkspacePath(workspace, workspace)).not.toThrow();
  });

  it('rejects path traversal with ..', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/home/user/workspace/../etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('rejects path outside workspace', () => {
    const workspace = '/home/user/workspace';
    const outsidePath = '/home/otheruser/file';
    expect(() => validateWorkspacePath(outsidePath, workspace)).toThrow(/Security error/);
  });

  it('rejects absolute path traversal', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('handles trailing separators correctly', () => {
    const workspace = '/home/user/workspace/';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });
});

describe('Native module verification', () => {
  const mockExecFileSync = vi.mocked(childProcess.execFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifyNativeModules succeeds when modules are loadable', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('verifyNativeModules skips missing modules', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('verifyNativeModules throws when module fails to load', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Cannot load native module');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).toThrow(/verification failed/);
  });
});

describe('checkBuiltPlugin validation', () => {
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockExistsSync = vi.spyOn(fs, 'existsSync');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['hook'] },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid plugin manifest', async () => {
    const pluginDir = '/test/plugin';
    
    await expect(checkBuiltPlugin(pluginDir)).resolves.not.toThrow();
  });

  it('rejects missing dist directory', async () => {
    mockExistsSync.mockImplementation((p) => {
      return !p.toString().includes('dist');
    });

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/Built plugin files missing/);
  });

  it('rejects missing activation object', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/openclaw.plugin.json is missing activation object/);
  });

  it('rejects missing hook capability', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['other'] },
    }));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/does not include "hook"/);
  });
});

describe('installProgress calculation', () => {
  it('progress percentage is calculated correctly', () => {
    const INSTALL_STEPS = [
      { name: 'Step 1', weight: 10 },
      { name: 'Step 2', weight: 20 },
      { name: 'Step 3', weight: 30 },
    ];
    const TOTAL_WEIGHT = INSTALL_STEPS.reduce((sum, s) => sum + s.weight, 0);

    expect(TOTAL_WEIGHT).toBe(60);

    const completedWeight = INSTALL_STEPS.slice(0, 2).reduce((sum, s) => sum + s.weight, 0);
    const percent = Math.round((completedWeight / TOTAL_WEIGHT) * 100);
    
    expect(percent).toBe(50);
  });
});