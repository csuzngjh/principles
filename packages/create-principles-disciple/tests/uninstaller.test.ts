import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import { isPdOwnedShim, checkInstallStatus, parseConsoleProcessCsv } from '../src/uninstaller.js';
import { getInstalledBinDir, isWindows } from '../src/mvp-config.js';

vi.mock('fs');
vi.mock('fs-extra');
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

  // Regression (CodeRabbit PR #1298 finding): ~/.codex/hooks.json MUST NOT
  // appear in the deletion paths. It is a shared host config file whose PD
  // entries are cleaned by CodexHostInstaller.uninstall() via __pd_marker
  // filtering. If listed here, the generic delete loop would delete the entire
  // file, destroying the user's non-PD Codex hooks (data loss).
  it('does NOT include ~/.codex/hooks.json in deletion paths', () => {
    mockExistsSync.mockReturnValue(true);

    const result = checkInstallStatus();

    const hooksJsonEntry = result.paths.find(p => p.path.endsWith('.codex') && p.path.includes('hooks.json'));
    expect(hooksJsonEntry).toBeUndefined();
    // Sanity: the path must not appear anywhere in the paths list
    expect(result.paths.some(p => p.path.includes(path.join('.codex', 'hooks.json')))).toBe(false);
  });

  // Regression: a user who merely has ~/.codex/hooks.json (but never installed
  // PD) must NOT be reported as "installed" — that would launch the delete
  // loop against hooks.json. isInstalled must key off PD-owned markers only.
  it('isInstalled is false when only ~/.codex/hooks.json exists (no PD markers)', () => {
    mockExistsSync.mockImplementation((p) => {
      // Only hooks.json exists — no PD marker, no wrapper, no OpenClaw files
      return p.toString().includes(path.join('.codex', 'hooks.json'));
    });

    const result = checkInstallStatus();

    expect(result.isInstalled).toBe(false);
  });
});

describe('parseConsoleProcessCsv (PRI-710 — PowerShell Get-CimInstance, supersedes wmic)', () => {
  const consoleEntry = 'C:\\Users\\u\\.pd\\runtime\\console\\dist\\server.js';

  // Fixture shape captured from a REAL run on a Windows host (2026-09-08,
  // PRI-710 evidence): header quoted, embedded quotes doubled, backslashes
  // NOT escaped (wmic escaped them; ConvertTo-Csv does not).
  const realShapeHeader = '"ProcessId","CommandLine"';

  it('extracts the PID from real-shape ConvertTo-Csv output (unquoted path row)', () => {
    const output = [
      realShapeHeader,
      `"42872","node C:\\Users\\u\\.pd\\runtime\\console\\dist\\server.js --port 3100"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([{ pid: 42872 }]);
  });

  it('parses quoted argv with doubled embedded quotes and a comma inside the CommandLine', () => {
    const output = [
      realShapeHeader,
      // The comma inside --label is the point of this test: splitCsvLine
      // must NOT split the row there — a wrong split shifts the CommandLine
      // field and the consoleEntry match must fail (CodeRabbit, PR #1575).
      `"40480","""D:\\Program Files\\nodejs\\node.exe"" --label ""alpha,beta"" ""${consoleEntry}"" --workspace ""D:\\ws (2)"" --port 3100"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([{ pid: 40480 }]);
  });

  it('locates columns by header name (ProcessId/CommandLine reorder-proof)', () => {
    const output = [
      '"CommandLine","ProcessId"',
      `"node ${consoleEntry}",777`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([{ pid: 777 }]);
  });

  it('refuses to guess columns on an unrecognized header (rc-3 fail closed)', () => {
    const output = [
      '"Node","Host","ProcessId"',
      `"node.exe,HOSTNAME,58628"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([]);
  });

  it('ignores rows that do not reference the console entry', () => {
    const output = [
      realShapeHeader,
      '"1111","node some-other-server.js --port 3100"',
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([]);
  });

  it('ignores rows with an empty CommandLine (CIM null renders as empty field)', () => {
    const output = [
      realShapeHeader,
      `"2222",""`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([]);
  });

  it('ignores the uninstaller process itself', () => {
    const ownPid = process.pid;
    const output = [
      realShapeHeader,
      `"${ownPid}","node ${consoleEntry}"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([]);
  });

  it('ignores non-numeric or non-positive PIDs', () => {
    const output = [
      realShapeHeader,
      `"","node ${consoleEntry}"`,
      `"-5","node ${consoleEntry}"`,
      `"abc","node ${consoleEntry}"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([]);
  });

  it('collapses duplicate PIDs (CIM can surface the same process twice)', () => {
    const output = [
      realShapeHeader,
      `"58628","node ${consoleEntry} --port 3100"`,
      `"58628","node ${consoleEntry} --port 3100"`,
    ].join('\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([{ pid: 58628 }]);
  });

  it('handles CRLF output and a UTF-8 BOM before the header', () => {
    const output = '\uFEFF' + [
      realShapeHeader,
      `"58628","node ${consoleEntry}"`,
    ].join('\r\n');
    expect(parseConsoleProcessCsv(output, consoleEntry)).toEqual([{ pid: 58628 }]);
  });

  it('handles empty output', () => {
    expect(parseConsoleProcessCsv('', consoleEntry)).toEqual([]);
  });
});
