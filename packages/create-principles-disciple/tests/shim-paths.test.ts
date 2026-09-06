/**
 * PRI-696 — getGlobalShimPaths must cover every location a pd shim has been
 * observed in, not only the npm prefix. A shim left behind after uninstall
 * becomes a DANGLING command (the user's `pd` fails with a shell error
 * instead of command-not-found), so the uninstall-time scan set has to
 * include the ~/bin location used by operator-created wrappers
 * (ADR-0023 records `~/bin/pd` as an operator-owned redirect).
 *
 * The ownership check itself (isPdOwnedShim content verification) is tested
 * in uninstaller.test.ts; here we only pin the SCAN SET.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

const MOCK_HOME = '/home/shimuser';
const MOCK_NPM_PREFIX = '/home/shimuser/.npm-global';

const { mockHomedir, mockExecSync } = vi.hoisted(() => {
  const mockHomedir = vi.fn(() => MOCK_HOME);
  const mockExecSync = vi.fn(() => MOCK_NPM_PREFIX);
  return { mockHomedir, mockExecSync };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: mockHomedir };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: mockExecSync };
});

import { getGlobalShimPaths, isWindows } from '../src/mvp-config.js';

describe('getGlobalShimPaths scan set (PRI-696)', () => {
  beforeEach(() => {
    mockHomedir.mockReturnValue(MOCK_HOME);
    mockExecSync.mockReturnValue(MOCK_NPM_PREFIX);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes both the npm-prefix location AND the ~/bin location', () => {
    const paths = getGlobalShimPaths();
    const homeBin = path.join(MOCK_HOME, 'bin');
    if (isWindows()) {
      expect(paths).toContain(path.join(MOCK_NPM_PREFIX, 'pd.cmd'));
      expect(paths).toContain(path.join(homeBin, 'pd.cmd'));
      expect(paths).toContain(path.join(homeBin, 'pd.ps1'));
    } else {
      expect(paths).toContain(path.join(MOCK_NPM_PREFIX, 'pd'));
      expect(paths).toContain(path.join(homeBin, 'pd'));
    }
  });

  it('scans BOTH pd.cmd/pd.ps1 (Windows) or the extensionless shim (Unix) at every root', () => {
    const paths = getGlobalShimPaths();
    const homeBin = path.join(MOCK_HOME, 'bin');
    if (isWindows()) {
      expect(paths).toContain(path.join(homeBin, 'pd.cmd'));
      expect(paths).toContain(path.join(homeBin, 'pd.ps1'));
      expect(paths).toContain(path.join(MOCK_NPM_PREFIX, 'pd.ps1'));
    } else {
      expect(paths).toContain(path.join(homeBin, 'pd'));
      expect(paths).toContain(path.join(MOCK_NPM_PREFIX, 'pd'));
      expect(paths.some((p) => p.endsWith('.cmd') || p.endsWith('.ps1'))).toBe(false);
    }
  });

  it('still returns the ~/bin candidates when npm prefix detection fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('npm not found');
    });
    const paths = getGlobalShimPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.startsWith(path.join(MOCK_HOME, 'bin')))).toBe(true);
  });
});
