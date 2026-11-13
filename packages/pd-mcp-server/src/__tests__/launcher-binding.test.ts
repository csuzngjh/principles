/**
 * Launcher binding security tests — SPEC-PD-MCP-GATE4-001 §3.3/§3.5 + Gate 4 P2.
 *
 * The launcher is the only PD-owned component every host executes before any
 * MCP traffic. These tests run the REAL shipped launcher (not a reimplementation)
 * against fabricated payloads/runtimes and pin:
 *   - exactly one payload marker decides the host; ambiguity fails closed;
 *   - a binding from a different host is rejected (copied/forged binding);
 *   - serverEntry must equal the canonical entry for that host's layout;
 *   - symlinks/junctions may not escape the recorded runtime directory;
 *   - the installed package identity/version must agree with the binding and
 *     (Codex) the plugin runtime pin;
 *   - failures emit ONE sanitized stderr JSON line and no stdout;
 *   - a valid binding starts the entry with the binding — never inherited
 *     cwd/HOME/env — as the workspace/host authority.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.join(PKG_ROOT, '..', '..');
const LAUNCHER = path.join(REPO_ROOT, 'plugins', 'principles-disciple', 'mcp', 'launcher.cjs');

const FAKE_SERVER = [
  "'use strict';",
  'exports.main = async (env) => {',
  '  process.stdout.write(JSON.stringify({',
  '    workspace: env.PD_MCP_WORKSPACE_DIR,',
  '    host: env.PD_MCP_HOST,',
  '    ...(env.PD_EXPERIMENT_ROOT ? { experimentRoot: env.PD_EXPERIMENT_ROOT } : {}),',
  '    ...(env.PD_MCP_LOG_DIR ? { logDir: env.PD_MCP_LOG_DIR } : {}),',
  '  }));',
  '  return 0;',
  '};',
  '',
].join('\n');

interface HostSpec {
  marker: string;
  entrySegments: string[];
  pin?: { mcpServer: string; core: string };
}

const HOSTS: Record<'codex' | 'openclaw' | 'workbuddy', HostSpec> = {
  codex: {
    marker: path.join('.codex-plugin', 'plugin.json'),
    entrySegments: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
    pin: { mcpServer: '0.1.0', core: '1.298.1' },
  },
  openclaw: {
    marker: 'openclaw.plugin.json',
    entrySegments: ['pd-mcp-server', 'dist', 'index.js'],
  },
  workbuddy: {
    marker: path.join('.codebuddy-plugin', 'plugin.json'),
    entrySegments: ['pd-mcp-server', 'dist', 'index.js'],
  },
};

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function makeWorkspace(): string {
  return tempDir('pd-launcher-ws-');
}

function makePluginRoot(host: keyof typeof HOSTS): string {
  const root = tempDir('pd-launcher-plugin-');
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
  fs.copyFileSync(LAUNCHER, path.join(root, 'mcp', 'launcher.cjs'));
  const marker = path.join(root, HOSTS[host].marker);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ name: 'principles-disciple' }), 'utf8');
  const {pin} = HOSTS[host];
  if (pin !== undefined) {
    fs.writeFileSync(path.join(root, 'runtime-version.json'), JSON.stringify(pin), 'utf8');
  }
  return root;
}

function addMarker(root: string, marker: string): void {
  const file = path.join(root, marker);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}', 'utf8');
}

interface FabricatedRuntime {
  runtimeDir: string;
  packageDir: string;
  serverEntry: string;
}

/** Fabricate the canonical component layout for one host. */
function makeRuntime(host: keyof typeof HOSTS, version = '0.1.0'): FabricatedRuntime {
  const runtimeDir = tempDir('pd-launcher-runtime-');
  const packageDir = path.join(runtimeDir, ...HOSTS[host].entrySegments.slice(0, -2));
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@principles/pd-mcp-server', version }), 'utf8');
  fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), FAKE_SERVER, 'utf8');
  return { runtimeDir, packageDir, serverEntry: path.join(runtimeDir, ...HOSTS[host].entrySegments) };
}

function writeBinding(root: string, binding: unknown): void {
  fs.writeFileSync(path.join(root, 'mcp-binding.json'), typeof binding === 'string' ? binding : JSON.stringify(binding, null, 2), 'utf8');
}

interface BindingInput {
  host: keyof typeof HOSTS;
  runtime: FabricatedRuntime;
  workspace: string;
  overrides?: Record<string, unknown>;
}

