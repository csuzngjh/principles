/**
 * WorkBuddy round-3 remediation P1 — the LLM runtime profile collected at
 * install time (--provider/--api-key-env/--model) must land in the GOVERNANCE
 * workspace config (resolveWorkbuddyPaths(home).governanceDir/.pd/config.yaml
 * — the file the worker/console/hook chain actually reads), never as a second
 * truth in the project-directory config.yaml.
 *
 * Defect (frozen by the round-3 main agent, code-level verified):
 *   installer.ts wrote the profile into the PROJECT config.yaml
 *   (generateConfigYamlConfig) while the WorkBuddy host installer initialized
 *   the governance workspace with `pd runtime init` defaults and NEVER
 *   consumed ctx.runtimeProfile — the install success prompt promised a
 *   working LLM profile while the diagnostician had none.
 *
 * Harness discipline — REAL production boundary at every load-bearing seam:
 *   - the REAL top-level install() (the exact entry the CLI drives), with the
 *     documented smoke seams (PD_SKIP_CONSOLE_AUTOLAUNCH / PD_SKIP_GLOBAL_SHIM
 *     / PD_SKIP_NPM_UPGRADE / PD_ALLOW_LEGACY_NPM_INSTALL);
 *   - REAL filesystem everywhere (sandbox HOME/USERPROFILE; nothing mocked
 *     away — the workspace and governance config.yaml files are real bytes);
 *   - the REAL fake-engine registration boundary
 *     (tests/fixtures/workbuddy-fake-engine.mjs) through the REAL spawnSync —
 *     the same process boundary runHostInstallers uses in production;
 *   - the REAL pd-cli dist (packages/pd-cli/dist/index.js) as the deployed
 *     runtime pd-cli entry, so the governance workspace is initialized by the
 *     REAL `pd runtime init --confirm` subprocess (default openclaw.default
 *     bindings — the true state the profile override must beat);
 *   - the REAL production loader chain for assertions
 *     (loadPdConfigForPlugin → resolveAgentRuntimeBinding →
 *     checkAgentRuntimeReadiness) — the exact consumer path of the worker.
 *
 * Only the purely environmental child processes are mocked: the workspace
 * `pd runtime init` call and npm dependency resolution (execFileSync), the
 * console server spawn, and the demo story-a verification (execFile).
 * spawnSync is deliberately left REAL: governance init and engine
 * registration are the subjects under test.
 *
 * Credentials: only env-var NAMES are ever written (apiKeyEnv); the readiness
 * stub returns a fake sentinel value — no real key material exists anywhere
 * in this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import * as yaml from 'js-yaml';
import { install } from '../src/installer.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';
import { productIdentityStampJson } from './helpers/payload-identity.js';
import { loadPdConfigForPlugin } from '@principles/host-runtime';
import {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
} from '@principles/core/runtime-v2';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const { EventEmitter } = await import('node:events') as typeof import('node:events');
  return {
    ...actual,
    // Host-neutral workspace `pd runtime init` + npm dependency resolution
    // (documented smoke seams — the governance-workspace init below is a
    // DIFFERENT call site and runs REAL via spawnSync).
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => ''),
    // Demo verification smoke seam: promisify(execFile) resolves immediately.
    execFile: vi.fn((_file: unknown, _args: unknown, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (typeof cb === 'function') cb(null, '', '');
      return undefined as unknown as ReturnType<typeof execFile>;
    }),
    // Console server spawn: a fake child that never exits; the mocked 'http'
    // below answers healthy so verifyConsole passes without a real server.
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
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }),
    // spawnSync intentionally REAL — governance init + engine registration.
  };
});

vi.mock('http', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));

const FAKE_ENGINE = path.resolve(__dirname, 'fixtures', 'workbuddy-fake-engine.mjs');
const REAL_PD_CLI_ENTRY = path.resolve(__dirname, '..', '..', 'pd-cli', 'dist', 'index.js');
const TMP = fs.realpathSync(os.tmpdir());

const PAYLOAD_VERSION = '9.9.9';

/** The real pd-cli dist resolves @principles/core relative to ITSELF, so the
 * deployed runtime entry only needs to be a loader shim to the real dist. */
function pdCliLauncherContent(): string {
  if (!fs.existsSync(REAL_PD_CLI_ENTRY)) {
    throw new Error(`real pd-cli dist missing: ${REAL_PD_CLI_ENTRY} — build packages/pd-cli first (npm run build in packages/pd-cli)`);
  }
  return `// Test launcher: deployed runtime pd-cli entry delegating to the real dist.\nimport ${JSON.stringify(pathToFileURL(REAL_PD_CLI_ENTRY).href)};\n`;
}

