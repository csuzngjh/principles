import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkBuddyHostInstaller, resolveWorkbuddyPaths, findWorkbuddyPluginPayload } from '../src/installers/workbuddy-host-installer.js';

const adapter = path.resolve(__dirname, '../../workbuddy-adapter');
const installerPackage = path.resolve(__dirname, '..');
const requiredSkills = ['pd-cli-operator', 'pd-pain-signal', 'pd-review', 'pd-control'];
const directories: string[] = [];
const originalConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
const copyFailure = vi.hoisted((): { staging?: boolean; commitFile?: string } => ({}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      const destination = String(args[1]);
      // staging=true fails the copy into the installer's temp dir, which is the
      // real upgrade-failure shape (ENOSPC / EPERM) without knowing its name.
      if (copyFailure.staging === true && path.basename(destination).startsWith('.pd-staging-')) {
        throw new Error('injected cache copy failure');
      }
      return actual.cpSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      // The registry/settings writer uses atomic rename. Fail exactly one
      // commit after the cache swap, leaving rollback free to run normally.
      if (copyFailure.commitFile === path.basename(String(args[1]))) {
        delete copyFailure.commitFile;
        throw new Error('injected registration commit failure');
      }
      return actual.renameSync(...args);
    },
  };
});

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-skill-delivery-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  delete copyFailure.staging;
  delete copyFailure.commitFile;
  if (originalConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
  else process.env.WORKBUDDY_CONFIG_DIR = originalConfigDir;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkBuddy skills through production delivery boundaries', () => {
  it.each(['../', '../../..', '..\\..\\..', '/absolute/path', 'C:\\absolute\\path', '\\\\server\\share', '.', '..', 'nested/version', 'nested\\version', '', ' 0.1.0', '1.2'])('rejects unsafe manifest version %j before all installer mutations', async (version) => {
    const payload = temporaryDirectory();
    const plugin = path.join(payload, 'workbuddy-adapter/plugin');
    fs.cpSync(path.join(adapter, 'plugin'), plugin, { recursive: true });
    const manifestPath = path.join(plugin, '.codebuddy-plugin/plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const home = temporaryDirectory();
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    const paths = resolveWorkbuddyPaths(home);
    const sentinels = [
      path.join(paths.cachePluginRoot, '0.0.9/owner.txt'),
      path.join(path.dirname(paths.cachePluginRoot), 'neighbor/owner.txt'),
      path.join(paths.marketplaceRoot, 'owner.txt'),
      path.join(paths.governanceDir, '.pd/state.db'),
      path.join(home, 'owner.txt'),
    ];
    for (const sentinel of sentinels) {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, 'Preserve Owner data');
    }
    fs.writeFileSync(paths.settingsPath, '{"enabledPlugins":{"other@market":true},"owner":"preserve"}');
    fs.mkdirSync(path.dirname(paths.registryPath), { recursive: true });
    fs.writeFileSync(paths.registryPath, '{"version":2,"plugins":{"other@market":[{"scope":"user","version":"1.0.0","installPath":"preserve"}]}}');
    // Reading the file directly (no stat-then-read check) keeps this a real
    // snapshot of the bytes and avoids the TOCTOU shape js/file-system-race flags.
    const snapshot = () => fs.readdirSync(home, { recursive: true }).sort().map((entry) => {
      const absolute = path.join(home, String(entry));
      try {
        return [entry, fs.readFileSync(absolute).toString('base64')];
      } catch {
        return [entry, 'directory'];
      }
    });
    const before = snapshot();
    const installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
    const result = await installer.install({ workspaceDir: home, pluginDir: payload, language: 'en', mode: 'smart' });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_plugin_version_invalid');
    expect(snapshot()).toEqual(before);
  });

  it.each(['0.1.0', '1.2.3', '1.2.3-rc.1', '1.2.3+build.4', '1.2.3-rc.1+build.4'])('accepts safe semantic manifest version %s without normalizing its cache identity', (version) => {
    const payload = temporaryDirectory();
    const plugin = path.join(payload, 'workbuddy-adapter/plugin');
    fs.cpSync(path.join(adapter, 'plugin'), plugin, { recursive: true });
    const manifestPath = path.join(plugin, '.codebuddy-plugin/plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = findWorkbuddyPluginPayload(payload, path.join(payload, 'absent-runtime'));
    expect(result.payload?.version, result.reason).toBe(version);
  });

  /** Cache dir names derive from manifest versions: whitelist strict numeric
   * X.Y.Z and prove the resolved path stays inside the cache root. */
  function versionedCacheDir(cacheRoot: string, version: string): string {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`non-numeric plugin version: ${version}`);
    const resolved = path.resolve(cacheRoot, version);
    if (!resolved.startsWith(path.resolve(cacheRoot) + path.sep)) throw new Error('cache path escaped the cache root');
    return resolved;
  }

  /** Read a fixed file under a proven root: the join can never leave root. */
  function fileUnderRoot(root: string, ...segments: string[]): string {
    const resolved = path.resolve(root, ...segments);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('path escaped its root');
    return resolved;
  }

  async function oldCacheLab(engine: boolean) {
    const payload = temporaryDirectory();
    const payloadRoot = path.resolve(payload);
    fs.cpSync(path.join(adapter, 'plugin'), fileUnderRoot(payloadRoot, 'workbuddy-adapter', 'plugin'), { recursive: true });
    // The cache version directory follows the payload manifest, so this lab
    // keeps modeling the real upgrade shape as the shipped plugin version
    // moves (0.1.0 → 0.2.0 → …) instead of pinning a stale literal.
    const manifestPath = fileUnderRoot(payloadRoot, 'workbuddy-adapter', 'plugin', '.codebuddy-plugin', 'plugin.json');
    const shippedVersion = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: unknown }).version;
    if (typeof shippedVersion !== 'string') throw new Error(`unexpected shipped plugin version: ${String(shippedVersion)}`);
    const home = temporaryDirectory();
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    fs.mkdirSync(process.env.WORKBUDDY_CONFIG_DIR);
    const installer = new WorkBuddyHostInstaller({
      homeDir: () => home,
      enginePath: () => engine ? fileUnderRoot(__dirname, 'fixtures', 'workbuddy-fake-engine.mjs') : undefined,
    });
    const context = { workspaceDir: home, pluginDir: payload, language: 'en', mode: 'smart' as const };
    const installed = await installer.install(context);
    expect(installed.success, installed.reason).toBe(true);
    const paths = resolveWorkbuddyPaths(home);
    const cache = versionedCacheDir(paths.cachePluginRoot, shippedVersion);
    // Real old shipped shape: same manifest version, hooks/wrapper, zero skills.
    expect(JSON.parse(fs.readFileSync(fileUnderRoot(cache, '.codebuddy-plugin', 'plugin.json'), 'utf8')).version).toBe(shippedVersion);
    fs.rmSync(fileUnderRoot(cache, 'skills'), { recursive: true });
    fs.unlinkSync(fileUnderRoot(cache, 'scripts', 'pd-control.cjs'));
    const database = path.join(paths.governanceDir, '.pd/state.db');
    fs.writeFileSync(database, 'Owner governance data');
    const otherPlugin = path.join(paths.configDir, 'plugins/cache/other/plugin/1.0.0/owner.txt');
    fs.mkdirSync(path.dirname(otherPlugin), { recursive: true });
    fs.writeFileSync(otherPlugin, 'Other plugin data');
    const settings = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
    settings.enabledPlugins['other@market'] = true;
    settings.ownerSetting = 'preserve';
    fs.writeFileSync(paths.settingsPath, JSON.stringify(settings));
    const registry = JSON.parse(fs.readFileSync(paths.registryPath, 'utf8'));
    registry.plugins['other@market'] = { version: '1.0.0', installPath: path.dirname(otherPlugin) };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    return { installer, context, cache, paths, database, otherPlugin, payloadRoot, manifestPath, shippedVersion };
  }

  it.each([true, false])('refreshes registered hook-only cache from a same-version complete payload (engine=%s)', async (engine) => {
    const lab = await oldCacheLab(engine);
    const result = await lab.installer.install(lab.context);
    expect(result.success, result.reason).toBe(true);
    expect(result.reason).toContain('refreshed by installer');
    for (const skill of requiredSkills) {
      expect(fs.readFileSync(fileUnderRoot(lab.cache, 'skills', skill, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin', 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    expect(fs.readFileSync(fileUnderRoot(lab.cache, 'scripts', 'pd-control.cjs'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin', 'scripts', 'pd-control.cjs'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(registry.plugins['principles-disciple@principles-disciple-market']).toMatchObject({ version: lab.shippedVersion, installPath: lab.cache });
    expect(registry.plugins['other@market']).toEqual({ version: '1.0.0', installPath: path.dirname(lab.otherPlugin) });
    expect(JSON.parse(fs.readFileSync(lab.paths.settingsPath, 'utf8'))).toMatchObject({ ownerSetting: 'preserve', enabledPlugins: { 'other@market': true } });
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
    expect(fs.readFileSync(lab.otherPlugin, 'utf8')).toBe('Other plugin data');
  });

  it('upgrades to a higher plugin version into its own cache dir, repoints registration, and keeps governance data', async () => {
    const lab = await oldCacheLab(true);
    // The next shipped release: bump the payload manifest's minor (the same
    // move a release PR makes) and re-run the installer over the existing
    // cache. nextVersion stays within the whitelisted X.Y.Z shape.
    const parts = lab.shippedVersion.split('.').map((part) => Number(part));
    const nextVersion = `${parts[0]}.${parts[1] + 1}.0`;
    versionedCacheDir(lab.paths.cachePluginRoot, nextVersion); // validates the shape before it names a directory
    const manifest = JSON.parse(fs.readFileSync(lab.manifestPath, 'utf8')) as { version: string };
    manifest.version = nextVersion;
    fs.writeFileSync(lab.manifestPath, JSON.stringify(manifest, null, 2));
    const result = await lab.installer.install(lab.context);
    expect(result.success, result.reason).toBe(true);
    const newCache = versionedCacheDir(lab.paths.cachePluginRoot, nextVersion);
    for (const skill of requiredSkills) {
      expect(fs.readFileSync(fileUnderRoot(newCache, 'skills', skill, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin', 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    expect(fs.readFileSync(fileUnderRoot(newCache, 'scripts', 'pd-control.cjs'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin', 'scripts', 'pd-control.cjs'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(registry.plugins['principles-disciple@principles-disciple-market']).toMatchObject({ version: nextVersion, installPath: newCache });
    // The old version dir stays on disk (inert until uninstall sweeps it) but
    // nothing points at it anymore.
    expect(fs.existsSync(fileUnderRoot(lab.cache, 'scripts', 'wrapper.cjs'))).toBe(true);
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
    expect(fs.readFileSync(lab.otherPlugin, 'utf8')).toBe('Other plugin data');
  });

  it('reports cache refresh failure and leaves the previous cache loadable', async () => {
    const lab = await oldCacheLab(true);
    const settingsBefore = fs.readFileSync(lab.paths.settingsPath, 'utf8');
    const registryBefore = fs.readFileSync(lab.paths.registryPath, 'utf8');
    // The old cache is hook-only (skills + pd-control removed by the lab); the
    // hook still runs, so a failed refresh must never trade it for a partial copy.
    copyFailure.staging = true;
    const result = await lab.installer.install(lab.context);
    expect(result.success).toBe(false);
    // Data first, wording second: a regression must fail on "the old plugin is
    // gone", not on a message that happened to change.
    expect(fs.existsSync(path.join(lab.cache, 'scripts/wrapper.cjs')), 'the previous cache must survive a failed refresh').toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(lab.cache, '.codebuddy-plugin/plugin.json'), 'utf8')).version).toBe(lab.shippedVersion);
    expect(fs.readFileSync(path.join(lab.cache, 'scripts/wrapper.cjs'), 'utf8').length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(lab.cache, 'hooks/hooks.json'), 'utf8'))).toHaveProperty('hooks');
    // No half-written pieces from the failed attempt.
    expect(fs.existsSync(path.join(lab.cache, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(lab.cache, 'scripts/pd-control.cjs'))).toBe(false);
    expect(result.reason).toContain('workbuddy_cache_write_failed');
    expect(result.reason).toContain('previous cache payload was left in place');
    // No registration state was committed for a payload that never landed.
    expect(fs.readFileSync(lab.paths.settingsPath, 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(lab.paths.registryPath, 'utf8')).toBe(registryBefore);
    // No staging/backup temp dirs left next to the version cache.
    expect(fs.readdirSync(path.dirname(lab.paths.cachePluginRoot))
      .filter((name) => name.startsWith('.pd-staging-') || name.startsWith('.pd-backup-'))).toEqual([]);
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
    expect(fs.readFileSync(lab.otherPlugin, 'utf8')).toBe('Other plugin data');
  });

  it.each(['settings.json', 'installed_plugins.json'])('rolls back cache and BOTH host files when %s commit fails after swapping', async (commitFile) => {
    const lab = await oldCacheLab(true);
    const settingsBefore = fs.readFileSync(lab.paths.settingsPath, 'utf8');
    const registryBefore = fs.readFileSync(lab.paths.registryPath, 'utf8');
    const wrapperBefore = fs.readFileSync(path.join(lab.cache, 'scripts/wrapper.cjs'));
    copyFailure.commitFile = commitFile;
    const result = await lab.installer.install(lab.context);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_registration_commit_failed');
    expect(result.reason).toContain('Previous cache and registration state restored');
    expect(fs.readFileSync(lab.paths.settingsPath, 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(lab.paths.registryPath, 'utf8')).toBe(registryBefore);
    expect(fs.readFileSync(path.join(lab.cache, 'scripts/wrapper.cjs'))).toEqual(wrapperBefore);
    expect(fs.existsSync(path.join(lab.cache, 'skills'))).toBe(false);
    expect(fs.readdirSync(path.dirname(lab.paths.cachePluginRoot))
      .filter((name) => name.startsWith('.pd-staging-') || name.startsWith('.pd-backup-'))).toEqual([]);
  });

  it.each([true, false])('preserves native v2 array scopes and older caches, then reinstalls without registry churn (engine=%s)', async (engine) => {
    const lab = await oldCacheLab(engine);
    const olderCache = path.join(lab.paths.cachePluginRoot, '0.0.9');
    fs.mkdirSync(olderCache, { recursive: true });
    const olderFile = path.join(olderCache, 'project-owner.txt');
    fs.writeFileSync(olderFile, 'Existing project/local version');
    // Native 2026-10-17 engine array receipt, paths redacted; project/local
    // rows and Owner metadata supplement it to protect coexistence behavior.
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workbuddy-installed-registry-v2-array.json'), 'utf8'), (_key, value: unknown) => {
      if (value === 'USER_CACHE') return lab.cache;
      if (value === 'PROJECT_CACHE') return olderCache;
      if (value === 'PROJECT_WORKSPACE') return path.join(lab.paths.homeDir, 'project');
      return value;
    });
    const pluginKey = 'principles-disciple@principles-disciple-market';
    const untouchedScopes = registry.plugins[pluginKey].slice(1);
    fs.writeFileSync(lab.paths.registryPath, JSON.stringify(registry));
    const refreshed = await lab.installer.install(lab.context);
    expect(refreshed.success, refreshed.reason).toBe(true);
    const after = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(Array.isArray(after.plugins[pluginKey])).toBe(true);
    expect(after.plugins[pluginKey]).toHaveLength(3);
    expect(after.plugins[pluginKey].slice(1)).toEqual(untouchedScopes);
    expect(after.plugins[pluginKey][0]).toMatchObject({
      scope: 'user', installPath: lab.cache, version: lab.shippedVersion,
      installedAt: '2026-10-17T08:26:05.778Z', ownerMetadata: { preserve: true },
    });
    expect(fs.readFileSync(olderFile, 'utf8')).toBe('Existing project/local version');
    for (const skill of requiredSkills) {
      expect(fs.readFileSync(path.join(lab.cache, 'skills', skill, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin/skills', skill, 'SKILL.md'), 'utf8'));
    }
    const registryBytes = fs.readFileSync(lab.paths.registryPath, 'utf8');
    const repeated = await lab.installer.install(lab.context);
    expect(repeated.success, repeated.reason).toBe(true);
    expect(repeated.configAction).toBe('preserved');
    expect(fs.readFileSync(lab.paths.registryPath, 'utf8')).toBe(registryBytes);
    expect(fs.readFileSync(olderFile, 'utf8')).toBe('Existing project/local version');
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
  });

  it('uninstall removes only the user scope, keeping project/local registrations and their cache loadable', async () => {
    // Direct-write path: the engine's own uninstall deletes the whole key (frozen
    // host fact), so the scope discipline PD owns is proven where PD writes.
    const lab = await oldCacheLab(false);
    const olderCache = path.join(lab.paths.cachePluginRoot, '0.0.9');
    fs.mkdirSync(olderCache, { recursive: true });
    const olderFile = path.join(olderCache, 'project-owner.txt');
    fs.writeFileSync(olderFile, 'Existing project/local version');
    const pluginKey = 'principles-disciple@principles-disciple-market';
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workbuddy-installed-registry-v2-array.json'), 'utf8'), (_key, value: unknown) => {
      if (value === 'USER_CACHE') return lab.cache;
      if (value === 'PROJECT_CACHE') return olderCache;
      if (value === 'PROJECT_WORKSPACE') return path.join(lab.paths.homeDir, 'project');
      return value;
    });
    fs.writeFileSync(lab.paths.registryPath, JSON.stringify(registry));

    const result = await lab.installer.uninstall({ language: 'en', force: true });

    expect(result.success, result.reason).toBe(true);
    const after = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(after.plugins[pluginKey].map((record: { scope: string }) => record.scope)).toEqual(['project', 'local']);
    // The user version dir is gone; the version another scope references survives.
    expect(fs.existsSync(lab.cache)).toBe(false);
    expect(fs.readFileSync(olderFile, 'utf8')).toBe('Existing project/local version');
    // Still installed for those scopes, so the host-level enable entry stays.
    const settings = JSON.parse(fs.readFileSync(lab.paths.settingsPath, 'utf8'));
    expect(settings.enabledPlugins[pluginKey]).toBe(true);
    expect(result.preservedPaths).toContain(lab.paths.registryPath);
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
  });

  it('preserves non-user scope installations even when native engine is available', async () => {
    const lab = await oldCacheLab(true);
    const olderCache = path.join(lab.paths.cachePluginRoot, '0.0.9');
    fs.mkdirSync(olderCache, { recursive: true });
    fs.writeFileSync(path.join(olderCache, 'project-owner.txt'), 'Preserve project payload');
    const pluginKey = 'principles-disciple@principles-disciple-market';
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workbuddy-installed-registry-v2-array.json'), 'utf8'), (_key, value: unknown) => {
      if (value === 'USER_CACHE') return lab.cache;
      if (value === 'PROJECT_CACHE') return olderCache;
      if (value === 'PROJECT_WORKSPACE') return path.join(lab.paths.homeDir, 'project');
      return value;
    });
    fs.writeFileSync(lab.paths.registryPath, JSON.stringify(registry));
    const result = await lab.installer.uninstall({ language: 'en', force: true });
    expect(result.success, result.reason).toBe(true);
    const after = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(after.plugins[pluginKey].map((record: { scope: string }) => record.scope)).toEqual(['project', 'local']);
    expect(JSON.parse(fs.readFileSync(lab.paths.settingsPath, 'utf8')).enabledPlugins[pluginKey]).toBe(true);
    expect(fs.readFileSync(path.join(olderCache, 'project-owner.txt'), 'utf8')).toBe('Preserve project payload');
    expect(fs.existsSync(lab.paths.marketplaceRoot)).toBe(true);
    expect(result.reason).toContain('bypassed host-wide engine commands');
  });

  it('refuses cache removal when registry is corrupt, even if plugin is not enabled', async () => {
    const lab = await oldCacheLab(false);
    const settings = JSON.parse(fs.readFileSync(lab.paths.settingsPath, 'utf8'));
    settings.enabledPlugins['principles-disciple@principles-disciple-market'] = false;
    fs.writeFileSync(lab.paths.settingsPath, JSON.stringify(settings));
    fs.writeFileSync(lab.paths.registryPath, '{not valid json');
    const originalSettings = fs.readFileSync(lab.paths.settingsPath, 'utf8');
    const result = await lab.installer.uninstall({ language: 'en', force: true });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_settings_unparsable');
    expect(fs.readFileSync(lab.paths.registryPath, 'utf8')).toBe('{not valid json');
    expect(fs.readFileSync(lab.paths.settingsPath, 'utf8')).toBe(originalSettings);
    expect(fs.existsSync(path.join(lab.cache, 'scripts/wrapper.cjs'))).toBe(true);
    expect(fs.existsSync(lab.paths.marketplaceRoot)).toBe(true);
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
  });

  it('ships all skills through an actual adapter npm archive, official installer marketplace and versioned cache', async () => {
    const staging = temporaryDirectory();
    const nodeDir = path.dirname(process.execPath);
    const npmCli = [
      path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
      path.join(path.dirname(nodeDir), 'node_modules/npm/bin/npm-cli.js'),
      path.join(path.dirname(nodeDir), 'lib/node_modules/npm/bin/npm-cli.js'),
    ].find((candidate) => fs.existsSync(candidate));
    expect(npmCli, 'real npm is required to test the package files contract').toBeDefined();
    const packed: unknown = JSON.parse(execFileSync(process.execPath, [npmCli!, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging], {
      cwd: adapter, encoding: 'utf8', windowsHide: true,
    }));
    if (!Array.isArray(packed) || !packed[0] || typeof packed[0].filename !== 'string') throw new Error('npm pack returned no filename');
    const unpacked = path.join(staging, 'unpacked');
    fs.mkdirSync(unpacked);
    await tar.extract({ file: path.join(staging, packed[0].filename), cwd: unpacked });
    const payload = path.join(staging, 'payload');
    fs.mkdirSync(payload);
    fs.renameSync(path.join(unpacked, 'package'), path.join(payload, 'workbuddy-adapter'));
    const home = temporaryDirectory();
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    fs.mkdirSync(process.env.WORKBUDDY_CONFIG_DIR);
    const installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
    const result = await installer.install({ workspaceDir: path.join(home, 'project'), pluginDir: payload, language: 'en', mode: 'smart' });
    expect(result.success, result.reason).toBe(true);
    expect(result.reason).toContain('direct-write');
    const paths = resolveWorkbuddyPaths(home);
    const manifest: { version: string } = JSON.parse(fs.readFileSync(path.join(adapter, 'plugin/.codebuddy-plugin/plugin.json'), 'utf8'));
    for (const root of [
      path.join(payload, 'workbuddy-adapter/plugin'),
      path.join(paths.marketplaceRoot, 'principles-disciple'),
      path.join(paths.cachePluginRoot, manifest.version),
    ]) {
      for (const name of requiredSkills) {
        expect(fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin/skills', name, 'SKILL.md'), 'utf8'));
      }
      expect(fs.readFileSync(path.join(root, 'scripts/pd-control.cjs'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin/scripts/pd-control.cjs'), 'utf8'));
    }
    expect(fs.existsSync(path.join(home, '.workbuddy/skills')), 'plugin-root discovery needs no second global copy').toBe(false);
  }, 60_000);

  it.each(requiredSkills)('rejects a missing required %s before any marketplace/host registration', async (skill) => {
    const payload = temporaryDirectory();
    fs.cpSync(path.join(adapter, 'plugin'), path.join(payload, 'workbuddy-adapter/plugin'), { recursive: true });
    fs.unlinkSync(path.join(payload, 'workbuddy-adapter/plugin/skills', skill, 'SKILL.md'));
    const home = temporaryDirectory();
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    fs.mkdirSync(process.env.WORKBUDDY_CONFIG_DIR);
    const preservedSettings = '{"theme":"Owner setting","enabledPlugins":{"other@market":true}}';
    fs.writeFileSync(path.join(process.env.WORKBUDDY_CONFIG_DIR, 'settings.json'), preservedSettings);
    const installer = new WorkBuddyHostInstaller({ homeDir: () => home, enginePath: () => undefined });
    const result = await installer.install({ workspaceDir: home, pluginDir: payload, language: 'en', mode: 'smart' });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_plugin_skill_missing');
    expect(result.reason).toContain(skill);
    const paths = resolveWorkbuddyPaths(home);
    expect(fs.readFileSync(paths.settingsPath, 'utf8')).toBe(preservedSettings);
    for (const absent of [paths.marketplaceRoot, paths.registryPath, paths.governanceDir]) {
      expect(fs.existsSync(absent), absent).toBe(false);
    }
  });
});

describe('WorkBuddy disable skill official control command', () => {
  function runControl(home: string, ...args: string[]) {
    return spawnSync(process.execPath, [path.join(adapter, 'plugin/scripts/pd-control.cjs'), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', windowsHide: true,
    });
  }

  it('delegates the real installer setter, reads back OFF and preserves other flags/data', () => {
    const home = temporaryDirectory();
    const executor = path.join(home, '.pd/bootstrap/executor');
    fs.mkdirSync(path.dirname(executor), { recursive: true });
    fs.symlinkSync(installerPackage, executor, process.platform === 'win32' ? 'junction' : 'dir');
    const workspace = path.join(home, '.workbuddy/pd-workspace');
    const config = path.join(workspace, '.pd/config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '# keep Owner comment\nfeatures:\n  host.workbuddy:\n    enabled: true\n    category: quiet\n  host.codex:\n    enabled: true\n    category: quiet\n');
    const database = path.join(workspace, '.pd/state.db');
    fs.writeFileSync(database, 'Owner data remains');
    const result = runControl(home, 'disable');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, host: 'workbuddy', workspace, enabled: false });
    expect(fs.readFileSync(config, 'utf8')).toContain('host.workbuddy:\n    enabled: false');
    expect(fs.readFileSync(config, 'utf8')).toContain('host.codex:\n    enabled: true');
    expect(fs.readFileSync(config, 'utf8')).toContain('# keep Owner comment');
    expect(fs.readFileSync(database, 'utf8')).toBe('Owner data remains');
  });

  it('reports absent official API without inventing a replacement flag writer', () => {
    const home = temporaryDirectory();
    const result = runControl(home, 'disable');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, host: 'workbuddy', reason: expect.stringContaining('official_installer_api_missing') });
    expect(fs.existsSync(path.join(home, '.workbuddy'))).toBe(false);
  });

  it('propagates an official setter refusal as exit 1 and preserves malformed Owner config', () => {
    const home = temporaryDirectory();
    const executor = path.join(home, '.pd/bootstrap/executor');
    fs.mkdirSync(path.dirname(executor), { recursive: true });
    fs.symlinkSync(installerPackage, executor, process.platform === 'win32' ? 'junction' : 'dir');
    const config = path.join(home, '.workbuddy/pd-workspace/.pd/config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = 'features: [\n';
    fs.writeFileSync(config, original);
    const result = runControl(home, 'disable');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, host: 'workbuddy', reason: expect.stringContaining('config_unparsable') });
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
  });
});
