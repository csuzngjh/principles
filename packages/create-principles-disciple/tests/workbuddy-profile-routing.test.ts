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
 *     REAL `pd runtime init --confirm` subprocess (pi-ai `pd.default`
 *     bindings since ADR-0029 — the true state the profile override must beat);
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
  createAdapterConfigFromProfile,
  INTERNAL_AGENT_NAMES,
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
  // Skills/control are part of the production installer payload contract.
  fs.cpSync(path.resolve(__dirname, '../../workbuddy-adapter/plugin/skills'), path.join(pluginDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../workbuddy-adapter/plugin/scripts/pd-control.cjs'), path.join(pluginDir, 'scripts', 'pd-control.cjs'));

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

function baseOptions(lab: Lab, runtimeProfile?: { provider: string; apiKeyEnv: string; model?: string; baseUrl?: string }): InstallOptions {
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

    // 3. ADR-0029: the install writes NO new openclaw fact — runtime init
    //    seeds only the pi-ai default, so no openclaw.default profile appears.
    expect(governance.runtimeProfiles['openclaw.default']).toBeUndefined();
    expect(Object.keys(governance.runtimeProfiles)).toEqual(['pd.default']);

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

  it('round-4 R3: --base-url lands in the governance profile and reaches the binding resolver; a malformed base-url fails loud with nothing written', { timeout: 240_000 }, async () => {
    // The first installed-product E2E run died here: pi-ai validates the
    // model against the provider catalog UNLESS the profile carries a custom
    // endpoint, and the install surface could not express one — the custom
    // AMD RADEON deployment model was catalog-rejected and the diagnostician
    // burned its attempts. The endpoint must round-trip to the resolver.
    const lab = currentLab();
    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'custom-deployment-model', baseUrl: 'https://llm.example.test/v1' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    expect(governance.runtimeProfiles['pd.default']['baseUrl']).toBe('https://llm.example.test/v1');

    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok, `loader errors: ${JSON.stringify(loaded.errors)}`).toBe(true);
    const binding = resolveAgentRuntimeBinding(loaded.effective, 'diagnostician');
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.profile.baseUrl).toBe('https://llm.example.test/v1');

    // Malformed endpoint → fail loud at the write boundary (rc-3), no write.
    // Round-5 S3: `https://` (no hostname) and EXPLICIT blank are invalid too
    // (the prefix-regex era accepted `https://` and silently dropped blanks).
    for (const badBaseUrl of ['not-a-url', 'https://', '   ']) {
      const bad = currentLab();
      const badResult = await install(
        baseOptions(bad, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'm', baseUrl: badBaseUrl }),
        bad.payloadDir,
        { quiet: true },
      );
      expect(badResult.success, `base-url ${JSON.stringify(badBaseUrl)} must not install`).toBe(false);
      expect(String(badResult.reason ?? '')).toMatch(/not a valid http\(s\) URL|was given but blank/);
    }
  });

  it('no --provider: the governance config keeps the runtime-init default (no empty-value write, no binding overwrite)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    const result = await install(baseOptions(lab), lab.payloadDir, { quiet: true });

    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    // Exactly what `pd runtime init` wrote — untouched by the installer.
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('');
    expect(governance.runtimeProfiles['pd.default']['apiKeyEnv']).toBe('');
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    // Round-4 S1 authority contract: fresh init seeds NO explicit per-agent
    // runtimeProfile rows — agents inherit defaultRuntime. This is precisely
    // what lets an installer's defaultRuntime override reach the whole
    // learning chain (and what keeps the vanilla default resolving every
    // agent to the pi-ai default, asserted below through the REAL loader).
    expect(governance.internalAgents.agents['diagnostician']).toBeDefined();
    expect(governance.internalAgents.agents['diagnostician']['runtimeProfile']).toBeUndefined();
    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok).toBe(true);
    const diagnostician = resolveAgentRuntimeBinding(loaded.effective, 'diagnostician');
    expect(diagnostician.ok).toBe(true);
    if (diagnostician.ok) {
      expect(diagnostician.profileId).toBe('pd.default');
      expect(diagnostician.profile.type).toBe('pi-ai');
      expect(createAdapterConfigFromProfile(diagnostician.profile, lab.governanceDir).runtimeKind).toBe('pi-ai');
      // ADR-0029 §5 accepted consequence: with no LLM collected at install
      // time the agent is NOT silently delegated to a host CLI session — it
      // reports needs_setup with a pi-ai nextAction the Owner can act on.
      const readiness = checkAgentRuntimeReadiness(diagnostician.profile, () => undefined);
      expect(readiness.readiness).toBe('needs_setup');
      expect(readiness.nextAction).toMatch(/pi-ai|runtimeProfiles/);
    }
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
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
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
      expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    } finally {
      fs.chmodSync(path.dirname(lab.governanceConfigPath), 0o755);
      fs.chmodSync(lab.governanceConfigPath, 0o644);
    }
  });
});