function bindingFor({ host, runtime, workspace, overrides = {} }: BindingInput): Record<string, unknown> {
  return {
    schemaVersion: 'pd.mcp-binding.v1',
    host,
    workspaceDir: workspace,
    runtimeDir: runtime.runtimeDir,
    serverEntry: runtime.serverEntry,
    versions: host === 'codex'
      ? { mcpServer: '0.1.0', core: '1.298.1' }
      : { mcpServer: '0.1.0' },
    writtenAt: new Date().toISOString(),
    ...overrides,
  };
}

interface LaunchOptions {
  /** Explicit OWNER declaration the launcher cross-checks against the binding. */
  declareWorkspace?: string;
  /** Extra env for opt-out / rotation experiments. */
  extraEnv?: Record<string, string>;
}

function runLauncher(root: string, options: LaunchOptions = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(root, 'mcp', 'launcher.cjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      // Isolate HOME so ambient PD config files cannot declare a workspace.
      HOME: root,
      USERPROFILE: root,
      // The openclaw gate re-derives the declaration from env/config; an
      // inherited value from the developer machine must not leak into the test.
      PD_WORKSPACE_DIR: options.declareWorkspace ?? '',
      OPENCLAW_WORKSPACE: '',
      // Neither value may reach the server: the binding is the only authority.
      PD_MCP_WORKSPACE_DIR: path.join(root, 'inherited-workspace-must-not-win'),
      PD_MCP_HOST: 'inherited-host-must-not-win',
      // A developer machine may have an experiment running; neither variable
      // may leak into the production-path tests.
      PD_EXPERIMENT_ROOT: '',
      PD_MCP_LOG_DIR: '',
      ...options.extraEnv,
    },
  });
}

function expectFailure(result: ReturnType<typeof spawnSync>, reasonPrefix: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  const lines = String(result.stderr).trim().split('\n');
  expect(lines).toHaveLength(1);
  const payload = JSON.parse(lines[0] as string) as { launcher?: string; status?: string; reason?: string; nextAction?: string };
  expect(payload.launcher).toBe('pd-mcp');
  expect(payload.status).toBe('failed');
  expect(payload.reason?.startsWith(reasonPrefix)).toBe(true);
  expect(payload.nextAction?.length).toBeGreaterThan(0);
}

describe.each(['codex', 'openclaw', 'workbuddy'] as const)('launcher valid binding (%s)', (host) => {
  it('starts the canonical entry and injects the binding workspace/host', () => {
    const root = makePluginRoot(host);
    const runtime = makeRuntime(host);
    const workspace = makeWorkspace();
    writeBinding(root, bindingFor({ host, runtime, workspace }));

    const result = runLauncher(root, host === 'openclaw' ? { declareWorkspace: workspace } : {});
    expect(result.status).toBe(0);
    expect(String(result.stderr)).toBe('');
    expect(JSON.parse(String(result.stdout))).toEqual({ workspace, host });
  });
});

// ── Experiment isolation (P0, 2026-11-13) ──────────────────────────────────
interface ExperimentFixture {
  root: string;
  workspace: string;
  logDir: string;
}

function makeExperiment(): ExperimentFixture {
  const root = tempDir('pd-launcher-experiment-');
  const workspace = path.join(root, 'workspace');
  const logDir = path.join(root, '.pd', 'logs', 'mcp');
  fs.mkdirSync(workspace, { recursive: true });
  return { root, workspace, logDir };
}

function experimentEnv(experiment: ExperimentFixture): Record<string, string> {
  return {
    PD_EXPERIMENT_ROOT: experiment.root,
    PD_MCP_LOG_DIR: experiment.logDir,
  };
}

