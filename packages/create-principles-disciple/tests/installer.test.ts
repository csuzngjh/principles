import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { validateWorkspacePath, verifyNativeModules, checkBuiltPlugin, ensureConversationAccess, install, resolveConsolePortBase } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';

vi.mock('fs');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
}));
// Control the gateway detection + service-control helpers without spawning real
// processes. Spread importOriginal so other env exports (detectWorkspace, etc.)
// used elsewhere stay intact.
vi.mock('../src/utils/env.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(),
    stopOpenClawGateway: vi.fn(),
    restartOpenClawGateway: vi.fn(),
  };
});

describe('console port base authority (PD_CONSOLE_PORT_BASE)', () => {
  const originalBase = process.env.PD_CONSOLE_PORT_BASE;
  afterEach(() => {
    if (originalBase === undefined) delete process.env.PD_CONSOLE_PORT_BASE;
    else process.env.PD_CONSOLE_PORT_BASE = originalBase;
  });

  it('defaults to the historical 3100 window', () => {
    delete process.env.PD_CONSOLE_PORT_BASE;
    expect(resolveConsolePortBase()).toBe(3100);
  });

  it('shifts the resolved base to 3300 (e.g. past a reserved port range)', () => {
    process.env.PD_CONSOLE_PORT_BASE = '3300';
    expect(resolveConsolePortBase()).toBe(3300);
  });

  it('rejects non-integer and out-of-range values loudly', () => {
    for (const invalid of ['not-a-number', '3100.5', '1023', '65001', '-1']) {
      process.env.PD_CONSOLE_PORT_BASE = invalid;
      expect(() => resolveConsolePortBase()).toThrow(/PD_CONSOLE_PORT_BASE/);
    }
  });
});

describe('validateWorkspacePath security guard', () => {
  it('accepts path within workspace', () => {
    const workspace = '/home/user/workspace';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });

  it('accepts workspace root itself', () => {
    const workspace = '/home/user/workspace';
    expect(() => validateWorkspacePath(workspace, workspace)).not.toThrow();
  });

  it('rejects path traversal with ..', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/home/user/workspace/../etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('rejects path outside workspace', () => {
    const workspace = '/home/user/workspace';
    const outsidePath = '/home/otheruser/file';
    expect(() => validateWorkspacePath(outsidePath, workspace)).toThrow(/Security error/);
  });

  it('rejects absolute path traversal', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('handles trailing separators correctly', () => {
    const workspace = '/home/user/workspace/';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });
});

describe('Native module verification', () => {
  const mockExecFileSync = vi.mocked(childProcess.execFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifyNativeModules succeeds when modules are loadable', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('verifyNativeModules skips missing modules', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('verifyNativeModules throws when module fails to load', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Cannot load native module');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).toThrow(/require probe/);
  });
});

describe('checkBuiltPlugin validation', () => {
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockExistsSync = vi.spyOn(fs, 'existsSync');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['hook'] },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid plugin manifest', async () => {
    const pluginDir = '/test/plugin';
    
    await expect(checkBuiltPlugin(pluginDir)).resolves.not.toThrow();
  });

  it('rejects missing dist directory', async () => {
    mockExistsSync.mockImplementation((p) => {
      return !p.toString().includes('dist');
    });

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/Built plugin files missing/);
  });

  it('rejects missing activation object', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/openclaw.plugin.json is missing activation object/);
  });

  it('rejects missing hook capability', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['other'] },
    }));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/does not include "hook"/);
  });
});

describe('ensureConversationAccess — PRI-343', () => {
  it('sets hooks.allowConversationAccess to true when missing', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            model: 'gpt-4',
            provider: 'openai',
            hooks: {},
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    // Other fields preserved
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBe('gpt-4');
    expect(entry.provider).toBe('openai');
  });

  it('is idempotent when allowConversationAccess is already true', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            hooks: { allowConversationAccess: true },
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    expect(entry.enabled).toBe(true);
  });

  it('creates hooks object when hooks field is completely absent', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            model: 'gpt-4',
            // hooks field does not exist at all
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    // Other fields preserved
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBe('gpt-4');
  });
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

