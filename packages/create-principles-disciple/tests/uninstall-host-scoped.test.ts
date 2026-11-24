/**
 * Host-scoped uninstall isolation (review 2026-10-13 S1/P1, SPEC §6: 卸载不删除
 * 其它宿主).
 *
 * Regression for the confirmed defect: checkInstallStatus('workbuddy') fell
 * into the openclaw+codex else-branch, so a WorkBuddy-ONLY uninstall ran the
 * generic delete loop over the OPENCLAW plugin/config and CODEX marker/entry
 * files before WorkBuddyHostInstaller.uninstall() ever ran.
 *
 * These tests drive the REAL uninstall entry (src/uninstaller.ts uninstall() —
 * the function the CLI runUninstall handler calls) against a REAL filesystem
 * in a fake HOME where all three hosts are synthetically installed:
 *   - OpenClaw: extensions/principles-disciple + principles-disciple.json
 *   - Codex:    ~/.pd/codex/pd-hooks.marker + pd-hook-entry.cjs
 *   - WorkBuddy: PD marketplace + registration + governance workspace
 * and pin the symmetric guarantees:
 *   - uninstall --host workbuddy destroys ONLY WorkBuddy PD-owned state;
 *   - uninstall --host openclaw must not touch Codex/WorkBuddy either.
 *
 * Engine determinism: PD_WORKBUDDY_ENGINE points at a stub that exits 3 so the
 * host installer takes its observable direct-write path — the defect under test
 * is the generic path-selection, not the engine chain. The stub lives INSIDE
 * the sandbox; no real ~/.workbuddy, ~/.codebuddy, ~/.pd or ~/.openclaw is
 * touched (fake HOME/USERPROFILE pinned to the sandbox for both getHomeDir()
 * and os.homedir()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { uninstall } from '../src/uninstaller.js';
import { canonicalizeDeepestExisting, getWorkbuddyWorkspaceDir, isPathWithinRoot } from '@principles/install-layout';
import { WORKBUDDY_PLUGIN_KEY } from '../src/installers/workbuddy-host-installer.js';
import { logger } from '../src/utils/logger.js';

const TMP = fs.realpathSync(os.tmpdir());

/**
 * Host-directory overrides that `resolvePdHome()` honours AHEAD of an
 * explicitly passed `homeDir`. A test that inherits any of them from the
 * ambient host process (WorkBuddy sets WORKBUDDY_CONFIG_DIR in every child
 * shell) silently resolves the REAL user directories instead of the
 * sandbox. They must be removed before ANY layout resolution.
 */
const AMBIENT_HOST_OVERRIDE_KEYS = [
  'WORKBUDDY_CONFIG_DIR',
  'CODEBUDDY_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'PD_EXPERIMENT_ROOT',
] as const;

/**
 * Point every "where is ~" authority at the sandbox and drop the ambient
 * host overrides. MUST run before `seedThreeHosts()` resolves any path.
 * `getHomeDir()` reads HOME, `os.homedir()` reads USERPROFILE on win32.
 */
function pinSandboxHome(sandbox: string): void {
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  for (const key of AMBIENT_HOST_OVERRIDE_KEYS) delete process.env[key];
}

/** Every env var a test in this file may set — saved before, restored after. */
const SAVED_ENV_NAMES = [
  'HOME',
  'USERPROFILE',
  'PD_WORKBUDDY_ENGINE',
  ...AMBIENT_HOST_OVERRIDE_KEYS,
] as const;

/**
 * Fail loud instead of writing outside the disposable sandbox.
 *
 * REAL-path boundary check (round-2 P2): canonicalize the deepest existing
 * ancestor of BOTH paths so a junction/symlink/reparse point cannot fake
 * containment — a `path.relative`/`startsWith` string check resolves nothing.
 */
