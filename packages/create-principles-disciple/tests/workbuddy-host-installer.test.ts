/**
 * Tests for WorkBuddyHostInstaller — the WorkBuddy (third ADR-0020 host)
 * install/enable/uninstall lifecycle, exercised against REAL filesystem state
 * in isolated temp homes and a REAL spawned fake engine
 * (tests/fixtures/workbuddy-fake-engine.mjs) that reproduces the registration
 * semantics frozen by Phase 0 probe P01
 * (packages/workbuddy-adapter/tests/fixtures/host-contract/manifest-facts.json).
 *
 * These tests never touch the real ~/.workbuddy, ~/.pd or the WorkBuddy
 * installation: everything lives under a per-test temp home, and the config
 * dir is pointed there via WORKBUDDY_CONFIG_DIR (the same isolation recipe as
 * scripts/dev/workbuddy-probe).
 *
 * Coverage required by SPEC workbuddy-host-adapter §6:
 * - frozen settings/registry formats; unknown fields, other plugins, hooks keys preserved
 * - malformed host JSON → zero modification, loud failure
 * - backup + atomic replace + no residue
 * - idempotent reinstall
 * - install ≠ enable (host.workbuddy stays default OFF — asserted with the
 *   core production flag resolver computeEffectiveFlags)
 * - explicit enable/disable writes the override into the governance config
 * - uninstall: disable-first ordering, only PD-owned files removed, governance
 *   database and other plugins preserved, new-session effect communicated
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  WorkBuddyHostInstaller,
  WORKBUDDY_PLUGIN_KEY,
  WORKBUDDY_MARKETPLACE_NAME,
  WORKBUDDY_PLUGIN_NAME,
  resolveWorkbuddyPaths,
  readHostJsonFile,
  writeHostJsonFileProtected,
  setWorkbuddyGovernanceFlag,
  findWorkbuddyPluginPayload,
  runWorkbuddyEarlyPreflight,
} from '../src/installers/workbuddy-host-installer.js';
import { getHostInstallers, isHostTarget, WorkBuddyHostInstaller as WiredInstaller } from '../src/installers/index.js';
import { computeEffectiveFlags, computeFeatureFlagsFromConfig, DEFAULT_FEATURE_FLAGS, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from '@principles/host-runtime';

function parseYaml(text: string): Record<string, unknown> {
  return yaml.load(text) as Record<string, unknown>;
}

const FAKE_ENGINE = path.resolve(__dirname, 'fixtures', 'workbuddy-fake-engine.mjs');
const TMP = fs.realpathSync(os.tmpdir());

// ─── Lab construction ────────────────────────────────────────────────────────

interface Lab {
  home: string;
  configDir: string;
  payloadRoot: string; // acts as HostInstallContext.pluginDir (installer package root)
  adapterPayloadDir: string;
  runtimeAdapterDir: string;
  installer: WorkBuddyHostInstaller;
  engineEnv: Record<string, string>;
  cleanup: () => void;
}

function writePluginSkeleton(pluginDir: string, version = '0.3.0'): void {
  // Skills/control are part of the production installer payload contract.
  fs.cpSync(path.resolve(__dirname, '../../workbuddy-adapter/plugin/skills'), path.join(pluginDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../workbuddy-adapter/plugin/scripts/pd-control.cjs'), path.join(pluginDir, 'scripts', 'pd-control.cjs'));

  fs.mkdirSync(path.join(pluginDir, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
    JSON.stringify({ name: WORKBUDDY_PLUGIN_NAME, version, description: 'Principles Disciple (test skeleton)' }, null, 2),
  );
  // hooks/hooks.json at the plugin ROOT with a representative multi-event
  // baseline shape (frozen manifest-facts hooksJsonShape; the installer copies
  // the payload verbatim and asserts no event identity of its own).
  const hook = (eventArg: string) => ({
    matcher: '*',
    hooks: [{ type: 'command', command: `node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ${eventArg}`, timeout: 30 }],
  });
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [hook('pretooluse')],
        PostToolUse: [hook('posttooluse')],
        UserPromptSubmit: [hook('userpromptsubmit')],
        SessionStart: [hook('sessionstart')],
      },
    }, null, 2),
  );
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'wrapper.cjs'), '// test wrapper placeholder\n');
}

function makeLab(options: { engine?: 'real-fake' | 'unreachable' } = {}): Lab {
  const home = fs.mkdtempSync(path.join(TMP, 'pd-wb-home-'));
  const configDir = path.join(home, '.workbuddy');
  fs.mkdirSync(configDir, { recursive: true }); // host discovered

  // Bundled adapter payload (what the installer package carries).
  const payloadRoot = fs.mkdtempSync(path.join(TMP, 'pd-wb-payload-'));
  const adapterPayloadDir = path.join(payloadRoot, 'workbuddy-adapter');
  writePluginSkeleton(path.join(adapterPayloadDir, 'plugin'), '0.3.0');
  fs.mkdirSync(path.join(adapterPayloadDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(adapterPayloadDir, 'dist', 'index.js'), '// adapter dist placeholder\n');
  fs.writeFileSync(path.join(adapterPayloadDir, 'package.json'), JSON.stringify({ name: '@principles/workbuddy-adapter', version: '0.1.0' }, null, 2));

  // Installed runtime adapter copy (as installBundledWorkbuddyAdapter would lay down).
  const runtimeAdapterDir = path.join(home, '.pd', 'runtime', 'workbuddy-adapter');
  fs.mkdirSync(runtimeAdapterDir, { recursive: true });
  fs.cpSync(adapterPayloadDir, runtimeAdapterDir, { recursive: true });

  const engineEnv: Record<string, string> = {};
  const prevConfigEnv = process.env.WORKBUDDY_CONFIG_DIR;
  process.env.WORKBUDDY_CONFIG_DIR = configDir;
  const prevFail = process.env.PD_FAKE_ENGINE_FAIL;
  const prevLie = process.env.PD_FAKE_ENGINE_LIE;
  delete process.env.PD_FAKE_ENGINE_FAIL;
  delete process.env.PD_FAKE_ENGINE_LIE;

  const engine = options.engine === 'unreachable' ? undefined : FAKE_ENGINE;
  const installer = new WorkBuddyHostInstaller({
    homeDir: () => home,
    enginePath: () => engine,
    // Default runCommand (spawnSync) — the fake engine is spawned via the REAL
    // node binary path, exercising the real spawn boundary.
  });

  return {
    home,
    configDir,
    payloadRoot,
    adapterPayloadDir,
    runtimeAdapterDir,
    installer,
    engineEnv,
    cleanup: () => {
      if (prevConfigEnv === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
      else process.env.WORKBUDDY_CONFIG_DIR = prevConfigEnv;
      if (prevFail === undefined) delete process.env.PD_FAKE_ENGINE_FAIL;
      else process.env.PD_FAKE_ENGINE_FAIL = prevFail;
      if (prevLie === undefined) delete process.env.PD_FAKE_ENGINE_LIE;
      else process.env.PD_FAKE_ENGINE_LIE = prevLie;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(payloadRoot, { recursive: true, force: true });
    },
  };
}

const installCtx = (lab: Lab) => ({
  workspaceDir: path.join(lab.home, 'some-project'),
  pluginDir: lab.payloadRoot,
  language: 'en',
  mode: 'smart' as const,
});

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function settingsPath(lab: Lab): string {
  return path.join(lab.configDir, 'settings.json');
}
function registryPath(lab: Lab): string {
  return path.join(lab.configDir, 'plugins', 'installed_plugins.json');
}

const labs: Lab[] = [];
function lab(options?: { engine?: 'real-fake' | 'unreachable' }): Lab {
  const created = makeLab(options);
  labs.push(created);
  return created;
}

afterEach(() => {
  while (labs.length > 0) labs.pop()?.cleanup();
});

// ─── detect ──────────────────────────────────────────────────────────────────

describe('WorkBuddyHostInstaller.detect', () => {
  it('distinguishes host discovery, registration, enablement, runtime reachability and governance init on a fresh machine', () => {
    const created = lab();
    const details = created.installer.detectDetails();
    expect(details.installed).toBe(false);
    expect(details.hostFound).toBe(true);
    expect(details.engineFound).toBe(true); // fake engine injected
    expect(details.registered).toBe(false);
    expect(details.pluginEnabled).toBe(false);
    expect(details.flagOverride).toBeNull();
    expect(details.runtimeReachable).toBe(true);
    expect(details.governanceInitialized).toBe(false);
  });

  it('honors WORKBUDDY_CONFIG_DIR for the config dir and derives all paths from install-layout', () => {
    const created = lab();
    const p = resolveWorkbuddyPaths(created.home);
    expect(p.configDir).toBe(created.configDir);
    expect(p.governanceDir).toBe(path.join(created.home, '.workbuddy', 'pd-workspace'));
    expect(p.runtimeAdapterDir).toBe(path.join(created.home, '.pd', 'runtime', 'workbuddy-adapter'));
    expect(p.marketplaceRoot).toBe(path.join(created.home, '.pd', 'workbuddy-marketplace'));
    expect(p.installManifestPath).toBe(path.join(created.home, '.pd', 'install.json'));
  });

  it('falls back to ~/.workbuddy when no isolation env is set', () => {
    const created = lab();
    const prev = process.env.WORKBUDDY_CONFIG_DIR;
    delete process.env.WORKBUDDY_CONFIG_DIR;
    try {
      const p = resolveWorkbuddyPaths(created.home);
      expect(p.configDir).toBe(path.join(created.home, '.workbuddy'));
    } finally {
      if (prev !== undefined) process.env.WORKBUDDY_CONFIG_DIR = prev;
    }
  });
});

// ─── install (engine path) ───────────────────────────────────────────────────

describe('WorkBuddyHostInstaller.install — engine registration path', () => {
  it('registers via the engine and produces the frozen settings/registry/cache formats', async () => {
    const created = lab();
    // Pre-seed settings with unknown fields, another plugin AND a hooks key —
    // all must survive the registration.
    fs.writeFileSync(settingsPath(created), JSON.stringify({
      theme: 'dark',
      enabledPlugins: { 'workbuddy-sheetagent@workbuddy-builtin': true },
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }, null, 2));

    const result = await created.installer.install(installCtx(created));

    expect(result.success).toBe(true);
    expect(result.reason).toContain('via engine');
    expect(result.configAction).toBe('updated');

    // settings.json: enabledPlugins["principles-disciple@principles-disciple-market"]=true,
    // everything else preserved (frozen enabledPluginsFormat).
    const settings = readJson(settingsPath(created));
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    expect(enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
    expect(enabledPlugins['workbuddy-sheetagent@workbuddy-builtin']).toBe(true);
    expect(settings.theme).toBe('dark');
    expect(settings.hooks).toBeDefined();

    // installed_plugins.json v2 with scope user + cache installPath + version.
    const registry = readJson(registryPath(created));
    expect(registry.version).toBe(2);
    const entry = (registry.plugins as Record<string, Record<string, unknown>>)[WORKBUDDY_PLUGIN_KEY];
    expect(entry.scope).toBe('user');
    expect(entry.version).toBe('0.3.0');
    expect(typeof entry.installedAt).toBe('string');
    expect(String(entry.installPath)).toContain(path.join('plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME, '0.3.0'));

    // Versioned cache layout carries the plugin manifest.
    expect(fs.existsSync(path.join(created.configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME, '0.3.0', '.codebuddy-plugin', 'plugin.json'))).toBe(true);

    // Marketplace materialized PD-owned with a non-escaping source.
    const marketplace = readJson(path.join(created.home, '.pd', 'workbuddy-marketplace', '.codebuddy-plugin', 'marketplace.json'));
    expect(marketplace.name).toBe(WORKBUDDY_MARKETPLACE_NAME);
    expect(marketplace.plugins).toEqual([{ name: WORKBUDDY_PLUGIN_NAME, source: './principles-disciple' }]);
    expect(fs.existsSync(path.join(created.home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'hooks', 'hooks.json'))).toBe(true);

    // Governance workspace explicitly created (OD-07).
    expect(fs.statSync(path.join(created.home, '.workbuddy', 'pd-workspace')).isDirectory()).toBe(true);

    // Install manifest: workbuddy host added as a SET UNION with existing hosts,
    // governance workspace registered, unknown keys preserved.
    const manifest = readJson(path.join(created.home, '.pd', 'install.json'));
    expect(manifest.hosts).toContain('workbuddy');
    expect((manifest.workspaces as string[])).toContain(path.join(created.home, '.workbuddy', 'pd-workspace'));

    // R1 (review 2026-10-13): install must initialize the governance
    // workspace with a LOADER-VALID default config (never a bare mkdir). In
    // this lab the pd-cli runtime entry is absent, so the installer writes
    // its own default config and reports the DB init as an observable skip.
    // Install ≠ enable (OD-03) is preserved: the config carries NO
    // host.workbuddy override — the flag resolves to its registry default OFF.
    const governanceConfigPath = path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml');
    expect(fs.existsSync(governanceConfigPath)).toBe(true);
    const governanceConfig = parseYaml(fs.readFileSync(governanceConfigPath, 'utf8'));
    expect(governanceConfig.version).toBe(1);
    expect(governanceConfig.features).toMatchObject({
      'host.workbuddy': { enabled: true, category: 'quiet' },
      workbuddy_live_keyword_pain: { enabled: true, category: 'quiet' },
    });
    expect(created.installer.detectDetails().flagOverride).toBe(true);
    expect(created.installer.detectDetails().governanceInitialized).toBe(true);
  });

  it('merges the workbuddy host into an existing manifest without dropping codex/openclaw or unknown keys', async () => {
    const created = lab();
    fs.mkdirSync(path.join(created.home, '.pd'), { recursive: true });
    // The manifest validator requires ABSOLUTE workspace paths, and
    // `path.isAbsolute` is platform-dependent: the hard-coded 'D:/elsewhere/ws'
    // is absolute on Windows but NOT on Linux, where install() then refused the
    // whole merge with `workspaces must be non-empty absolute paths`. Derive it
    // from the lab home so the fixture is a real absolute path everywhere.
    const elsewhereWorkspace = path.resolve(created.home, 'elsewhere', 'ws');
    fs.writeFileSync(path.join(created.home, '.pd', 'install.json'), JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw', 'codex'],
      workspaces: [elsewhereWorkspace],
      channel: 'stable', // owned by the update side — must survive (PRI-709 P0-1)
    }, null, 2));

    // The hosts merge is UNCONDITIONAL once install() reaches it, so a missing
    // 'workbuddy' below means install() bailed out at one of its preflights.
    // Assert the outcome itself — not only the side effect — so the refusal
    // reason surfaces. Awaiting without checking `success` is what let a
    // Linux-only early return present as a confusing hosts diff.
    const installResult = await created.installer.install(installCtx(created));
    expect(installResult.success, `install refused: ${JSON.stringify(installResult)}`).toBe(true);

    const manifest = readJson(path.join(created.home, '.pd', 'install.json'));
    expect(manifest.hosts).toEqual(['openclaw', 'codex', 'workbuddy']);
    expect(manifest.channel).toBe('stable');
    // install-layout's merge resolves canonical absolute paths (win32 separators).
    expect((manifest.workspaces as string[])).toContain(elsewhereWorkspace);
    expect((manifest.workspaces as string[])).toContain(path.join(created.home, '.workbuddy', 'pd-workspace'));
  });

  it('never enables keyword detection when an existing governance config was present', async () => {
    const created = lab();
    const configPath = path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = getDefaultPdConfig();
    // Existing opt-outs are protected from install defaults, even if the
    // WorkBuddy plugin is not yet registered on this machine.
    original.features['host.workbuddy']!.enabled = false;
    original.features.workbuddy_live_keyword_pain!.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(original));
    const originalBytes = fs.readFileSync(configPath, 'utf8');
    const result = await created.installer.install(installCtx(created));
    expect(result.success, result.reason).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalBytes);
    const loaded = loadPdConfigForPlugin(path.join(created.home, '.workbuddy', 'pd-workspace'));
    expect(loaded.ok).toBe(true);
    const flags = computeFeatureFlagsFromConfig(loaded.effective).flags;
    expect(flags['host.workbuddy']?.enabled).toBe(false);
    expect(flags.workbuddy_live_keyword_pain?.enabled).toBe(false);
  });

  it('is idempotent: reinstall preserves state and reports preserved', async () => {
    const created = lab();
    const first = await created.installer.install(installCtx(created));
    expect(first.success).toBe(true);

    const settingsBefore = fs.readFileSync(settingsPath(created), 'utf8');
    const second = await created.installer.install(installCtx(created));
    expect(second.success).toBe(true);
    expect(second.configAction).toBe('preserved');
    // No duplicate keys, no settings churn.
    const settings = readJson(settingsPath(created));
    expect(Object.keys(settings.enabledPlugins as Record<string, unknown>).filter((k) => k === WORKBUDDY_PLUGIN_KEY)).toHaveLength(1);
    expect(fs.readFileSync(settingsPath(created), 'utf8').length).toBe(settingsBefore.length);
  });

  it('fails loud when the engine reports success but the frozen-format state is absent', async () => {
    const created = lab();
    process.env.PD_FAKE_ENGINE_LIE = '1'; // engine prints success, writes nothing
    const result = await created.installer.install(installCtx(created));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('unverified');
    // Zero PD state may remain claimed-as-installed: settings untouched.
    expect(fs.existsSync(settingsPath(created))).toBe(false);
  });
});

// ─── install (engine-unreachable direct-write path) ──────────────────────────

describe('WorkBuddyHostInstaller.install — engine-unreachable direct-write fallback', () => {
  it('registers in the frozen formats with an OBSERVABLE direct-write mode (rc-9)', async () => {
    const created = lab({ engine: 'unreachable' });
    fs.writeFileSync(settingsPath(created), JSON.stringify({
      enabledPlugins: { 'other@other-market': true },
      customKey: { nested: true },
    }, null, 2));

    const result = await created.installer.install(installCtx(created));

    expect(result.success).toBe(true);
    expect(result.reason).toContain('direct-write');
    expect(result.reason).toContain('engine');

    const settings = readJson(settingsPath(created));
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    expect(enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
    expect(enabledPlugins['other@other-market']).toBe(true); // other plugins preserved
    expect((settings.customKey as Record<string, unknown>).nested).toBe(true); // unknown fields preserved

    const registry = readJson(registryPath(created));
    expect(registry.version).toBe(2);
    const entry = (registry.plugins as Record<string, Record<string, unknown>>)[WORKBUDDY_PLUGIN_KEY];
    expect(entry.scope).toBe('user');
    expect(entry.version).toBe('0.3.0');
    expect(typeof entry.installedAt).toBe('string');

    // Cache copy materialized by the fallback itself.
    expect(fs.existsSync(path.join(String(entry.installPath), '.codebuddy-plugin', 'plugin.json'))).toBe(true);
  });

  it('falls back observable when the engine is present but its command fails', async () => {
    const created = lab();
    process.env.PD_FAKE_ENGINE_FAIL = 'marketplace-add';
    const result = await created.installer.install(installCtx(created));
    expect(result.success).toBe(true);
    expect(result.reason).toContain('direct-write');
    expect(result.reason).toContain('engine marketplace add failed');
    const settings = readJson(settingsPath(created));
    expect((settings.enabledPlugins as Record<string, unknown>)[WORKBUDDY_PLUGIN_KEY]).toBe(true);
  });
});

// ─── install refusals ────────────────────────────────────────────────────────

describe('WorkBuddyHostInstaller.install — refusals (fail loud, zero mutation)', () => {
  it('refuses when the WorkBuddy host is entirely absent', async () => {
    const created = lab({ engine: 'unreachable' });
    fs.rmSync(created.configDir, { recursive: true, force: true });
    const result = await created.installer.install(installCtx(created));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_host_not_found');
  });

  it('refuses with a fix path when node is not runnable', async () => {
    const created = lab();
    const installer = new WorkBuddyHostInstaller({
      homeDir: () => created.home,
      enginePath: () => FAKE_ENGINE,
      runCommand: (file) => ({ status: file === 'node' ? 127 : 0, stdout: '', stderr: 'not found' }),
    });
    const result = await installer.install(installCtx(created));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('node_not_available');
    expect(result.nextAction).toContain('Node');
  });

  it.skipIf(process.platform !== 'win32')('refuses on Windows when Git Bash is not resolvable', async () => {
    const created = lab();
    const installer = new WorkBuddyHostInstaller({
      homeDir: () => created.home,
      enginePath: () => FAKE_ENGINE,
      runCommand: (file) => (file === 'node'
        ? { status: 0, stdout: 'v26.0.0', stderr: '' }
        : { status: 127, stdout: '', stderr: 'not found' }),
    });
    const result = await installer.install(installCtx(created));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('git_bash_not_available');
  });

  it('refuses when the bundled adapter payload is missing (pre-integration builds)', async () => {
    const created = lab();
    fs.rmSync(created.adapterPayloadDir, { recursive: true, force: true });
    fs.rmSync(created.runtimeAdapterDir, { recursive: true, force: true });
    const result = await created.installer.install(installCtx(created));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_adapter_payload_missing');
    expect(fs.existsSync(settingsPath(created))).toBe(false);
  });

  it('stops with ZERO modification when settings.json is malformed (rc-3)', async () => {
    const created = lab();
    const malformed = '{ "enabledPlugins": ';
    fs.writeFileSync(settingsPath(created), malformed);

    const result = await created.installer.install(installCtx(created));

    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_settings_unparsable');
    // Zero modification: file byte-identical, no registry, no marketplace, no governance dir.
    expect(fs.readFileSync(settingsPath(created), 'utf8')).toBe(malformed);
    expect(fs.existsSync(registryPath(created))).toBe(false);
    expect(fs.existsSync(path.join(created.home, '.pd', 'workbuddy-marketplace'))).toBe(false);
    expect(fs.existsSync(path.join(created.home, '.workbuddy', 'pd-workspace'))).toBe(false);
    expect(fs.existsSync(path.join(created.home, '.pd', 'install.json'))).toBe(false);
  });
});

// ─── protected JSON write discipline ─────────────────────────────────────────

describe('writeHostJsonFileProtected — backup + atomic replace discipline', () => {
  it('replaces content atomically and leaves no backup residue on success', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-json-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, '{"a":1}');
      const outcome = writeHostJsonFileProtected(file, '{"a":2}\n');
      expect(outcome.ok).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":2}\n');
      expect(fs.readdirSync(dir).filter((name) => name.includes('pd-backup'))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write (and mutates nothing) when the backup itself cannot be taken', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-json-'));
    try {
      // settings.json as a non-empty DIRECTORY: cpSync(file→file) fails, so the
      // backup step stops the operation before any write is attempted.
      const file = path.join(dir, 'settings.json');
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, 'inner.txt'), 'x');
      const outcome = writeHostJsonFileProtected(file, '{"a":2}');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain('workbuddy_settings_backup_failed');
      expect(fs.readdirSync(file)).toEqual(['inner.txt']); // untouched
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── enable / disable (OD-03 explicit opt-in) ────────────────────────────────

describe('WorkBuddyHostInstaller — explicit governance enable/disable', () => {
  it('fresh install explicitly enables host while registry remains OFF for existing users', async () => {
    const created = lab();
    await created.installer.install(installCtx(created));

    // No explicit override → registry default (quiet, false) via computeEffectiveFlags.
    const effective = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, 'memory://installed-config');
    expect(effective.flags['host.workbuddy'].enabled).toBe(false);
    expect(created.installer.detectDetails().flagOverride).toBe(true);
  });

  it('describes the exact target config BEFORE any write (informed consent)', () => {
    const created = lab();
    const plan = created.installer.describeGovernanceEnable();
    expect(plan.flag).toBe('host.workbuddy');
    expect(plan.value).toBe(true);
    expect(plan.configPath).toBe(path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml'));
  });

  it('enable writes the override and the core resolver sees it ON', async () => {
    const created = lab();
    await created.installer.install(installCtx(created));

    const enabled = created.installer.enableGovernance();
    expect(enabled.ok).toBe(true);

    const governanceConfig = path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml');
    expect(fs.existsSync(governanceConfig)).toBe(true);
    // Parse the features map the same way the production loader does, then
    // resolve through the frozen core flag contract (computeEffectiveFlags).
    const parsed = parseYaml(fs.readFileSync(governanceConfig, 'utf8')) as { features: Record<string, unknown> };
    const effective = computeEffectiveFlags(parsed.features, DEFAULT_FEATURE_FLAGS, governanceConfig);
    expect(effective.flags['host.workbuddy'].enabled).toBe(true);
    expect(created.installer.detectDetails().flagOverride).toBe(true);
  });

  it('disableGovernance flips the override back OFF (reversible rollback)', async () => {
    const created = lab();
    await created.installer.install(installCtx(created));
    expect(created.installer.enableGovernance().ok).toBe(true);

    const disabled = created.installer.disableGovernance();
    expect(disabled.ok).toBe(true);
    const governanceConfig = path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml');
    const parsed = parseYaml(fs.readFileSync(governanceConfig, 'utf8')) as { features: Record<string, unknown> };
    const effective = computeEffectiveFlags(parsed.features, DEFAULT_FEATURE_FLAGS, governanceConfig);
    expect(effective.flags['host.workbuddy'].enabled).toBe(false);
  });

  it('enable preserves comments and unrelated feature overrides in an existing config', async () => {
    const created = lab();
    const governanceConfig = path.join(created.home, '.workbuddy', 'pd-workspace', '.pd', 'config.yaml');
    fs.mkdirSync(path.dirname(governanceConfig), { recursive: true });
    fs.writeFileSync(governanceConfig, [
      '# Owner-managed config',
      'version: 1',
      'features:',
      '  other_feature:',
      '    enabled: true # keep me',
      'runtimeProfiles: {}',
      'internalAgents: {}',
      '',
    ].join('\n'));

    const outcome = setWorkbuddyGovernanceFlag(path.join(created.home, '.workbuddy', 'pd-workspace'), true);
    expect(outcome.ok).toBe(true);

    const text = fs.readFileSync(governanceConfig, 'utf8');
    expect(text).toContain('# Owner-managed config');
    expect(text).toContain('enabled: true # keep me');
    expect(text).toContain('host.workbuddy:');
    const parsed = parseYaml(text) as { features: Record<string, Record<string, unknown>> };
    expect(parsed.features.other_feature.enabled).toBe(true);
    expect(parsed.features['host.workbuddy'].enabled).toBe(true);
  });

  it('enable keeps the line edit minimal on an existing entry and normalizes it with the registry-required category (R1)', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'features:\n  host.workbuddy:\n    enabled: false\n');
      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      expect(outcome.ok).toBe(true);
      // The enabled value flips in place; the write contract (R1) adds the
      // schema-required category so the production validator accepts the
      // entry (an enabled-only entry makes every hook invocation degrade).
      expect(fs.readFileSync(configPath, 'utf8')).toBe('features:\n  host.workbuddy:\n    enabled: true\n    category: quiet\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated enable keeps the entry single and idempotent (category line not duplicated)', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag2-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'features:\n  host.workbuddy:\n    enabled: true\n    category: quiet\n');
      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      expect(outcome.ok).toBe(true);
      expect(fs.readFileSync(configPath, 'utf8')).toBe('features:\n  host.workbuddy:\n    enabled: true\n    category: quiet\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enable/disable handle legal field orders inside the flag mapping (category before enabled, comments, blank lines) — review 2026-10-13 §3 P2', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag3-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // category FIRST, then enabled — the exact ordering the review flagged.
      fs.writeFileSync(configPath, 'features:\n  host.workbuddy:\n    category: quiet\n    enabled: false\n');
      const enable = setWorkbuddyGovernanceFlag(dir, true);
      expect(enable.ok).toBe(true);
      const parsed = parseYaml(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, Record<string, unknown>> };
      expect(parsed.features['host.workbuddy']).toEqual({ category: 'quiet', enabled: true });
      const disable = setWorkbuddyGovernanceFlag(dir, false);
      expect(disable.ok).toBe(true);
      const reparsed = parseYaml(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, Record<string, unknown>> };
      expect(reparsed.features['host.workbuddy'].enabled).toBe(false);
      expect(reparsed.features['host.workbuddy'].category).toBe('quiet');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enable handles comments and blank lines inside the flag mapping without duplicating keys', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag4-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, [
        'features:',
        '  host.workbuddy:',
        '    # user comment',
        '',
        '    enabled: false',
        '    category: quiet',
        '',
      ].join('\n'));
      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      expect(outcome.ok).toBe(true);
      const text = fs.readFileSync(configPath, 'utf8');
      const parsed = parseYaml(text) as { features: Record<string, Record<string, unknown>> };
      expect(parsed.features['host.workbuddy'].enabled).toBe(true);
      // No duplicate keys may be introduced.
      expect(text.match(/enabled: true/g)?.length).toBe(1);
      expect(text.match(/host\.workbuddy:/g)?.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Round-3 remediation P2: a legal `source` field (PRI-637 provenance,
  //    FeatureFlagEntry source?: 'owner' | 'system') may sit anywhere in the
  //    flag mapping. The previous scanner treated the first unrecognized line
  //    as the end of the mapping block and spliced duplicate keys ABOVE it, so
  //    the rewrite verification failed (config_rewrite_invalid) and
  //    enable/disable was refused with the stale enabled value preserved.
  //    Every assertion below that observes the flag value goes through the
  //    PRODUCTION loader composition (loadPdConfigForPlugin → validatePdConfig
  //    → computeFeatureFlagsFromConfig — the same path
  //    packages/workbuddy-adapter/src/pd-hook.ts uses to gate the flag), never
  //    through text matching alone.

  // Minimal config that the production validator accepts (version,
  // runtimeProfiles and internalAgents are required sections). The
  // `host.workbuddy:` key line is emitted by the helper; the argument is the
  // mapping BLOCK (fields/comments/blank lines indented 4 spaces).
  const governanceConfigYaml = (workbuddyBlock: string[], afterBlock: string[] = []): string =>
    [
      'version: 1',
      'features:',
      '  host.workbuddy:',
      ...workbuddyBlock,
      ...afterBlock,
      'runtimeProfiles:',
      '  pd.default:',
      '    type: pi-ai',
      '    provider: probe',
      '    model: probe-model',
      '    apiKeyEnv: PD_PROBE_KEY',
      'internalAgents:',
      '  defaultRuntime: pd.default',
      '  agents: {}',
      '',
    ].join('\n');

  function readGovernanceFlagThroughProductionLoader(governanceDir: string, flagId = 'host.workbuddy'): boolean {
    const loaded = loadPdConfigForPlugin(governanceDir);
    expect(loaded.ok, `production loader must accept the config: ${JSON.stringify(loaded.errors)}`).toBe(true);
    const flag = computeFeatureFlagsFromConfig(loaded.effective).flags[flagId];
    expect(flag, `${flagId} must resolve through the frozen flag contract`).toBeDefined();
    return flag?.enabled === true;
  }

  it.each([
    ['before enabled (category, source, enabled)', ['    category: quiet', '    source: owner', '    enabled: false']],
    ['between enabled and category (enabled, source, category)', ['    enabled: false', '    source: owner', '    category: quiet']],
    ['after category (enabled, category, source)', ['    enabled: false', '    category: quiet', '    source: owner']],
  ])('legal source field %s: enable reads true and disable reads false through the production loader', (_ordering, block) => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag-src-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, governanceConfigYaml(block));

      const enable = setWorkbuddyGovernanceFlag(dir, true);
      expect(enable.ok, `enable failed: ${enable.ok ? '' : JSON.stringify(enable)}`).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(true);

      const disable = setWorkbuddyGovernanceFlag(dir, false);
      expect(disable.ok, `disable failed: ${disable.ok ? '' : JSON.stringify(disable)}`).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enable preserves the source field, comments and blank lines inside the mapping without duplicate keys', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag-srcmix-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, governanceConfigYaml([
        '    # PRI-637 provenance recorded by the Owner',
        '    source: owner',
        '',
        '    enabled: false',
        '    # registry-required category',
        '    category: quiet',
      ]));

      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      expect(outcome.ok, `enable failed: ${outcome.ok ? '' : JSON.stringify(outcome)}`).toBe(true);

      const text = fs.readFileSync(configPath, 'utf8');
      expect(text).toContain('# PRI-637 provenance recorded by the Owner');
      expect(text).toContain('# registry-required category');
      expect(text.match(/    source: owner/g)?.length).toBe(1);
      expect(text.match(/^ {4}enabled:/gm)?.length).toBe(1);
      expect(text.match(/^ {4}category:/gm)?.length).toBe(1);
      const parsed = parseYaml(text) as { features: Record<string, Record<string, unknown>> };
      expect(parsed.features['host.workbuddy']).toEqual({ source: 'owner', enabled: true, category: 'quiet' });
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrite stops at the mapping block boundary: neighbor feature override and top-level sections untouched', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag-srcnb-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // Dedent boundaries right after the workbuddy mapping: the next feature
      // key at 2-space indent, then the required top-level sections at 0.
      fs.writeFileSync(configPath, governanceConfigYaml(
        ['    category: quiet', '    source: owner', '    enabled: false'],
        ['  signal_collector:', '    enabled: true # neighbor override', '    category: quiet'],
      ));

      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      expect(outcome.ok, `enable failed: ${outcome.ok ? '' : JSON.stringify(outcome)}`).toBe(true);

      const text = fs.readFileSync(configPath, 'utf8');
      expect(text).toContain('enabled: true # neighbor override');
      const parsed = parseYaml(text) as { features: Record<string, Record<string, unknown>> };
      expect(parsed.features.signal_collector.enabled).toBe(true);
      expect(parsed.features['host.workbuddy'].enabled).toBe(true);
      expect(parsed.features['host.workbuddy'].source).toBe('owner');
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir, 'signal_collector')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full official round trip true→false→true with a source-first mapping: every leg loader-verified', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag-srcrt-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // source BEFORE enabled — the exact shape that made the old writer
      // refuse the rewrite and silently keep the stale value.
      fs.writeFileSync(configPath, governanceConfigYaml(['    category: quiet', '    source: owner', '    enabled: false']));

      const firstEnable = setWorkbuddyGovernanceFlag(dir, true);
      expect(firstEnable.ok, `enable 1 failed: ${firstEnable.ok ? '' : JSON.stringify(firstEnable)}`).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(true);

      const disable = setWorkbuddyGovernanceFlag(dir, false);
      expect(disable.ok, `disable failed: ${disable.ok ? '' : JSON.stringify(disable)}`).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(false);

      const secondEnable = setWorkbuddyGovernanceFlag(dir, true);
      expect(secondEnable.ok, `enable 2 failed: ${secondEnable.ok ? '' : JSON.stringify(secondEnable)}`).toBe(true);
      expect(readGovernanceFlagThroughProductionLoader(dir)).toBe(true);

      const text = fs.readFileSync(configPath, 'utf8');
      expect(text.match(/^ {4}enabled:/gm)?.length).toBe(1);
      expect(text.match(/^ {4}source:/gm)?.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed flag mapping (duplicate enabled keys) is refused with zero modification', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-flag5-'));
    try {
      const configPath = path.join(dir, '.pd', 'config.yaml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const before = 'features:\n  host.workbuddy:\n    enabled: false\n    enabled: true\n';
      fs.writeFileSync(configPath, before);
      const outcome = setWorkbuddyGovernanceFlag(dir, true);
      // The production loader rejects duplicate keys; the writer must not
      // edit blind — refuse and leave the file byte-identical.
      expect(outcome.ok).toBe(false);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── uninstall ───────────────────────────────────────────────────────────────

describe('WorkBuddyHostInstaller.uninstall', () => {
  function seedNeighbors(created: Lab): void {
    // Another plugin fully registered + cached; governance state.db present.
    const settings = readJson(settingsPath(created));
    (settings.enabledPlugins as Record<string, unknown>)['neighbor@nmarket'] = true;
    fs.writeFileSync(settingsPath(created), JSON.stringify(settings, null, 2));
    const registry = readJson(registryPath(created));
    const neighborCache = path.join(created.configDir, 'plugins', 'cache', 'nmarket', 'neighbor', '1.2.3');
    fs.mkdirSync(neighborCache, { recursive: true });
    fs.writeFileSync(path.join(neighborCache, 'marker.txt'), 'neighbor');
    (registry.plugins as Record<string, unknown>)['neighbor@nmarket'] = { scope: 'user', installPath: neighborCache, version: '1.2.3' };
    fs.writeFileSync(registryPath(created), JSON.stringify(registry, null, 2));
    const governanceDb = path.join(created.home, '.workbuddy', 'pd-workspace', 'state.db');
    fs.mkdirSync(path.dirname(governanceDb), { recursive: true });
    fs.writeFileSync(governanceDb, 'governance-data');
  }

  it('disables BEFORE uninstalling, removes only PD-owned files, preserves neighbors and the governance database', async () => {
    const created = lab();
    await created.installer.install(installCtx(created));
    seedNeighbors(created);

    const result = await created.installer.uninstall({ language: 'en', force: true });

    expect(result.success).toBe(true);
    // New-session effect communicated (SPEC §6 host cache semantics).
    expect(result.nextAction).toContain('NEW WorkBuddy sessions');

    // Engine command order: disable preceded uninstall.
    const cmdLog = fs.readFileSync(path.join(created.configDir, 'plugins', '.pd-fake-engine-cmdlog.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as { cmd: string });
    const disableIdx = cmdLog.findIndex((e) => e.cmd === `plugin disable ${WORKBUDDY_PLUGIN_KEY}`);
    const uninstallIdx = cmdLog.findIndex((e) => e.cmd === `plugin uninstall ${WORKBUDDY_PLUGIN_KEY}`);
    expect(disableIdx).toBeGreaterThanOrEqual(0);
    expect(uninstallIdx).toBeGreaterThan(disableIdx);

    // Our registration is gone in BOTH frozen-format stores.
    const settings = readJson(settingsPath(created));
    expect(Object.hasOwn(settings.enabledPlugins as Record<string, unknown>, WORKBUDDY_PLUGIN_KEY)).toBe(false);
    const registry = readJson(registryPath(created));
    expect(Object.hasOwn(registry.plugins as Record<string, unknown>, WORKBUDDY_PLUGIN_KEY)).toBe(false);

    // Neighbors untouched (other plugin enabled + registered + cached).
    expect((settings.enabledPlugins as Record<string, unknown>)['neighbor@nmarket']).toBe(true);
    expect((registry.plugins as Record<string, unknown>)['neighbor@nmarket']).toBeDefined();
    expect(fs.existsSync(path.join(created.configDir, 'plugins', 'cache', 'nmarket', 'neighbor', '1.2.3', 'marker.txt'))).toBe(true);

    // OUR cache subtree removed (engine orphaned it — frozen fact — PD reclaims its own).
    expect(fs.existsSync(path.join(created.configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME))).toBe(false);

    // PD-owned marketplace removed.
    expect(fs.existsSync(path.join(created.home, '.pd', 'workbuddy-marketplace'))).toBe(false);

    // Governance database PRESERVED and reported.
    expect(fs.readFileSync(path.join(created.home, '.workbuddy', 'pd-workspace', 'state.db'), 'utf8')).toBe('governance-data');
    expect(result.preservedPaths).toContain(path.join(created.home, '.workbuddy', 'pd-workspace'));

    // Manifest: workbuddy dropped from hosts; workspaces/governance record kept.
    const manifest = readJson(path.join(created.home, '.pd', 'install.json'));
    expect(manifest.hosts).not.toContain('workbuddy');
    expect((manifest.workspaces as string[])).toContain(path.join(created.home, '.workbuddy', 'pd-workspace'));
  });

  it('uninstalls via direct-write removal when the engine is unreachable', async () => {
    const created = lab({ engine: 'unreachable' });
    await created.installer.install(installCtx(created));
    seedNeighbors(created);

    const result = await created.installer.uninstall({ language: 'en', force: true });

    expect(result.success).toBe(true);
    const settings = readJson(settingsPath(created));
    expect(Object.hasOwn(settings.enabledPlugins as Record<string, unknown>, WORKBUDDY_PLUGIN_KEY)).toBe(false);
    expect((settings.enabledPlugins as Record<string, unknown>)['neighbor@nmarket']).toBe(true);
    const registry = readJson(registryPath(created));
    expect(Object.hasOwn(registry.plugins as Record<string, unknown>, WORKBUDDY_PLUGIN_KEY)).toBe(false);
    expect(fs.existsSync(path.join(created.home, '.workbuddy', 'pd-workspace', 'state.db'))).toBe(true);
  });

  it('uninstall is a no-op that still reports success when nothing is registered', async () => {
    const created = lab();
    const result = await created.installer.uninstall({ language: 'en', force: true });
    expect(result.success).toBe(true);
  });
});

// ─── payload contract + wiring ───────────────────────────────────────────────

describe('workbuddy adapter payload contract + installer wiring', () => {
  it('rejects a plugin skeleton whose manifest name is not principles-disciple', () => {
    const parent = fs.mkdtempSync(path.join(TMP, 'pd-wb-skel-'));
    try {
      const skeleton = path.join(parent, 'workbuddy-adapter', 'plugin');
      fs.mkdirSync(path.join(skeleton, '.codebuddy-plugin'), { recursive: true });
      fs.writeFileSync(path.join(skeleton, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'someone-else' }));
      fs.mkdirSync(path.join(skeleton, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(skeleton, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
      const outcome = findWorkbuddyPluginPayload(parent, parent);
      expect(outcome.payload).toBeUndefined();
      expect(outcome.reason).toContain('workbuddy_plugin_manifest_invalid');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('is registered for --host workbuddy and NOT for --host all (install direction)', () => {
    expect(isHostTarget('workbuddy')).toBe(true);
    const workbuddy = getHostInstallers('workbuddy');
    expect(workbuddy).toHaveLength(1);
    expect(workbuddy[0]).toBeInstanceOf(WiredInstaller);
    expect(workbuddy[0].hostId).toBe('workbuddy');
    const all = getHostInstallers('all');
    expect(all.map((i) => i.hostId).sort()).toEqual(['codex', 'openclaw']);
  });
});

// readHostJsonFile direct contract (used by the installer's preflight).
describe('readHostJsonFile', () => {
  it('treats a non-object root as unparsable with a next action', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'pd-wb-read-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, '[1,2,3]');
      const outcome = readHostJsonFile(file);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.nextAction.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// PRI-1062: the pre-mutation hard preflights the MAIN installer runs before
// any npm/deployment work. Every case names what it pins from the feedback:
// a running host (locked settings.json) or a missing Git Bash must abort in
// seconds with an actionable nextAction, not after minutes of work.
describe('runWorkbuddyEarlyPreflight (PRI-1062)', () => {
  function seedHostHome(): { home: string; settingsPath: string } {
    const home = fs.mkdtempSync(path.join(TMP, 'pd-wb-preflight-'));
    const paths = resolveWorkbuddyPaths(home);
    fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
    fs.writeFileSync(paths.settingsPath, '{}');
    return { home, settingsPath: paths.settingsPath };
  }

  it('fails with git_bash_not_available when bash is unresolvable (win32 path)', () => {
    const { home } = seedHostHome();
    try {
      const result = runWorkbuddyEarlyPreflight({
        homeDir: () => home,
        platform: 'win32',
        probeBash: () => ({ ok: false, detail: 'exit 1' }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('git_bash_not_available');
        expect(result.nextAction).toContain('bash.exe on PATH');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails with workbuddy_host_file_locked when settings.json is held by the running host', () => {
    const { home, settingsPath } = seedHostHome();
    try {
      const result = runWorkbuddyEarlyPreflight({
        homeDir: () => home,
        platform: 'linux',
        probeHostFileLock: (filePath) => (filePath === settingsPath ? 'EPERM' : undefined),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('workbuddy_host_file_locked');
        expect(result.reason).toContain('settings.json');
        // The nextAction must name the user action AND note that nothing
        // was rolled back (the whole point of the early check).
        expect(result.nextAction).toContain('Fully exit WorkBuddy');
        expect(result.nextAction).toContain('before any installation work');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('passes when host files are absent or unlocked (real default probe, happy path)', () => {
    const { home } = seedHostHome();
    try {
      const result = runWorkbuddyEarlyPreflight({ homeDir: () => home, platform: 'linux' });
      expect(result).toEqual({ ok: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips the bash probe on non-win32 platforms', () => {
    const { home } = seedHostHome();
    try {
      // probeBash would fail if consulted; linux must not consult it.
      const result = runWorkbuddyEarlyPreflight({
        homeDir: () => home,
        platform: 'linux',
        probeBash: () => ({ ok: false, detail: 'must not be called' }),
      });
      expect(result).toEqual({ ok: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores lock errnos that are not exclusive-hold signals (default probe semantics)', () => {
    const { home } = seedHostHome();
    try {
      // ENOENT-style "not a lock verdict" must not abort the install.
      const result = runWorkbuddyEarlyPreflight({
        homeDir: () => home,
        platform: 'linux',
        probeHostFileLock: () => undefined,
      });
      expect(result).toEqual({ ok: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
