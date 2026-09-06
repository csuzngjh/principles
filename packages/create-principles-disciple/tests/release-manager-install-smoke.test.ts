/**
 * PR #1525 review — release-manager dependency installation + authority
 * import smoke wiring.
 *
 * Contracts under test (flow-level over install(), same harness as
 * installer-journal.test.ts):
 * 1. npm-distributed shape: the installed release-manager/ payload ships as
 *    package.json + dist only, so the installer MUST run registry resolution
 *    (npm install) in that component directory — without it, the authority
 *    module's static import chain (release-manager → trust-metadata → tuf-js)
 *    cannot resolve.
 * 2. The REAL authority module import is smoked at install time: when the
 *    module graph cannot load, the install fails loudly here with a
 *    structured message instead of surfacing later as `installer_missing` in
 *    the console.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { install } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';
import { appendJournalTransition } from '../src/update/transaction-journal.js';

vi.mock('fs');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
}));
vi.mock('../src/utils/env.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(),
    stopOpenClawGateway: vi.fn(),
    restartOpenClawGateway: vi.fn(),
  };
});
vi.mock('../src/update/transaction-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/transaction-journal.js')>();
  return {
    ...actual,
    appendJournalTransition: vi.fn(),
  };
});

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  workspaceDir: '/tmp/pd-rm-smoke-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

const PLUGIN_MANIFEST = JSON.stringify({
  name: 'principles-disciple',
  activation: { onCapabilities: ['hook'] },
});

describe('install() release-manager dependency install + authority import smoke (PR #1525 review)', () => {
  let savedLegacyNpmInstall: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appendJournalTransition).mockImplementation(() => undefined);
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    // Force the npm-distributed shape: registry resolution is the subject.
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });
    // Happy filesystem: every component source and runtime probe exists, so
    // the flow reaches the release-manager deployment step.
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json')) return false;
      if (s.endsWith(path.join('.pd', 'state.db'))) return false;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) return PLUGIN_MANIFEST;
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    setLanguage('zh');
  });

  it('runs npm install in the installed release-manager dir and fails loudly when the authority graph cannot load', async () => {
    // The authority path exists per the fs mock, but the REAL file is absent
    // in the test environment — the import must fail and the installer must
    // report it with a structured, actionable message (rc-9), never silently
    // continue.
    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ReleaseManager authority module failed to load/);
    expect(result.error).toMatch(/Re-run the installer to repair/);

    // Registry resolution ran for the release-manager component directory —
    // the exact gap the review found (payload ships no node_modules).
    const { execFileSync } = await import('child_process');
    const releaseManagerNpmCall = vi.mocked(execFileSync).mock.calls.find((call) => {
      const argv = call[1] as string[] | undefined;
      const opts = call[2] as { cwd?: string } | undefined;
      return Array.isArray(argv)
        && argv.some((a) => String(a) === 'install')
        && typeof opts?.cwd === 'string'
        && /[\\/]release-manager$/.test(opts.cwd.replace(/[\\/]+$/, ''));
    });
    expect(releaseManagerNpmCall, 'expected npm install to run with cwd=<runtime>/release-manager').toBeDefined();
  });
});