// ─── Round-4 S1: the WHOLE learning chain must ride the install runtime ─────
//
// Defect (round-4 independent audit, standards-profile-results.json): after a
// fresh install with profile args the diagnostician resolved to pd.default
// (pi-ai) but dreamer/scribe/artificer/signalCollector (and the rest of the
// internalization chain) stayed explicitly bound to openclaw.default — the
// fresh-config defaults seeded an explicit per-agent `runtimeProfile` row for
// every agent, and a per-agent row outranks internalAgents.defaultRuntime in
// resolveAgentRuntimeBinding.
//
// Harness: same REAL production boundary as above — REAL install(), REAL
// `pd runtime init` subprocess (built pd-cli dist), REAL loader chain. The
// fake-HOME lab carries no OpenClaw installation at all, so the
// "no necessary agent resolves to openclaw-cli" assertions below are the
// resolution-level isolation proof (no openclaw exists to delegate to).

/** Sentinel env getter — the ONLY readiness input; never a real credential. */
function sentinelEnv(name: string): string | undefined {
  return name === 'WB_TEST_KEY' ? 'stub-sentinel-not-a-credential' : process.env[name];
}

describe('round-4 S1: fresh install binds the whole learning chain to the install-configured runtime', () => {

  it('fresh install with profile args (model omitted): every learning agent resolves to pd.default (pi-ai, ready) — none to openclaw-cli — and the per-provider default model is applied', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    // NO --model: the S2 per-provider default (openai → gpt-4o-mini) must make
    // the profile genuinely ready instead of needs_setup.
    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    // S2: the written profile carries the per-provider default model.
    const governance = readGovernanceConfig(lab);
    expect(governance.runtimeProfiles['pd.default']['model']).toBe('gpt-4o-mini');

    // S1: EVERY internal agent — the diagnostician AND the whole
    // dreamer→philosopher→scribe→artificer→evaluator→rolloutReviewer chain
    // plus signalCollector/correctionObserver — resolves to the
    // install-configured runtime.
    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.source).toBe('user_config');
    expect(loaded.ok, `loader errors: ${JSON.stringify(loaded.errors)}`).toBe(true);
    for (const name of INTERNAL_AGENT_NAMES) {
      const binding = resolveAgentRuntimeBinding(loaded.effective, name);
      if (!loaded.effective.config.internalAgents.agents[name]?.enabled) {
        expect(binding.ok, `${name} is default-disabled`).toBe(false);
        continue;
      }
      expect(binding.ok, `${name}: ${binding.ok ? '' : binding.reason}`).toBe(true);
      if (!binding.ok) continue;
      expect(binding.profileId, `${name} must ride the install runtime`).toBe('pd.default');
      // Resolution-level isolation proof: the lab has no OpenClaw install, so
      // any openclaw-cli resolution would be a silent wrong-host delegation.
      const adapter = createAdapterConfigFromProfile(binding.profile, lab.governanceDir);
      expect(adapter.runtimeKind, `${name} must not resolve to openclaw-cli`).toBe('pi-ai');
      const readiness = checkAgentRuntimeReadiness(binding.profile, sentinelEnv);
      expect(readiness.readiness, `${name}: ${readiness.reason ?? ''}`).toBe('ready');
    }

    // Fresh init seeds no explicit per-agent rows anymore → the installer has
    // NO pending-config items to report on a fresh install.
    const wb = (result.hostResults ?? []).find((h) => h.hostId === 'workbuddy');
    expect(wb).toBeDefined();
    const wbText = `${wb?.reason ?? ''} ${wb?.nextAction ?? ''}`;
    expect(wbText).not.toContain('still bound to their explicit runtime profiles');
  });

  it('legacy workspace (old init wrote explicit openclaw.default rows): rows are KEPT and reported as pending-config in the installer result', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab, (config) => {
      // Reproduce the OLD `pd runtime init` output: an openclaw.default
      // profile PLUS explicit per-agent openclaw.default rows for every
      // agent. Indistinguishable from an Owner choice → the installer must
      // keep them and REPORT, not override. (Fresh init no longer seeds the
      // profile — ADR-0029 — so a faithful legacy fixture writes it itself.)
      config.runtimeProfiles['openclaw.default'] = { type: 'openclaw', source: 'default' };
      for (const name of INTERNAL_AGENT_NAMES) {
        (config.internalAgents.agents[name] as Record<string, unknown>)['runtimeProfile'] = 'openclaw.default';
      }
    });

    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'test-model' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    // The explicit rows survive (no silent override).
    const governance = readGovernanceConfig(lab);
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    for (const name of INTERNAL_AGENT_NAMES) {
      if (name === 'diagnostician') continue; // the declared install override
      expect(governance.internalAgents.agents[name]['runtimeProfile'], name).toBe('openclaw.default');
    }

    // …and the installer result names them honestly as pending-config items.
    const wb = (result.hostResults ?? []).find((h) => h.hostId === 'workbuddy');
    expect(wb).toBeDefined();
    const wbText = `${wb?.reason ?? ''} ${wb?.nextAction ?? ''}`;
    expect(wbText).toContain('still bound to their explicit runtime profiles');
    expect(wbText).toContain('dreamer');
    expect(wbText).toContain('signalCollector');
    expect(wbText).toContain('pd.default');

    // Resolution-level truth of the report: those agents STILL resolve to
    // openclaw.default (their Owner/init choice), not to the install runtime.
    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok).toBe(true);
    const dreamer = resolveAgentRuntimeBinding(loaded.effective, 'dreamer');
    expect(dreamer.ok).toBe(true);
    if (dreamer.ok) {
      expect(dreamer.profileId).toBe('openclaw.default');
      expect(createAdapterConfigFromProfile(dreamer.profile, lab.governanceDir).runtimeKind).toBe('openclaw-cli');
    }
  });

  it('explicit enabled:false agent stays disabled across an install (kill switch is Owner-authoritative)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab, (config) => {
      (config.internalAgents.agents['dreamer'] as Record<string, unknown>)['enabled'] = false;
    });

    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: 'test-model' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    expect(governance.internalAgents.agents['dreamer']['enabled']).toBe(false);

    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok).toBe(true);
    const binding = resolveAgentRuntimeBinding(loaded.effective, 'dreamer');
    expect(binding.ok).toBe(false);
    if (!binding.ok) expect(binding.readiness).toBe('disabled');
  });

  it('multi-host coexistence: a workspace initialized by `pd runtime init` alone resolves every enabled agent to the pi-ai default — never a host CLI session (ADR-0029)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab); // real runtime init, NO installer profile step

    const governance = readGovernanceConfig(lab);
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
    expect(governance.runtimeProfiles['openclaw.default']).toBeUndefined();

    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok, `loader errors: ${JSON.stringify(loaded.errors)}`).toBe(true);
    for (const name of INTERNAL_AGENT_NAMES) {
      if (!loaded.effective.config.internalAgents.agents[name]?.enabled) continue;
      const binding = resolveAgentRuntimeBinding(loaded.effective, name);
      expect(binding.ok, `${name}: ${binding.ok ? '' : binding.reason}`).toBe(true);
      if (!binding.ok) continue;
      expect(binding.profileId, `${name} rides PD's own runtime`).toBe('pd.default');
      expect(createAdapterConfigFromProfile(binding.profile, lab.governanceDir).runtimeKind).toBe('pi-ai');
      // An env-less lab is the ADR-0029 §5 case: the agent tells the Owner it
      // needs an LLM instead of silently borrowing the host's model.
      const readiness = checkAgentRuntimeReadiness(binding.profile, () => undefined);
      expect(readiness.readiness, `${name}: ${readiness.reason ?? ''}`).toBe('needs_setup');
    }
  });
});

