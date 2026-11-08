/**
 * WorkBuddy host-fact truthfulness for `pd health --host workbuddy`
 * (2026-11-07). Real temp fixtures; every test pins that the FOUR facts —
 * plugin registration, plugin enablement, governance flag, runtime boundary —
 * are read independently and never inferred from one another:
 * unreadable sources are UNKNOWN, an Owner opt-out stays
 * EXPLICITLY_DISABLED, and a complete MCP payload proves nothing about the
 * plugin. Read-only is proven by a directory snapshot: the assessment must
 * not write, create, or start anything.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assessWorkbuddyHostFacts, formatWorkbuddyHostFactLines } from '../../src/commands/health-workbuddy.js';

const PLUGIN_KEY = 'principles-disciple@principles-disciple-market';

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-wb-'));
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

function registryPath(home: string): string {
  return path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json');
}
function settingsPath(home: string): string {
  return path.join(home, '.workbuddy', 'settings.json');
}
function governanceDir(home: string): string {
  return path.join(home, '.workbuddy', 'pd-workspace');
}
function governanceConfig(home: string): string {
  return path.join(governanceDir(home), '.pd', 'config.yaml');
}

const GOVERNANCE_HEADER = 'version: 1\nfeatures:\n';

function writeGovernanceConfig(home: string, hostWorkbuddyYaml: string): void {
  fs.mkdirSync(path.join(governanceDir(home), '.pd'), { recursive: true });
  fs.writeFileSync(governanceConfig(home), GOVERNANCE_HEADER + hostWorkbuddyYaml
    + '  workbuddy_live_keyword_pain:\n    enabled: false\n    category: quiet\n'
    + 'runtimeProfiles:\n  pd.default:\n    type: pi-ai\n    provider: openai\n    model: m\n    apiKeyEnv: K\n'
    + 'internalAgents:\n  defaultRuntime: pd.default\n  agents:\n    diagnostician:\n      enabled: true\n      runtimeProfile: pd.default\n');
}

/** Loader-valid governance config that never mentions host.workbuddy. */
function writeGovernanceConfigWithoutHostFlag(home: string): void {
  fs.mkdirSync(path.join(governanceDir(home), '.pd'), { recursive: true });
  fs.writeFileSync(governanceConfig(home), GOVERNANCE_HEADER
    + '  workbuddy_live_keyword_pain:\n    enabled: false\n    category: quiet\n'
    + 'runtimeProfiles:\n  pd.default:\n    type: pi-ai\n    provider: openai\n    model: m\n    apiKeyEnv: K\n'
    + 'internalAgents:\n  defaultRuntime: pd.default\n  agents:\n    diagnostician:\n      enabled: true\n      runtimeProfile: pd.default\n');
}

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