describe('install() gateway lock pre-flight', () => {
  // Pin English so string assertions on operator-visible failure text are
  // deterministic (the catch block now routes through t()).
  let savedLang: 'zh' | 'en';
  let savedLegacyNpmInstall: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedLang = 'zh';
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    setLanguage(savedLang);
  });

  it('refuses a wrong-ABI release before gateway control or filesystem mutation', async () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules === '999999' ? '999998' : '999999',
    }));

    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result).toMatchObject({
      success: false,
      reason: 'self_contained_asset_target_mismatch',
      component: 'Release asset',
    });
    expect(checkOpenClawGateway).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('refuses a missing source dependency before gateway control or filesystem mutation', async () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.existsSync).mockImplementation((value) => !String(value).endsWith(path.join('node_modules', 'missing-runtime')));
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith(path.join('_release', 'asset.json'))) {
        return JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules });
      }
      if (filePath.endsWith(path.join('_release', 'manifest.json'))) {
        return JSON.stringify({ schemaVersion: 1, files: [] });
      }
      return JSON.stringify({ dependencies: { 'missing-runtime': '1.0.0' } });
    });
    vi.mocked(fs.statSync).mockReturnValue(actualFs.statSync(process.cwd()));
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result).toMatchObject({
      success: false,
      reason: 'self_contained_runtime_dependency_missing',
      component: 'Core',
      dependency: 'missing-runtime',
    });
    expect(checkOpenClawGateway).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  // cli-5: the abort path must NOT mutate — gateway is never stopped and no
  // install step runs. This is the core fix: the old code warned + proceeded
  // into a known-likely EPERM; now non-interactive mode refuses cleanly.
  it('aborts cleanly (no mutation) when gateway is running in non-interactive mode without --stop-gateway', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789, pid: 33584 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });

    const result = await install({ ...baseInstallOptions, stopGateway: false }, '/nonexistent/plugin', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^gateway_running_aborted:/);
    // No mutation: gateway never stopped, restart never invoked.
    expect(stopOpenClawGateway).not.toHaveBeenCalled();
    expect(restartOpenClawGateway).not.toHaveBeenCalled();
  });

  // Regression: `--yes` is non-interactive but NOT json (quiet=false, human
  // output on). interactive must follow nonInteractive, NOT quiet — otherwise
  // a `--yes` run with the gateway up would hang on an interactive prompt.
  it('--yes mode (quiet=false, nonInteractive=true) aborts without prompting when the gateway is running', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });

    // quiet=false (not --json), nonInteractive=true (--yes): must NOT prompt.
    const result = await install({ ...baseInstallOptions, stopGateway: false }, '/nonexistent/plugin', { quiet: false, nonInteractive: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^gateway_running_aborted:/);
    expect(stopOpenClawGateway).not.toHaveBeenCalled();
  });

  it('--stop-gateway stops the gateway and restarts it even when a later step fails (finally)', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    // fs is auto-mocked -> checkBuiltPlugin throws ("Built plugin files missing")
    // -> catch -> finally(restart). Verifies restart runs on failure too.
    const result = await install({ ...baseInstallOptions, stopGateway: true }, '/nonexistent/plugin', { quiet: true });

    expect(stopOpenClawGateway).toHaveBeenCalledTimes(1);
    expect(restartOpenClawGateway).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  // ERR-046 / rc-9: when install fails before a backup is created, the result
  // must NOT claim "Previous install has been restored" (the old misleading
  // success-shaped message). backupDir stays null -> "not modified" branch.
  it('reports "not modified" (never "restored") when install fails before a backup is created', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });

    const result = await install({ ...baseInstallOptions }, '/nonexistent/plugin', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^install_failed_before_mutation:/);
    expect(result.error).toMatch(/not modified/);
    expect(result.error).not.toMatch(/has been restored/);
  });
});

// ---------------------------------------------------------------------------
// CP-6 / CP-9 (install-upgrade investigation 2026-09-05): honest failure
// semantics for a fresh install that dies mid-deployment, and early workspace
// creation.
// ---------------------------------------------------------------------------

