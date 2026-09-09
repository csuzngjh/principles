/**
 * PRI-697 review P1 — global pd shim lifecycle inside the install
 * transaction.
 *
 * The npm-distributed payload restores the global `pd` shim write (PR
 * #1582). These flow-level tests pin the review's transaction contract:
 *  1. a FRESH install that fails AFTER the shim step removes the shim
 *     files THIS run created (no dangling global `pd` pointing at a
 *     cleaned ~/.pd/runtime — and the failure message tells the truth);
 *  2. a foreign (non-PD) `pd` in the npm global bin dir is never
 *     overwritten — the installer's write side now carries the same
 *     ownership discipline the uninstaller already has (isPdOwnedShim);
 *  3. unit-level: PD-owned pre-existing shims are updated in place and
 *     recorded as replaced, not created — a rolled-back upgrade of a
 *     previously-shimmed install keeps its old global command.
 *
 * Same harness as installer.test.ts (auto-mocked fs + mocked gateway
 * control + real on-disk npm-bundle fixture).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { install, installGlobalPdShim, tryUpgradePdCliFromNpm } from '../src/installer.js';
import { getInstalledBinDir } from '../src/mvp-config.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import { logger } from '../src/utils/logger.js';
import type { InstallOptions } from '../src/prompts.js';

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

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  workspaceDir: '/tmp/pd-697-shim-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

describe('PRI-697 review P1: global pd shim transaction lifecycle', () => {
  let savedLegacyNpmInstall: string | undefined;
  let savedSkipShim: string | undefined;
  let savedSkipUpgrade: string | undefined;
  let savedLang: 'zh' | 'en';
  let fixtureDir: string;
  let globalBinDir: string;
  let realFs: typeof import('node:fs');
  let realPath: typeof import('node:path');
  let infoLines: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    savedSkipShim = process.env.PD_SKIP_GLOBAL_SHIM;
    savedSkipUpgrade = process.env.PD_SKIP_NPM_UPGRADE;
    // npm-distributed payload shape (registry-resolved deps + global shim),
    // no smoke skip envs — the global write is the subject.
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    delete process.env.PD_SKIP_GLOBAL_SHIM;
    delete process.env.PD_SKIP_NPM_UPGRADE;
    savedLang = 'zh';
    setLanguage('en');
    infoLines = [];
    vi.spyOn(logger, 'info').mockImplementation((msg: string) => { infoLines.push(msg); });

    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    realPath = await vi.importActual<typeof import('node:path')>('node:path');

    const tmpRoot = realFs.realpathSync.native(realOs.tmpdir());
    fixtureDir = realFs.mkdtempSync(realPath.join(tmpRoot, 'pd-697-bundle-'));
    globalBinDir = realFs.mkdtempSync(realPath.join(tmpRoot, 'pd-697-globalbin-'));

    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      realFs.mkdirSync(realPath.join(fixtureDir, component, 'dist'), { recursive: true });
      realFs.writeFileSync(realPath.join(fixtureDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
    }
    realFs.mkdirSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};');
    realFs.mkdirSync(realPath.join(fixtureDir, 'console', 'dist', 'web'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'server.js'), 'export {};');
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');

    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    // execFileSync dispatch: `npm prefix -g` (via cmd.exe argv sniffing)
    // resolves to the throwaway globalBinDir so the shim write lands in the
    // test sandbox, never in the real npm global bin. Everything else keeps
    // the module-scope '' stub (deterministic no-op for verification probes
    // etc.); the deployment steps below fail deterministically at the
    // injected point BEFORE any real subprocess can matter.
    const execMock = vi.mocked(childProcess.execFileSync);
    execMock.mockImplementation(((_file: string, argv?: readonly string[]) => {
      if (Array.isArray(argv) && argv.includes('prefix')) return globalBinDir;
      return '';
    }) as typeof childProcess.execFileSync);

    // Happy-ish filesystem: form gate + deployment sources exist (real
    // fixture), no pre-existing install manifest, no workspace state.db.
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json')) return false;
      if (s.endsWith(realPath.join('.pd', 'state.db'))) return false;
      if (s.includes(realPath.join('.pd', 'runtime', 'release-manager'))) return false; // authority smoke fails here
      return realFs.existsSync(s);
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) {
        return JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } });
      }
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      // Files inside the sandbox dirs (npm-bundle fixture + global bin)
      // read from the REAL fs — the ownership classifier must see the
      // actual shim bytes, not a synthetic manifest.
      if (realFs.existsSync(filePath)) return realFs.readFileSync(filePath, 'utf-8');
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    // Real fs delegation for writes: the shim/rollback bookkeeping and the
    // final assertions must observe REAL files in the sandbox dirs.
    vi.mocked(fs.writeFileSync).mockImplementation((p, data) => realFs.writeFileSync(String(p), data as never));
    vi.mocked(fs.mkdirSync).mockImplementation((p, opts) => realFs.mkdirSync(String(p), opts as never));
    vi.mocked(fs.rmSync).mockImplementation((p, opts) => realFs.rmSync(String(p), opts as never));
    vi.mocked(fs.chmodSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.rmSync).mockReset();
    vi.mocked(fs.chmodSync).mockReset();
    for (const [name, value] of [
      ['PD_ALLOW_LEGACY_NPM_INSTALL', savedLegacyNpmInstall],
      ['PD_SKIP_GLOBAL_SHIM', savedSkipShim],
      ['PD_SKIP_NPM_UPGRADE', savedSkipUpgrade],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setLanguage(savedLang);
    if (fixtureDir) realFs.rmSync(fixtureDir, { recursive: true, force: true });
    if (globalBinDir) realFs.rmSync(globalBinDir, { recursive: true, force: true });
  });

  const shimFilesInSandbox = (): string[] =>
    ['pd.cmd', 'pd.ps1', 'pd'].map((name) => realPath.join(globalBinDir, name)).filter((p) => realFs.existsSync(p));

  it('FRESH npm-distributed install that fails after the shim step removes the global pd shim (no dangling command)', async () => {
    // Inject the post-shim failure: the release-manager authority smoke
    // (runs after the pd CLI step) reads as absent → structured failure
    // AFTER syncPdCli wrote the global shim.
    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    // The failure fired at/after the pd-cli step (authority smoke), not at
    // the form gate — proving the shim write happened before it.
    expect(result.reason).not.toMatch(/^npm_bundle_incomplete:/);
    // Core contract: no shim files remain in the global bin dir.
    expect(shimFilesInSandbox()).toEqual([]);
    // The rollback message names what happened — and never claims a clean
    // rollback while a created shim survived.
    expect(result.error).toMatch(/removed|not modified|No changes/);
    if (result.reason.startsWith('install_failed_unactivated_cleaned')) {
      expect(shimFilesInSandbox()).toEqual([]);
    }
  });

  it('never overwrites a foreign (non-PD) pd command in the npm global bin dir', async () => {
    // Pre-existing foreign `pd` in the sandboxed global bin dir: content
    // that does NOT reference the PD install dir.
    const foreignPath = realPath.join(globalBinDir, process.platform === 'win32' ? 'pd.cmd' : 'pd');
    realFs.writeFileSync(foreignPath, '#!/bin/sh\nexec some-other-tool\n', 'utf-8');

    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    // The foreign file is byte-for-byte untouched.
    expect(realFs.readFileSync(foreignPath, 'utf-8')).toBe('#!/bin/sh\nexec some-other-tool\n');
    // No PD-owned shim was written next to it either (the ownership gate
    // refused the whole global-shim step).
    expect(shimFilesInSandbox()).toEqual([foreignPath]);
  });

  it('PD-owned pre-existing shims are updated in place and recorded as replaced, not created', async () => {
    // Drive install() once so activePayloadMode reflects the fixture's
    // npm-distributed shape (the helpers read the module-level mode —
    // the unit assertions below must run under the same mode a real
    // install would set). The run fails at the injected post-shim point.
    const firstRun = await install(baseInstallOptions, fixtureDir, { quiet: true });
    expect(firstRun.success).toBe(false);

    // Pre-existing PD-owned shim content: embeds the REAL installed bin
    // dir path getInstalledBinDir() resolves — exactly what the ownership
    // classifier checks for (uninstaller isPdOwnedShim semantics).
    const installedBinDir = getInstalledBinDir();
    const shimPath = realPath.join(globalBinDir, process.platform === 'win32' ? 'pd.cmd' : 'pd');
    realFs.writeFileSync(shimPath, `#!/bin/sh\nexec "${realPath.join(installedBinDir, 'pd')}" "$@"\n`, 'utf-8');

    const shimResult = installGlobalPdShim();

    expect(shimResult).toMatchObject({ installed: true, skippedForeignPaths: [] });
    const record = shimResult as { installed: boolean; createdPaths: string[]; replacedPaths: string[] };
    expect(record.replacedPaths.some((p) => realPath.resolve(p) === realPath.resolve(shimPath))).toBe(true);
    expect(record.createdPaths).toEqual([]);
    // And the env-gated upgrade path still reports the ACTUAL payload mode.
    expect(tryUpgradePdCliFromNpm('/nonexistent-pd-697')).toBeUndefined();
    expect(infoLines.some((line) => line.includes('Skipping npm pd-cli upgrade (bundled pd-cli is authoritative'))).toBe(true);
    expect(infoLines.some((line) => line.includes('self-contained'))).toBe(false);
  });
});