describe('launcher experiment isolation', () => {
  it('passes the experiment root/log dir to the real MCP child and binds the experiment workspace', () => {
    const pluginRoot = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const experiment = makeExperiment();
    writeBinding(pluginRoot, bindingFor({ host: 'openclaw', runtime, workspace: experiment.workspace }));

    const result = runLauncher(pluginRoot, {
      declareWorkspace: experiment.workspace,
      extraEnv: experimentEnv(experiment),
    });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({
      workspace: experiment.workspace,
      host: 'openclaw',
      experimentRoot: experiment.root,
      logDir: experiment.logDir,
    });
  });

  it('refuses a binding whose workspace is outside the experiment root', () => {
    const pluginRoot = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const experiment = makeExperiment();
    const productionWorkspace = makeWorkspace();
    writeBinding(pluginRoot, bindingFor({ host: 'openclaw', runtime, workspace: productionWorkspace }));

    expectFailure(
      runLauncher(pluginRoot, {
        declareWorkspace: productionWorkspace,
        extraEnv: experimentEnv(experiment),
      }),
      'experiment_binding_workspace_outside_root',
    );
  });

  it('refuses an experiment without PD_MCP_LOG_DIR (default would be production logs)', () => {
    const pluginRoot = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const experiment = makeExperiment();
    writeBinding(pluginRoot, bindingFor({ host: 'openclaw', runtime, workspace: experiment.workspace }));

    expectFailure(
      runLauncher(pluginRoot, {
        declareWorkspace: experiment.workspace,
        extraEnv: { PD_EXPERIMENT_ROOT: experiment.root },
      }),
      'experiment_mcp_log_dir_missing',
    );
  });

  it('refuses a PD_MCP_LOG_DIR outside the experiment root and writes nothing there', () => {
    const pluginRoot = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const experiment = makeExperiment();
    const outside = tempDir('pd-launcher-outside-logs-');
    writeBinding(pluginRoot, bindingFor({ host: 'openclaw', runtime, workspace: experiment.workspace }));

    expectFailure(
      runLauncher(pluginRoot, {
        declareWorkspace: experiment.workspace,
        extraEnv: { PD_EXPERIMENT_ROOT: experiment.root, PD_MCP_LOG_DIR: outside },
      }),
      'experiment_mcp_log_dir_outside_root',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a relative experiment root', () => {
    const pluginRoot = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const experiment = makeExperiment();
    writeBinding(pluginRoot, bindingFor({ host: 'openclaw', runtime, workspace: experiment.workspace }));

    expectFailure(
      runLauncher(pluginRoot, {
        declareWorkspace: experiment.workspace,
        extraEnv: { PD_EXPERIMENT_ROOT: 'relative/root', PD_MCP_LOG_DIR: experiment.logDir },
      }),
      'experiment_root_not_absolute',
    );
  });
});

describe('launcher durable log (observability)', () => {
  it('persists startup_failure to the PD log dir before any MCP traffic', () => {
    const root = makePluginRoot('openclaw');
    expectFailure(runLauncher(root), 'binding_missing');

    const logDir = path.join(root, '.pd', 'logs', 'mcp');
    const files = fs.readdirSync(logDir).filter((name) => /^mcp-.*\.jsonl$/.test(name));
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(logDir, files[0] as string), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('startup_failure');
    expect(lines[0]?.stage).toBe('launcher');
    expect(lines[0]?.reason).toBe('binding_missing');
    expect(lines[0]?.bindingPathExists).toBe(false);
    expect(lines[0]?.seq).toBe(1);
    expect(String(lines[0]?.ts)).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('PD_MCP_LOG=0 writes nothing (zero side effects)', () => {
    const root = makePluginRoot('openclaw');
    expectFailure(runLauncher(root, { extraEnv: { PD_MCP_LOG: '0' } }), 'binding_missing');
    expect(fs.existsSync(path.join(root, '.pd', 'logs', 'mcp'))).toBe(false);
  });
});

describe('launcher binding rejection (fail-closed)', () => {
  it('missing binding', () => {
    expectFailure(runLauncher(makePluginRoot('openclaw')), 'binding_missing');
  });

  it('unreadable (malformed JSON) binding', () => {
    const root = makePluginRoot('openclaw');
    writeBinding(root, '{"schemaVersion":');
    expectFailure(runLauncher(root), 'binding_unreadable');
  });

  it('non-object binding', () => {
    const root = makePluginRoot('openclaw');
    writeBinding(root, '[]');
    expectFailure(runLauncher(root), 'binding_invalid');
  });

  it('unsupported schema version', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { schemaVersion: 'pd.mcp-binding.v2' } }));
    expectFailure(runLauncher(root), 'binding_schema_unsupported');
  });

  it('sanitizes a hostile schemaVersion before it reaches the host log', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const hostile = `${'x'.repeat(400)}%0A{"status":"forged"}`;
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { schemaVersion: hostile } }));
    const result = runLauncher(root);
    expectFailure(result, 'binding_schema_unsupported');
    const payload = JSON.parse(String(result.stderr).trim()) as { reason: string };
    expect(payload.reason).not.toContain('forged');
    expect(payload.reason.length).toBeLessThanOrEqual('binding_schema_unsupported:'.length + 60);
  });

  it('unknown host value', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { host: 'evil-host' } }));
    expectFailure(runLauncher(root), 'binding_host_invalid');
  });

  it('binding copied from another host (cross-host forgery)', () => {
    const root = makePluginRoot('codex');
    const runtime = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'binding_host_mismatch');
  });

  it('missing payload host marker', () => {
    const root = tempDir('pd-launcher-plugin-');
    fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
    fs.copyFileSync(LAUNCHER, path.join(root, 'mcp', 'launcher.cjs'));
    expectFailure(runLauncher(root), 'host_marker_missing');
  });

  it('ambiguous payload host markers', () => {
    const root = makePluginRoot('workbuddy');
    addMarker(root, 'openclaw.plugin.json');
    addMarker(root, path.join('.codex-plugin', 'plugin.json'));
    expectFailure(runLauncher(root), 'host_marker_ambiguous');
  });

  it('entry pointing at another absolute JavaScript file', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const otherJs = path.join(runtime.runtimeDir, 'other.js');
    fs.writeFileSync(otherJs, FAKE_SERVER, 'utf8');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { serverEntry: otherJs } }));
    expectFailure(runLauncher(root), 'server_entry_not_canonical');
  });

  it('entry in an external directory', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const external = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { serverEntry: external.serverEntry } }));
    expectFailure(runLauncher(root), 'server_entry_not_canonical');
  });

  it('relative runtimeDir', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace(), overrides: { runtimeDir: 'relative/runtime' } }));
    expectFailure(runLauncher(root), 'binding_runtime_dir_invalid');
  });

  it('missing runtimeDir field (legacy binding)', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const binding = bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() });
    delete binding.runtimeDir;
    writeBinding(root, binding);
    expectFailure(runLauncher(root), 'binding_runtime_dir_invalid');
  });

  it('runtime directory no longer exists', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    fs.rmSync(runtime.runtimeDir, { recursive: true, force: true });
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'runtime_dir_missing');
  });

  it('server entry missing', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    fs.rmSync(runtime.serverEntry, { force: true });
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'server_entry_missing');
  });

  it('symlink/junction escape outside the runtime directory', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const external = makeRuntime('openclaw');
    fs.rmSync(path.join(runtime.runtimeDir, 'pd-mcp-server'), { recursive: true, force: true });
    fs.symlinkSync(external.packageDir, path.join(runtime.runtimeDir, 'pd-mcp-server'), process.platform === 'win32' ? 'junction' : 'dir');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'server_entry_escape');
  });

  it('package identity mismatch', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    fs.writeFileSync(path.join(runtime.packageDir, 'package.json'), JSON.stringify({ name: 'evil-package', version: '0.1.0' }), 'utf8');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'server_package_identity_mismatch');
  });

  it('installed version disagrees with the binding', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw', '9.9.9');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'binding_version_mismatch');
  });

  it('installed version disagrees with the Codex runtime pin', () => {
    const root = makePluginRoot('codex');
    const runtime = makeRuntime('codex');
    fs.writeFileSync(path.join(root, 'runtime-version.json'), JSON.stringify({ mcpServer: '0.2.0', core: '1.298.1' }), 'utf8');
    const binding = bindingFor({ host: 'codex', runtime, workspace: makeWorkspace() });
    writeBinding(root, binding);
    expectFailure(runLauncher(root), 'runtime_pin_mismatch:mcpServer');
  });

  it('binding core disagrees with the Codex runtime pin', () => {
    const root = makePluginRoot('codex');
    const runtime = makeRuntime('codex');
    const binding = bindingFor({ host: 'codex', runtime, workspace: makeWorkspace() });
    binding.versions = { mcpServer: '0.1.0', core: '9.9.9' };
    writeBinding(root, binding);
    expectFailure(runLauncher(root), 'runtime_pin_mismatch:core');
  });

  it('missing Codex runtime pin', () => {
    const root = makePluginRoot('codex');
    const runtime = makeRuntime('codex');
    fs.rmSync(path.join(root, 'runtime-version.json'), { force: true });
    writeBinding(root, bindingFor({ host: 'codex', runtime, workspace: makeWorkspace() }));
    expectFailure(runLauncher(root), 'runtime_pin_invalid');
  });

  it('missing workspace directory', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: path.join(os.tmpdir(), 'pd-launcher-missing-ws-' + process.pid) }));
    expectFailure(runLauncher(root), 'binding_workspace_missing');
  });

  it('workspace pointing at a file', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    const file = path.join(runtime.runtimeDir, 'not-a-workspace');
    fs.writeFileSync(file, 'x', 'utf8');
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace: file }));
    expectFailure(runLauncher(root), 'binding_workspace_not_directory');
  });

  it('entry that does not export main()', () => {
    const root = makePluginRoot('openclaw');
    const runtime = makeRuntime('openclaw');
    fs.writeFileSync(runtime.serverEntry, "'use strict';\nexports.notMain = 1;\n", 'utf8');
    const workspace = makeWorkspace();
    writeBinding(root, bindingFor({ host: 'openclaw', runtime, workspace }));
    expectFailure(runLauncher(root, { declareWorkspace: workspace }), 'server_entry_invalid');
  });
});
