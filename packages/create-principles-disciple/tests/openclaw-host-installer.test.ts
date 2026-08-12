/**
 * Regression tests for OpenClawHostInstaller.writeInstallRecord (PR #1300).
 *
 * Covers the nested-field validation added per CodeRabbit #3762804744:
 * when installs.json parses to a top-level object but its `installRecords`
 * field is null/array/string, writeInstallRecord MUST return without writing
 * (rc-3/rc-9), preserving the original file instead of overwriting it with
 * an empty installRecords object.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { OpenClawHostInstaller } from '../src/installers/openclaw-host-installer.js';

// Mock fs (hoisted before imports).
vi.mock('fs');
// Mock mvp-config helpers used by writeInstallRecord.
vi.mock('../src/mvp-config.js', () => ({
  getOpenClawDir: vi.fn(() => '/home/user/.openclaw'),
  getPluginExtDir: vi.fn(() => '/home/user/.openclaw/extensions/principles-disciple'),
  isWindows: vi.fn(() => false),
}));

describe('OpenClawHostInstaller.writeInstallRecord — nested installRecords validation (rc-3/rc-9)', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockWriteFileSync = vi.spyOn(fs, 'writeFileSync');
  const mockMkdirSync = vi.spyOn(fs, 'mkdirSync');

  // Access the private method via type narrowing. writeInstallRecord is
  // private on the class but exercised here through a typed cast to keep
  // the test focused on the data-integrity contract.
  type OpenClawHostInstallerWithInternals = OpenClawHostInstaller & {
    writeInstallRecord(configDir: string): void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // installs dir exists; package.json reads succeed with a version.
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves installs.json when installRecords is null (CodeRabbit #3762804744)', () => {
    // Top-level object, but installRecords is null — must NOT overwrite.
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = p.toString();
      if (s.endsWith('installs.json')) {
        return JSON.stringify({ version: 1, installRecords: null });
      }
      if (s.endsWith('package.json')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      throw new Error(`unexpected read: ${s}`);
    });

    const installer = new OpenClawHostInstaller() as OpenClawHostInstallerWithInternals;
    installer.writeInstallRecord('/home/user/.openclaw');

    // No writeFileSync call targeting installs.json should occur.
    const installsWrite = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('installs.json'),
    );
    expect(installsWrite).toBeUndefined();
  });

  it('preserves installs.json when installRecords is an array', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = p.toString();
      if (s.endsWith('installs.json')) {
        return JSON.stringify({ version: 1, installRecords: ['not', 'an', 'object'] });
      }
      if (s.endsWith('package.json')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      throw new Error(`unexpected read: ${s}`);
    });

    const installer = new OpenClawHostInstaller() as OpenClawHostInstallerWithInternals;
    installer.writeInstallRecord('/home/user/.openclaw');

    const installsWrite = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('installs.json'),
    );
    expect(installsWrite).toBeUndefined();
  });

  it('preserves installs.json when installRecords is a string', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = p.toString();
      if (s.endsWith('installs.json')) {
        return JSON.stringify({ version: 1, installRecords: 'bad' });
      }
      if (s.endsWith('package.json')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      throw new Error(`unexpected read: ${s}`);
    });

    const installer = new OpenClawHostInstaller() as OpenClawHostInstallerWithInternals;
    installer.writeInstallRecord('/home/user/.openclaw');

    const installsWrite = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('installs.json'),
    );
    expect(installsWrite).toBeUndefined();
  });

  it('initializes installRecords to {} when field is missing (compatible format)', () => {
    // No installRecords field at all — compatible, should proceed and write.
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = p.toString();
      if (s.endsWith('installs.json')) {
        return JSON.stringify({ version: 1 });
      }
      if (s.endsWith('package.json')) {
        return JSON.stringify({ version: '1.0.0' });
      }
      throw new Error(`unexpected read: ${s}`);
    });

    const installer = new OpenClawHostInstaller() as OpenClawHostInstallerWithInternals;
    installer.writeInstallRecord('/home/user/.openclaw');

    const installsWrite = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('installs.json'),
    );
    expect(installsWrite).toBeDefined();
    // The written content should include an installRecords object with PD entry.
    const written = JSON.parse(installsWrite![1] as string);
    expect(written.installRecords).toBeDefined();
    expect(written.installRecords['principles-disciple']).toBeDefined();
  });
});