describe('install() failure-path honesty (CP-6) and workspace creation (CP-9)', () => {
  let savedLegacyNpmInstall: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('cleans up deployed runtime dirs and reports truth when a FRESH install fails mid-deployment (CP-6)', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    // Fresh install: no pre-existing ext copy / runtime root, so
    // backupExistingInstall returns no_existing (no backup safety net).
    // The package source core/ exists (deployed), host-runtime/ does not —
    // so the failure fires AFTER the first component deployment. The mock
    // is phase-based: the first core-source probe flips the fixture into
    // "deployed" phase so the catch-block cleanup sees the targets on disk.
    let deployed = false;
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json') || s.endsWith(path.join('.pd', 'state.db'))) return false;
      if (s.includes(path.join('/asset', 'host-runtime'))) return false;
      // Pre-deployment phase: only the package sources (plugin + core staging
      // probes) exist; deployment flips every probe to true from then on.
      if (!deployed) {
        if (s.includes(path.join('/asset', 'core'))) deployed = true;
        else return s.includes(path.join('/asset', 'plugin'));
      }
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) {
        return JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } });
      }
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const result = await install({ ...baseInstallOptions }, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    // Truthful reason: mutation happened, fresh install, residue cleaned.
    expect(result.reason).toMatch(/^install_failed_unactivated_cleaned:/);
    expect(result.error).toMatch(/removed/);
    expect(result.error).not.toMatch(/not modified/);
    // The deployment roots this run created were removed (rc-9 observable).
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.pd[/\\]runtime$/),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringMatching(/extensions[/\\]principles-disciple$/),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('still cleans residue when a LOCK-SHAPED error fires AFTER core landed on disk (PR #1526 review P2)', async () => {
    // The old cleanup condition excluded EPERM/EACCES/EBUSY from
    // cleanUnactivatedFreshInstall on the assumption lock errors only fire
    // BEFORE any mutation. They do not: core deploys fine, then a later
    // cpSync dies with EACCES — and the old code left the residue behind a
    // "No changes were made" report. Cleanup must key on mutationStarted
    // (actual write state), not on the error class.
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    // Fresh install: no pre-existing ext copy / runtime root (no backup).
    let deployed = false;
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json') || s.endsWith(path.join('.pd', 'state.db'))) return false;
      // Pre-deployment phase: only the package sources exist; deployment
      // flips every probe to true from the first core probe onward.
      if (!deployed) {
        if (s.includes(path.join('/asset', 'core'))) deployed = true;
        else return s.includes(path.join('/asset', 'plugin'));
      }
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) {
        return JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } });
      }
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    // First cpSync (core deploy) succeeds — core IS on disk when the failure
    // hits; the second (host-runtime deploy) dies with a lock-shaped EACCES.
    let cpCalls = 0;
    vi.mocked(fs.cpSync).mockImplementation((_src, _dest, _options) => {
      cpCalls += 1;
      if (cpCalls > 1) throw new Error('EACCES: permission denied, copyfile');
    });

    const result = await install({ ...baseInstallOptions }, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    // Truthful reason: mutation happened and residue was cleaned — NOT
    // install_aborted_lock / "No changes were made".
    expect(result.reason).toMatch(/^install_failed_unactivated_cleaned:/);
    expect(result.error).toMatch(/removed/);
    expect(result.error).not.toMatch(/not modified/);
    // The deployment roots this run created were removed (rc-9 observable).
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.pd[/\\]runtime$/),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringMatching(/extensions[/\\]principles-disciple$/),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('creates the workspace directory early, inside the unified failure boundary (CP-9 + review R1)', async () => {
    // The workspace must exist before console verification / pd runtime init
    // consume it, and its creation failure must surface as a structured
    // InstallResult instead of a bare rejection. Verified against the REAL
    // filesystem (fs-extra is not mocked; throwaway temp dirs).
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    const wsRoot = realFs.mkdtempSync(realPath.join(realFs.realpathSync.native(realOs.tmpdir()), 'pd-cp9-'));
    const workspaceDir = realPath.join(wsRoot, 'ws', 'nested');
    try {
      // fs is auto-mocked: package/asset probes fail loudly (form-gate or
      // built-plugin check), so the run ends in the catch WITHOUT reaching
      // the deploy steps — but only AFTER ensureDir ran inside the try.
      const result = await install({ ...baseInstallOptions, workspaceDir }, '/asset', { quiet: true });
      expect(result.success).toBe(false);
      expect(realFs.existsSync(workspaceDir)).toBe(true);
    } finally {
      realFs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
