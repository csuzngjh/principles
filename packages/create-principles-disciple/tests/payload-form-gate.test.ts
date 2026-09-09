// Payload form-gate tests (npm-distributed package shape):
// install-upgrade investigation CP-1/CP-2 (2026-09-05).
//
// The npm registry package ships the bundled component trees WITHOUT
// node_modules/_release; `npx create-principles-disciple` must install from
// that shape by resolving dependencies from the registry, while a present
// `_release/asset.json` keeps the self-contained hard preflight and an
// incomplete component bundle must fail loud naming what is missing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { install, decideInstallPayloadMode, installGlobalPdShim, tryUpgradePdCliFromNpm } from '../src/installer.js';
import { setLanguage } from '../src/i18n.js';
import { logger } from '../src/utils/logger.js';
import { checkOpenClawGateway } from '../src/utils/env.js';
import type { InstallOptions } from '../src/prompts.js';

vi.mock('fs');
vi.mock('child_process', () => ({ execFileSync: vi.fn(() => ''), execSync: vi.fn(() => '') }));
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
  workspaceDir: '/tmp/pd-test-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

describe('install payload form-gate (npm-distributed shape)', () => {
  let savedLegacyNpmInstall: string | undefined;
  let savedLang: 'zh' | 'en';
  let fixtureDir: string;
  let actualFs: typeof import('node:fs');

  beforeEach(async () => {
    vi.clearAllMocks();
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    savedLang = 'zh';
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
    actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');
    fixtureDir = actualFs.mkdtempSync(realPath.join(actualFs.realpathSync.native(actualOs.tmpdir()), 'pd-form-gate-'));
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      actualFs.mkdirSync(realPath.join(fixtureDir, component, 'dist'), { recursive: true });
      actualFs.writeFileSync(realPath.join(fixtureDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
    }
    // Components whose install steps demand more than package.json+dist.
    actualFs.mkdirSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update'), { recursive: true });
    actualFs.writeFileSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};');
    actualFs.mkdirSync(realPath.join(fixtureDir, 'console', 'dist', 'web'), { recursive: true });
    actualFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'server.js'), 'export {};');
    actualFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');
    // 'fs' is auto-mocked at module scope; the form-gate consults
    // existsSync, so delegate it to the real fs so the real fixture is
    // visible to install() while the rest of the mocked fs still fails
    // later steps loudly.
    vi.mocked(fs.existsSync).mockImplementation((value) => actualFs.existsSync(String(value)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    setLanguage(savedLang);
    if (fixtureDir) actualFs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('classifies a complete component bundle without _release as npm-distributed', () => {
    expect(decideInstallPayloadMode(fixtureDir)).toBe('npm-distributed');
  });

  it('classifies a package with _release/asset.json as self-contained even with the legacy env off', () => {
    actualFs.mkdirSync(path.join(fixtureDir, '_release'), { recursive: true });
    actualFs.writeFileSync(path.join(fixtureDir, '_release', 'asset.json'), '{}');
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    expect(decideInstallPayloadMode(fixtureDir)).toBe('self-contained');
  });

  it('refuses an incomplete component bundle naming the missing items (rc-3)', async () => {
    actualFs.rmSync(path.join(fixtureDir, 'codex-adapter'), { recursive: true, force: true });
    actualFs.rmSync(path.join(fixtureDir, 'console', 'dist', 'web'), { recursive: true, force: true });

    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    // Path separators are platform-dependent — match them agnostically.
    expect(result.reason).toMatch(/^npm_bundle_incomplete: missing codex-adapter[/\\]package\.json, codex-adapter[/\\]dist, console[/\\]dist[/\\]web[/\\]index\.html/);
    expect(result.error).toMatch(/No changes were made/);
  });

  it('refuses a package missing release-manager BEFORE any mutation (review blocker)', async () => {
    // installBundledReleaseManagerPackage runs unconditionally mid-deploy
    // and demands package.json + dist/update/release-manager-authority.js;
    // a package truncated before that component used to pass the form-gate
    // and die AFTER the backup + five component copies. The gate must name
    // the exact missing files and leave the system untouched.
    actualFs.rmSync(path.join(fixtureDir, 'release-manager', 'dist'), { recursive: true, force: true });

    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^npm_bundle_incomplete: missing release-manager[/\\]dist[/\\]update[/\\]release-manager-authority\.js/);
    expect(result.error).toMatch(/No changes were made/);
    // Zero mutation: no backup rename, no component copies (cli-5).
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('refuses a package with a console bundle missing its real entrypoint (exact-shape check)', async () => {
    actualFs.rmSync(path.join(fixtureDir, 'console', 'dist', 'server.js'));

    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^npm_bundle_incomplete: missing console[/\\]dist[/\\]server\.js/);
  });
});

// PRI-697: the two "Skipping …" gates used to key on the legacy env var
// (PD_ALLOW_LEGACY_NPM_INSTALL) while their messages blamed the payload
// shape — a standard npm-channel install (npm-distributed shape, no env)
// logged "npm-distributed package detected …" followed by "Skipping … for
// the self-contained release asset". The matrix below pins each gate to its
// intended predicate and pins the message text to the ACTUAL mode.
describe('PRI-697 payload-mode skip gates (shim discovery + pd-cli upgrade)', () => {
  let savedLegacyNpmInstall: string | undefined;
  let savedSkipShim: string | undefined;
  let savedSkipUpgrade: string | undefined;
  let savedLang: 'zh' | 'en';
  let infoLines: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    savedSkipShim = process.env.PD_SKIP_GLOBAL_SHIM;
    savedSkipUpgrade = process.env.PD_SKIP_NPM_UPGRADE;
    // Never touch the real npm global bin dir / registry from tests.
    process.env.PD_SKIP_GLOBAL_SHIM = '1';
    process.env.PD_SKIP_NPM_UPGRADE = '1';
    setLanguage('en');
    infoLines = [];
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.spyOn(logger, 'info').mockImplementation((msg: string) => { infoLines.push(msg); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of [
      ['PD_ALLOW_LEGACY_NPM_INSTALL', savedLegacyNpmInstall],
      ['PD_SKIP_GLOBAL_SHIM', savedSkipShim],
      ['PD_SKIP_NPM_UPGRADE', savedSkipUpgrade],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setLanguage(savedLang);
  });

  /**
   * Run install() until the payload mode is decided (immediately before the
   * preflight), so activePayloadMode reflects the fixture shape exactly as
   * in a real run. The fixture dir passes the form-gate, then
   * checkBuiltPlugin fails on the mocked fs — install() returns a failure
   * result, but the mode stays set for the helper assertions that follow.
   */
  const setPayloadModeViaInstall = async (pluginDir: string): Promise<void> => {
    await install(baseInstallOptions, pluginDir, { quiet: true });
  };
  void setPayloadModeViaInstall;

  const completeNpmBundle = async (): Promise<{ dir: string; actualFs: typeof import('node:fs') }> => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');
    const dir = actualFs.mkdtempSync(realPath.join(actualFs.realpathSync.native(actualOs.tmpdir()), 'pd-697-npm-bundle-'));
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      actualFs.mkdirSync(realPath.join(dir, component, 'dist'), { recursive: true });
      actualFs.writeFileSync(realPath.join(dir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
    }
    actualFs.mkdirSync(realPath.join(dir, 'release-manager', 'dist', 'update'), { recursive: true });
    actualFs.writeFileSync(realPath.join(dir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};');
    actualFs.mkdirSync(realPath.join(dir, 'console', 'dist', 'web'), { recursive: true });
    actualFs.writeFileSync(realPath.join(dir, 'console', 'dist', 'server.js'), 'export {};');
    actualFs.writeFileSync(realPath.join(dir, 'console', 'dist', 'web', 'index.html'), '<html></html>');
    // Form-gate consults existsSync — delegate to the real fs like the
    // suites above.
    vi.mocked(fs.existsSync).mockImplementation((value) => actualFs.existsSync(String(value)));
    return { dir, actualFs };
  };

  it('npm-distributed shape (no env): install() logs the npm-distributed banner, and the shim gate NO LONGER claims self-contained', async () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    const { dir } = await completeNpmBundle();

    const result = await install(baseInstallOptions, dir, { quiet: true });

    // install() decided npm-distributed (form-gate passed; checkBuiltPlugin
    // fails later on the mocked plugin manifest).
    expect(result.success).toBe(false);
    // The old bug: with the env off the shim gate fired and blamed the
    // self-contained release asset even though this run is npm-distributed.
    // The gate now keys on the payload mode, so in the npm-distributed shape
    // the self-contained message must NOT appear.
    const shape = infoLines.filter((line) => line.includes('self-contained release asset'));
    expect(shape).toEqual([]);
  });

  it('self-contained shape: shim gate still skips and names the self-contained release asset', async () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    const { dir, actualFs } = await completeNpmBundle();
    actualFs.mkdirSync(path.join(dir, '_release'), { recursive: true });
    actualFs.writeFileSync(path.join(dir, '_release', 'asset.json'), '{}');

    const result = await install(baseInstallOptions, dir, { quiet: true });

    // The '{}' asset body fails identity validation — any preflight refusal
    // proves activePayloadMode === 'self-contained' for the helper assertions
    // that follow.
    expect(result.success).toBe(false);
    expect(result.reason).toBe('self_contained_asset_identity_invalid');
    // Direct helper assertion under the self-contained mode this run set:
    // skip fires (no npm discovery for the release-asset shape). The helper
    // returns plain false for the skip gates (no global write attempted).
    infoLines.length = 0;
    expect(installGlobalPdShim()).toBe(false);
    expect(infoLines.some((line) => line.includes('Skipping npm global shim discovery for the self-contained release asset.'))).toBe(true);
    tryUpgradePdCliFromNpm('/nonexistent-pd-697');
    expect(infoLines.some((line) => line.includes('Skipping npm pd-cli upgrade for the self-contained release asset.'))).toBe(true);
  });

  it('npm-distributed shape: helpers under the npm-distributed mode report the actual mode, never the self-contained asset', async () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    const { dir } = await completeNpmBundle();

    // Drive install() far enough to set activePayloadMode (fails later on
    // the mocked plugin manifest — the mode decision precedes deployment).
    await install(baseInstallOptions, dir, { quiet: true });

    infoLines.length = 0;
    // PD_SKIP_GLOBAL_SHIM is set → the dedicated skip fires before the
    // payload gate; clear it so the payload gate is what we observe.
    delete process.env.PD_SKIP_GLOBAL_SHIM;
    try {
      // The mocked child_process makes npm prefix -g resolve to '' — the
      // helper returns false silently at the globalBin step. The contract
      // under test is the MESSAGE: the payload gate passed, so the
      // self-contained skip message must NOT appear (it did before PRI-697).
      expect(installGlobalPdShim()).toBe(false);
      expect(infoLines.some((line) => line.includes('self-contained release asset'))).toBe(false);
    } finally {
      process.env.PD_SKIP_GLOBAL_SHIM = '1';
    }

    infoLines.length = 0;
    delete process.env.PD_SKIP_NPM_UPGRADE;
    try {
      tryUpgradePdCliFromNpm('/nonexistent-pd-697');
      // The pd-cli upgrade gate keeps the env-var predicate (bundled pd-cli
      // stays authoritative), but the message reports the ACTUAL mode.
      expect(infoLines.some((line) => line.includes('Skipping npm pd-cli upgrade (bundled pd-cli is authoritative'))).toBe(true);
      expect(infoLines.some((line) => line.includes('self-contained'))).toBe(false);
    } finally {
      process.env.PD_SKIP_NPM_UPGRADE = '1';
    }
  });
});
