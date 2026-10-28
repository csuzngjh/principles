/**
 * PRI-1054 — the update chain must auto-launch the console in the machine's
 * declared authentication posture, never in a hardcoded one.
 *
 * PD Companion asks for an authenticated console whenever PD_CONSOLE_TOKEN is
 * in its environment (it restores the token from its own encrypted state), so
 * the previous unconditional `--no-auth` replaced a healthy authenticated
 * console on every release and the next Companion start aborted with
 * `console_authentication_mode_mismatch`.
 *
 * Harness: the install()-flow family (see installer-gateway-notice.test.ts) —
 * mocked 'fs' + 'child_process' + 'http', real fs-extra payload copies, HOME /
 * USERPROFILE redirected to a throwaway temp dir so nothing touches the
 * developer's ~/.pd runtime. Assertions are on the REAL spawn argv and the REAL
 * readiness-probe headers captured through install(), not on internal helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { install } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import type { InstallOptions } from '../src/prompts.js';
import { appendJournalTransition } from '../src/update/transaction-journal.js';
import { productIdentityStampJson } from './helpers/payload-identity.js';

vi.mock('fs');
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => ''),
    spawn: vi.fn(),
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

const TOKEN = 'tok-pri-1054';

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  // os.tmpdir(), not a literal '/tmp/...': install() refuses a POSIX-rooted
  // workspace pointer on win32 before the auto-launch under test is reached.
  workspaceDir: path.join(os.tmpdir(), 'pd-autolaunch-posture-ws'),
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
let savedToken: string | undefined;
let realFs: typeof import('node:fs');

/** argv of the captured `pd console open` spawn, if any. */
let consoleOpenArgs: string[] | undefined;
/**
 * Flipped the moment `pd console open` is spawned. Before it the /api/health
 * probes belong to verifyConsole (which spawns the server directly and is not
 * this ticket's subject); after it they belong to probeAutolaunchHealth.
 */
let autoLaunchPhaseStarted = false;

function fakeChild(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; pid: number;
    kill: (signal?: string) => boolean; unref: () => unknown;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // A real pid would let any stray process.kill(pid) path terminate the test
  // runner itself — keep the fake clearly fake.
  child.pid = 424242;
  child.kill = () => true;
  child.unref = () => child;
  return child as unknown as ReturnType<typeof spawn>;
}

function callbackOf(callArgs: unknown[]): ((res: unknown) => void) | undefined {
  const last = callArgs[callArgs.length - 1];
  return typeof last === 'function' ? (last as (res: unknown) => void) : undefined;
}

function headersOf(callArgs: unknown[]): Record<string, string> | undefined {
  const options = callArgs[1] as { headers?: Record<string, string> } | undefined;
  return options?.headers;
}

/**
 * Health responses for the two probe phases. `requireBearer` makes the
 * auto-launch readiness probe DEMAND the token header — dropping it in
 * production code then turns this suite red instead of silently accepting an
 * unauthenticated answer.
 */
function stubHealth(
  httpMock: { get: ReturnType<typeof vi.fn> },
  behavior: { requireBearer: boolean; authenticatedConsole: boolean },
): void {
  httpMock.get.mockImplementation((...callArgs: unknown[]) => {
    const url = String(callArgs[0]);
    const cb = callbackOf(callArgs);
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    const isAutoLaunchProbe = autoLaunchPhaseStarted && url.endsWith('/api/health');
    const bearerAccepted = headersOf(callArgs)?.Authorization === `Bearer ${TOKEN}`;
    if (isAutoLaunchProbe && (!behavior.authenticatedConsole || (behavior.requireBearer && !bearerAccepted))) {
      res.statusCode = 401;
      setImmediate(() => {
        cb?.(res);
        res.emit('end');
      });
    } else {
      res.statusCode = 200;
      setImmediate(() => {
        cb?.(res);
        res.emit('data', Buffer.from(JSON.stringify({ success: true, data: { overall: 'healthy' } })));
        res.emit('end');
      });
    }
    return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
  });
}

function authorizationHeaderCalls(httpMock: { get: ReturnType<typeof vi.fn> }): unknown[] {
  return httpMock.get.mock.calls
    .map((call: unknown[]) => headersOf(call)?.Authorization)
    .filter((value: unknown) => value !== undefined);
}