function assertInsideSandbox(sandbox: string, candidate: string): void {
  const root = canonicalizeDeepestExisting(sandbox) ?? path.resolve(sandbox);
  const target = canonicalizeDeepestExisting(candidate);
  if (target === null || !isPathWithinRoot(root, target)) {
    throw new Error(
      `Refusing to seed outside the test sandbox: "${target ?? path.resolve(candidate)}" escapes "${root}". ` +
      'A host directory override (WORKBUDDY_CONFIG_DIR / CODEX_HOME / OPENCLAW_HOME) leaked into the test process.',
    );
  }
}

interface Lab {
  sandbox: string;
  openclawExtDir: string;
  openclawConfig: string;
  codexMarker: string;
  codexEntry: string;
  marketplace: string;
  configDir: string;
  settingsPath: string;
  registryPath: string;
  cacheVersionDir: string;
  governance: string;
  governanceConfig: string;
  governanceTrajectory: string;
  manifestPath: string;
}

function seedThreeHosts(): Lab {
  const sandbox = fs.mkdtempSync(path.join(TMP, 'pd-uninstall-scoped-'));
  const openclawExtDir = path.join(sandbox, '.openclaw', 'extensions', 'principles-disciple');
  fs.mkdirSync(path.join(openclawExtDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(openclawExtDir, 'package.json'), '{"name":"principles-disciple"}');
  fs.writeFileSync(path.join(openclawExtDir, 'dist', 'bundle.js'), '// plugin bundle');
  const openclawConfig = path.join(sandbox, '.openclaw', 'principles-disciple.json');
  fs.writeFileSync(openclawConfig, JSON.stringify({ enabled: true }, null, 2));

  const codexMarker = path.join(sandbox, '.pd', 'codex', 'pd-hooks.marker');
  const codexEntry = path.join(sandbox, '.pd', 'codex', 'pd-hook-entry.cjs');
  fs.mkdirSync(path.dirname(codexMarker), { recursive: true });
  fs.writeFileSync(codexMarker, 'owned');
  fs.writeFileSync(codexEntry, '// entry');

  const marketplace = path.join(sandbox, '.pd', 'workbuddy-marketplace');
  fs.mkdirSync(path.join(marketplace, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplace, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({ name: 'principles-disciple-market' }, null, 2));
  fs.mkdirSync(path.join(marketplace, 'principles-disciple', '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplace, 'principles-disciple', '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: '0.3.0' }, null, 2));

  const configDir = path.join(sandbox, '.workbuddy');
  const settingsPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    enabledPlugins: { 'workbuddy-sheetagent@workbuddy-builtin': true, [WORKBUDDY_PLUGIN_KEY]: true },
  }, null, 2));
  const registryPath = path.join(configDir, 'plugins', 'installed_plugins.json');
  const cacheVersionDir = path.join(configDir, 'plugins', 'cache', 'principles-disciple-market', 'principles-disciple', '0.3.0');
  fs.mkdirSync(path.join(cacheVersionDir, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(cacheVersionDir, '.codebuddy-plugin', 'plugin.json'), '{"name":"principles-disciple"}');
  fs.writeFileSync(registryPath, JSON.stringify({
    version: 2,
    plugins: {
      [WORKBUDDY_PLUGIN_KEY]: { scope: 'user', installPath: cacheVersionDir, version: '0.3.0', installedAt: '2026-10-13T00:00:00.000Z' },
    },
  }, null, 2));

  // Governance workspace with REAL data that must survive any host uninstall.
  //
  // HARD ISOLATION (2026-11-24, real data-loss incident): the governance dir
  // MUST be derived from the sandbox, never from an ambient host override.
  // `resolvePdHome()` honours WORKBUDDY_CONFIG_DIR ahead of the `homeDir`
  // argument, so a seed that ran before `makeLab()` pinned the fake home
  // wrote this fixture into the REAL `~/.workbuddy/pd-workspace` — observed
  // on 2026-11-22 as a 24-byte config.yaml and a 22-byte
  // `sqlite-governance-data` trajectory.db replacing the Owner's live
  // databases. `pinSandboxHome()` now runs FIRST, and the explicit
  // configDirOverride makes the sandbox win even if a future caller forgets.
  pinSandboxHome(sandbox);
  // Round-2 hardening: an EMPTY env makes the resolution independent of the
  // process env entirely — the explicit override plus `{}` means the sandbox
  // wins no matter what the ambient shell carried (or what a future refactor
  // does to pinSandboxHome's ordering).
  const governance = getWorkbuddyWorkspaceDir(sandbox, path.join(sandbox, '.workbuddy'), {});
  assertInsideSandbox(sandbox, governance);
  const governanceConfig = path.join(governance, '.pd', 'config.yaml');
  fs.mkdirSync(path.dirname(governanceConfig), { recursive: true });
  fs.writeFileSync(governanceConfig, 'version: 1\nfeatures: {}\n');
  const governanceTrajectory = path.join(governance, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(governanceTrajectory), { recursive: true });
  fs.writeFileSync(governanceTrajectory, 'sqlite-governance-data');

  const manifestPath = path.join(sandbox, '.pd', 'install.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['openclaw', 'codex', 'workbuddy'],
    workspaces: [governance],
  }, null, 2));

  // Deterministic engine stub: exists (passes the engine probe) and always
  // exits 3 — the host installer reports an observable engine failure and
  // proceeds direct-write. Lives inside the sandbox.
  const engineStub = path.join(sandbox, 'pd-uninstall-scoped-engine-stub.mjs');
  fs.writeFileSync(engineStub, 'process.exit(3);\n');
  process.env.PD_WORKBUDDY_ENGINE = engineStub;

  return {
    sandbox, openclawExtDir, openclawConfig, codexMarker, codexEntry,
    marketplace, configDir, settingsPath, registryPath, cacheVersionDir,
    governance, governanceConfig, governanceTrajectory, manifestPath,
  };
}

