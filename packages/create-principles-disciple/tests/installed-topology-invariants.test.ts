/**
 * PRI-920 (Runtime Topology Invariant Guard, gap G2) — settled-install
 * topology invariants.
 *
 * Phase 0 audit (docs/release/runtime-topology-audit.md) found the settled
 * install tree had ZERO落盘 assertions: R3 zero-data, canonical resolution,
 * deployment identity and payload→runtime drift were only "conventionally
 * correct". This test runs a REAL installer install() into a sandboxed HOME
 * (same harness discipline as global-shim-lifecycle.test.ts: HOME/USERPROFILE
 * redirect + real-fs delegation + mocked child_process) and then asserts the
 * invariants through the PRODUCTION reader API (@principles/install-layout +
 * the installer's own active-record reader), plus three failure simulations
 * proving each invariant is discriminating:
 *   S1 stale runtime copy    → payload-drift check reddens
 *   S2 wrong-writer mutation → zero-data check reddens
 *   S3 missing canonical     → with REAL existsSync flags (as production
 *                              callers pass them) the reader first reports
 *                              'legacy' (extension copy still present), then
 *                              'missing' after it is removed too
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { install } from '../src/installer.js';
import { digestDirectory } from '../src/update/install-layout.js';
import { getPdCliEntry, getInstallLayoutPaths, parseInstallManifest, resolveInstallLayout } from '@principles/install-layout';
import { readActiveRecord } from '../src/update/transaction-journal.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';
import { stampPayloadIdentity } from './helpers/payload-identity.js';

vi.mock('fs');
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => ''),
    // verifyConsole spawns the console server and probes /api/health; the
    // fake child never exits and the mocked 'http' answers healthy on the
    // first port, so exactly one 6s warmup elapses per install (harness
    // borrowed from installer-gateway-notice.test.ts, the only suite that
    // reaches a SUCCESS install() return).
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; pid: number;
        kill: (signal?: string) => boolean; unref: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 424242;
      child.kill = () => true;
      child.unref = () => child;
      return child;
    }),
  };
});
vi.mock('http', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));
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
  workspaceDir: '/tmp/pri920-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

const PAYLOAD_VERSION = '9.9.9';

describe('PRI-920 settled-install topology invariants', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let fixtureDir: string;
  let workspaceDir: string;
  let realFs: typeof import('node:fs');
  let realPath: typeof import('node:path');

  beforeEach(async () => {
    vi.clearAllMocks();
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PD_ALLOW_LEGACY_NPM_INSTALL: process.env.PD_ALLOW_LEGACY_NPM_INSTALL,
      PD_SKIP_GLOBAL_SHIM: process.env.PD_SKIP_GLOBAL_SHIM,
      PD_SKIP_NPM_UPGRADE: process.env.PD_SKIP_NPM_UPGRADE,
      PD_SKIP_CONSOLE_AUTOLAUNCH: process.env.PD_SKIP_CONSOLE_AUTOLAUNCH,
    };
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    realPath = await vi.importActual<typeof import('node:path')>('node:path');

    sandboxRoot = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'pd-920-sandbox-')));
    const globalBinDir = realPath.join(sandboxRoot, 'npm-global', 'bin');
    const npmPrefixForProbe = process.platform === 'win32' ? globalBinDir : realPath.join(sandboxRoot, 'npm-global');
    fixtureDir = realPath.join(sandboxRoot, 'bundle');
    workspaceDir = realPath.join(sandboxRoot, 'ws');
    realFs.mkdirSync(globalBinDir, { recursive: true });
    realFs.mkdirSync(workspaceDir, { recursive: true });

    // Both must be pinned: the installer's getHomeDir() reads HOME, but the
    // bootstrap-executor module dynamically imported during delivery resolves
    // home via os.homedir(), which on Windows consults USERPROFILE — a HOME-only
    // redirect let one install run write the REAL ~/.pd (install.json + executor.staging).
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    delete process.env.PD_SKIP_GLOBAL_SHIM;
    delete process.env.PD_SKIP_NPM_UPGRADE;
    // The settled topology is the subject — the post-install console launch
    // would spawn a detached real process; the documented smoke seam skips it.
    process.env.PD_SKIP_CONSOLE_AUTOLAUNCH = '1';
    setLanguage('en');

    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      realFs.mkdirSync(realPath.join(fixtureDir, component, 'dist'), { recursive: true });
      realFs.writeFileSync(realPath.join(fixtureDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: PAYLOAD_VERSION }));
      realFs.writeFileSync(realPath.join(fixtureDir, component, 'dist', 'entry.js'), `export const component = '${component}';\n`);
    }
    realFs.writeFileSync(realPath.join(fixtureDir, 'plugin', 'openclaw.plugin.json'), JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } }));
    realFs.writeFileSync(realPath.join(fixtureDir, 'pd-cli', 'dist', 'index.js'), 'module.exports = {};\n');
    realFs.mkdirSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};\n');
    realFs.writeFileSync(realPath.join(fixtureDir, 'release-manager', 'dist', 'update', 'console-surface.js'), 'export {};\n');
    realFs.mkdirSync(realPath.join(fixtureDir, 'console', 'dist', 'web'), { recursive: true });
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'server.js'), 'export {};\n');
    realFs.writeFileSync(realPath.join(fixtureDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');

    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });
    // /api/health answers healthy on the first probe (mirrors
    // installer-gateway-notice.test.ts answerHealthy).
    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
    httpModule.get.mockImplementation((_url: unknown, cb: (res: unknown) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ success: true, data: { overall: 'healthy' } })));
        res.emit('end');
      });
      return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
    });
    vi.mocked(childProcess.execFileSync).mockImplementation(((_file: string, argv?: readonly string[]) => {
      if (Array.isArray(argv) && argv.includes('prefix')) return npmPrefixForProbe;
      return '';
    }) as typeof childProcess.execFileSync);

    const fsMock = vi.mocked(fs) as unknown as Record<string, { mockImplementation: (impl: never) => void }>;
    for (const key of Object.keys(realFs)) {
      const value = (realFs as unknown as Record<string, unknown>)[key];
      const mock = fsMock[key];
      if (typeof value === 'function' && mock && typeof mock.mockImplementation === 'function') {
        mock.mockImplementation(((...args: unknown[]) => (value as (...a: unknown[]) => unknown)(...args)) as never);
      }
    }

    stampPayloadIdentity(fixtureDir, PAYLOAD_VERSION);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setLanguage('zh');
    if (sandboxRoot) realFs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  async function settleInstalledRuntime(): Promise<{ coreDir: string; consoleDir: string; pdDir: string; runtimeDir: string }> {
    const result = await install({ ...baseInstallOptions, workspaceDir }, fixtureDir, { quiet: true });
    expect(result.success, `install must succeed: ${result.reason ?? result.error}`).toBe(true);
    return getInstallLayoutPaths(sandboxRoot) as unknown as { coreDir: string; consoleDir: string; pdDir: string; runtimeDir: string };
  }

  /** Invariant battery — the SAME checks a future pd doctor would reuse. */
  function expectSettledTopology() {
    const layout = getInstallLayoutPaths(sandboxRoot);

    // I4+I1 — the layout pointer exists, parses, and declares canonical mode,
    // and the production reader resolves through it to real component dirs.
    const manifest = realFs.readFileSync(layout.manifest, 'utf8');
    expect(parseInstallManifest(JSON.parse(manifest)).manifest?.mode).toBe('canonical');
    const resolution = resolveInstallLayout({
      homeDir: sandboxRoot,
      manifest: JSON.parse(manifest),
      canonicalRuntimeExists: realFs.existsSync(layout.consoleDir),
      // Real legacy state, as every production caller passes it
      // (pd-cli/console.ts, companion locate.ts): canonical must win the
      // precedence even though the openclaw extension copy also exists.
      legacyExtensionExists: realFs.existsSync(layout.openClawExtensionDir),
    });
    expect(resolution.mode).toBe('canonical');
    expect(realFs.existsSync(getPdCliEntry(resolution.paths, resolution.mode))).toBe(true);
    expect(realFs.existsSync(resolution.paths.consoleDir)).toBe(true);
    expect(realFs.existsSync(resolution.paths.coreDir)).toBe(true);

    // I4 — deployment provenance: active.json identity matches the payload stamp.
    const active = readActiveRecord(realPath.join(layout.pdDir, 'active.json'));
    expect(active, 'active.json must exist after a settled install').not.toBeNull();
    expect(active!.productVersion).toBe(PAYLOAD_VERSION);
    const stamp = JSON.parse(realFs.readFileSync(realPath.join(fixtureDir, '_release', 'product-identity.json'), 'utf8')) as { sourceCommit: string };
    expect(active!.sourceCommit, 'active.json must carry the payload identity sourceCommit').toBe(stamp.sourceCommit);
    expect(active!.releaseMetadataDigest).toMatch(/^[a-f0-9]{64}$/);

    // I3 — runtime zero-data: no workspace state lives under the runtime tree.
    // Suffix match, not a name whitelist: any *.db / *.sqlite (owner.db,
    // cache.sqlite, ...) and a foreign `.state` dir violate the invariant.
    const isStateName = (name: string) =>
      name === 'config.yaml' || name.endsWith('.db') || name.endsWith('.sqlite');
    const finders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of realFs.readdirSync(dir, { withFileTypes: true })) {
        const p = realPath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.state') finders.push(p);
          else walk(p);
        } else if (isStateName(entry.name)) finders.push(p);
      }
    };
    walk(layout.runtimeDir);
    expect(finders, `zero-data violated: ${finders.join(', ')}`).toEqual([]);
    expect(realFs.existsSync(realPath.join(layout.pdDir, 'state'))).toBe(false);

    // I1 drift — deployed bytes equal the payload bytes that were installed.
    expect(digestDirectory(layout.consoleDir)).toBe(digestDirectory(realPath.join(fixtureDir, 'console')));
    expect(digestDirectory(layout.coreDir)).toBe(digestDirectory(realPath.join(fixtureDir, 'core')));
    // digestDirectory skips non-regular entries, so the two dependency links
    // installConsole() creates under console/node_modules need explicit
    // realpath checks — a link aimed at a wrong component is drift the
    // digest cannot see. (coreDir has no such links; nothing to assert there.)
    const consoleModules = realPath.join(layout.consoleDir, 'node_modules');
    expect(realFs.realpathSync(realPath.join(consoleModules, 'principles-disciple')))
      .toBe(realFs.realpathSync(layout.pluginDir));
    expect(realFs.realpathSync(realPath.join(consoleModules, 'create-principles-disciple')))
      .toBe(realFs.realpathSync(layout.releaseManagerDir));
  }

  it('settled install satisfies canonical resolution, identity, zero-data and byte-drift invariants', async () => {
    await settleInstalledRuntime();
    expectSettledTopology();
  // Each case runs a real install(); the 6s console warmup in verifyConsole
  // exceeds vitest's 5s default.
  }, 90_000);

  it('S1 stale runtime copy: a drifted deployed component is detected', async () => {
    const layout = await settleInstalledRuntime();
    realFs.writeFileSync(realPath.join(layout.consoleDir, 'dist', 'server.js'), 'module.exports = { stale: true };\n');
    expect(() => expectSettledTopology()).toThrow(/digest|expected/);
  }, 90_000);

  it('S2 wrong-writer mutation: foreign state under the runtime tree is detected', async () => {
    const layout = await settleInstalledRuntime();
    realFs.writeFileSync(realPath.join(layout.runtimeDir, 'core', 'state.db'), 'foreign write');
    expect(() => expectSettledTopology()).toThrow(/zero-data/);
  }, 90_000);

  it('S3 missing canonical runtime: the production reader degrades loudly, not silently', async () => {
    const layout = await settleInstalledRuntime();
    realFs.rmSync(layout.consoleDir, { recursive: true, force: true });
    const manifest = JSON.parse(realFs.readFileSync(layout.manifest, 'utf8'));
    const flags = () => ({
      canonicalRuntimeExists: realFs.existsSync(layout.consoleDir),
      // Exactly what production callers pass (pd-cli, companion, console):
      // the live existsSync of the openclaw extension copy.
      legacyExtensionExists: realFs.existsSync(layout.openClawExtensionDir),
    });
    // Canonical gone while the host still has its plugin copy → legacy.
    const legacy = resolveInstallLayout({ homeDir: sandboxRoot, manifest, ...flags() });
    expect(legacy.mode).toBe('legacy');
    // Nothing left → missing, with nextAction pointing back at the installer.
    realFs.rmSync(layout.openClawExtensionDir, { recursive: true, force: true });
    const resolution = resolveInstallLayout({ homeDir: sandboxRoot, manifest, ...flags() });
    expect(resolution.mode).toBe('missing');
    expect(resolution.reason).toBe('install_runtime_missing');
    expect(resolution.nextAction).toMatch(/create-principles-disciple/);
  }, 90_000);
});