describe('install() — console auto-launch inherits the authentication posture (PRI-1054)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    savedToken = process.env.PD_CONSOLE_TOKEN;
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    delete process.env.PD_SKIP_CONSOLE_AUTOLAUNCH;
    pdHome = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-autolaunch-posture-home-')));
    process.env.HOME = pdHome;
    process.env.USERPROFILE = pdHome;
    consoleOpenArgs = undefined;
    autoLaunchPhaseStarted = false;

    // Real payload fixture: every component the npm-distributed form gate and
    // the fse.copy deployment steps consume.
    payloadDir = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-autolaunch-posture-payload-')));
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
      realFs.mkdirSync(path.join(payloadDir, component, 'dist'), { recursive: true });
      realFs.writeFileSync(path.join(payloadDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '1.74.1' }));
    }
    realFs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'index.js'), 'export {};\n');
    realFs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'bundle.js'), 'export {};\n');
    realFs.writeFileSync(path.join(payloadDir, 'plugin', 'openclaw.plugin.json'), PLUGIN_MANIFEST);
    realFs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'server.js'), 'export {};');
    realFs.mkdirSync(path.join(payloadDir, 'console', 'dist', 'web'), { recursive: true });
    realFs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');
    realFs.mkdirSync(path.join(payloadDir, 'release-manager', 'dist', 'update'), { recursive: true });
    realFs.writeFileSync(path.join(payloadDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};\n');
    realFs.writeFileSync(path.join(payloadDir, 'release-manager', 'dist', 'update', 'console-surface.js'), 'export {};\n');
    // PRI-874: without the embedded identity stamp install() refuses at the
    // identity gate long before the auto-launch under test.
    realFs.mkdirSync(path.join(payloadDir, '_release'), { recursive: true });
    realFs.writeFileSync(path.join(payloadDir, '_release', 'product-identity.json'), productIdentityStampJson('1.74.1'));

    // The installed authority + pd-cli entry must really exist: the flow does a
    // real dynamic import and a real statSync against them.
    const installedAuthorityDir = path.join(pdHome, '.pd', 'runtime', 'release-manager', 'dist', 'update');
    realFs.mkdirSync(installedAuthorityDir, { recursive: true });
    realFs.writeFileSync(path.join(pdHome, '.pd', 'runtime', 'release-manager', 'package.json'), JSON.stringify({ name: 'create-principles-disciple', type: 'module' }));
    realFs.writeFileSync(path.join(installedAuthorityDir, 'release-manager-authority.js'), 'export {};\n');
    realFs.writeFileSync(path.join(installedAuthorityDir, 'console-surface.js'), 'export {};\n');
    const installedPdCliEntry = path.join(pdHome, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js');
    realFs.mkdirSync(path.dirname(installedPdCliEntry), { recursive: true });
    realFs.writeFileSync(installedPdCliEntry, '');

    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false, port: 18789, pid: undefined });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    // fs topology: real bytes for the payload fixture, `true` for every
    // presence probe into the (mocked-cpSync) installed tree.
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
      if (filePath.endsWith(path.join('_release', 'product-identity.json'))) {
        return realFs.readFileSync(filePath, 'utf8');
      }
      if (filePath.endsWith('install.json')) {
        return JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [], channel: 'stable', autoCheck: false });
      }
      // The generated config is read back on the success path.
      if (filePath.endsWith('config.yaml')) return 'features: {}\n';
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    // The demo verification calls statSync(entry).isFile() on the REALLY
    // planted pd-cli entry — delegate to the real fs.
    vi.mocked(fs.statSync).mockImplementation((value) => realFs.statSync(String(value)));
    vi.mocked(appendJournalTransition).mockImplementation(() => undefined);

    vi.mocked(spawn).mockImplementation((...callArgs: unknown[]) => {
      const argv = Array.isArray(callArgs[1]) ? callArgs[1].map(String) : [];
      if (argv[1] === 'console' && argv[2] === 'open') {
        consoleOpenArgs = argv;
        autoLaunchPhaseStarted = true;
      }
      return fakeChild();
    });

    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
    stubHealth(httpModule, { requireBearer: false, authenticatedConsole: true });
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
    if (savedToken === undefined) delete process.env.PD_CONSOLE_TOKEN; else process.env.PD_CONSOLE_TOKEN = savedToken;
    delete process.env.PD_SKIP_CONSOLE_AUTOLAUNCH;
    if (pdHome) {
      realFs.rmSync(pdHome, { recursive: true, force: true });
      pdHome = '';
    }
    if (payloadDir) {
      realFs.rmSync(payloadDir, { recursive: true, force: true });
      payloadDir = '';
    }
  });

  it('PD_CONSOLE_TOKEN configured → launches authenticated and the readiness probe carries the Bearer token', { timeout: 90_000 }, async () => {
    process.env.PD_CONSOLE_TOKEN = TOKEN;
    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
    // An authenticated console answers 401 to a header-less /api/health probe.
    stubHealth(httpModule, { requireBearer: true, authenticatedConsole: true });

    const result = await install(baseInstallOptions, payloadDir, { quiet: true });

    expect(result.success).toBe(true);
    expect(consoleOpenArgs).toBeDefined();
    expect(consoleOpenArgs).not.toContain('--no-auth');
    // The token is inherited from the environment, exactly as `pd console open`
    // resolves it — the installer never passes it as a flag.
    expect(consoleOpenArgs).not.toContain('--token');
    // Readiness only succeeded because the header was sent. The port comes from
    // the console's own range authority, so pin the shape, not a copy of it.
    expect(result.consoleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/welcome$/);
    expect(authorizationHeaderCalls(httpModule)).toContain(`Bearer ${TOKEN}`);
  });

  it('authenticated console never becomes ready → manual instruction stays authenticated', { timeout: 90_000 }, async () => {
    process.env.PD_CONSOLE_TOKEN = TOKEN;
    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
    stubHealth(httpModule, { requireBearer: false, authenticatedConsole: false });

    const result = await install(baseInstallOptions, payloadDir, { quiet: true });

    expect(result.consoleUrl).toBeUndefined();
    const expectedManual = `pd console open --workspace "${baseInstallOptions.workspaceDir}"`;
    expect(result.nextAction).toContain(`${expectedManual} (listens on 127.0.0.1 only)`);
    // The defect being fixed: no instruction from the update chain may tell an
    // authenticated machine to start the console without authentication.
    expect(result.nextAction).not.toContain('--no-auth');
  });

  it('no PD_CONSOLE_TOKEN → keeps the fresh-install no-auth default and sends no Authorization', { timeout: 90_000 }, async () => {
    delete process.env.PD_CONSOLE_TOKEN;
    const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };

    const result = await install(baseInstallOptions, payloadDir, { quiet: true });

    expect(result.success).toBe(true);
    expect(consoleOpenArgs).toContain('--no-auth');
    expect(authorizationHeaderCalls(httpModule)).toEqual([]);
    expect(result.consoleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/welcome$/);
  });
});
