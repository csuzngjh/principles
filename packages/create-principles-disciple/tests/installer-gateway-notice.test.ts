/**
 * PRI-726 — installer gateway restart failures ride the InstallResult out.
 *
 * The update committed, then the finally-block gateway restart failed: the
 * installer must report `success: true` (the payload DID deploy — never
 * rollback, never "failed") AND carry a `gatewayNotice` with a manual
 * recovery action, so ReleaseManager.apply → Console apply-full can hand it
 * to the Owner (PRI-723 legacy-path parity). A healthy restart keeps the
 * field absent — no fake warnings.
 *
 * Harness: the install()-flow family (auto-mocked 'fs' + mocked gateway
 * control, real fs-extra). Two deviations are required to reach the SUCCESS
 * return, which no existing suite does:
 *  - existsSync delegates to the REAL fs for the payload fixture (real
 *    fse.copy in installPluginToStaging needs real bytes) and answers `true`
 *    elsewhere (mocked cpSync never lands files the later probes check);
 *  - the installed release-manager authority stub is REALLY planted under
 *    the temp PD home, because verifyReleaseManagerAuthorityImports does a
 *    real dynamic import.
 * HOME/USERPROFILE point at a throwaway temp dir, so every real write stays
 * inside the test sandbox (never the developer's ~/.pd runtime).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { install } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage, t } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';
import { appendJournalTransition } from '../src/update/transaction-journal.js';

vi.mock('fs');
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => ''),
    // verifyConsole spawns the console server and probes /api/health; the
    // fake child never exits and the mocked 'http' below answers healthy on
    // the first port, so exactly one 6s warmup elapses.
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; pid: number;
        kill: (signal?: string) => boolean; unref: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // Review round: a real pid would let any stray process.kill(pid) path
      // terminate the test runner itself — keep the fake clearly fake.
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
vi.mock('../src/update/transaction-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/transaction-journal.js')>();
  return {
    ...actual,
    appendJournalTransition: vi.fn(),
  };
});

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  workspaceDir: '/tmp/pd-gateway-notice-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: true,
};

const PLUGIN_MANIFEST = JSON.stringify({
  name: 'principles-disciple',
  activation: { onCapabilities: ['hook'] },
});

/** Real on-disk npm-distributed payload (fse.copy reads real bytes). */
let payloadDir = '';
/** Throwaway PD home: every "installed" path resolves inside it. */
let pdHome = '';
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedLegacyNpmInstall: string | undefined;
let realFs: typeof import('node:fs');

function answerHealthy(httpMock: { get: ReturnType<typeof vi.fn> }): void {
  httpMock.get.mockImplementation((_url: unknown, cb: (res: unknown) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ success: true, data: { overall: 'healthy' } })));
      res.emit('end');
    });
    return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
  });
}

