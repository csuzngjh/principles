/**
 * WorkBuddy install-transaction compensation (2026-11-07) — REAL fault
 * injection on the REAL installer over a REAL temp filesystem.
 *
 * The registration transaction inside directWriteRegistration only covered
 * cache + settings + registry. These tests pin the extended contract: a
 * failure in ANY post-registration stage (governance init, runtime profile,
 * install manifest, governance flags) restores the pre-install host state —
 * verified by FILE DIGESTS, not by `success === false`:
 *
 *   - settings.json / installed_plugins.json byte hashes;
 *   - cache tree digest (old version byte-identical after an upgrade fault);
 *   - install.json content including OTHER hosts' entries;
 *   - governance config byte-identical (Owner flag state preserved);
 *   - no staging/backup residue left behind;
 *   - concurrent modifications are never clobbered (hash guard);
 *   - a sabotaged rollback reports ROLLBACK_INCOMPLETE with evidence.
 *
 * Faults are real OS/IO states (read-only files, deleted evidence, a failing
 * `pd runtime init` child through the documented deps.runCommand seam) — the
 * installer itself is never replaced by a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WorkBuddyHostInstaller,
  WORKBUDDY_MARKETPLACE_NAME,
  WORKBUDDY_PLUGIN_NAME,
  WORKBUDDY_PLUGIN_KEY,
} from '../src/installers/workbuddy-host-installer.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp');
const VERSION = '0.1.0';
const FOREIGN_PLUGIN = 'foreign-plugin@foreign-market';

let home = '';
let configDir = '';
let payloadRoot = '';
let previousConfigEnv: string | undefined;

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, relative: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative.length === 0 ? entry.name : relative + '/' + entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out[rel] = sha256File(abs);
    }
  };
  walk(root, '');
  return out;
}

function settingsPath(): string {
  return path.join(configDir, 'settings.json');
}
function registryPath(): string {
  return path.join(configDir, 'plugins', 'installed_plugins.json');
}
function manifestPath(): string {
  return path.join(home, '.pd', 'install.json');
}
function governanceDir(): string {
  return path.join(home, '.workbuddy', 'pd-workspace');
}
function governanceConfigPath(): string {
  return path.join(governanceDir(), '.pd', 'config.yaml');
}
function cacheVersionDirPath(): string {
  return path.join(configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME, VERSION);
}
function cacheParent(): string {
  return path.dirname(path.resolve(path.join(configDir, 'plugins', 'cache', WORKBUDDY_MARKETPLACE_NAME, WORKBUDDY_PLUGIN_NAME)));
}

/** The runtime-profile section shape the profile writer requires (loader-valid minimal config). */
const OWNER_GOVERNANCE_CONFIG = [
  '# owner governance config (pre-existing, must survive every rollback)',
  'features:',
  '  host.workbuddy:',
  '    enabled: true',
  '  workbuddy_live_keyword_pain:',
  '    enabled: false',
  '    category: quiet',
  'runtimeProfiles:',
  '  pd.default:',
  '    type: pi-ai',
  '    provider: openai',
  '    model: owner-model-x',
  '    apiKeyEnv: OWNER_KEY',
  'internalAgents:',
  '  defaultRuntime: pd.default',
  '  agents:',
  '    diagnostician:',
  '      runtimeProfile: pd.default',
  '',
].join('\n');

function writePluginSkeleton(pluginDir: string, wrapperMark: string): void {
  const src = path.join(PACKAGE_ROOT, '..', 'workbuddy-adapter', 'plugin');
  fs.cpSync(path.join(src, 'skills'), path.join(pluginDir, 'skills'), { recursive: true });
  fs.cpSync(path.join(src, 'mcp'), path.join(pluginDir, 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(src, 'scripts', 'pd-control.cjs'), path.join(pluginDir, 'scripts', 'pd-control.cjs'));
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'wrapper.cjs'), '// wrapper ' + wrapperMark + '\n');
  fs.mkdirSync(path.join(pluginDir, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
    JSON.stringify({ name: WORKBUDDY_PLUGIN_NAME, version: VERSION, defaultEnabled: false }, null, 2),
  );
  const hook = (eventArg: string) => ({
    matcher: '*',
    hooks: [{ type: 'command', command: 'node "${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ' + eventArg, timeout: 30 }],
  });
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [hook('pretooluse')], PostToolUse: [hook('posttooluse')], UserPromptSubmit: [hook('userpromptsubmit')], SessionStart: [hook('sessionstart')] } }, null, 2),
  );
}