function writeWorkbuddyPluginSkeleton(pluginDir: string, version = '0.3.0'): void {
  fs.mkdirSync(path.join(pluginDir, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
    JSON.stringify({ name: 'principles-disciple', version, description: 'Principles Disciple (test skeleton)' }, null, 2),
  );
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

interface Lab {
  sandbox: string;
  workspaceDir: string;
  payloadDir: string;
  governanceDir: string;
  governanceConfigPath: string;
  projectConfigPath: string;
}

function makeLab(): Lab {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'pd-wb-profile-')));
  const workspaceDir = path.join(sandbox, 'project-workspace');
  const payloadDir = path.join(sandbox, 'payload');

  // npm-distributed payload fixture (the shape the form gate demands).
  for (const component of ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager']) {
    fs.mkdirSync(path.join(payloadDir, component, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(payloadDir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: PAYLOAD_VERSION }));
    fs.writeFileSync(path.join(payloadDir, component, 'dist', 'entry.js'), `export const component = '${component}';\n`);
  }
  // pd-cli entry: loader shim to the REAL dist (governance init really runs).
  fs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'index.js'), pdCliLauncherContent());
  fs.writeFileSync(path.join(payloadDir, 'pd-cli', 'dist', 'bundle.js'), 'export {};\n');
  fs.writeFileSync(path.join(payloadDir, 'plugin', 'openclaw.plugin.json'), JSON.stringify({ name: 'principles-disciple', activation: { onCapabilities: ['hook'] } }));
  fs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'server.js'), 'export {};');
  fs.mkdirSync(path.join(payloadDir, 'console', 'dist', 'web'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'console', 'dist', 'web', 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(payloadDir, 'release-manager', 'dist', 'update'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};\n');
  fs.writeFileSync(path.join(payloadDir, 'release-manager', 'dist', 'update', 'console-surface.js'), 'export {};\n');
  fs.mkdirSync(path.join(payloadDir, '_release'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, '_release', 'product-identity.json'), productIdentityStampJson(PAYLOAD_VERSION));

  // Bundled WorkBuddy adapter payload (findWorkbuddyPluginPayload lookup).
  writeWorkbuddyPluginSkeleton(path.join(payloadDir, 'workbuddy-adapter', 'plugin'), '0.3.0');
  fs.mkdirSync(path.join(payloadDir, 'workbuddy-adapter', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'workbuddy-adapter', 'dist', 'index.js'), '// adapter dist placeholder\n');
  fs.writeFileSync(path.join(payloadDir, 'workbuddy-adapter', 'package.json'), JSON.stringify({ name: '@principles/workbuddy-adapter', version: '0.1.0' }));

  fs.mkdirSync(workspaceDir, { recursive: true });

  return {
    sandbox,
    workspaceDir,
    payloadDir,
    governanceDir: getWorkbuddyWorkspaceDir(sandbox),
    governanceConfigPath: path.join(getWorkbuddyWorkspaceDir(sandbox), '.pd', 'config.yaml'),
    projectConfigPath: path.join(workspaceDir, '.pd', 'config.yaml'),
  };
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [
  'HOME', 'USERPROFILE',
  'PD_ALLOW_LEGACY_NPM_INSTALL', 'PD_SKIP_CONSOLE_AUTOLAUNCH', 'PD_SKIP_GLOBAL_SHIM', 'PD_SKIP_NPM_UPGRADE',
  'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'PD_WORKBUDDY_ENGINE', 'WB_ENGINE',
] as const;

function answerHealthy(httpModule: { get: ReturnType<typeof vi.fn> }): void {
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
}

/** The REAL child-process module (un-mocked) — used to seed governance state
 * through the same production initializer the host installer spawns. */
let realChildProcess: typeof import('node:child_process');

beforeEach(async () => {
  realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  const lab = makeLab();
  (globalThis as Record<string, unknown>).__pdWbProfileLab = lab;
  process.env.HOME = lab.sandbox;
  process.env.USERPROFILE = lab.sandbox;
  process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
  process.env.PD_SKIP_CONSOLE_AUTOLAUNCH = '1';
  process.env.PD_SKIP_GLOBAL_SHIM = '1';
  process.env.PD_SKIP_NPM_UPGRADE = '1';
  // Explicit custom host root INSIDE the sandbox (the isolation recipe) — the
  // governance dir itself stays getWorkbuddyWorkspaceDir(home), which the
  // assertions resolve through the production resolver, never hand-joined.
  process.env.WORKBUDDY_CONFIG_DIR = path.join(lab.sandbox, '.workbuddy');
  process.env.CODEBUDDY_CONFIG_DIR = path.join(lab.sandbox, '.codebuddy-unused');
  process.env.PD_WORKBUDDY_ENGINE = FAKE_ENGINE;
  setLanguage('en');
  const httpModule = await import('http') as unknown as { get: ReturnType<typeof vi.fn> };
  answerHealthy(httpModule);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  const lab = (globalThis as Record<string, unknown>).__pdWbProfileLab as Lab | undefined;
  if (lab) {
    fs.rmSync(lab.sandbox, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__pdWbProfileLab;
  }
  setLanguage('zh');
});

function currentLab(): Lab {
  return (globalThis as Record<string, unknown>).__pdWbProfileLab as Lab;
}

function baseOptions(lab: Lab, runtimeProfile?: { provider: string; apiKeyEnv: string; model?: string }): InstallOptions {
  return {
    language: 'en',
    mode: 'force',
    workspaceDir: lab.workspaceDir,
    channels: [],
    overwriteConfig: false,
    host: 'workbuddy',
    stopGateway: false,
    ...(runtimeProfile !== undefined ? { runtimeProfile } : {}),
  };
}

interface GovernanceRawConfig {
  runtimeProfiles: Record<string, Record<string, unknown>>;
  internalAgents: { defaultRuntime: string; agents: Record<string, Record<string, unknown>> };
  [key: string]: unknown;
}

function readGovernanceConfig(lab: Lab): GovernanceRawConfig {
  return yaml.load(fs.readFileSync(lab.governanceConfigPath, 'utf8')) as GovernanceRawConfig;
}

/** Run the REAL pd-cli runtime init against the governance dir (the same
 * production initializer the host installer invokes), then apply a simulated
 * OWNER customization on top. */
function seedGovernanceWorkspace(lab: Lab, customize?: (config: GovernanceRawConfig) => void): void {
  realChildProcess.execFileSync(process.execPath, [REAL_PD_CLI_ENTRY, 'runtime', 'init', '--confirm', '--workspace', lab.governanceDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (!fs.existsSync(lab.governanceConfigPath)) {
    throw new Error(`runtime init did not create ${lab.governanceConfigPath}`);
  }
  if (customize) {
    const config = readGovernanceConfig(lab);
    customize(config);
    fs.writeFileSync(lab.governanceConfigPath, yaml.dump(config, { lineWidth: -1, quoteStyle: 'double' }), 'utf8');
  }
}

describe('install() routes the LLM runtime profile into the WorkBuddy governance workspace (round-3 P1)', () => {

  it('main chain: explicit --provider/--api-key-env/--model land in the governance config, bind the diagnostician, and never duplicate into the project config', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'test-model' }),
      lab.payloadDir,
      { quiet: true },
    );

    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    // 1. The governance config (the file worker/console/hooks read) carries
    //    the install profile with the generateConfigYamlContent write shape.
    const governance = readGovernanceConfig(lab);
    const pdDefault = governance.runtimeProfiles['pd.default'];
    expect(pdDefault, 'governance runtimeProfiles.pd.default missing').toBeDefined();
    expect(pdDefault['type']).toBe('pi-ai');
    expect(pdDefault['provider']).toBe('openai');
    expect(pdDefault['model']).toBe('test-model');
    expect(pdDefault['apiKeyEnv']).toBe('WB_TEST_KEY');

    // 2. The diagnostician binding + defaultRuntime resolve to that profile.
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    const diagnostician = governance.internalAgents.agents['diagnostician'];
    expect(diagnostician).toBeDefined();
    expect(diagnostician['runtimeProfile']).toBe('pd.default');

    // 3. Other profiles survive (runtime init's openclaw.default).
    expect(governance.runtimeProfiles['openclaw.default']).toBeDefined();

    // 4. REAL loader: the governance config is loader-valid user config.
    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.source).toBe('user_config');
    expect(loaded.ok, `loader errors: ${JSON.stringify(loaded.errors)}`).toBe(true);

    // 5. Worker consumption chain: the diagnostician binding resolves and the
    //    profile is READY (stubbed env — the sentinel is not a credential).
    const binding = resolveAgentRuntimeBinding(loaded.effective, 'diagnostician');
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.profileId).toBe('pd.default');
    const readiness = checkAgentRuntimeReadiness(binding.profile, (name) => (name === 'WB_TEST_KEY' ? 'stub-sentinel-not-a-credential' : process.env[name]));
    expect(readiness.readiness).toBe('ready');

    // 6. NO governance-profile copy in the project config (single truth).
    const projectLoaded = loadPdConfigForPlugin(lab.workspaceDir);
    expect(projectLoaded.ok).toBe(true);
    const projectRaw = fs.readFileSync(lab.projectConfigPath, 'utf8');
    expect(projectRaw).not.toContain('WB_TEST_KEY');
    expect(projectRaw).not.toContain('test-model');
    const projectConfig = yaml.load(projectRaw) as GovernanceRawConfig;
    expect(projectConfig.runtimeProfiles['pd.default']['provider']).toBe('');
  });

  it('no --provider: the governance config keeps the runtime-init default (no empty-value write, no binding overwrite)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    const result = await install(baseOptions(lab), lab.payloadDir, { quiet: true });

    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    // Exactly what `pd runtime init` wrote — untouched by the installer.
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('');
    expect(governance.runtimeProfiles['pd.default']['apiKeyEnv']).toBe('');
    expect(governance.internalAgents.defaultRuntime).toBe('openclaw.default');
    expect(governance.internalAgents.agents['diagnostician']['runtimeProfile']).toBe('openclaw.default');
    expect(loadPdConfigForPlugin(lab.governanceDir).ok).toBe(true);
  });

  it('owner-customized profiles survive an install that passes an explicit profile (explicit override of pd.default only)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab, (config) => {
      config.runtimeProfiles['owner.custom'] = {
        type: 'pi-ai',
        provider: 'owner-provider',
        model: 'owner-model',
        apiKeyEnv: 'OWNER_CUSTOM_KEY_ENV',
      };
      (config.internalAgents.agents['scribe'] as Record<string, unknown>)['runtimeProfile'] = 'owner.custom';
    });

    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'test-model' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    // Explicit install override applied to pd.default + diagnostician/defaultRuntime…
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('openai');
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    expect(governance.internalAgents.agents['diagnostician']['runtimeProfile']).toBe('pd.default');
    // …while the Owner's own profile and the scribe binding stay intact.
    const ownerCustom = governance.runtimeProfiles['owner.custom'];
    expect(ownerCustom).toBeDefined();
    expect(ownerCustom['provider']).toBe('owner-provider');
    expect(ownerCustom['apiKeyEnv']).toBe('OWNER_CUSTOM_KEY_ENV');
    expect(governance.internalAgents.agents['scribe']['runtimeProfile']).toBe('owner.custom');
    expect(loadPdConfigForPlugin(lab.governanceDir).ok).toBe(true);
  });

  it('existing non-empty pd.default with NO install profile is left untouched', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab, (config) => {
      config.runtimeProfiles['pd.default']['provider'] = 'owner-provider';
      config.runtimeProfiles['pd.default']['model'] = 'owner-model';
      config.runtimeProfiles['pd.default']['apiKeyEnv'] = 'OWNER_DEFAULT_KEY_ENV';
    });

    const result = await install(baseOptions(lab), lab.payloadDir, { quiet: true });
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('owner-provider');
    expect(governance.runtimeProfiles['pd.default']['apiKeyEnv']).toBe('OWNER_DEFAULT_KEY_ENV');
    expect(governance.internalAgents.defaultRuntime).toBe('openclaw.default');
    expect(loadPdConfigForPlugin(lab.governanceDir).ok).toBe(true);
  });

  it('unwritable governance config → install fails loud (success=false) with a structured reason; the config is not half-written', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab);
    // Make the config file un-replaceable: read-only file + non-writable dir
    // (Windows honors the file attribute, POSIX the dir mode).
    fs.chmodSync(lab.governanceConfigPath, 0o444);
    fs.chmodSync(path.dirname(lab.governanceConfigPath), 0o555);
    try {
      const result = await install(
        baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'test-model' }),
        lab.payloadDir,
        { quiet: true },
      );

      expect(result.success).toBe(false);
      const failureText = `${result.error ?? ''} ${result.reason ?? ''}`;
      expect(failureText).toMatch(/workbuddy_governance_(profile_)?(write|read|init)_failed|Host installation failed/);

      // No partial write: the governance config still holds the runtime-init
      // default state (the profile never landed half-way).
      const governance = readGovernanceConfig(lab);
      expect(governance.runtimeProfiles['pd.default']['provider']).toBe('');
      expect(governance.internalAgents.defaultRuntime).toBe('openclaw.default');
    } finally {
      fs.chmodSync(path.dirname(lab.governanceConfigPath), 0o755);
      fs.chmodSync(lab.governanceConfigPath, 0o644);
    }
  });
});