// ─── Round-4 S2: model handling at the governance write boundary ────────────
//
// Defect (round-4 audit, withModel:false half): --model is documented optional
// with "a sensible default per provider", but the installer wrote an EMPTY
// model into pd.default and the resolver failed with `pi-ai profile missing
// required 'model' field` (needs_setup) — while the install reported success.
// The interactive prompt path already owned per-provider defaults
// (prompts.ts) — the write boundary now reuses that same resolution and
// preserves an existing valid model (existing-coverage contract).

describe('round-4 S2: model resolution at the governance write boundary', () => {

  it('blank-string --model fails loud at the write boundary; the governance config is left untouched', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY', model: '   ' }),
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success).toBe(false);
    const failureText = `${result.error ?? ''} ${result.reason ?? ''}`;
    expect(failureText).toContain('workbuddy_governance_profile_invalid');
    expect(failureText).toContain('--model');

    // No partial write: still exactly what `pd runtime init` laid down.
    const governance = readGovernanceConfig(lab);
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('');
    expect(governance.internalAgents.defaultRuntime).toBe('pd.default');
  });

  it('existing valid pd.default model is PRESERVED when the install argument omits --model (existing-coverage contract)', { timeout: 240_000 }, async () => {
    const lab = currentLab();
    seedGovernanceWorkspace(lab, (config) => {
      config.runtimeProfiles['pd.default'] = {
        type: 'pi-ai',
        provider: 'owner-provider',
        model: 'owner-model',
        apiKeyEnv: 'OWNER_DEFAULT_KEY_ENV',
      };
    });

    const result = await install(
      baseOptions(lab, { provider: 'openai', apiKeyEnv: 'WB_TEST_KEY' }), // no model
      lab.payloadDir,
      { quiet: true },
    );
    expect(result.success, `install failed: ${result.error ?? result.reason} Next: ${result.nextAction}`).toBe(true);

    const governance = readGovernanceConfig(lab);
    // The three install-collected fields win; the omitted model does NOT
    // clobber the existing valid one.
    expect(governance.runtimeProfiles['pd.default']['provider']).toBe('openai');
    expect(governance.runtimeProfiles['pd.default']['apiKeyEnv']).toBe('WB_TEST_KEY');
    expect(governance.runtimeProfiles['pd.default']['model']).toBe('owner-model');

    const loaded = loadPdConfigForPlugin(lab.governanceDir);
    expect(loaded.ok).toBe(true);
    const binding = resolveAgentRuntimeBinding(loaded.effective, 'diagnostician');
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    const readiness = checkAgentRuntimeReadiness(binding.profile, sentinelEnv);
    expect(readiness.readiness, readiness.reason ?? '').toBe('ready');
  });
});
