import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkBuddyHostInstaller, resolveWorkbuddyPaths } from '../src/installers/workbuddy-host-installer.js';

const adapter = path.resolve(__dirname, '../../workbuddy-adapter');
const installerPackage = path.resolve(__dirname, '..');
const requiredSkills = ['pd-record-pain', 'pd-status', 'pd-review', 'pd-disable'];
const directories: string[] = [];
const originalConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
const copyFailure = vi.hoisted((): { destination?: string } => ({}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (copyFailure.destination !== undefined && String(args[1]) === copyFailure.destination) throw new Error('injected cache copy failure');
      return actual.cpSync(...args);
    },
  };
});

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-skill-delivery-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  delete copyFailure.destination;
  if (originalConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
  else process.env.WORKBUDDY_CONFIG_DIR = originalConfigDir;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkBuddy skills through production delivery boundaries', () => {
  async function oldCacheLab(engine: boolean) {
    const payload = temporaryDirectory();
    fs.cpSync(path.join(adapter, 'plugin'), path.join(payload, 'workbuddy-adapter/plugin'), { recursive: true });
    const home = temporaryDirectory();
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, '.workbuddy');
    fs.mkdirSync(process.env.WORKBUDDY_CONFIG_DIR);
    const installer = new WorkBuddyHostInstaller({
      homeDir: () => home,
      enginePath: () => engine ? path.join(__dirname, 'fixtures/workbuddy-fake-engine.mjs') : undefined,
    });
    const context = { workspaceDir: home, pluginDir: payload, language: 'en', mode: 'smart' as const };
    const installed = await installer.install(context);
    expect(installed.success, installed.reason).toBe(true);
    const paths = resolveWorkbuddyPaths(home);
    const cache = path.join(paths.cachePluginRoot, '0.1.0');
    // Real old shipped shape: same 0.1.0 manifest, hooks/wrapper, zero skills.
    expect(JSON.parse(fs.readFileSync(path.join(cache, '.codebuddy-plugin/plugin.json'), 'utf8')).version).toBe('0.1.0');
    fs.rmSync(path.join(cache, 'skills'), { recursive: true });
    fs.unlinkSync(path.join(cache, 'scripts/pd-control.cjs'));
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
    return { installer, context, cache, paths, database, otherPlugin };
  }

  it.each([true, false])('refreshes registered hook-only 0.1.0 cache from a same-version complete payload (engine=%s)', async (engine) => {
    const lab = await oldCacheLab(engine);
    const result = await lab.installer.install(lab.context);
    expect(result.success, result.reason).toBe(true);
    expect(result.reason).toContain('refreshed by installer');
    for (const skill of requiredSkills) {
      expect(fs.readFileSync(path.join(lab.cache, 'skills', skill, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin/skills', skill, 'SKILL.md'), 'utf8'));
    }
    expect(fs.readFileSync(path.join(lab.cache, 'scripts/pd-control.cjs'), 'utf8')).toBe(fs.readFileSync(path.join(adapter, 'plugin/scripts/pd-control.cjs'), 'utf8'));
    const registry = JSON.parse(fs.readFileSync(lab.paths.registryPath, 'utf8'));
    expect(registry.plugins['principles-disciple@principles-disciple-market']).toMatchObject({ version: '0.1.0', installPath: lab.cache });
    expect(registry.plugins['other@market']).toEqual({ version: '1.0.0', installPath: path.dirname(lab.otherPlugin) });
    expect(JSON.parse(fs.readFileSync(lab.paths.settingsPath, 'utf8'))).toMatchObject({ ownerSetting: 'preserve', enabledPlugins: { 'other@market': true } });
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
    expect(fs.readFileSync(lab.otherPlugin, 'utf8')).toBe('Other plugin data');
  });

  it('reports cache refresh failure rather than preserving a false success', async () => {
    const lab = await oldCacheLab(true);
    copyFailure.destination = lab.cache;
    const result = await lab.installer.install(lab.context);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_cache_write_failed');
    expect(result.reason).toContain('cache copy is incomplete');
    expect(fs.readFileSync(lab.database, 'utf8')).toBe('Owner governance data');
    expect(fs.readFileSync(lab.otherPlugin, 'utf8')).toBe('Other plugin data');
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