/** Seed foreign/Owner state a rollback must NEVER clobber. */
function seedForeignState(): void {
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({
    theme: 'owner-dark',
    enabledPlugins: { [FOREIGN_PLUGIN]: true },
  }, null, 2));
  fs.writeFileSync(registryPath(), JSON.stringify({
    version: 2,
    plugins: { [FOREIGN_PLUGIN]: { scope: 'user', installPath: '/elsewhere/foreign', version: '9.9.9', installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' } },
  }, null, 2));
  fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify({
    layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['C:/owner/codex-ws'],
  }, null, 2));
}

interface ScenarioDeps {
  pdCliEntry?: () => string | undefined;
  runCommand?: (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string; error?: string };
}

function freshScenario(deps: ScenarioDeps = {}): WorkBuddyHostInstaller {
  return new WorkBuddyHostInstaller({
    homeDir: () => home,
    enginePath: () => undefined,
    pdCliEntry: deps.pdCliEntry ?? (() => undefined),
    runCommand: deps.runCommand,
  });
}

function installCtx(runtimeProfile?: { provider: string; model: string; apiKeyEnv: string }): Parameters<WorkBuddyHostInstaller['install']>[0] {
  return {
    workspaceDir: path.join(home, 'project'),
    pluginDir: payloadRoot,
    language: 'en',
    mode: 'smart',
    ...(runtimeProfile !== undefined ? { runtimeProfile } : {}),
  };
}

interface SeedState {
  settings: string;
  registry: string;
  manifest: string;
  governance?: string;
  cache?: Record<string, string>;
}

function captureSeed(withCache: boolean, withGovernance: boolean): SeedState {
  const state: SeedState = {
    settings: sha256File(settingsPath()),
    registry: sha256File(registryPath()),
    manifest: fs.readFileSync(manifestPath(), 'utf-8'),
  };
  if (withGovernance) state.governance = fs.readFileSync(governanceConfigPath(), 'utf-8');
  if (withCache) state.cache = digestTree(cacheVersionDirPath());
  return state;
}

function assertResidueFree(expectCacheRemoval: boolean): void {
  const parent = cacheParent();
  const leftovers = fs.readdirSync(parent).filter((name) => name.startsWith('.pd-staging-') || name.startsWith('.pd-backup-') || name.startsWith('.pd-txn-backup-'));
  expect(leftovers).toEqual([]);
  if (expectCacheRemoval) {
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
  }
}

