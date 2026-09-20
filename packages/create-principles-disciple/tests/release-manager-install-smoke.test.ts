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
import * as os from 'node:os';
import { getPdRuntimeDir, getPluginExtDir } from '../src/mvp-config.js';
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
  const actual = await importOriginal<typeof import('../src/utils/env.js')>();
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
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let tempHome = '';
  let realFs: typeof fs;

  beforeEach(async () => {
    realFs = await vi.importActual<typeof fs>('fs');
    vi.clearAllMocks();
    vi.mocked(appendJournalTransition).mockImplementation(() => undefined);
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    // Force the npm-distributed shape: registry resolution is the subject.
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
    // PRI-822：复用既有 smoke 的真实临时目录模式；不扩大 fs mock。
    // getHomeDir 优先 HOME，os.homedir 在 Windows 使用 USERPROFILE，故同时隔离。
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    tempHome = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri822-smoke-home-')));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });
    // Happy filesystem: every component source and runtime probe exists, so
    // the flow reaches the release-manager deployment step.
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json')) return false;
      if (s.endsWith(path.join('.pd', 'state.db'))) return false;
      // The fixture payload carries no embedded product identity stamp —
      // pretending it exists would trip the fail-closed identity parser.
      if (s.endsWith(path.join('_release', 'product-identity.json'))) return false;
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

  function seedPreviousInstall(): void {
    const originalDirs = [getPdRuntimeDir(), getPluginExtDir()];
    for (const originalDir of originalDirs) {
      realFs.mkdirSync(originalDir, { recursive: true });
      realFs.writeFileSync(path.join(originalDir, 'previous-install.txt'), originalDir);
    }
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (!originalDirs.includes(String(source)) && !originalDirs.includes(String(destination))) return;
      realFs.mkdirSync(path.dirname(String(destination)), { recursive: true });
      realFs.renameSync(source, destination);
    });
    vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (originalDirs.includes(String(target))) realFs.rmSync(target, options);
    });
  }

  function expectPreviousInstallRestored(): void {
    const renames = vi.mocked(fs.renameSync).mock.calls;
    for (const originalDir of [getPdRuntimeDir(), getPluginExtDir()]) {
      const backupCalls = renames.filter(([source]) => source === originalDir);
      expect(backupCalls).toHaveLength(1);
      const backupCall = backupCalls[0]!;
      expect(backupCall[1]).not.toBe(originalDir);
      expect(renames).toContainEqual([backupCall[1], originalDir]);
      const restoreIndex = renames.findIndex(([source, destination]) =>
        source === backupCall[1] && destination === originalDir);
      expect(restoreIndex).toBeGreaterThan(renames.indexOf(backupCall));
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.rmSync).mockReset();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    setLanguage('zh');
    if (tempHome !== '') {
      realFs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it.each(['HOME + USERPROFILE', 'USERPROFILE fallback'])('authority 缺失时通过真实导入失败并回滚（%s）', async (homeMode) => {
    // 空的真实临时目录决定导入失败，不再借用机器上恰好缺失的文件。
    if (homeMode === 'USERPROFILE fallback') delete process.env.HOME;
    const runtimeDir = path.join(tempHome, '.pd', 'runtime');
    const authorityPath = path.join(runtimeDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js');
    expect(getPdRuntimeDir()).toBe(runtimeDir);
    expect(realFs.existsSync(authorityPath)).toBe(false);
    seedPreviousInstall();
    const result = await install(
      { ...baseInstallOptions, workspaceDir: path.join(tempHome, 'workspace') },
      path.join(tempHome, 'asset'),
      { quiet: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ReleaseManager authority module failed to load/);
    expect(result.error).toMatch(/Re-run the installer to repair/);
    expect(result.error).toContain('Previous install has been restored');
    expectPreviousInstallRestored();
    for (const originalDir of [runtimeDir, getPluginExtDir()]) {
      expect(realFs.readFileSync(path.join(originalDir, 'previous-install.txt'), 'utf8')).toBe(originalDir);
    }
    // Entry-path probes, split by gate:
    //  - the pre-mutation form gate inspects the PAYLOAD's exact-shape files
    //    (package.json + authority + the registered seam entry);
    //  - the post-install probe loads the INSTALLED seam entry (the Console's
    //    runtime import target) when the component carries it, and only falls
    //    back to the authority entry for a pre-seam asset. This fixture's
    //    existsSync mock answers true, so the seam is the entry probed.
    const seamProbes = vi.mocked(fs.existsSync).mock.calls
      .map(([value]) => String(value))
      .filter((value) => value.endsWith('console-surface.js'));
    const installedSeamPath = path.join(runtimeDir, 'release-manager', 'dist', 'update', 'console-surface.js');
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(installedSeamPath);
    expect([...new Set(seamProbes)]).toEqual([
      path.join(tempHome, 'asset', 'release-manager', 'dist', 'update', 'console-surface.js'),
      installedSeamPath,
    ]);
    // The authority file itself stays a demanded payload entry (form gate +
    // component guard) — the seam is additive, not a replacement.
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
      path.join(tempHome, 'asset', 'release-manager', 'dist', 'update', 'release-manager-authority.js'),
    );
    expect(vi.mocked(fs.renameSync).mock.calls.length).toBeGreaterThan(0);
    for (const [source, destination] of vi.mocked(fs.renameSync).mock.calls) {
      expect(path.relative(tempHome, String(source))).not.toMatch(/^(\.\.|[A-Za-z]:)/);
      expect(path.relative(tempHome, String(destination))).not.toMatch(/^(\.\.|[A-Za-z]:)/);
    }

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
    expect(releaseManagerNpmCall?.[2]).toEqual(expect.objectContaining({
      cwd: path.join(runtimeDir, 'release-manager'),
    }));
  });

  it('临时 HOME 中 authority 的真实依赖缺失时报告加载失败并回滚', async () => {
    const componentDir = path.join(tempHome, '.pd', 'runtime', 'release-manager');
    const authorityPath = path.join(componentDir, 'dist', 'update', 'release-manager-authority.js');
    realFs.mkdirSync(path.dirname(authorityPath), { recursive: true });
    realFs.writeFileSync(path.join(componentDir, 'package.json'), JSON.stringify({ type: 'module' }));
    realFs.writeFileSync(authorityPath, "import './fixture-missing-dependency.js';\n");
    // The installed component carries the real seam shape: console-surface
    // re-exports the authority, so the probe's import chain reaches the
    // broken dependency through the SAME entry the Console imports.
    realFs.writeFileSync(
      path.join(componentDir, 'dist', 'update', 'console-surface.js'),
      "export * from './release-manager-authority.js';\n",
    );

    const result = await install(
      { ...baseInstallOptions, workspaceDir: path.join(tempHome, 'workspace') },
      path.join(tempHome, 'asset'),
      { quiet: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ReleaseManager authority module failed to load/);
    expect(result.error).toContain('fixture-missing-dependency.js');
    expect(result.error).toContain('Previous install has been restored');
    expectPreviousInstallRestored();
    expect(fs.existsSync).toHaveBeenCalledWith(path.join(componentDir, 'dist', 'update', 'console-surface.js'));
  });
});
