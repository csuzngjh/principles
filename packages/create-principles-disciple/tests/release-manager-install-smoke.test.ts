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
import { productIdentityStampJson } from './helpers/payload-identity.js';

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

// PRI-874: a real train payload carries the embedded product identity stamp,
// so the mocked fixture answers the identity gate's strict read with a VALID
// stamp (unstamped payloads are refused before the steps under test).
const STAMP_CONTENT = productIdentityStampJson('1.74.1');

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
      // The PD workspace declaration is a real file the install preflight
      // reads/never overwrites: answer from the throwaway HOME, not `true`.
      if (s.endsWith('principles-disciple.json')) return realFs.existsSync(s);
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) return PLUGIN_MANIFEST;
      if (filePath.endsWith(path.join('_release', 'product-identity.json'))) return STAMP_CONTENT;
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      // Only reached when the real throwaway HOME actually holds the file.
      if (filePath.endsWith('principles-disciple.json')) return realFs.readFileSync(filePath, 'utf8');
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    // PRI-1102: the installer now inspects install targets with lstat (an
    // automock would answer `undefined` = "missing" for every path, which
    // contradicts the real seeded trees). Answer from the real filesystem so
    // the harness keeps modelling an actual install. `throwIfNoEntry: false`
    // must return undefined for a truly absent path AND still report a link
    // that exists but does not resolve (a dangling junction) — gating on
    // existsSync would follow the link and erase it.
    vi.mocked(fs.lstatSync).mockImplementation(((value: fs.PathLike, options?: fs.StatOptions) => {
      if (options && typeof options === 'object' && options.throwIfNoEntry === false) {
        return realFs.lstatSync(String(value), { throwIfNoEntry: false });
      }
      return realFs.lstatSync(String(value));
    }) as unknown as typeof fs.lstatSync);
  });

  function seedPreviousInstall(): void {
    const originalDirs = [getPdRuntimeDir(), getPluginExtDir()];
    for (const originalDir of originalDirs) {
      realFs.mkdirSync(originalDir, { recursive: true });
      realFs.writeFileSync(path.join(originalDir, 'previous-install.txt'), originalDir);
    }
    seedHealthyComponentTree(getPdRuntimeDir(), getPluginExtDir());
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (!originalDirs.includes(String(source)) && !originalDirs.includes(String(destination))) return;
      realFs.mkdirSync(path.dirname(String(destination)), { recursive: true });
      realFs.renameSync(source, destination);
    });
    vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (originalDirs.includes(String(target))) realFs.rmSync(target, options);
    });
  }

  /**
   * PRI-1102: a "restored" pre-run state is only usable when the component
   * entries exist. Seed what a healthy previous install leaves on disk.
   */
  function seedHealthyComponentTree(runtimeDir: string, extDir: string): void {
    const consoleDist = path.join(runtimeDir, 'console', 'dist');
    realFs.mkdirSync(path.join(consoleDist, 'web'), { recursive: true });
    realFs.writeFileSync(path.join(consoleDist, 'server.js'), '// console\n');
    realFs.writeFileSync(path.join(consoleDist, 'web', 'index.html'), '<html></html>\n');

    const cliDist = path.join(runtimeDir, 'pd-cli', 'dist');
    realFs.mkdirSync(cliDist, { recursive: true });
    realFs.writeFileSync(path.join(cliDist, 'index.js'), '// cli\n');

    const runtimePlugin = path.join(runtimeDir, 'plugin');
    realFs.mkdirSync(path.join(runtimePlugin, 'dist'), { recursive: true });
    realFs.writeFileSync(path.join(runtimePlugin, 'dist', 'bundle.js'), '// plugin\n');
    realFs.writeFileSync(path.join(runtimePlugin, 'openclaw.plugin.json'), '{}');

    realFs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    realFs.writeFileSync(path.join(extDir, 'dist', 'bundle.js'), '// ext plugin\n');
    realFs.writeFileSync(path.join(extDir, 'openclaw.plugin.json'), '{}');
    realFs.writeFileSync(path.join(extDir, 'package.json'), '{}');
  }

  function expectPreviousInstallRestored(): void {
    const renames = vi.mocked(fs.renameSync).mock.calls;
    for (const originalDir of [getPdRuntimeDir(), getPluginExtDir()]) {
      // G1 P0-3 (rename-aside restore): the live tree moves out to a backup
      // once; the restore may additionally ATTEMPT a quarantine aside of the
      // live dir (ENOENT here — the mocked existsSync says present while the
      // real tree already moved). Load-bearing: exactly one backup move-out,
      // and the backup lands BACK on the original dir after it, in order.
      const movesOut = renames.filter(([source]) => source === originalDir);
      const backupCall = movesOut.find(([, destination]) => !String(destination).includes('restore-quarantine'));
      expect(backupCall).toBeDefined();
      expect(backupCall![1]).not.toBe(originalDir);
      expect(renames).toContainEqual([backupCall![1], originalDir]);
      const restoreIndex = renames.findIndex(([source, destination]) =>
        source === backupCall![1] && destination === originalDir);
      expect(restoreIndex).toBeGreaterThan(renames.indexOf(backupCall!));
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.rmSync).mockReset();
    vi.mocked(fs.realpathSync).mockReset();
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
    // PRI-1102: this fixture seeds only the runtime component tree — there is
    // no extension tree to return to, so the rollback must name the gap
    // instead of claiming a healthy "restored" install.
    expect(result.error).toContain('but that state is NOT usable — incomplete:');
    expect(result.error).toContain(getPluginExtDir());
    expectPreviousInstallRestored();
    expect(fs.existsSync).toHaveBeenCalledWith(path.join(componentDir, 'dist', 'update', 'console-surface.js'));
  });

  it('rolls back to an incomplete runtime and names missing Console + dangling extension (PRI-1102)', async () => {
    const runtimeDir = getPdRuntimeDir();
    const extDir = getPluginExtDir();
    seedHealthyComponentTree(runtimeDir, extDir);
    // Pre-run state: Console component never finished, extension copy is a
    // dangling NTFS junction left by an interrupted install.
    realFs.rmSync(path.join(runtimeDir, 'console'), { recursive: true, force: true });
    realFs.rmSync(extDir, { recursive: true, force: true });
    const ghost = path.join(tempHome, 'ghost-extension-target');
    realFs.mkdirSync(ghost, { recursive: true });
    realFs.symlinkSync(ghost, extDir, 'junction');
    realFs.rmSync(ghost, { recursive: true, force: true });
    expect(realFs.lstatSync(extDir).isSymbolicLink()).toBe(true);

    const originalDirs = [runtimeDir, extDir];
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (!originalDirs.includes(String(source)) && !originalDirs.includes(String(destination))) return;
      realFs.mkdirSync(path.dirname(String(destination)), { recursive: true });
      realFs.renameSync(source, destination);
    });
    vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (originalDirs.includes(String(target))) realFs.rmSync(target, options);
    });
    // Only the extension link is resolved for real: the production link
    // resolver must observe the dangling junction. Other paths keep the
    // harness's automocked value (a full real resolver would not exist here).
    vi.mocked(fs.realpathSync).mockImplementation(((value: fs.PathLike) => {
      const s = String(value);
      if (s === extDir) return realFs.realpathSync(s);
      return undefined as unknown as string;
    }) as unknown as typeof fs.realpathSync);

    const result = await install(
      { ...baseInstallOptions, workspaceDir: path.join(tempHome, 'workspace') },
      path.join(tempHome, 'asset'),
      { quiet: true },
    );

    expect(result.success).toBe(false);
    // Acceptance: a rollback that lands on a state missing a key component
    // must NEVER be reported as "Previous install has been restored".
    expect(result.error).toContain('NOT usable — incomplete:');
    expect(result.error).not.toContain('Previous install has been restored.');
    expect(result.error).toContain(path.join(runtimeDir, 'console'));
    expect(result.error).toContain(extDir);
    expect(result.error).toContain('dangling link');
    // The restored pre-run state is what it was — including the dirty junction.
    expect(realFs.lstatSync(extDir).isSymbolicLink()).toBe(true);
    expectPreviousInstallRestored();
  });
});
