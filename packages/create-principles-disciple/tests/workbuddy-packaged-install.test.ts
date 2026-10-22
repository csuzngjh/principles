/**
 * WorkBuddy distribution tests — the packaging pipeline's REAL output for the
 * workbuddy-adapter payload (SPEC workbuddy-host-adapter §4.1/§5: P05 lesson —
 * the payload must ship with its own runtime dependencies).
 *
 * Honest gating on TWO baseline realities:
 *
 * 1. `ADAPTER_PRESENT` — the @principles/workbuddy-adapter package is
 *    implemented in a PARALLEL worktree on the same baseline and lands on the
 *    integration branch together with this change. Absent → the loud-skip
 *    contract is asserted (bundle carries NO workbuddy payload; packaged
 *    installer refuses --host workbuddy with workbuddy_adapter_payload_missing)
 *    and adapter-dependent end-to-end tests are SKIPped "NOT RUN, rerun after
 *    integration" — never faked green.
 *
 * 2. `PACK_AVAILABLE` — a REAL `npm pack` (prepack = build + bundle) can only
 *    complete when every payload component compiles. On the 2026-10-12
 *    integration baseline 9a68c4b0 the shared build is broken OUTSIDE this
 *    package's scope (host-runtime src/product-telemetry/service.ts and
 *    pd-console evidence routes carry pre-widening hostKind types vs the
 *    core Part-2 freeze — owned by the parallel host-wiring/UI subagents).
 *    When the pack cannot complete for that pre-existing reason, the
 *    tarball-content tests are SKIPped with the captured failure; everything
 *    that does not need the tarball (files contract, bundle/lock wiring,
 *    compiled-dist installer behavior, upgrade refresh semantics) still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(INSTALLER_DIR, '..', '..');
const ADAPTER_SRC = path.join(REPO_ROOT, 'packages', 'workbuddy-adapter');
const ADAPTER_PRESENT = fs.existsSync(path.join(ADAPTER_SRC, 'package.json'));
const TMPDIR = fs.realpathSync(os.tmpdir());

let tarballPath: string | undefined;
let packError: string | undefined;
let tarEntries: Set<string> = new Set();
const tempDirs: string[] = [];

function npmPack(): { tarball?: string; error?: string } {
  const nodeDir = path.dirname(process.execPath);
  const prefixDir = path.dirname(nodeDir);
  const npmCli = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!npmCli) return { error: 'npm-cli.js not found next to the running Node binary' };
  const dest = fs.mkdtempSync(path.join(TMPDIR, 'pd-wb-pack-'));
  tempDirs.push(dest);
  try {
    const stdout = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', dest], {
      cwd: INSTALLER_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    const name = stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.tgz')).at(-1);
    if (!name) return { error: `npm pack produced no tarball (stdout tail: ${stdout.slice(-200)})` };
    return { tarball: path.join(dest, name) };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { error: `${err.message ?? String(error)} :: stderr tail: ${(err.stderr ?? '').slice(-400)}` };
  }
}

beforeAll(async () => {
  // Ensure THIS package's compiled dist is current for the behavioral tests
  // (fast tsc; independent of the broken cross-package build).
  const nodeDir = path.dirname(process.execPath);
  const prefixDir = path.dirname(nodeDir);
  const npmCli = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => fs.existsSync(candidate));
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, 'run', 'build', '--workspace=create-principles-disciple'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 180_000,
    });
  }
  const packed = npmPack();
  if (packed.tarball) {
    tarballPath = packed.tarball;
    const entries: string[] = [];
    await tar.list({ file: tarballPath, onReadEntry: (entry) => entries.push(entry.path) });
    tarEntries = new Set(entries); // npm tars carry the `package/` prefix
  } else {
    packError = packed.error;
  }
}, 600_000);

afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('WorkBuddy distribution — packaging contract', () => {
  it('the installer package files manifest declares the workbuddy-adapter payload', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALLER_DIR, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('workbuddy-adapter');
  });

  it('the bundle script gates the payload on the source package and requires the plugin skeleton (P05 shape)', () => {
    const bundle = fs.readFileSync(path.join(INSTALLER_DIR, 'scripts', 'bundle-plugin.mjs'), 'utf8');
    // Fail-loud required items once the adapter package exists.
    expect(bundle).toContain('WORKBUDDY_ADAPTER_REQUIRED');
    expect(bundle).toContain("join('plugin', '.codebuddy-plugin', 'plugin.json')");
    expect(bundle).toContain("join('plugin', 'hooks', 'hooks.json')");
    // Dependency rewrites make the bundled payload self-contained.
    expect(bundle).toContain("'workbuddy-adapter', '@principles/core', 'file:../core'");
    expect(bundle).toContain("'workbuddy-adapter', '@principles/host-runtime', 'file:../host-runtime'");
    expect(bundle).toContain("'workbuddy-adapter', '@principles/install-layout', 'file:../install-layout'");
    // Loud observable skip when the adapter package is absent (rc-9).
    expect(bundle).toContain('NOT present in this source tree');
  });

  // vitest skipIf evaluates at COLLECTION time, before beforeAll has packed —
  // gating here would silently skip the assertions forever (review P1). The
  // pack result is therefore asserted INSIDE each body: on the integrated
  // baseline the pack MUST succeed, and a failure is loud red with its
  // captured cause, never a skip.
  it('the tarball ships the workbuddy payload iff the adapter package exists in the source tree', () => {
    expect(packError, `npm pack failed: ${packError}`).toBeUndefined();
    expect(tarballPath).toBeDefined();
    if (ADAPTER_PRESENT) {
      expect(tarEntries.has('package/workbuddy-adapter/package.json')).toBe(true);
      expect(tarEntries.has('package/workbuddy-adapter/dist/index.js')).toBe(true);
      expect(tarEntries.has('package/workbuddy-adapter/plugin/.codebuddy-plugin/plugin.json')).toBe(true);
      expect(tarEntries.has('package/workbuddy-adapter/plugin/hooks/hooks.json')).toBe(true);
      for (const skill of ['pd-cli-operator', 'pd-pain-signal', 'pd-review', 'pd-control']) {
        expect(tarEntries.has(`package/workbuddy-adapter/plugin/skills/${skill}/SKILL.md`), skill).toBe(true);
      }
      expect(tarEntries.has('package/workbuddy-adapter/plugin/scripts/pd-control.cjs')).toBe(true);
    } else {
      expect([...tarEntries].some((entry) => entry.startsWith('package/workbuddy-adapter/'))).toBe(false);
    }
  });

  it('the tarball bundles the compiled WorkBuddy host installer', () => {
    expect(packError, `npm pack failed: ${packError}`).toBeUndefined();
    expect(tarEntries.has('package/dist/installers/workbuddy-host-installer.js')).toBe(true);
    expect(tarEntries.has('package/dist/installers/index.js')).toBe(true);
  });
});

describe('WorkBuddy distribution — P05 native-dependency distribution', () => {
  it.skipIf(!ADAPTER_PRESENT)('commits a release lock for workbuddy-adapter and wires it into the self-contained dependency install', () => {
    const lockPath = path.join(INSTALLER_DIR, 'release-locks', 'workbuddy-adapter', 'package-lock.json');
    expect(fs.existsSync(lockPath), 'release-locks/workbuddy-adapter/package-lock.json').toBe(true);
    const lock = fs.readFileSync(lockPath, 'utf8');
    expect(lock).toContain('"lockfileVersion"');

    // Self-contained build wiring (P05): the component's node_modules must be
    // materialized by bundle-plugin.mjs's locked npm ci, same as codex-adapter.
    const bundleScript = fs.readFileSync(path.join(INSTALLER_DIR, 'scripts', 'bundle-plugin.mjs'), 'utf8');
    expect(bundleScript).toContain("installBundledRuntimeDependencies(WORKBUDDY_ADAPTER_DEST, 'workbuddy-adapter')");
    // And the release lock scripts must include it (generate + check parity).
    expect(fs.readFileSync(path.join(INSTALLER_DIR, 'scripts', 'generate-release-locks.mjs'), 'utf8')).toContain("'workbuddy-adapter'");
    expect(fs.readFileSync(path.join(INSTALLER_DIR, 'scripts', 'check-release-locks.mjs'), 'utf8')).toContain("'workbuddy-adapter'");
    // The release asset builder must require the component once present.
    expect(fs.readFileSync(path.join(INSTALLER_DIR, 'scripts', 'build-release-asset.mjs'), 'utf8')).toContain("'workbuddy-adapter'");
  });

  it.skipIf(ADAPTER_PRESENT)('NOT RUN pre-integration: lock + native-dep materialization assertions', () => {
    // Verify the gate condition itself (documents why the lock cannot exist yet).
    expect(fs.existsSync(path.join(ADAPTER_SRC, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(INSTALLER_DIR, 'release-locks', 'workbuddy-adapter', 'package-lock.json'))).toBe(false);
  });
});

describe('WorkBuddy distribution — packaged dist installer behavior (real compiled artifact)', () => {
  interface DistInstaller {
    hostId: string;
    install: (ctx: { workspaceDir: string; pluginDir: string; language: string; mode: 'smart' | 'force' }) => Promise<{ success: boolean; reason?: string; nextAction: string }>;
    detectDetails: () => { installed: boolean; registered: boolean; governanceInitialized: boolean };
  }

  async function loadDistInstaller(): Promise<new (deps: { homeDir: () => string; enginePath?: () => undefined }) => DistInstaller> {
    const distEntry = path.join(INSTALLER_DIR, 'dist', 'installers', 'workbuddy-host-installer.js');
    expect(fs.existsSync(distEntry), 'compiled dist artifact').toBe(true);
    const module = (await import(pathToFileURL(distEntry).href)) as { WorkBuddyHostInstaller: new (deps: { homeDir: () => string; enginePath?: () => undefined }) => DistInstaller };
    return module.WorkBuddyHostInstaller;
  }

  function makeIsolatedHome(): { home: string; configDir: string; payloadRoot: string } {
    const home = fs.mkdtempSync(path.join(TMPDIR, 'pd-wb-dist-home-'));
    tempDirs.push(home);
    const configDir = path.join(home, '.workbuddy');
    fs.mkdirSync(configDir, { recursive: true });
    const payloadRoot = fs.mkdtempSync(path.join(TMPDIR, 'pd-wb-dist-payload-'));
    tempDirs.push(payloadRoot);
    return { home, configDir, payloadRoot };
  }

  function withWorkbuddyConfigDir<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = configDir;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
      else process.env.WORKBUDDY_CONFIG_DIR = prev;
    });
  }

  function writeSyntheticAdapterPayload(payloadRoot: string): void {
    // A minimal VALID adapter payload per the frozen manifest-facts layout —
    // dist + package.json at the component root, plugin skeleton inside.
    const adapter = path.join(payloadRoot, 'workbuddy-adapter');
    fs.mkdirSync(path.join(adapter, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(adapter, 'dist', 'index.js'), '// dist placeholder\n');
    fs.writeFileSync(path.join(adapter, 'package.json'), JSON.stringify({ name: '@principles/workbuddy-adapter', version: '0.1.0' }));
    const plugin = path.join(adapter, 'plugin');
    fs.mkdirSync(path.join(plugin, '.codebuddy-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: '9.9.9' }));
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
  }

  it.skipIf(!ADAPTER_PRESENT)('installs from a payload-carrying package into an isolated home with all writes inside that home', async () => {
    const Ctor = await loadDistInstaller();
    const labHome = makeIsolatedHome();
    await withWorkbuddyConfigDir(labHome.configDir, async () => {
      const installer = new Ctor({
        homeDir: () => labHome.home,
        enginePath: () => undefined, // engine unreachable → observable direct-write path
      });
      // pluginDir = the REAL bundled payload inside this package.
      const result = await installer.install({ workspaceDir: path.join(labHome.home, 'proj'), pluginDir: INSTALLER_DIR, language: 'en', mode: 'smart' });
      expect(result.success).toBe(true);
      expect(result.reason).toContain('direct-write');
      const details = installer.detectDetails();
      expect(details.installed).toBe(true);
      expect(details.registered).toBe(true);
      expect(details.governanceInitialized).toBe(true);
      // Every PD write lives under the isolated home (no global state touched).
      expect(fs.existsSync(path.join(labHome.configDir, 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(labHome.home, '.pd', 'install.json'))).toBe(true);
      expect(fs.existsSync(path.join(labHome.home, '.workbuddy', 'pd-workspace'))).toBe(true);
    });
  });

  it.skipIf(ADAPTER_PRESENT)('a payload-less package refuses --host workbuddy loud (pre-integration packaged behavior)', async () => {
    const Ctor = await loadDistInstaller();
    const labHome = makeIsolatedHome();
    await withWorkbuddyConfigDir(labHome.configDir, async () => {
      const installer = new Ctor({ homeDir: () => labHome.home, enginePath: () => undefined });
      const result = await installer.install({ workspaceDir: path.join(labHome.home, 'proj'), pluginDir: INSTALLER_DIR, language: 'en', mode: 'smart' });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('workbuddy_adapter_payload_missing');
      // Zero host-state mutation.
      expect(fs.existsSync(path.join(labHome.configDir, 'settings.json'))).toBe(false);
    });
  });

  it('runtime adapter dir refresh (upgrade semantics): reinstall rewrites the dir, registration and governance data survive', async () => {
    // Upgrade-path contract at the dist boundary: installBundledWorkbuddyAdapter
    // refreshes ~/.pd/runtime/workbuddy-adapter on every deployment while the
    // WorkBuddy registration and the governance database are NOT touched.
    const distIndex = path.join(INSTALLER_DIR, 'dist', 'installer.js');
    expect(fs.existsSync(distIndex), 'compiled installer dist').toBe(true);
    const dist = await import(pathToFileURL(distIndex).href) as {
      installBundledWorkbuddyAdapter: (pluginDir: string) => boolean;
    };
    const labHome = makeIsolatedHome();
    const prevHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = labHome.home;
    process.env.USERPROFILE = labHome.home;
    await withWorkbuddyConfigDir(labHome.configDir, async () => {
      // Lay down a first runtime adapter copy from a synthetic payload.
      writeSyntheticAdapterPayload(labHome.payloadRoot);
      expect(dist.installBundledWorkbuddyAdapter(labHome.payloadRoot)).toBe(true);
      const runtimeDir = path.join(labHome.home, '.pd', 'runtime', 'workbuddy-adapter');
      expect(fs.existsSync(path.join(runtimeDir, 'plugin', '.codebuddy-plugin', 'plugin.json'))).toBe(true);

      // Simulate governance data + registration that an upgrade MUST preserve.
      const governanceDb = path.join(labHome.home, '.workbuddy', 'pd-workspace', 'state.db');
      fs.mkdirSync(path.dirname(governanceDb), { recursive: true });
      fs.writeFileSync(governanceDb, 'governance-data');
      fs.writeFileSync(path.join(labHome.configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'principles-disciple@principles-disciple-market': true } }));

      // "Upgrade": a NEW payload version rewrites the runtime dir byte-fresh.
      fs.writeFileSync(
        path.join(labHome.payloadRoot, 'workbuddy-adapter', 'plugin', '.codebuddy-plugin', 'plugin.json'),
        JSON.stringify({ name: 'principles-disciple', version: '9.9.10' }),
      );
      expect(dist.installBundledWorkbuddyAdapter(labHome.payloadRoot)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'plugin', '.codebuddy-plugin', 'plugin.json'), 'utf8')).version).toBe('9.9.10');

      // Preserved across the upgrade:
      expect(fs.readFileSync(governanceDb, 'utf8')).toBe('governance-data');
      expect(JSON.parse(fs.readFileSync(path.join(labHome.configDir, 'settings.json'), 'utf8')).enabledPlugins['principles-disciple@principles-disciple-market']).toBe(true);
    }).finally(() => {
      if (prevHome.HOME === undefined) delete process.env.HOME; else process.env.HOME = prevHome.HOME;
      if (prevHome.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevHome.USERPROFILE;
    });
  });

  it.skipIf(ADAPTER_PRESENT)('NOT RUN pre-integration: packaged end-to-end WorkBuddy install with the real adapter runtime', () => {
    // Full self-contained resolution (no source dir, no global npm deps, real
    // better-sqlite3 load from the payload) requires the adapter package —
    // verify the gate condition that documents the skip.
    expect(fs.existsSync(path.join(ADAPTER_SRC, 'package.json'))).toBe(false);
  });
});
