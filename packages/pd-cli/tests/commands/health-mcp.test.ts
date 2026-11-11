/**
 * `pd health` shared MCP diagnostics — PRI-1071 Gate 4 P2 (SPEC §7.8).
 *
 * Real-filesystem tests: every fixture is built under an exclusive mkdtemp
 * HOME and removed in finally. They pin the honest status ladder —
 * HOST_NOT_FOUND / NOT_INSTALLED / CONFIG_MISSING / CONFIG_DRIFT /
 * VERSION_MISMATCH / RESTART_REQUIRED / HOST_RUNTIME_NOT_VERIFIED / HEALTHY —
 * for all three host layouts, and prove the section never guesses:
 * unverifiable layers report `unverified`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assessMcpHealth, selectMcpHostForWorkspace, formatMcpHostSelectionLine } from '../../src/commands/health-mcp.js';

const SCHEMA = 'pd.mcp-binding.v1';
const WORKSPACE_NAME = 'ws';
type Host = 'codex' | 'openclaw' | 'workbuddy';

function writePdLauncher(root: string, host: Host): string {
  const markerPath = host === 'codex'
    ? path.join(root, '.codex-plugin', 'plugin.json')
    : host === 'openclaw'
      ? path.join(root, 'openclaw.plugin.json')
      : path.join(root, '.codebuddy-plugin', 'plugin.json');
  if (!fs.existsSync(markerPath)) {
    writeJson(markerPath, host === 'openclaw'
      ? { id: 'principles-disciple', name: 'Principles Disciple', host }
      : { name: 'principles-disciple', host });
  }
  const launcher = path.join(root, 'mcp', 'launcher.cjs');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `// pd-mcp-launcher.v1\nconst bindingSchema = 'pd.mcp-binding.v1';\n`);
  return launcher;
}

function writeHostConfig(home: string, host: Host, launcher: string): string {
  if (host === 'codex') {
    const file = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const escapedLauncher = launcher.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.writeFileSync(file, `[mcp_servers.pd-recall]\ncommand = "node"\nargs = ["${escapedLauncher}"]\n`);
    return file;
  }
  if (host === 'openclaw') {
    const file = path.join(home, '.openclaw', 'openclaw.json');
    writeJson(file, { mcp: { servers: { 'pd-recall': { command: 'node', args: [launcher] } } } });
    return file;
  }
  const file = path.join(home, '.workbuddy', 'mcp.json');
  writeJson(file, { mcpServers: { 'pd-recall': { command: 'node', args: [launcher] } } });
  return file;
}

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-mcp-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeMcpPackage(packageDir: string, version: string): void {
  writeJson(path.join(packageDir, 'package.json'), { name: '@principles/pd-mcp-server', version });
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), '// installed MCP server entry\n');
}

function makeWorkspace(home: string): string {
  const workspace = path.join(home, WORKSPACE_NAME);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

interface CodexFixture {
  home: string;
  codexHome: string;
  payloadRoot: string;
  runtimeDir: string;
  serverEntry: string;
  bindingPath: string;
}

function makeCodexFixture(home: string, opts: { installedVersion?: string; pinVersion?: string | null } = {}): CodexFixture {
  const codexHome = path.join(home, '.codex');
  const payloadRoot = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', '0.1.0');
  writeJson(path.join(payloadRoot, '.codex-plugin', 'plugin.json'), { name: 'principles-disciple' });
  writePdLauncher(payloadRoot, 'codex');
  const runtimeDir = path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime');
  const serverEntry = path.join(runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js');
  const pinVersion = opts.pinVersion === undefined ? '0.1.0' : opts.pinVersion;
  writeJson(path.join(payloadRoot, 'runtime-version.json'), {
    codexAdapter: '0.6.2',
    hostRuntime: '0.14.4',
    core: '1.0.0',
    ...(pinVersion === null ? {} : { mcpServer: pinVersion }),
  });
  writeJson(path.join(payloadRoot, '.mcp.json'), {
    mcpServers: { 'pd-recall': { command: 'node', args: ['./mcp/launcher.cjs'], cwd: '.' } },
  });
  writeMcpPackage(
    path.join(runtimeDir, 'node_modules', '@principles', 'pd-mcp-server'),
    opts.installedVersion ?? '0.1.0',
  );
  const bindingPath = path.join(payloadRoot, 'mcp-binding.json');
  writeJson(bindingPath, {
    schemaVersion: SCHEMA,
    host: 'codex',
    workspaceDir: makeWorkspace(home),
    runtimeDir,
    serverEntry,
    versions: { mcpServer: opts.installedVersion ?? '0.1.0', core: '1.0.0' },
    writtenAt: new Date().toISOString(),
  });
  return { home, codexHome, payloadRoot, runtimeDir, serverEntry, bindingPath };
}

function assessCodex(fixture: CodexFixture) {
  return assessMcpHealth({ host: 'codex', homeDir: fixture.home, env: {} });
}

interface SharedFixture {
  home: string;
  payloadRoot: string;
  runtimeDir: string;
  serverEntry: string;
  bindingPath: string;
}

function makeSharedFixture(home: string, host: 'openclaw' | 'workbuddy'): SharedFixture {
  const payloadRoot = host === 'openclaw'
    ? path.join(home, '.openclaw', 'extensions', 'principles-disciple')
    : path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple');
  const runtimeDir = path.join(home, '.pd', 'runtime');
  const serverEntry = path.join(runtimeDir, 'pd-mcp-server', 'dist', 'index.js');
  if (host === 'openclaw') {
    writeJson(path.join(payloadRoot, 'openclaw.plugin.json'), {
      id: 'principles-disciple',
      mcpServers: { 'pd-recall': { transport: 'stdio', command: 'node', args: ['./mcp/launcher.cjs'] } },
    });
  } else {
    writeJson(path.join(payloadRoot, '.mcp.json'), {
      mcpServers: { 'pd-recall': { command: 'node', args: ['./mcp/launcher.cjs'], cwd: '.' } },
    });
  }
  if (host === 'workbuddy') {
    writeJson(path.join(payloadRoot, '.codebuddy-plugin', 'plugin.json'), { name: 'principles-disciple' });
  }
  writePdLauncher(payloadRoot, host);
  writeMcpPackage(path.join(runtimeDir, 'pd-mcp-server'), '0.1.0');
  const bindingPath = path.join(payloadRoot, 'mcp-binding.json');
  writeJson(bindingPath, {
    schemaVersion: SCHEMA,
    host,
    workspaceDir: makeWorkspace(home),
    runtimeDir,
    serverEntry,
    versions: { mcpServer: '0.1.0' },
  });
  return { home, payloadRoot, runtimeDir, serverEntry, bindingPath };
}

describe('assessMcpHealth — codex layout', () => {
  it('reports HEALTHY when binding, entry, pin and host config all agree', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const section = assessCodex(fixture);
      expect(section.status).toBe('HEALTHY');
      expect(section.reason).toBeUndefined();
      expect(section.server.version).toBe('0.1.0');
      expect(section.server.pin).toBe('0.1.0');
      expect(section.server.pinSource).toBe('runtime-version.json');
      expect(section.server.versionMatchesPin).toBe(true);
      expect(section.binding.canonical).toBe(true);
      expect(section.binding.insideRuntime).toBe(true);
      expect(section.binding.versionMatchesInstalled).toBe(true);
      expect(section.hostConfig.registered).toBe(true);
      expect(section.hostConfig.launcher).toBe('./mcp/launcher.cjs');
      expect(section.workspace.exists).toBe(true);
      expect(section.probe).toEqual({ performed: false, reason: 'health_is_read_only_and_does_not_spawn_the_server' });
    });
  });

  it('reports VERSION_MISMATCH when the installed bytes drift from the runtime pin', () => {
    withHome((home) => {
      const section = assessCodex(makeCodexFixture(home, { installedVersion: '0.1.0', pinVersion: '0.2.0' }));
      expect(section.status).toBe('VERSION_MISMATCH');
      expect(section.reason).toBe('installed_mcp_server_version_mismatch');
      expect(section.nextAction).toContain('Re-run the PD host setup');
    });
  });

  it('reports HOST_RUNTIME_NOT_VERIFIED when the pin file has no mcpServer pin', () => {
    withHome((home) => {
      const section = assessCodex(makeCodexFixture(home, { pinVersion: null }));
      expect(section.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(section.reason).toBe('runtime_pin_unreadable');
      expect(section.server.pin).toBeNull();
      expect(section.server.versionMatchesPin).toBe('unverified');
    });
  });

  it('reports CONFIG_MISSING with a setup action when mcp-binding.json is absent', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      fs.rmSync(fixture.bindingPath);
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_MISSING');
      expect(section.reason).toBe('mcp_binding_missing');
      expect(section.nextAction).toContain('Re-run the PD host setup');
    });
  });

  it('refuses a binding written for another host (cross-host drift)', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8')) as Record<string, unknown>;
      writeJson(fixture.bindingPath, { ...binding, host: 'openclaw' });
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('binding_host_mismatch');
    });
  });

  it('rejects a non-canonical serverEntry even when the file exists', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const other = path.join(fixture.runtimeDir, 'other.js');
      fs.writeFileSync(other, '// not the server\n');
      const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8')) as Record<string, unknown>;
      writeJson(fixture.bindingPath, { ...binding, serverEntry: other });
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('server_entry_not_canonical');
    });
  });

  it('reports CONFIG_DRIFT when the bound workspace no longer exists', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      fs.rmSync(path.join(home, WORKSPACE_NAME), { recursive: true, force: true });
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('binding_workspace_missing');
    });
  });

  it('reports CONFIG_DRIFT when the host MCP config does not register pd-recall', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      fs.rmSync(path.join(fixture.payloadRoot, '.mcp.json'));
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('host_mcp_config_not_registered');
    });
  });

  it('reports HOST_RUNTIME_NOT_VERIFIED when the installed server entry is missing', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      fs.rmSync(path.join(fixture.runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'));
      const section = assessCodex(fixture);
      expect(section.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(section.reason).toBe('server_entry_missing');
      expect(section.server.entryExists).toBe(false);
    });
  });

  it('reports RESTART_REQUIRED when the binding was written after the newest session started', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const rolloutDir = path.join(fixture.codexHome, 'sessions', '2026', '01', '01');
      fs.mkdirSync(rolloutDir, { recursive: true });
      fs.writeFileSync(path.join(rolloutDir, 'rollout-test.jsonl'), '{}\n');
      const binding = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8')) as Record<string, unknown>;
      writeJson(fixture.bindingPath, { ...binding, writtenAt: new Date(Date.now() + 3_600_000).toISOString() });
      const section = assessCodex(fixture);
      expect(section.status).toBe('RESTART_REQUIRED');
      expect(section.restart.required).toBe(true);
      expect(section.restart.reason).toBe('binding_written_after_newest_codex_session_started');
      expect(section.nextAction).toContain('Restart the host');
    });
  });

  it('reports HOST_NOT_FOUND when ~/.codex does not exist', () => {
    withHome((home) => {
      const section = assessMcpHealth({ host: 'codex', homeDir: home, env: {} });
      expect(section.status).toBe('HOST_NOT_FOUND');
      expect(section.reason).toBe('codex_home_missing');
    });
  });
});

describe('assessMcpHealth — openclaw layout', () => {
  it('reports HEALTHY for the canonical shared-runtime layout', () => {
    withHome((home) => {
      makeSharedFixture(home, 'openclaw');
      const section = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(section.status).toBe('HEALTHY');
      expect(section.server.runtimeDir).toBe(path.join(home, '.pd', 'runtime'));
      expect(section.server.pinSource).toBe('binding.versions.mcpServer');
      expect(section.hostConfig.registered).toBe(true);
      // OpenClaw exposes no host process start time — restart stays honest.
      expect(section.restart.required).toBe('unverified');
    });
  });

  it('reports HOST_NOT_FOUND without ~/.openclaw and NOT_INSTALLED with an empty extension dir', () => {
    withHome((home) => {
      const missing = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(missing.status).toBe('HOST_NOT_FOUND');
      expect(missing.reason).toBe('openclaw_home_missing');

      fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
      const empty = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(empty.status).toBe('NOT_INSTALLED');
      expect(empty.reason).toBe('openclaw_plugin_payload_missing');
    });
  });

  it('reports CONFIG_DRIFT when the server entry realpath escapes the runtime dir', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'openclaw');
      const outside = path.join(home, 'outside-pd-mcp-server');
      writeMcpPackage(outside, '0.1.0');
      fs.rmSync(path.join(fixture.runtimeDir, 'pd-mcp-server'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(fixture.runtimeDir, 'pd-mcp-server'), process.platform === 'win32' ? 'junction' : 'dir');
      const section = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('server_entry_escape');
      expect(section.binding.canonical).toBe(true);
      expect(section.binding.insideRuntime).toBe(false);
    });
  });
});

describe('assessMcpHealth — workbuddy layout', () => {
  it('reports HEALTHY for the PD-owned marketplace payload', () => {
    withHome((home) => {
      makeSharedFixture(home, 'workbuddy');
      const section = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(section.status).toBe('HEALTHY');
      expect(section.host).toBe('workbuddy');
      expect(section.binding.host).toBe('workbuddy');
      expect(section.hostConfig.registered).toBe(true);
    });
  });

  it('reports NOT_INSTALLED when the marketplace payload is missing', () => {
    withHome((home) => {
      const section = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(section.status).toBe('NOT_INSTALLED');
      expect(section.reason).toBe('workbuddy_plugin_payload_missing');
      expect(section.nextAction).toContain('install --host workbuddy');
    });
  });
});

describe('assessMcpHealth — declared entry integrity (PRI-1130)', () => {
  it('openclaw: a declared launcher that is missing is HOST_RUNTIME_NOT_VERIFIED, not HEALTHY', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'openclaw');
      const launcher = path.join(fixture.payloadRoot, 'mcp', 'launcher.cjs');
      const healthy = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(healthy.status).toBe('HEALTHY');
      expect(healthy.declaredEntries.checked).toBeGreaterThan(0);
      expect(healthy.declaredEntries.missing).toEqual([]);

      fs.rmSync(launcher);
      const broken = assessMcpHealth({ host: 'openclaw', homeDir: home });

      // The manifest still declares the launcher, so the config layer stays
      // "registered"; only the real-file check can expose the broken install.
      expect(broken.hostConfig.registered).toBe(true);
      expect(broken.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(broken.reason).toBe('declared_entry_missing');
      expect(broken.declaredEntries.missing.map((entry) => path.resolve(String(entry.resolved)))).toContain(path.resolve(launcher));
    });
  });

  it('workbuddy: a missing declared hook script is caught without hardcoding launcher.cjs', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'workbuddy');
      const wrapper = path.join(fixture.payloadRoot, 'scripts', 'wrapper.cjs');
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(wrapper, '// pd hook wrapper\n');
      writeJson(path.join(fixture.payloadRoot, 'hooks', 'hooks.json'), {
        hooks: {
          PreToolUse: [{
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" PreToolUse' }],
          }],
        },
      });

      const healthy = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(healthy.status).toBe('HEALTHY');
      expect(healthy.declaredEntries.missing).toEqual([]);

      fs.rmSync(wrapper);
      const broken = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(broken.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(broken.reason).toBe('declared_entry_missing');
      const missingDeclarations = broken.declaredEntries.missing.map((entry) => entry.declaration);
      expect(missingDeclarations.some((declaration) => declaration.includes('hooks/hooks.json#hooks.PreToolUse'))).toBe(true);
      expect(broken.declaredEntries.missing.map((entry) => path.resolve(String(entry.resolved)))).toContain(path.resolve(wrapper));
    });
  });

  it('workbuddy: a manifest-declared CUSTOM hooks path is verified, and a missing one is caught', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'workbuddy');
      const wrapper = path.join(fixture.payloadRoot, 'scripts', 'wrapper.cjs');
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(wrapper, '// pd hook wrapper\n');
      // Legal declaration form (manifest-facts.json): plugin.json `hooks` may
      // point to a custom hooks JSON file instead of the root hooks/hooks.json.
      const customHooks = './hooks/custom-hooks.json';
      writeJson(path.join(fixture.payloadRoot, '.codebuddy-plugin', 'plugin.json'), {
        name: 'principles-disciple',
        hooks: customHooks,
      });
      writeJson(path.join(fixture.payloadRoot, 'hooks', 'custom-hooks.json'), {
        hooks: {
          PreToolUse: [{
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" PreToolUse' }],
          }],
        },
      });

      const healthy = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(healthy.status).toBe('HEALTHY');
      expect(healthy.declaredEntries.missing).toEqual([]);
      expect(healthy.declaredEntries.checked).toBeGreaterThan(0);

      // The declared custom hooks FILE disappearing is itself a missing entry.
      fs.rmSync(path.join(fixture.payloadRoot, 'hooks', 'custom-hooks.json'));
      const broken = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(broken.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(broken.reason).toBe('declared_entry_missing');
      expect(broken.declaredEntries.missing.map((entry) => entry.declaration))
        .toContain('.codebuddy-plugin/plugin.json#hooks');
    });
  });

  it('workbuddy: commands inside a custom hooks file are verified under that file', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'workbuddy');
      const wrapper = path.join(fixture.payloadRoot, 'scripts', 'wrapper.cjs');
      writeJson(path.join(fixture.payloadRoot, '.codebuddy-plugin', 'plugin.json'), {
        name: 'principles-disciple',
        hooks: './hooks/custom-hooks.json',
      });
      writeJson(path.join(fixture.payloadRoot, 'hooks', 'custom-hooks.json'), {
        hooks: {
          PreToolUse: [{
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" PreToolUse' }],
          }],
        },
      });
      // wrapper intentionally absent → the custom file's command is a missing entry.
      const broken = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(broken.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(broken.reason).toBe('declared_entry_missing');
      const missing = broken.declaredEntries.missing;
      expect(missing.map((entry) => entry.declaration)
        .some((declaration) => declaration.startsWith('hooks/custom-hooks.json#hooks.PreToolUse'))).toBe(true);
      expect(missing.map((entry) => path.resolve(String(entry.resolved)))).toContain(path.resolve(wrapper));
    });
  });

  it('openclaw: a missing declared skill directory is caught by the same universal rule', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'openclaw');
      const manifestPath = path.join(fixture.payloadRoot, 'openclaw.plugin.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.skills = ['skills/core'];
      writeJson(manifestPath, manifest);
      const skillDir = path.join(fixture.payloadRoot, 'skills', 'core');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# core\n');

      expect(assessMcpHealth({ host: 'openclaw', homeDir: home }).status).toBe('HEALTHY');

      fs.rmSync(skillDir, { recursive: true, force: true });
      const broken = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(broken.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(broken.reason).toBe('declared_entry_missing');
      expect(broken.declaredEntries.missing.map((entry) => entry.declaration)).toContain('openclaw.plugin.json#skills[0]');
    });
  });

  it('unknown plugin-root variables are unverifiable, never reported healthy', () => {
    withHome((home) => {
      const fixture = makeSharedFixture(home, 'workbuddy');
      writeJson(path.join(fixture.payloadRoot, 'hooks', 'hooks.json'), {
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${UNKNOWN_PLUGIN_ROOT}/scripts/wrapper.cjs" PreToolUse' }] }],
        },
      });
      const section = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(section.status).toBe('HOST_RUNTIME_NOT_VERIFIED');
      expect(section.reason).toBe('declared_entry_unverifiable');
      expect(section.declaredEntries.unverifiable).toHaveLength(1);
      expect(section.declaredEntries.unverifiable[0]?.resolved).toBeNull();
    });
  });
});

describe('assessMcpHealth — same-name registration conflict (SPEC §7.5/§11.3)', () => {
  it('codex: user-tier pd-recall owned by another server degrades to CONFIG_DRIFT', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      fs.mkdirSync(fixture.codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(fixture.codexHome, 'config.toml'),
        '[mcp_servers.pd-recall]\ncommand = "npx"\nargs = ["-y", "other-mcp"]\n',
      );
      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('mcp_same_name_conflict');
      expect(section.registrationConflict.verdict).toBe('conflict');
      expect(section.nextAction).toContain('not owned by codex');
    });
  });

  it('openclaw: operator same-name server degrades; different names stay HEALTHY', () => {
    withHome((home) => {
      makeSharedFixture(home, 'openclaw');
      const configPath = path.join(home, '.openclaw', 'openclaw.json');
      writeJson(configPath, { mcp: { servers: { 'pd-recall': { command: 'python', args: ['other.py'] } } } });
      const conflict = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(conflict.status).toBe('CONFIG_DRIFT');
      expect(conflict.reason).toBe('mcp_same_name_conflict');
      expect(conflict.registrationConflict.verdict).toBe('conflict');

      writeJson(configPath, { mcp: { servers: { comfyui: { command: 'node', args: ['comfyui-mcp'] } } } });
      const coexist = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(coexist.status).toBe('HEALTHY');
      expect(coexist.registrationConflict.verdict).toBe('other_servers_only');
    });
  });

  it('openclaw: a same-name THIRD-PARTY mcp/launcher.cjs is a conflict, never PD', () => {
    withHome((home) => {
      makeSharedFixture(home, 'openclaw');
      const foreign = path.join(home, 'other-product', 'mcp', 'launcher.cjs');
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      fs.writeFileSync(foreign, '// third-party product launcher\n');
      const configPath = path.join(home, '.openclaw', 'openclaw.json');
      writeJson(configPath, { mcp: { servers: { 'pd-recall': { command: 'node', args: [foreign] } } } });
      const foreignSection = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(foreignSection.status).toBe('CONFIG_DRIFT');
      expect(foreignSection.reason).toBe('mcp_same_name_conflict');
      expect(foreignSection.registrationConflict.verdict).toBe('conflict');

      writeJson(configPath, { mcp: { servers: { 'pd-recall': { command: 'node', args: ['./mcp/launcher.cjs'] } } } });
      const relative = assessMcpHealth({ host: 'openclaw', homeDir: home });
      expect(relative.status).toBe('CONFIG_DRIFT');
      expect(relative.reason).toBe('mcp_registration_unverifiable');
      console.log('[gate4-evidence]', JSON.stringify({
        host: 'openclaw', foreignVerdict: foreignSection.registrationConflict.verdict,
        relativeVerdict: relative.registrationConflict.verdict,
      }));
    });
  });

  it('workbuddy: a same-name user-level server degrades; malformed file is unverifiable', () => {
    withHome((home) => {
      makeSharedFixture(home, 'workbuddy');
      const configPath = path.join(home, '.workbuddy', 'mcp.json');
      writeJson(configPath, { mcpServers: { 'pd-recall': { type: 'streamableHttp', url: 'https://example/mcp' } } });
      const conflict = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(conflict.status).toBe('CONFIG_DRIFT');
      expect(conflict.reason).toBe('mcp_same_name_conflict');
      expect(conflict.registrationConflict.verdict).toBe('conflict');

      fs.writeFileSync(configPath, '{ not json');
      const malformed = assessMcpHealth({ host: 'workbuddy', homeDir: home });
      expect(malformed.status).toBe('CONFIG_DRIFT');
      expect(malformed.reason).toBe('mcp_registration_unverifiable');
      expect(malformed.registrationConflict.verdict).toBe('unverifiable');
    });
  });

  it.each(['codex', 'openclaw', 'workbuddy'] as const)('%s accepts its own marked PD launcher', (host) => {
    withHome((home) => {
      const payloadRoot = host === 'codex'
        ? makeCodexFixture(home).payloadRoot
        : makeSharedFixture(home, host).payloadRoot;
      const launcher = path.join(payloadRoot, 'mcp', 'launcher.cjs');
      writeHostConfig(home, host, launcher);
      const section = assessMcpHealth({ host, homeDir: home, env: {} });
      expect(section.registrationConflict.verdict).toBe('pd_owned');
      expect(section.status).toBe('HEALTHY');
    });
  });

  it.each([
    ['codex', 'openclaw'],
    ['codex', 'workbuddy'],
    ['openclaw', 'codex'],
    ['workbuddy', 'codex'],
  ] as const)('%s health blocks a %s launcher with valid PD content stamps', (expectedHost, launcherHost) => {
    withHome((home) => {
      if (expectedHost === 'codex') makeCodexFixture(home);
      else makeSharedFixture(home, expectedHost);
      const foreignLauncher = writePdLauncher(path.join(home, `source-${launcherHost}`), launcherHost);
      writeHostConfig(home, expectedHost, foreignLauncher);
      const section = assessMcpHealth({ host: expectedHost, homeDir: home, env: {} });
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('mcp_same_name_conflict');
      expect(section.registrationConflict.verdict).toBe('conflict');
    });
  });

  it('Codex health blocks a cross-host junction that escapes its trusted payload root', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const openclawLauncher = writePdLauncher(path.join(home, 'openclaw-source'), 'openclaw');
      const codexMcpDir = path.join(fixture.payloadRoot, 'mcp');
      fs.rmSync(codexMcpDir, { recursive: true, force: true });
      fs.symlinkSync(path.dirname(openclawLauncher), codexMcpDir, process.platform === 'win32' ? 'junction' : 'dir');
      writeHostConfig(home, 'codex', path.join(codexMcpDir, 'launcher.cjs'));

      const section = assessCodex(fixture);
      expect(section.status).toBe('CONFIG_DRIFT');
      expect(section.reason).toBe('mcp_registration_unverifiable');
      expect(section.registrationConflict.verdict).toBe('unverifiable');
    });
  });
});

describe('selectMcpHostForWorkspace — PRI-1186: the serving binding is the host authority', () => {
  const query = (home: string, ws?: string) => path.join(home, ws ?? WORKSPACE_NAME);

  it('selects codex when the codex binding serves the queried workspace', () => {
    withHome((home) => {
      makeCodexFixture(home);
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} })).toEqual({
        host: 'codex',
        selectedBy: 'binding-workspace-match',
        matchedHosts: ['codex'],
      });
    });
  });

  it('selects openclaw when the openclaw binding serves the queried workspace', () => {
    withHome((home) => {
      makeSharedFixture(home, 'openclaw');
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} })).toEqual({
        host: 'openclaw',
        selectedBy: 'binding-workspace-match',
        matchedHosts: ['openclaw'],
      });
    });
  });

  it('selects workbuddy when the workbuddy binding serves the queried workspace', () => {
    withHome((home) => {
      makeSharedFixture(home, 'workbuddy');
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} })).toEqual({
        host: 'workbuddy',
        selectedBy: 'binding-workspace-match',
        matchedHosts: ['workbuddy'],
      });
    });
  });

  it('keeps the openclaw default and discloses when no binding serves the workspace', () => {
    withHome((home) => {
      makeCodexFixture(home); // binds home/ws, NOT home/other-ws
      expect(selectMcpHostForWorkspace(query(home, 'other-ws'), { homeDir: home, env: {} })).toEqual({
        host: 'openclaw',
        selectedBy: 'default-no-match',
        matchedHosts: [],
      });
    });
  });

  it('keeps the openclaw default when no host binding exists at all', () => {
    withHome((home) => {
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} })).toEqual({
        host: 'openclaw',
        selectedBy: 'default-no-match',
        matchedHosts: [],
      });
    });
  });

  it('discloses ambiguity instead of guessing when two hosts bind the same workspace', () => {
    withHome((home) => {
      makeSharedFixture(home, 'openclaw');
      makeCodexFixture(home);
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} })).toEqual({
        host: 'openclaw',
        selectedBy: 'default-ambiguous',
        matchedHosts: ['openclaw', 'codex'],
      });
    });
  });

  it('ignores a binding whose workspaceDir is relative (unusable as authority)', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const record = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8'));
      record.workspaceDir = 'relative/ws';
      writeJson(fixture.bindingPath, record);
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} }).selectedBy).toBe('default-no-match');
    });
  });

  it('ignores a binding without a workspaceDir', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const record = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8'));
      delete record.workspaceDir;
      writeJson(fixture.bindingPath, record);
      expect(selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} }).selectedBy).toBe('default-no-match');
    });
  });

  it('matches a trailing-separator variant of the same workspace', () => {
    withHome((home) => {
      makeCodexFixture(home);
      const selection = selectMcpHostForWorkspace(query(home) + path.sep, { homeDir: home, env: {} });
      expect(selection.host).toBe('codex');
      expect(selection.selectedBy).toBe('binding-workspace-match');
    });
  });

  it.skipIf(process.platform !== 'win32')('matches case-insensitively on Windows', () => {
    withHome((home) => {
      const fixture = makeCodexFixture(home);
      const record = JSON.parse(fs.readFileSync(fixture.bindingPath, 'utf8'));
      record.workspaceDir = String(record.workspaceDir).toUpperCase();
      writeJson(fixture.bindingPath, record);
      const selection = selectMcpHostForWorkspace(query(home), { homeDir: home, env: {} });
      expect(selection.host).toBe('codex');
      expect(selection.selectedBy).toBe('binding-workspace-match');
    });
  });

  it('honors CODEX_HOME when locating the codex binding', () => {
    withHome((home) => {
      makeCodexFixture(home);
      const selection = selectMcpHostForWorkspace(query(home), {
        homeDir: home,
        env: { CODEX_HOME: path.join(home, '.codex') },
      });
      expect(selection.host).toBe('codex');
      expect(selection.selectedBy).toBe('binding-workspace-match');
    });
  });
});

describe('formatMcpHostSelectionLine — every selection reason is disclosed', () => {
  it('names the host and the explicit flag', () => {
    expect(formatMcpHostSelectionLine({ host: 'workbuddy', selectedBy: 'explicit-flag', matchedHosts: [] }))
      .toBe('mcp.hostSelection: workbuddy (explicit --host)');
  });

  it('names the serving binding for a workspace match', () => {
    const line = formatMcpHostSelectionLine({ host: 'codex', selectedBy: 'binding-workspace-match', matchedHosts: ['codex'] });
    expect(line).toContain('mcp.hostSelection: codex');
    expect(line).toContain('serves this workspace');
  });

  it('discloses that no host binding serves the workspace', () => {
    const line = formatMcpHostSelectionLine({ host: 'openclaw', selectedBy: 'default-no-match', matchedHosts: [] });
    expect(line).toContain('mcp.hostSelection: openclaw');
    expect(line).toContain('no host binding serves this workspace');
  });

  it('discloses every matching host on ambiguity and asks for --host', () => {
    const line = formatMcpHostSelectionLine({ host: 'openclaw', selectedBy: 'default-ambiguous', matchedHosts: ['openclaw', 'codex'] });
    expect(line).toContain('openclaw, codex');
    expect(line).toContain('--host');
  });
});