describe('assessWorkbuddyHostFacts — four independent facts (real fixtures)', () => {
  it('C5.1 registered + enabled', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user', version: '0.1.0' } } });
      writeJson(settingsPath(home), { enabledPlugins: { [PLUGIN_KEY]: true } });
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registered).toBe(true);
      expect(facts.plugin.registryReadable).toBe(true);
      expect(facts.plugin.enabled).toBe(true);
    });
  });

  it('C5.2 registered + disabled', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user' } } });
      writeJson(settingsPath(home), { enabledPlugins: { [PLUGIN_KEY]: false } });
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registered).toBe(true);
      expect(facts.plugin.enabled).toBe(false);
    });
  });

  it('C5.3 not registered (registry readable, key absent)', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: {} });
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registered).toBe(false);
      expect(facts.plugin.registryReadable).toBe(true);
      expect(facts.plugin.enabled).toBeNull();
    });
  });

  it('C5.4 registry unreadable → registration UNKNOWN, never NOT_REGISTERED-by-guess', () => {
    withHome((home) => {
      fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true });
      // A DIRECTORY at the registry path — a real unreadable shape.
      fs.mkdirSync(registryPath(home));
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registryReadable).toBe(false);
      expect(facts.plugin.registered).toBe(false);
    });
  });

  it('C5.5 settings unreadable → enablement UNKNOWN, never DISABLED-by-guess', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user' } } });
      fs.mkdirSync(settingsPath(home));
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.enabled).toBeNull();
      expect(facts.plugin.registered).toBe(true);
    });
  });

  it('C5.6 governance ENABLED', () => {
    withHome((home) => {
      writeGovernanceConfig(home, '  host.workbuddy:\n    enabled: true\n    category: quiet\n');
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.governance.state).toBe('ENABLED');
    });
  });

  it('C5.7 governance EXPLICITLY_DISABLED (Owner opt-out preserved as its own state)', () => {
    withHome((home) => {
      writeGovernanceConfig(home, '  host.workbuddy:\n    enabled: false\n    category: quiet\n');
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.governance.state).toBe('EXPLICITLY_DISABLED');
    });
  });

  it('C5.8 governance config unreadable → UNKNOWN with reason', () => {
    withHome((home) => {
      fs.mkdirSync(path.join(governanceDir(home), '.pd'), { recursive: true });
      // A DIRECTORY at the config path — unreadable for real.
      fs.mkdirSync(governanceConfig(home));
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.governance.state).toBe('UNKNOWN');
      expect(facts.governance.reason).toBeDefined();
    });
  });

  it('C5.9 a complete MCP payload does NOT imply registration or enablement', () => {
    withHome((home) => {
      // MCP payload fully present (marketplace payload + launcher)…
      const payload = path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple');
      writeJson(path.join(payload, '.codebuddy-plugin', 'plugin.json'), { name: 'principles-disciple' });
      fs.mkdirSync(path.join(payload, 'mcp'), { recursive: true });
      fs.writeFileSync(path.join(payload, 'mcp', 'launcher.cjs'), '// pd-mcp-launcher.v1\n');
      // …while the plugin registry has NO entry at all.
      writeJson(registryPath(home), { version: 2, plugins: {} });
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registered).toBe(false);
      expect(facts.plugin.enabled).toBeNull();
    });
  });

  it('C5.10 registration does NOT imply MCP health (facts stay independent)', () => {
    withHome((home) => {
      // Registered + enabled, but NO MCP payload anywhere.
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user' } } });
      writeJson(settingsPath(home), { enabledPlugins: { [PLUGIN_KEY]: true } });
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.plugin.registered).toBe(true);
      expect(facts.plugin.enabled).toBe(true);
      // The facts module reports no MCP verdict at all — that is assessMcpHealth's
      // independent section; the absence of an MCP claim here IS the separation.
      expect(Object.hasOwn(facts, 'mcp')).toBe(false);
    });
  });

  it('C5.14 read-only: the assessment writes/creates/starts nothing', () => {
    withHome((home) => {
      fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
      const before = snapshotTree(home);
      assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(snapshotTree(home)).toEqual(before);
      expect(fSExists(governanceDir(home))).toBe(false); // governance dir never created
    });
  });

  it('C5.15 loader-valid config WITHOUT the flag key → DEFAULT_OFF, never a fabricated opt-out', () => {
    withHome((home) => {
      // Loader-valid governance config that never mentions host.workbuddy.
      writeGovernanceConfigWithoutHostFlag(home);
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.governance.state).toBe('DEFAULT_OFF');
    });
  });

  it('C5.14b read-only proof over the FULL fixture (governance loader + flag computation included)', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user' } } });
      writeJson(settingsPath(home), { enabledPlugins: { [PLUGIN_KEY]: false } });
      writeGovernanceConfig(home, '  host.workbuddy:\n    enabled: false\n    category: quiet\n');
      const before = snapshotTree(home);
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.governance.state).toBe('EXPLICITLY_DISABLED');
      expect(snapshotTree(home)).toEqual(before);
    });
  });

  it('runtime boundary is explicit: probe never performed, model tool call NOT_VERIFIED', () => {
    withHome((home) => {
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      expect(facts.runtime.probePerformed).toBe(false);
      expect(facts.runtime.modelToolCall).toBe('NOT_VERIFIED');
      const lines = formatWorkbuddyHostFactLines(facts);
      expect(lines.join('\n')).toContain('RUNTIME_PROBE_NOT_PERFORMED');
      expect(lines.join('\n')).toContain('MODEL_TOOL_CALL_NOT_VERIFIED');
    });
  });

  it('C5.13 text rendering agrees with the structured facts', () => {
    withHome((home) => {
      writeJson(registryPath(home), { version: 2, plugins: { [PLUGIN_KEY]: { scope: 'user' } } });
      writeJson(settingsPath(home), { enabledPlugins: { [PLUGIN_KEY]: false } });
      writeGovernanceConfig(home, '  host.workbuddy:\n    enabled: false\n    category: quiet\n');
      const facts = assessWorkbuddyHostFacts({ homeDir: home, configDirOverride: path.join(home, '.workbuddy') });
      const text = formatWorkbuddyHostFactLines(facts).join('\n');
      expect(text).toContain('registration: REGISTERED');
      expect(text).toContain('enabled: DISABLED');
      expect(text).toContain('EXPLICITLY_DISABLED');
    });
  });
});

function fSExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}
