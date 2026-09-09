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
 *  3. PD-owned pre-existing shims are updated in place and recorded as
 *     replaced, not created — a rolled-back upgrade of a previously-
 *     shimmed install keeps its old global command.
 *
 * Sandbox discipline (non-negotiable): getHomeDir() reads process.env.HOME
 * first, so redirecting HOME/USERPROFILE at a throwaway temp root places
 * EVERY installed path (~/.pd, ~/.openclaw) inside the sandbox. `fs` is
 * fully delegated to the real module — safe because no product path can
 * escape the sandbox root — while `child_process` is mocked (no real npm /
 * node spawns). The global bin dir also lives inside the sandbox.
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
  // Overwritten per-test with the sandbox workspace path.
  workspaceDir: '/tmp/pd-697-shim-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

const SHIM_BASENAMES = process.platform === 'win32' ? ['pd.cmd', 'pd.ps1'] : ['pd'];

describe('PRI-697 review P1: global pd shim transaction lifecycle', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let globalBinDir: string;
  let fixtureDir: string;
  let workspaceDir: string;
  let realFs: typeof import('node:fs');
  let realPath: typeof import('node:path');
  let infoLines: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PD_ALLOW_LEGACY_NPM_INSTALL: process.env.PD_ALLOW_LEGACY_NPM_INSTALL,
      PD_SKIP_GLOBAL_SHIM: process.env.PD_SKIP_GLOBAL_SHIM,
      PD_SKIP_NPM_UPGRADE: process.env.PD_SKIP_NPM_UPGRADE,
    };
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    realPath = await vi.importActual<typeof import('node:path')>('node:path');

    sandboxRoot = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'pd-697-sandbox-')));
    // The dir where the global pd shims land. getNpmGlobalBinDir() uses the
    // `npm prefix -g` output AS the bin dir on Windows but appends /bin on
    // POSIX — the mocked probe below returns the matching prefix shape so
    // both platforms resolve to the SAME globalBinDir under assertion.
    globalBinDir = realPath.join(sandboxRoot, 'npm-global', 'bin');
    const npmPrefixForProbe = process.platform === 'win32' ? globalBinDir : realPath.join(sandboxRoot, 'npm-global');
    fixtureDir = realPath.join(sandboxRoot, 'bundle');
    workspaceDir = realPath.join(sandboxRoot, 'ws');
    realFs.mkdirSync(globalBinDir, { recursive: true });
    realFs.mkdirSync(workspaceDir, { recursive: true });

    // HOME redirect: every installed path (~/.pd, ~/.openclaw) now resolves
    // INSIDE the sandbox — the precondition that makes real-fs delegation
    // safe. Both vars, matching getHomeDir()'s lookup order (and Windows).
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    // npm-distributed payload shape (registry-resolved deps + global shim),
    // no smoke skip envs — the global write is the subject.
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    delete process.env.PD_SKIP_GLOBAL_SHIM;
    delete process.env.PD_SKIP_NPM_UPGRADE;

    setLanguage('en');
    infoLines = [];
    vi.spyOn(logger, 'info').mockImplementation((msg: string) => { infoLines.push(msg); });

    // npm-distributed bundle fixture: package.json + dist per component,
    // exact-shape extras the form-gate demands, the plugin manifest
    // checkBuiltPlugin reads, a pd-cli entry file for syncPdCli, and a CJS
    // authority module the real dynamic import in
    // verifyReleaseManagerAuthorityImports can load on ANY machine (never
    // the host's live runtime).
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      realFs.mkdirSync(realPath.join(fixtureDir, component, 'dist'), { recursive: true });
      realFs.writeFileSync(realPath.join(fixtureDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
    }
    realFs.writeFileSync(realPath.join(fixtureDir, 'plugin', 'openclaw.plugin.json'), JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } }));
    realFs.writeFileSync(realPath.join(fixtureDir, 'pd-cli', 'dist', 'index.js'), 'module.exports = {};\n');
    realFs.mkdirSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'module.exports = {};\n');
    realFs.mkdirSync(realPath.join(fixtureDir, 'console', 'dist', 'web'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'server.js'), 'module.exports = {};\n');
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');

    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    // execFileSync dispatch (never a real subprocess):
    //  - `npm prefix -g` → the sandbox global bin dir,
    //  - any `--version` probe → THROW (the post-shim failure injection:
    //    verifyPdCliShim's local probe runs AFTER syncPdCli wrote the
    //    global shim, so the catch path must roll the shim back),
    //  - everything else (npm install, etc.) → '' (silent no-op).
    const execMock = vi.mocked(childProcess.execFileSync);
    execMock.mockImplementation(((_file: string, argv?: readonly string[]) => {
      if (Array.isArray(argv) && argv.includes('prefix')) return npmPrefixForProbe;
      if (Array.isArray(argv) && argv.includes('--version')) throw new Error('injected version-probe failure (PRI-697 test)');
      return '';
    }) as typeof childProcess.execFileSync);

    // Real fs across the board — safe by the HOME redirect above. The
    // transaction journal, backups, component copies, junctions, local and
    // global shims all land inside the sandbox and the assertions observe
    // REAL on-disk state.
    const fsMock = vi.mocked(fs) as unknown as Record<string, { mockImplementation: (impl: never) => void }>;
    for (const key of Object.keys(realFs)) {
      const value = (realFs as unknown as Record<string, unknown>)[key];
      const mock = fsMock[key];
      if (typeof value === 'function' && mock && typeof mock.mockImplementation === 'function') {
        mock.mockImplementation(((...args: unknown[]) => (value as (...a: unknown[]) => unknown)(...args)) as never);
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setLanguage('zh');
    if (sandboxRoot) realFs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  const shimFilesInGlobalBin = (): string[] =>
    SHIM_BASENAMES.map((name) => realPath.join(globalBinDir, name)).filter((p) => realFs.existsSync(p));

  it('FRESH npm-distributed install that fails AFTER the shim step removes the global pd shim it created', async () => {
    const result = await install({ ...baseInstallOptions, workspaceDir }, fixtureDir, { quiet: true });

    // The run must have gotten past the shim write and died at the
    // injected pd-cli verification failure — NOT at some earlier gate.
    expect(result.success).toBe(false);
    expect(result.reason).not.toMatch(/^npm_bundle_incomplete:/);
    expect(result.reason).not.toMatch(/^transaction_journal_unavailable:/);
    expect(result.error).toMatch(/PD CLI verification failed/);
    // The injected failure fired AFTER installGlobalPdShim: the pre-fix
    // bug (createdPaths never populated) left the shims on disk here.
    expect(shimFilesInGlobalBin()).toEqual([]);
    // Fresh-install cleanup ran alongside: the sandbox runtime is gone.
    expect(realFs.existsSync(realPath.join(sandboxRoot, '.pd', 'runtime'))).toBe(false);
    expect(result.reason).toMatch(/^install_failed_unactivated_cleaned:/);
  });

  it('never overwrites a foreign (non-PD) pd command in the npm global bin dir', async () => {
    const foreignPath = realPath.join(globalBinDir, SHIM_BASENAMES[0]);
    realFs.writeFileSync(foreignPath, '#!/bin/sh\nexec some-other-tool\n', 'utf-8');

    const result = await install({ ...baseInstallOptions, workspaceDir }, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    // The foreign file is byte-for-byte untouched.
    expect(realFs.readFileSync(foreignPath, 'utf-8')).toBe('#!/bin/sh\nexec some-other-tool\n');
    // The ownership gate refused the whole global-shim step: no PD-owned
    // shim was written next to it.
    expect(shimFilesInGlobalBin()).toEqual([foreignPath]);
  });

  it('PD-owned pre-existing shims are updated in place and recorded as replaced, not created', async () => {
    // Drive install() once so activePayloadMode reflects the fixture's
    // npm-distributed shape (the helpers read the module-level mode; the
    // unit assertions below must run under the mode a real install sets).
    // It fails at the injected verification point, as in test 1.
    const firstRun = await install({ ...baseInstallOptions, workspaceDir }, fixtureDir, { quiet: true });
    expect(firstRun.success).toBe(false);

    // Pre-existing PD-owned shim: embeds the installed bin dir that
    // getInstalledBinDir() resolves (inside the sandboxed HOME) — the
    // ownership classifier's PD-owned marker.
    const installedBinDir = getInstalledBinDir();
    const shimPath = realPath.join(globalBinDir, SHIM_BASENAMES[0]);
    realFs.writeFileSync(shimPath, `#!/bin/sh\nexec "${realPath.join(installedBinDir, 'pd')}" "$@"\n`, 'utf-8');

    const shimResult = installGlobalPdShim();

    expect(shimResult).toMatchObject({ installed: true, skippedForeignPaths: [] });
    const record = shimResult as { installed: boolean; createdPaths: string[]; replacedPaths: string[] };
    // The pre-existing PD-owned target is bookkept as REPLACED — the
    // rollback must keep it — and the freshly written siblings as CREATED.
    expect(record.replacedPaths.map((p) => realPath.resolve(p))).toContain(realPath.resolve(shimPath));
    expect(record.createdPaths.map((p) => realPath.resolve(p))).not.toContain(realPath.resolve(shimPath));
    expect(record.createdPaths.length).toBeGreaterThan(0);
    // And the env-gated upgrade path still reports the ACTUAL payload mode.
    tryUpgradePdCliFromNpm('/nonexistent-pd-697');
    expect(infoLines.some((line) => line.includes('Skipping npm pd-cli upgrade (bundled pd-cli is authoritative'))).toBe(true);
    expect(infoLines.some((line) => line.includes('self-contained'))).toBe(false);
  });
});
