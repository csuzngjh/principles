/**
 * WorkBuddy install-transaction compensation — REAL fault injection on the
 * REAL installer over a REAL temp filesystem.
 *
 * The registration transaction inside directWriteRegistration only covered
 * cache + settings + registry. This suite pins the extended contract: a
 * failure in ANY post-registration stage restores the pre-install host state,
 * and a failure that CANNOT be safely restored refuses to clobber, preserves
 * verifiable recovery evidence and reports ROLLBACK_INCOMPLETE.
 *
 * All assertions are on REAL FILE BYTES / directory trees, never on a return
 * value alone. Faults are injected at documented real boundaries (the atomic
 * config writer, the cache copy/rename boundary, the command runner) — the
 * installer is never replaced by a mock, and no test depends on OS permission
 * bits (chmod is not a reliable write-failure injection when the process can
 * bypass DAC). Every test owns an isolated home/configDir/payloadRoot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import {
  atomicReplaceTextFile,
  AtomicReplaceCleanupError,
} from '../src/utils/config-file-io.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp');
const VERSION = '0.1.0';
const FOREIGN_PLUGIN = 'foreign-plugin@foreign-market';
const TEST_TIMEOUT = 30_000;

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

/** The installer adds a per-run mcp-binding.json when it stages the payload. */
function stripBinding(tree: Record<string, string>): Record<string, string> {
  const copy = { ...tree };
  delete copy['mcp-binding.json'];
  return copy;
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

function payloadPluginDir(): string {
  return path.join(payloadRoot, 'workbuddy-adapter', 'plugin');
}

function changePayload(mark: string): void {
  fs.writeFileSync(path.join(payloadPluginDir(), 'scripts', 'wrapper.cjs'), '// wrapper ' + mark + '\n');
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
  fs.writeFileSync(manifestPath(), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [] }, null, 2));
}

function seedOwnerGovernanceConfig(extra = ''): void {
  fs.mkdirSync(path.join(governanceDir(), '.pd'), { recursive: true });
  fs.writeFileSync(governanceConfigPath(), OWNER_GOVERNANCE_CONFIG + extra);
}