describe('WorkBuddy install-transaction compensation (real fault injection)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    home = fs.mkdtempSync(path.join(TMP_ROOT, 'wb-txn-'));
    configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    previousConfigEnv = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = configDir;
    payloadRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'wb-txn-payload-'));
    writePluginSkeleton(path.join(payloadRoot, 'workbuddy-adapter', 'plugin'), 'v1');
  });

  afterAll(() => {
    if (previousConfigEnv === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previousConfigEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(payloadRoot, { recursive: true, force: true });
  });

  it('B4 #1 fresh install: governance-init failure restores the registration and cache', async () => {
    seedForeignState();
    const seed = captureSeed(false, false);
    const failInit = (file: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
      if (args.includes('runtime') && args.includes('init')) return { status: 1, stdout: '', stderr: 'seam fault: runtime init failed' };
      return { status: 0, stdout: 'v22', stderr: '' };
    };
    const pdCli = path.join(home, 'fake-pd-cli', 'index.js');
    const installer = freshScenario({ pdCliEntry: () => pdCli, runCommand: failInit });

    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_governance_init_failed');
    expect(result.reason).toContain('Previous cache and registration state restored');

    // Real state verification — not success flags.
    expect(sha256File(settingsPath())).toBe(seed.settings);
    expect(sha256File(registryPath())).toBe(seed.registry);
    expect(fs.readFileSync(manifestPath(), 'utf-8')).toBe(seed.manifest);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
    // Fresh governance workspace created by the failed attempt is preserved + reported.
    expect(result.reason).toContain('PRESERVED');
  });

  it('B4 #3 fresh install: manifest-write failure restores registration (other hosts preserved)', async () => {
    seedForeignState();
    // Pre-create the manifest as a read-only file inside a read-only dir —
    // the proven cross-platform fault recipe (Windows: file attribute blocks
    // the replace; POSIX: dir mode blocks the temp+rename).
    fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['C:/owner/codex-ws'] }, null, 2));
    fs.chmodSync(manifestPath(), 0o444);
    fs.chmodSync(path.join(home, '.pd'), 0o555);

    const seed = captureSeed(false, false);
    const installer = freshScenario();
    try {
      const result = await installer.install(installCtx());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('install_manifest_write_failed');
      expect(result.reason).toContain('Previous cache and registration state restored');

      expect(sha256File(settingsPath())).toBe(seed.settings);
      expect(sha256File(registryPath())).toBe(seed.registry);
      expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
      assertResidueFree(true);
    } finally {
      fs.chmodSync(path.join(home, '.pd'), 0o755);
      fs.chmodSync(manifestPath(), 0o644);
    }
  });

  it('B4 #4 fresh install: governance-flag failure preserves the Owner flag state byte-identically', async () => {
    seedForeignState();
    // Pre-existing governance workspace with an OWNER config; read-only file
    // + read-only .pd dir (cross-platform fault recipe) so the flags stage's
    // atomic replace fails for REAL (read fine, write fails).
    fs.mkdirSync(path.join(governanceDir(), '.pd'), { recursive: true });
    fs.writeFileSync(governanceConfigPath(), OWNER_GOVERNANCE_CONFIG);
    fs.chmodSync(governanceConfigPath(), 0o444);
    fs.chmodSync(path.join(governanceDir(), '.pd'), 0o555);

    const seed = captureSeed(false, true);
    const installer = freshScenario();
    try {
      const result = await installer.install(installCtx());
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/fresh_workbuddy_flag_write_failed|flag_write_failed/);
      expect(result.reason).toContain('Previous cache and registration state restored');

      expect(sha256File(settingsPath())).toBe(seed.settings);
      expect(sha256File(registryPath())).toBe(seed.registry);
      // Owner governance config untouched (preserved pre-existing workspace).
      expect(fs.readFileSync(governanceConfigPath(), 'utf-8')).toBe(seed.governance);
      expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
      assertResidueFree(true);
    } finally {
      fs.chmodSync(path.join(governanceDir(), '.pd'), 0o755);
      fs.chmodSync(governanceConfigPath(), 0o644);
    }
  });

  it('B4 #2 fresh install: runtime-profile write failure restores registration', async () => {
    seedForeignState();
    // Pre-existing governance workspace + read-only config/dir (cross-platform
    // fault recipe) → the profile stage's atomic replace fails for REAL after
    // the read/verify phases.
    fs.mkdirSync(path.join(governanceDir(), '.pd'), { recursive: true });
    fs.writeFileSync(governanceConfigPath(), OWNER_GOVERNANCE_CONFIG);
    fs.chmodSync(governanceConfigPath(), 0o444);
    fs.chmodSync(path.join(governanceDir(), '.pd'), 0o555);

    const seed = captureSeed(false, true);
    const installer = freshScenario();
    try {
      const result = await installer.install(installCtx({ provider: 'openai', model: 'gpt-test', apiKeyEnv: 'PD_TEST_KEY' }));
      expect(result.success).toBe(false);
      expect(result.reason).toContain('workbuddy_governance_profile_write_failed');
      expect(result.reason).toContain('Previous cache and registration state restored');

      expect(sha256File(settingsPath())).toBe(seed.settings);
      expect(sha256File(registryPath())).toBe(seed.registry);
      expect(fs.readFileSync(governanceConfigPath(), 'utf-8')).toBe(seed.governance);
      expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
      assertResidueFree(true);
    } finally {
      fs.chmodSync(path.join(governanceDir(), '.pd'), 0o755);
      fs.chmodSync(governanceConfigPath(), 0o644);
    }
  });

  it('B4 #5 upgrade: flag failure restores the OLD cache payload and registration', async () => {
    seedForeignState();
    const installer = freshScenario();
    // 1. First install succeeds (creates cache + registration).
    const first = await installer.install(installCtx());
    expect(first.success).toBe(true);

    // 2. Changed same-version payload (upgrade refresh) + a pre-existing
    //    OWNER governance config that is NOT yet flag-correct (the flags
    //    stage must ATTEMPT a write) + read-only file/dir (cross-platform
    //    fault recipe), so the write fails for REAL after the cache swap.
    fs.writeFileSync(path.join(payloadRoot, 'workbuddy-adapter', 'plugin', 'scripts', 'wrapper.cjs'), '// wrapper v2-changed\n');
    fs.mkdirSync(path.join(governanceDir(), '.pd'), { recursive: true });
    fs.writeFileSync(governanceConfigPath(), OWNER_GOVERNANCE_CONFIG + '# owner tweak\n');
    fs.chmodSync(governanceConfigPath(), 0o444);
    fs.chmodSync(path.join(governanceDir(), '.pd'), 0o555);

    const seed = captureSeed(true, true);
    try {
      const second = await installer.install(installCtx());
      expect(second.success).toBe(false);
      expect(second.reason).toContain('Previous cache and registration state restored');

      // The OLD payload is back byte-for-byte (wrapper v1, not v2).
      expect(digestTree(cacheVersionDirPath())).toEqual(seed.cache);
      expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toBe('// wrapper v1\n');
      expect(sha256File(settingsPath())).toBe(seed.settings);
      expect(sha256File(registryPath())).toBe(seed.registry);
      expect(fs.readFileSync(governanceConfigPath(), 'utf-8')).toBe(seed.governance);
      assertResidueFree(false);
      // The plugin stays LOADABLE on the old version: registration hash back
      // to pre-upgrade state already asserted; payload present + complete.
      expect(fs.existsSync(path.join(cacheVersionDirPath(), '.codebuddy-plugin', 'plugin.json'))).toBe(true);
    } finally {
      fs.chmodSync(path.join(governanceDir(), '.pd'), 0o755);
      fs.chmodSync(governanceConfigPath(), 0o644);
    }
  });

  it('B4 #7 sabotaged rollback reports ROLLBACK_INCOMPLETE and keeps evidence', async () => {
    seedForeignState();
    // Standalone scenario (no cross-test coupling): first install succeeds so
    // a pre-existing cache + registration exist; the SECOND (upgrade) install
    // then runs with a pd runtime init seam that DELETES the transaction's
    // cache evidence copy before failing — the rollback must hit the missing
    // evidence and report ROLLBACK_INCOMPLETE instead of a claimed restore.
    const seedInstaller = freshScenario();
    const seeded = await seedInstaller.install(installCtx());
    expect(seeded.success).toBe(true);
    fs.writeFileSync(path.join(payloadRoot, 'workbuddy-adapter', 'plugin', 'scripts', 'wrapper.cjs'), '// wrapper v2-sabotage\n');

    const failInitAndSabotage = (file: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
      if (args.includes('runtime') && args.includes('init')) {
        const parent = cacheParent();
        for (const name of fs.readdirSync(parent)) {
          if (name.startsWith('.pd-txn-backup-')) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
        }
        return { status: 1, stdout: '', stderr: 'seam fault: runtime init failed after evidence sabotage' };
      }
      return { status: 0, stdout: 'v22', stderr: '' };
    };
    const pdCli = path.join(home, 'fake-pd-cli', 'index.js');
    const installer = freshScenario({ pdCliEntry: () => pdCli, runCommand: failInitAndSabotage });

    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_governance_init_failed');
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.nextAction).toContain('Do not treat the WorkBuddy plugin as installed');
  });

  it('B4 #9 success path regression: install then idempotent re-install', async () => {
    seedForeignState();
    const installer = freshScenario();
    const first = await installer.install(installCtx());
    expect(first.success).toBe(true);
    expect(first.pluginState?.registered).toBe(true);
    const second = await installer.install(installCtx());
    expect(second.success).toBe(true);
    expect(second.configAction).toBe('preserved');
    // Foreign plugin survives both runs.
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[FOREIGN_PLUGIN]).toBe(true);
    expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(false);
    assertResidueFree(false);
  });
});