describe('install() — gateway restart failure rides the success result (PRI-726)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    process.env.PD_SKIP_CONSOLE_AUTOLAUNCH = '1';
    pdHome = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-gateway-notice-home-')));
    process.env.HOME = pdHome;
    process.env.USERPROFILE = pdHome;
    setLanguage('en');

    // Real payload fixture: every component the npm-distributed form gate and
    // the fse.copy deployment steps consume.
    payloadDir = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-gateway-notice-payload-')));
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      realFs.mkdirSync(path.join(payloadDir, component, 'dist'), { recursive: true });
      realFs.writeFileSync(path.join(payloadDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '1.74.1' }));
    }
    // Exact-shape files real-fs probes demand inside the payload.
    realFs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'index.js'), 'export {};\n');
    realFs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'bundle.js'), 'export {};\n');
    realFs.writeFileSync(path.join(payloadDir, 'plugin', 'openclaw.plugin.json'), PLUGIN_MANIFEST);
    realFs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'server.js'), 'export {};');
    realFs.mkdirSync(path.join(payloadDir, 'console', 'dist', 'web'), { recursive: true });
    realFs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');
    // Exact-shape file the npm-distributed form gate demands beyond
    // package.json + dist (mirror of installBundledReleaseManagerPackage).
    realFs.mkdirSync(path.join(payloadDir, 'release-manager', 'dist', 'update'), { recursive: true });
    realFs.writeFileSync(path.join(payloadDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};\n');

    // The installed authority stub: verifyReleaseManagerAuthorityImports does
    // a REAL dynamic import of the INSTALLED path, so the file must really
    // exist and really parse as ESM.
    const installedAuthorityDir = path.join(pdHome, '.pd', 'runtime', 'release-manager', 'dist', 'update');
    realFs.mkdirSync(installedAuthorityDir, { recursive: true });
    realFs.writeFileSync(path.join(pdHome, '.pd', 'runtime', 'release-manager', 'package.json'), JSON.stringify({ name: 'create-principles-disciple', type: 'module' }));
    realFs.writeFileSync(path.join(installedAuthorityDir, 'release-manager-authority.js'), 'export {};\n');
    // The installed pd-cli entry: the demo verification stats it (real
    // statSync below) and really executes `node <entry> demo story-a --json`.
    // An empty entry exits 0 — the CLI-chain integrity itself is covered by
    // the other installer suites; this test's subject is the gateway notice.
    const installedPdCliEntry = path.join(pdHome, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js');
    realFs.mkdirSync(path.dirname(installedPdCliEntry), { recursive: true });
    realFs.writeFileSync(installedPdCliEntry, '');

    // Gateway: running before the run (forces the stop+restart cycle).
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789, pid: 33584 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });

    // fs topology: real bytes for the payload fixture, `true` for every
    // presence probe into the (mocked-cpSync) installed tree, fresh-install
    // shape otherwise.
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json')) return false;
      if (s.endsWith(path.join('.pd', 'state.db'))) return false;
      if (s.startsWith(payloadDir)) return realFs.existsSync(s);
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) return PLUGIN_MANIFEST;
      // PRI-850: the bootstrap executor probe reads install.json through the
      // strict reader — a valid record keeps the probe path realistic.
      if (filePath.endsWith('install.json')) {
        return JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [], channel: 'stable', autoCheck: false });
      }
      // The generated config is read back on the success path
      // (readEnabledChannelsFromConfigYaml): a minimal valid sparse config.
      if (filePath.endsWith('config.yaml')) return 'features: {}\n';
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    // The demo verification calls statSync(entry).isFile() on the REALLY
    // planted pd-cli entry — delegate to the real fs instead of the
    // auto-mocked undefined.
    vi.mocked(fs.statSync).mockImplementation((value) => realFs.statSync(String(value)));
    vi.mocked(appendJournalTransition).mockImplementation(() => undefined);
    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
    answerHealthy(httpModule);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    delete process.env.PD_SKIP_CONSOLE_AUTOLAUNCH;
    setLanguage('zh');
    if (pdHome) {
      realFs.rmSync(pdHome, { recursive: true, force: true });
      pdHome = '';
    }
    if (payloadDir) {
      realFs.rmSync(payloadDir, { recursive: true, force: true });
      payloadDir = '';
    }
  });

  it('update commits, gateway restart fails → success stays true and gatewayNotice carries the manual recovery', { timeout: 60_000 }, async () => {
    vi.mocked(restartOpenClawGateway).mockResolvedValue({
      ok: false,
      error: 'openclaw gateway start failed: spawn openclaw ENOENT',
    });

    const result = await install(baseInstallOptions, payloadDir, { quiet: true });

    // §8 critical semantics: the payload committed — a degraded SUCCESS,
    // never a failure, never a rollback trigger.
    // (60s: PRI-850 bootstrap delivery copies the dependency closure.)
    expect(result.success).toBe(true);
    expect(result.gatewayNotice).toBeDefined();
    // Review round: anchor on the i18n copy itself, not a substring the
    // injected error happens to share — dropping the reusable copy source
    // must fail this test, and the manual recovery action must lead.
    expect(result.gatewayNotice!.startsWith(t('gateway_restart_failed'))).toBe(true);
    expect(result.gatewayNotice).toContain('spawn openclaw ENOENT');
    expect(restartOpenClawGateway).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('update commits, gateway restart succeeds → no gatewayNotice (no fake warning)', { timeout: 60_000 }, async () => {
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    const result = await install(baseInstallOptions, payloadDir, { quiet: true });

    expect(result.success).toBe(true);
    expect(result.gatewayNotice).toBeUndefined();
  });
});
