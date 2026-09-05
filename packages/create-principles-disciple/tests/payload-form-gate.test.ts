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
import { install, decideInstallPayloadMode } from '../src/installer.js';
import { setLanguage } from '../src/i18n.js';
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
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout']) {
      actualFs.mkdirSync(realPath.join(fixtureDir, component, 'dist'), { recursive: true });
      actualFs.writeFileSync(realPath.join(fixtureDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
    }
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
    actualFs.rmSync(path.join(fixtureDir, 'console', 'dist'), { recursive: true, force: true });

    const result = await install(baseInstallOptions, fixtureDir, { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^npm_bundle_incomplete: missing codex-adapter\/package\.json, console\/dist/);
    expect(result.error).toMatch(/No changes were made/);
  });
});