type RunCommandResult = { status: number | null; stdout: string; stderr: string; error?: string };
type RunCommand = (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => RunCommandResult;

/** Deterministic command boundary: no real `bash` spawn, no OS permission tricks. */
const deterministicRunCommand: RunCommand = (file) =>
  file === 'bash' ? { status: 0, stdout: '', stderr: '' } : { status: 0, stdout: 'v22', stderr: '' };

interface ScenarioDeps {
  pdCliEntry?: () => string | undefined;
  enginePath?: () => string | undefined;
  runCommand?: RunCommand;
  backupCopyDir?: typeof fs.cpSync;
  atomicReplaceConfig?: typeof atomicReplaceTextFile;
  beforeCompensation?: () => void;
  cacheRollbackOps?: { copyDir: typeof fs.cpSync; rename: typeof fs.renameSync };
}

function freshScenario(deps: ScenarioDeps = {}): WorkBuddyHostInstaller {
  return new WorkBuddyHostInstaller({
    homeDir: () => home,
    enginePath: deps.enginePath ?? (() => undefined),
    pdCliEntry: deps.pdCliEntry ?? (() => undefined),
    ...(deps.backupCopyDir !== undefined ? { backupCopyDir: deps.backupCopyDir } : {}),
    ...(deps.atomicReplaceConfig !== undefined ? { atomicReplaceConfig: deps.atomicReplaceConfig } : {}),
    ...(deps.beforeCompensation !== undefined ? { beforeCompensation: deps.beforeCompensation } : {}),
    ...(deps.cacheRollbackOps !== undefined ? { cacheRollbackOps: deps.cacheRollbackOps } : {}),
    runCommand: deps.runCommand ?? deterministicRunCommand,
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
  settings: Buffer;
  registry: Buffer;
  manifest: Buffer;
  governance?: Buffer;
  cache?: Record<string, string>;
}

function captureSeed(withCache: boolean, withGovernance: boolean): SeedState {
  const state: SeedState = {
    settings: fs.readFileSync(settingsPath()),
    registry: fs.readFileSync(registryPath()),
    manifest: fs.readFileSync(manifestPath()),
  };
  if (withGovernance) state.governance = fs.readFileSync(governanceConfigPath());
  if (withCache) state.cache = digestTree(cacheVersionDirPath());
  return state;
}

function assertHostStateRestored(seed: SeedState): void {
  expect(fs.readFileSync(settingsPath()).equals(seed.settings), 'settings.json bytes').toBe(true);
  expect(fs.readFileSync(registryPath()).equals(seed.registry), 'installed_plugins.json bytes').toBe(true);
  expect(fs.readFileSync(manifestPath()).equals(seed.manifest), 'install.json bytes').toBe(true);
}

/** A complete rollback removes every staging/backup artifact. A PARTIAL
 *  rollback must KEEP the pre-install cache backup as recovery evidence, so
 *  callers opt in to that expected residue with `allowBackupEvidence`. */
function assertResidueFree(expectCacheRemoval: boolean, allowBackupEvidence = false): void {
  const parent = cacheParent();
  const prefixes = ['.pd-staging-', '.pd-backup-', '.pd-restore-', '.pd-discard-'];
  if (!allowBackupEvidence) prefixes.push('.pd-txn-backup-');
  const leftovers = fs.readdirSync(parent).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  expect(leftovers).toEqual([]);
  if (expectCacheRemoval) expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
}

function backupDirs(): string[] {
  return fs.readdirSync(cacheParent())
    .filter((name) => name.startsWith('.pd-txn-backup-'))
    .map((name) => path.join(cacheParent(), name));
}

function recoveryDirs(): string[] {
  return fs.readdirSync(configDir)
    .filter((name) => name.startsWith('.pd-workbuddy-recovery-'))
    .map((name) => path.join(configDir, name));
}

/** Fail an INSTALL-stage write (never a rollback write) with a real thrown error. */
function failWriteOn(
  match: (filePath: string) => boolean,
  beforeThrow?: () => void,
): typeof atomicReplaceTextFile {
  return (filePath, content, ops, retry, expected) => {
    if (expected === undefined && match(filePath)) {
      beforeThrow?.();
      throw new Error('injected deterministic write failure at ' + filePath);
    }
    return atomicReplaceTextFile(filePath, content, ops, retry, expected);
  };
}

/** The rename COMMITTED, then the private temp directory cleanup failed. */
function committedCleanupOn(match: (filePath: string) => boolean): typeof atomicReplaceTextFile {
  return (filePath, content, ops, retry, expected) => {
    if (expected === undefined && match(filePath)) {
      atomicReplaceTextFile(filePath, content, ops, retry, expected);
      throw new AtomicReplaceCleanupError(filePath, '(injected temp dir)', new Error('injected cleanup failure'));
    }
    return atomicReplaceTextFile(filePath, content, ops, retry, expected);
  };
}

/** Fail `pd runtime init` AFTER registration so the transaction compensates. */
function failRuntimeInit(afterFailure?: () => void): ScenarioDeps {
  const pdCli = path.join(home, 'fake-pd-cli', 'index.js');
  return {
    pdCliEntry: () => pdCli,
    runCommand: (file, args) => {
      if (args.includes('runtime') && args.includes('init')) {
        afterFailure?.();
        return { status: 1, stdout: '', stderr: 'seam fault: runtime init failed' };
      }
      return deterministicRunCommand(file, args);
    },
  };
}

/** Run a successful install, then change the payload so the next run is an upgrade. */
async function seedUpgrade(mark: string): Promise<SeedState> {
  const seeded = await freshScenario().install(installCtx());
  expect(seeded.success, seeded.reason).toBe(true);
  const seed = captureSeed(true, true);
  changePayload(mark);
  return seed;
}

describe('WorkBuddy install-transaction compensation (real fault injection)', () => {
  beforeEach(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    home = fs.mkdtempSync(path.join(TMP_ROOT, 'wb-txn-home-'));
    // Independent configDir per scenario: no shared host state between tests.
    configDir = fs.mkdtempSync(path.join(TMP_ROOT, 'wb-txn-config-'));
    previousConfigEnv = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = configDir;
    payloadRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'wb-txn-payload-'));
    writePluginSkeleton(payloadPluginDir(), 'v1');
  });

  afterEach(() => {
    if (previousConfigEnv === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previousConfigEnv;
    for (const dir of [home, configDir, payloadRoot]) {
      if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 1 ────────────────────────────────────────────────────────────────────────
  it('R01 normal install succeeds and leaves a coherent real filesystem state', async () => {
    seedForeignState();
    const result = await freshScenario().install(installCtx());
    expect(result.success, result.reason).toBe(true);
    expect(result.pluginState?.registered).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[FOREIGN_PLUGIN]).toBe(true);
    expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as { hosts: string[] };
    expect(manifest.hosts).toContain('codex');
    expect(manifest.hosts).toContain('workbuddy');
    expect(fs.existsSync(path.join(cacheVersionDirPath(), '.codebuddy-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(governanceConfigPath())).toBe(true);
    assertResidueFree(false);
    expect(recoveryDirs()).toEqual([]);
  }, TEST_TIMEOUT);

  // 2 ────────────────────────────────────────────────────────────────────────
  it('R02 mid-install failure fully restores every original byte', async () => {
    seedForeignState();
    const seed = captureSeed(false, false);
    const installer = freshScenario(failRuntimeInit());
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_governance_init_failed');
    expect(result.reason).toContain('Previous cache and registration state restored');
    assertHostStateRestored(seed);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
    expect(recoveryDirs()).toEqual([]);
  }, TEST_TIMEOUT);

  // 3 ────────────────────────────────────────────────────────────────────────
  it('R03 Owner settings edit after install is never overwritten by rollback', async () => {
    seedForeignState();
    const seed = captureSeed(false, false);
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(governanceConfigPath())),
      beforeCompensation: () => {
        const current = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ownerEdit: 'KEEP-ME' }, null, 2));
      },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('changed after PD wrote it (concurrent modification)');
    expect(result.reason).not.toContain('Previous cache and registration state restored');

    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(settings.ownerEdit).toBe('KEEP-ME');
    expect(fs.readFileSync(settingsPath()).equals(seed.settings)).toBe(false);
    // The registration could not be safely undone, so the cache must not be deleted.
    expect(fs.existsSync(path.join(cacheVersionDirPath(), '.codebuddy-plugin', 'plugin.json'))).toBe(true);
    expect(result.nextAction).toContain('Do not treat the WorkBuddy plugin as installed');
    expect(recoveryDirs().length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  // 4 ────────────────────────────────────────────────────────────────────────
  it('R04 external registry edit is never overwritten and keeps the cache alive', async () => {
    seedForeignState();
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(governanceConfigPath())),
      beforeCompensation: () => {
        const current = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(registryPath(), JSON.stringify({ ...current, ownerConcurrentEdit: true }, null, 2));
      },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('cache: preserved because host registration/settings could not be safely restored');
    const registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Record<string, unknown>;
    expect(registry.ownerConcurrentEdit).toBe(true);
    expect(fs.existsSync(path.join(cacheVersionDirPath(), '.codebuddy-plugin', 'plugin.json'))).toBe(true);
    expect(recoveryDirs().length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  // 5 ────────────────────────────────────────────────────────────────────────
  it('R05 a write at the rollback commit boundary is detected and refuses to clobber', async () => {
    seedForeignState();
    const settingsTarget = path.resolve(settingsPath());
    let boundaryArmed = false;
    const seam: typeof atomicReplaceTextFile = (filePath, content, ops, retry, expected) => {
      if (expected === undefined && path.resolve(filePath) === path.resolve(governanceConfigPath())) {
        throw new Error('injected deterministic write failure at governance flags');
      }
      return atomicReplaceTextFile(filePath, content, ops, retry, expected);
    };
    const installer = freshScenario({
      atomicReplaceConfig: (filePath, content, ops, retry, expected) => {
        // A non-cooperating host write lands AFTER the rollback's first byte
        // check but BEFORE the final guarded replacement.
        if (expected !== undefined && !boundaryArmed && path.resolve(filePath) === settingsTarget) {
          boundaryArmed = true;
          fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('owner-dark', 'HOST-EDIT-AT-BOUNDARY'));
        }
        return seam(filePath, content, ops, retry, expected);
      },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(boundaryArmed).toBe(true);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toMatch(/rollback commit boundary|not an atomic compare-and-swap/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toContain('HOST-EDIT-AT-BOUNDARY');
    expect(recoveryDirs().length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  // 6 ────────────────────────────────────────────────────────────────────────
  it('R06 rollback deletes only PD-created files, never unrelated Owner files', async () => {
    seedForeignState();
    fs.rmSync(manifestPath(), { force: true });
    const ownerNote = path.join(home, '.pd', 'owner-note.txt');
    fs.writeFileSync(ownerNote, 'Owner data — must survive\n');
    const seed = { settings: fs.readFileSync(settingsPath()), registry: fs.readFileSync(registryPath()) };

    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(governanceConfigPath())),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Previous cache and registration state restored');
    // install.json did not exist before this transaction and was created by PD.
    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(fs.readFileSync(settingsPath()).equals(seed.settings)).toBe(true);
    expect(fs.readFileSync(registryPath()).equals(seed.registry)).toBe(true);
    expect(fs.readFileSync(ownerNote, 'utf8')).toBe('Owner data — must survive\n');
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
  }, TEST_TIMEOUT);

  // 7 ────────────────────────────────────────────────────────────────────────
  it('R07 non-UTF-8 bytes in an original host file are restored byte-for-byte', async () => {
    seedForeignState();
    const rawSettings = Buffer.concat([
      Buffer.from('{"theme":"owner-'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('","enabledPlugins":{"foreign-plugin@foreign-market":true}}'),
    ]);
    fs.writeFileSync(settingsPath(), rawSettings); // JSON still parses (replacement chars in a string)
    const seed = captureSeed(false, false);

    const result = await freshScenario(failRuntimeInit()).install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Previous cache and registration state restored');
    expect(fs.readFileSync(settingsPath()).equals(rawSettings), 'exact invalid UTF-8 bytes').toBe(true);
    expect(sha256File(settingsPath())).toBe(createHash('sha256').update(seed.settings).digest('hex'));
    expect(fs.readFileSync(registryPath()).equals(seed.registry)).toBe(true);
  }, TEST_TIMEOUT);

  // 8 ────────────────────────────────────────────────────────────────────────
  it('R08 a MISSING cache backup never deletes the current payload', async () => {
    seedForeignState();
    const oldSeed = await seedUpgrade('v2-lost-backup');
    // A REFUSED restore must leave the CURRENT (upgraded) payload alive.
    const upgradedPayload = stripBinding(digestTree(payloadPluginDir()));

    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn(
        (p) => path.resolve(p) === path.resolve(manifestPath()),
        () => { for (const dir of backupDirs()) fs.rmSync(dir, { recursive: true, force: true }); },
      ),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('pre-install backup');
    expect(result.reason).toContain('the CURRENT payload is preserved untouched; restore refused');
    expect(result.reason).not.toContain('Previous cache and registration state restored');
    expect(result.reason).toContain('MISSING');
    expect(result.nextAction).toContain('Do not treat the WorkBuddy plugin as installed');
    expect(fs.existsSync(cacheVersionDirPath())).toBe(true);
    expect(stripBinding(digestTree(cacheVersionDirPath()))).toEqual(upgradedPayload);
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toContain('v2-lost-backup');
    // It was NOT silently reverted to the old version either.
    expect(stripBinding(digestTree(cacheVersionDirPath()))).not.toEqual(stripBinding(oldSeed.cache ?? {}));
    assertResidueFree(false);
  }, TEST_TIMEOUT);

  // 9 ────────────────────────────────────────────────────────────────────────
  it('R09 a CORRUPT cache backup is rejected and the current payload stays intact', async () => {
    seedForeignState();
    await seedUpgrade('v2-corrupt-backup');
    const upgradedPayload = stripBinding(digestTree(payloadPluginDir()));

    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn(
        (p) => path.resolve(p) === path.resolve(manifestPath()),
        () => {
          for (const dir of backupDirs()) {
            const marker = path.join(dir, 'scripts', 'wrapper.cjs');
            // No existence-check-then-act race: attempt the append directly.
            // A backup without this payload file simply stays unchanged.
            try { fs.appendFileSync(marker, '\n// injected backup corruption\n'); }
            catch { /* backup payload has no wrapper.cjs — nothing to corrupt */ }
          }
        },
      ),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toMatch(/digest mismatch|CORRUPT/);
    expect(result.reason).toContain('the CURRENT payload is preserved untouched; restore refused');
    expect(stripBinding(digestTree(cacheVersionDirPath()))).toEqual(upgradedPayload);
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toContain('v2-corrupt-backup');
    // The corrupt backup is kept as evidence but explicitly reported unusable.
    expect(result.reason).toContain('CORRUPT');
    expect(backupDirs().length).toBeGreaterThan(0);
    assertResidueFree(false, true);
  }, TEST_TIMEOUT);

  // 10 ───────────────────────────────────────────────────────────────────────
  it('R10 a failing cache STAGING copy never touches the current payload', async () => {
    seedForeignState();
    await seedUpgrade('v2-staging-failure');
    const upgradedPayload = stripBinding(digestTree(payloadPluginDir()));

    // Only the rollback staging copy uses this seam; the pre-install backup
    // copy uses deps.backupCopyDir and has already completed successfully.
    const copyDir = (() => { throw new Error('EIO: injected cache staging failure'); }) as typeof fs.cpSync;
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(manifestPath())),
      cacheRollbackOps: { copyDir, rename: fs.renameSync },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('staging the restore material failed');
    expect(result.reason).toContain('the CURRENT payload is preserved untouched');
    expect(stripBinding(digestTree(cacheVersionDirPath()))).toEqual(upgradedPayload);
    // The verified pre-install snapshot stays available for manual recovery.
    expect(result.reason).toContain('Verified pre-install cache snapshot preserved');
    expect(backupDirs().length).toBeGreaterThan(0);
    assertResidueFree(false, true);
  }, TEST_TIMEOUT);

  // 11 ───────────────────────────────────────────────────────────────────────
  it('R11 a failing SECOND cache rename recovers the current payload in place', async () => {
    seedForeignState();
    await seedUpgrade('v2-swap-failure');
    const upgradedPayload = stripBinding(digestTree(payloadPluginDir()));
    let swapFailed = false;

    const rename = ((from: string, to: string) => {
      const isSwap = path.basename(from).startsWith('.pd-restore-') &&
        path.resolve(to) === path.resolve(cacheVersionDirPath());
      if (isSwap) {
        swapFailed = true;
        throw new Error('EPERM: injected second rename (staging → live) failure');
      }
      fs.renameSync(from, to);
    }) as typeof fs.renameSync;
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(manifestPath())),
      cacheRollbackOps: { copyDir: fs.cpSync, rename },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(swapFailed).toBe(true);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('the CURRENT payload was recovered in place');
    expect(fs.existsSync(cacheVersionDirPath())).toBe(true);
    expect(stripBinding(digestTree(cacheVersionDirPath()))).toEqual(upgradedPayload);
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toContain('v2-swap-failure');
  }, TEST_TIMEOUT);

  // 12 ───────────────────────────────────────────────────────────────────────
  it('R12 a cache change between the first digest and the move is preserved, not discarded', async () => {
    seedForeignState();
    await seedUpgrade('v2-concurrent-cache');
    let mutated = false;

    const rename = ((from: string, to: string) => {
      const isSetAside = path.resolve(from) === path.resolve(cacheVersionDirPath()) &&
        path.basename(to).startsWith('.pd-discard-');
      if (isSetAside && !mutated) {
        mutated = true;
        fs.appendFileSync(path.join(from, 'scripts', 'wrapper.cjs'), '\n// concurrent host write before move\n');
      }
      fs.renameSync(from, to);
    }) as typeof fs.renameSync;
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(manifestPath())),
      cacheRollbackOps: { copyDir: fs.cpSync, rename },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(mutated).toBe(true);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toMatch(/payload changed during rollback|changed during rollback after the initial digest/);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(true);
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8'))
      .toContain('concurrent host write before move');
    // The concurrent edit survived: the payload is NOT the verified old version.
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toContain('v2-concurrent-cache');
  }, TEST_TIMEOUT);

  // 13 ───────────────────────────────────────────────────────────────────────
  it('R13 rename committed but temp cleanup failed: the manifest write enters rollback', async () => {
    seedForeignState();
    const seed = captureSeed(false, false);
    const installer = freshScenario({
      atomicReplaceConfig: committedCleanupOn((p) => path.resolve(p) === path.resolve(manifestPath())),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('install_manifest_write_committed_but_cleanup_failed');
    // The new manifest really was live; compensation must have removed it.
    expect(fs.readFileSync(manifestPath()).equals(seed.manifest), 'manifest restored to original bytes').toBe(true);
    expect(fs.readFileSync(manifestPath(), 'utf8')).not.toContain('workbuddy');
    expect(fs.readFileSync(settingsPath()).equals(seed.settings)).toBe(true);
    expect(fs.readFileSync(registryPath()).equals(seed.registry)).toBe(true);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
  }, TEST_TIMEOUT);

  // 14 ───────────────────────────────────────────────────────────────────────
  it('R14 governance config written successfully then a later stage fails: config is restored', async () => {
    seedForeignState();
    seedOwnerGovernanceConfig();
    const seed = captureSeed(false, true);
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(manifestPath())),
    });
    const result = await installer.install(installCtx({ provider: 'openai', model: 'gpt-test', apiKeyEnv: 'PD_TEST_KEY' }));
    expect(result.success).toBe(false);
    expect(result.reason).toContain('install_manifest_write_failed');
    expect(fs.readFileSync(governanceConfigPath()).equals(seed.governance ?? Buffer.alloc(0)),
      'governance config restored byte-for-byte after a real profile write').toBe(true);
    assertHostStateRestored(seed);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
  }, TEST_TIMEOUT);

  // 15 ───────────────────────────────────────────────────────────────────────
  it('R15 install manifest written successfully then a later stage fails: manifest is restored', async () => {
    seedForeignState();
    seedOwnerGovernanceConfig();
    const seed = captureSeed(false, true);
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(governanceConfigPath())),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('fresh_workbuddy_flag_write_failed');
    expect(fs.readFileSync(manifestPath()).equals(seed.manifest),
      'committed manifest write was rolled back').toBe(true);
    expect(fs.readFileSync(manifestPath(), 'utf8')).not.toContain('workbuddy');
    expect(fs.readFileSync(settingsPath()).equals(seed.settings)).toBe(true);
    expect(fs.readFileSync(registryPath()).equals(seed.registry)).toBe(true);
    expect(fs.readFileSync(governanceConfigPath()).equals(seed.governance ?? Buffer.alloc(0))).toBe(true);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
  }, TEST_TIMEOUT);

  // 16 ───────────────────────────────────────────────────────────────────────
  it('R16 partial rollback publishes verifiable recovery evidence (path + snapshot + SHA)', async () => {
    seedForeignState();
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(governanceConfigPath())),
      beforeCompensation: () => {
        const current = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ownerEdit: 'evidence-check' }, null, 2));
        const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(registryPath(), JSON.stringify({ ...reg, ownerEdit: 'evidence-check' }, null, 2));
      },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('ROLLBACK_INCOMPLETE');
    expect(result.reason).toContain('manifest.json');
    expect(result.reason).toContain('sha256=');

    const dirs = recoveryDirs();
    expect(dirs.length).toBeGreaterThan(0);
    const evidenceDir = dirs[0] as string;
    const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'manifest.json'), 'utf8')) as {
      format: string;
      records: { originalPath: string; existed: boolean; snapshotFile?: string; sha256?: string }[];
    };
    expect(manifest.format).toBe('pd-workbuddy-file-recovery-v1');
    expect(manifest.records.length).toBeGreaterThanOrEqual(2);
    const paths = manifest.records.map((r) => r.originalPath);
    expect(paths).toContain(settingsPath());
    expect(paths).toContain(registryPath());
    for (const record of manifest.records) {
      expect(fs.existsSync(record.originalPath)).toBe(true);
      if (record.existed) {
        expect(record.snapshotFile).toBeDefined();
        expect(record.sha256).toBeDefined();
        const bytes = fs.readFileSync(record.snapshotFile as string);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
        expect(bytes.length).toBeGreaterThan(0);
      } else {
        expect(record.snapshotFile).toBeUndefined();
      }
    }
    expect(result.nextAction).toContain('Do not treat the WorkBuddy plugin as installed');
  }, TEST_TIMEOUT);

  // ── AdditionalOwner-guard regressions (kept from the original suite) ────────

  it('R17 a pre-upgrade backup that cannot be proven REFUSES the upgrade before replacement', async () => {
    seedForeignState();
    const seeded = await freshScenario().install(installCtx());
    expect(seeded.success, seeded.reason).toBe(true);
    const oldCache = digestTree(cacheVersionDirPath());
    const oldSettings = fs.readFileSync(settingsPath());
    const oldRegistry = fs.readFileSync(registryPath());
    changePayload('v2-unprovable-backup');

    const installer = freshScenario({
      backupCopyDir: (() => { throw new Error('EIO: injected copy-boundary failure'); }) as typeof fs.cpSync,
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('workbuddy_cache_backup_failed');
    expect(result.reason).toContain('REFUSED');
    expect(result.nextAction).toContain('previous plugin version remains installed and usable');
    expect(digestTree(cacheVersionDirPath())).toEqual(oldCache);
    expect(fs.readFileSync(path.join(cacheVersionDirPath(), 'scripts', 'wrapper.cjs'), 'utf8')).toContain('v1');
    expect(fs.readFileSync(settingsPath()).equals(oldSettings)).toBe(true);
    expect(fs.readFileSync(registryPath()).equals(oldRegistry)).toBe(true);
    assertResidueFree(false);
  }, TEST_TIMEOUT);

  it('R18 an unreadable original snapshot refuses registration without deleting Owner data', async () => {
    seedForeignState();
    fs.rmSync(manifestPath(), { force: true });
    fs.mkdirSync(manifestPath());
    const oldSettings = fs.readFileSync(settingsPath());
    const oldRegistry = fs.readFileSync(registryPath());
    try {
      const result = await freshScenario().install(installCtx());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('workbuddy_transaction_snapshot_failed');
      expect(result.reason).toContain('No host registration or cache replacement was started');
      expect(fs.readFileSync(settingsPath()).equals(oldSettings)).toBe(true);
      expect(fs.readFileSync(registryPath()).equals(oldRegistry)).toBe(true);
      expect(fs.statSync(manifestPath()).isDirectory()).toBe(true);
      expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    } finally {
      fs.rmSync(manifestPath(), { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('R19 already-registered no-op does not roll back an Owner settings edit', async () => {
    seedForeignState();
    const seeded = await freshScenario().install(installCtx());
    expect(seeded.success, seeded.reason).toBe(true);
    let ownerChanged = false;
    const installer = freshScenario({
      ...failRuntimeInit(() => {
        const current = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ownerConcurrentEdit: 'keep' }, null, 2));
        ownerChanged = true;
      }),
    });
    const result = await installer.install(installCtx());
    expect(ownerChanged).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).not.toContain('changed after PD wrote it (concurrent modification)');
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect(settings.ownerConcurrentEdit).toBe('keep');
    expect(fs.existsSync(cacheVersionDirPath())).toBe(true);
  }, TEST_TIMEOUT);

  it('R20 malformed install manifest stops AFTER registration and compensation restores it', async () => {
    seedForeignState();
    fs.writeFileSync(manifestPath(), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: 'codex', workspaces: [] }, null, 2));
    const seed = captureSeed(false, false);
    const result = await freshScenario().install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('install_manifest_malformed');
    expect(result.reason).toContain('Previous cache and registration state restored');
    assertHostStateRestored(seed);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
  }, TEST_TIMEOUT);

  it('R21 idempotent re-install keeps the Owner/foreign state intact', async () => {
    seedForeignState();
    const installer = freshScenario();
    const first = await installer.install(installCtx());
    expect(first.success, first.reason).toBe(true);
    const second = await installer.install(installCtx());
    expect(second.success, second.reason).toBe(true);
    expect(second.configAction).toBe('preserved');
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[FOREIGN_PLUGIN]).toBe(true);
    assertResidueFree(false);
  }, TEST_TIMEOUT);

  // ── Review-thread closure: #14 (init-created config) and #13 (engine commit) ─

  it('R22 a governance-init config created in a pre-existing workspace is compensated', async () => {
    seedForeignState();
    // Workspace pre-exists, but .pd/config.yaml does NOT: init creates it.
    fs.mkdirSync(path.join(governanceDir(), '.pd'), { recursive: true });
    expect(fs.existsSync(governanceConfigPath())).toBe(false);
    const seed = captureSeed(false, false);
    const installer = freshScenario({
      atomicReplaceConfig: failWriteOn((p) => path.resolve(p) === path.resolve(manifestPath())),
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    expect(result.reason).toContain('install_manifest_write_failed');
    expect(result.reason).toContain('Previous cache and registration state restored');
    // The init-created config is a tracked PD write and must be removed again.
    expect(fs.existsSync(governanceConfigPath())).toBe(false);
    assertHostStateRestored(seed);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
    assertResidueFree(true);
  }, TEST_TIMEOUT);

  it('R23 an engine registration that already committed is compensated on a later failure', async () => {
    seedForeignState();
    const seed = captureSeed(false, false);
    const engineBin = path.join(home, 'fake-engine', 'workbuddy.js');
    const installer = freshScenario({
      enginePath: () => engineBin,
      runCommand: (file, args) => {
        if (file === 'bash') return { status: 0, stdout: '', stderr: '' };
        if (args.includes('marketplace') && args.includes('add')) {
          return { status: 0, stdout: 'Marketplace added successfully', stderr: '' };
        }
        if (args.includes('plugin') && args.includes('install')) {
          // The engine COMMITS the registration; the enable-state read that
          // follows then fails because settings.json became unreadable.
          const registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as { plugins: Record<string, unknown> };
          registry.plugins[WORKBUDDY_PLUGIN_KEY] = {
            scope: 'user', installPath: cacheVersionDirPath(), version: VERSION,
          };
          fs.writeFileSync(registryPath(), JSON.stringify(registry, null, 2));
          fs.writeFileSync(settingsPath(), '{ unreadable settings after engine commit');
          return { status: 0, stdout: 'Successfully installed', stderr: '' };
        }
        return { status: 0, stdout: 'v22', stderr: '' };
      },
    });
    const result = await installer.install(installCtx());
    expect(result.success).toBe(false);
    // Protected compensation actually ran, instead of silently keeping the
    // half-installed plugin and discarding the transaction evidence.
    expect(result.configAction).not.toBe('skipped');
    expect(result.reason).toContain('Previous cache and registration state restored');
    assertHostStateRestored(seed);
    expect(fs.existsSync(cacheVersionDirPath())).toBe(false);
  }, TEST_TIMEOUT);
});
