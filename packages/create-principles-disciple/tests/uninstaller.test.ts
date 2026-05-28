import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isPdOwnedShim, checkInstallStatus } from '../src/uninstaller.js';
import { getInstalledBinDir, isWindows } from '../src/mvp-config.js';

vi.mock('fs');
vi.mock('../src/mvp-config.js', () => ({
  getInstalledBinDir: vi.fn(() => '/home/user/.openclaw/extensions/principles-disciple/bin'),
  isWindows: vi.fn(() => false),
}));

describe('isPdOwnedShim security verification', () => {
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockGetInstalledBinDir = vi.mocked(getInstalledBinDir);
  const mockIsWindows = vi.mocked(isWindows);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstalledBinDir.mockReturnValue('/home/user/.openclaw/extensions/principles-disciple/bin');
    mockIsWindows.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for PD-owned shim (Unix)', () => {
    const pdBinDir = '/home/user/.openclaw/extensions/principles-disciple/bin';
    const shimPath = '/usr/local/bin/pd';
    
    mockReadFileSync.mockReturnValue(`#!/usr/bin/env sh\nexec "${pdBinDir}/pd" "$@"\n`);

    expect(isPdOwnedShim(shimPath)).toBe(true);
  });

  it('returns true for PD-owned shim (Windows cmd)', () => {
    const pdBinDir = 'C:\\Users\\user\\.openclaw\\extensions\\principles-disciple\\bin';
    const shimPath = 'C:\\Program Files\\npm\\bin\\pd.cmd';
    
    mockGetInstalledBinDir.mockReturnValue(pdBinDir);
    mockIsWindows.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`@echo off\r\ncall "${pdBinDir}\\pd.cmd" %*\r\n`);

    expect(isPdOwnedShim(shimPath)).toBe(true);
  });

  it('returns false for non-PD shim', () => {
    const shimPath = '/usr/local/bin/pd';
    
    mockReadFileSync.mockReturnValue(`#!/usr/bin/env sh\nexec "/some/other/pd" "$@"\n`);

    expect(isPdOwnedShim(shimPath)).toBe(false);
  });

  it('returns false when file read fails', () => {
    const shimPath = '/usr/local/bin/pd';
    
    mockReadFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    expect(isPdOwnedShim(shimPath)).toBe(false);
  });

  it('returns false for empty content', () => {
    const shimPath = '/usr/local/bin/pd';
    
    mockReadFileSync.mockReturnValue('');

    expect(isPdOwnedShim(shimPath)).toBe(false);
  });
});

describe('checkInstallStatus', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns isInstalled true when paths exist', () => {
    mockExistsSync.mockReturnValue(true);

    const result = checkInstallStatus();
    
    expect(result.isInstalled).toBe(true);
    expect(result.paths.length).toBeGreaterThan(0);
  });

  it('returns isInstalled false when no paths exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = checkInstallStatus();
    
    expect(result.isInstalled).toBe(false);
  });

  it('correctly identifies existing paths', () => {
    mockExistsSync.mockImplementation((p) => {
      return p.toString().includes('extension');
    });

    const result = checkInstallStatus();
    
    expect(result.paths.some(p => p.exists && p.path.includes('extension'))).toBe(true);
    expect(result.paths.some(p => !p.exists && p.path.includes('principles-disciple.json'))).toBe(true);
  });
});