describe('host-scoped uninstall isolation (S1: workbuddy-only must not select other hosts files)', () => {
  let savedEnv: Record<string, string | undefined>;
  let labs: Lab[] = [];

  beforeEach(() => {
    // Save EVERY variable the seed/isolation path can mutate (round-2 P1):
    // all ambient host overrides, both home authorities and the engine stub
    // pin. afterEach restores them all unconditionally so a failing test can
    // never leak a polluted process.env into the next file in this worker.
    savedEnv = {};
    for (const name of SAVED_ENV_NAMES) savedEnv[name] = process.env[name];
    labs = [];
    // Keep the uninstall console flow out of the test output.
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const lab of labs) {
      fs.rmSync(lab.sandbox, { recursive: true, force: true });
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function makeLab(): Lab {
    // Isolation is established BEFORE seeding: seedThreeHosts() resolves the
    // governance workspace through resolvePdHome(), which reads these same
    // variables. Pinning them afterwards was the 2026-11-22 data-loss bug.
    const lab = seedThreeHosts();
    labs.push(lab);
    pinSandboxHome(lab.sandbox);
    return lab;
  }

  it('seeding is hermetic even when the ambient host sets WORKBUDDY_CONFIG_DIR', () => {
    // Regression (2026-11-22 real data loss): a decoy override that looks
    // exactly like the one WorkBuddy injects into child shells. Pre-fix,
    // seedThreeHosts() resolved the governance workspace to the decoy and
    // wrote the fixture config + trajectory there.
    const decoy = fs.mkdtempSync(path.join(TMP, 'pd-uninstall-scoped-decoy-'));
    try {
      process.env.WORKBUDDY_CONFIG_DIR = path.join(decoy, '.workbuddy');

      const lab = makeLab();

      const seededConfig = path.join(lab.governance, '.pd', 'config.yaml');
      expect(fs.existsSync(seededConfig)).toBe(true);
      expect(path.resolve(lab.governance).startsWith(path.resolve(lab.sandbox))).toBe(true);
      // Nothing may be written into the decoy tree.
      expect(fs.existsSync(path.join(decoy, '.workbuddy'))).toBe(false);
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('uninstall --host workbuddy destroys ONLY WorkBuddy PD-owned state; OpenClaw and Codex stay intact', async () => {
    const lab = makeLab();

    const result = await uninstall({ force: true, lang: 'en', host: 'workbuddy' });

    expect(result.success, `uninstall failed: ${result.error ?? 'unknown'}`).toBe(true);

    // OpenClaw untouched (pre-fix these WERE deleted — the S1 defect).
    expect(fs.existsSync(path.join(lab.openclawExtDir, 'dist', 'bundle.js'))).toBe(true);
    expect(fs.existsSync(lab.openclawConfig)).toBe(true);

    // Codex untouched (pre-fix the marker + entry WERE deleted).
    expect(fs.existsSync(lab.codexMarker)).toBe(true);
    expect(fs.existsSync(lab.codexEntry)).toBe(true);

    // WorkBuddy PD-owned state removed.
    expect(fs.existsSync(lab.marketplace)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(lab.settingsPath, 'utf8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBeUndefined();
    expect(settings.enabledPlugins['workbuddy-sheetagent@workbuddy-builtin']).toBe(true); // other plugins preserved
    const registry = JSON.parse(fs.readFileSync(lab.registryPath, 'utf8')) as { plugins: Record<string, unknown> };
    expect(registry.plugins[WORKBUDDY_PLUGIN_KEY]).toBeUndefined();
    expect(fs.existsSync(lab.cacheVersionDir)).toBe(false);

    // Governance workspace preserved BY DESIGN (§18/OD-07).
    expect(fs.existsSync(lab.governanceConfig)).toBe(true);
    expect(fs.readFileSync(lab.governanceTrajectory, 'utf8')).toBe('sqlite-governance-data');

    // Manifest bookkeeping: workbuddy dropped, remaining hosts kept.
    const manifest = JSON.parse(fs.readFileSync(lab.manifestPath, 'utf8')) as { hosts: string[] };
    expect(manifest.hosts).toEqual(['openclaw', 'codex']);
  });

  it('symmetric pin: uninstall --host openclaw must not touch Codex or WorkBuddy files', async () => {
    const lab = makeLab();

    const result = await uninstall({ force: true, lang: 'en', host: 'openclaw' });

    expect(result.success, `uninstall failed: ${result.error ?? 'unknown'}`).toBe(true);

    // OpenClaw PD-owned files removed.
    expect(fs.existsSync(lab.openclawExtDir)).toBe(false);
    expect(fs.existsSync(lab.openclawConfig)).toBe(false);

    // Codex untouched.
    expect(fs.existsSync(lab.codexMarker)).toBe(true);
    expect(fs.existsSync(lab.codexEntry)).toBe(true);

    // WorkBuddy untouched: marketplace, registration, cache, governance.
    expect(fs.existsSync(lab.marketplace)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(lab.settingsPath, 'utf8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
    expect(fs.existsSync(lab.cacheVersionDir)).toBe(true);
    expect(fs.existsSync(lab.governanceConfig)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(lab.manifestPath, 'utf8')) as { hosts: string[] };
    expect(manifest.hosts).toEqual(['codex', 'workbuddy']);
  });

  it('checkInstallStatus reports only PD-owned WorkBuddy paths for the workbuddy target', async () => {
    const { checkInstallStatus } = await import('../src/uninstaller.js');
    const lab = makeLab();

    const status = checkInstallStatus('workbuddy');

    // PD-owned marketplace present; NO OpenClaw/Codex paths; NO governance dir
    // (never a deletion candidate); NO shared host config files.
    expect(status.paths.map((p) => p.path)).toEqual([lab.marketplace]);
    expect(status.isInstalled).toBe(true);

    // 'all' remains the union of all three hosts' PD-owned path sets.
    const all = checkInstallStatus('all');
    const allPaths = all.paths.map((p) => p.path);
    expect(allPaths).toContain(lab.openclawExtDir);
    expect(allPaths).toContain(lab.codexMarker);
    expect(allPaths).toContain(lab.marketplace);
    expect(allPaths).not.toContain(lab.governance);
  });
});
