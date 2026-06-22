/**
 * pd-config-loader tests — PRI-305
 *
 * Covers:
 *   - Missing config → defaults with nextAction
 *   - Malformed config → fail loud with errors and nextAction
 *   - Valid config → effective config with source='user_config'
 *   - OpenClaw reference summary shows safe label/id only
 *   - PD-local profile summary shows apiKeyEnv, not secret value
 *   - Per-agent override summary
 *   - No secret output in any result
 *   - Legacy file detection
 *   - JSON purity of outputs
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  loadPdConfig,
  computeFlagsFromLoadResult,
  redactLoadResult,
  getPdConfigPath,
  PD_CONFIG_DIR,
  PD_CONFIG_FILENAME,
} from '../../src/services/pd-config-loader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-loader-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, content: string): void {
  const configDir = path.join(workspaceDir, PD_CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, PD_CONFIG_FILENAME), content, 'utf8');
}

function makeValidConfigYaml(): string {
  return yaml.dump({
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: false },
      empathy_observer: { category: 'quiet', enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'openclaw.model.lmstudio.qwen3': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
      'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000 },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.model.lmstudio.qwen3' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  });
}

// ── getPdConfigPath ──────────────────────────────────────────────────────────

describe('getPdConfigPath', () => {
  it('returns path under .pd/config.yaml', () => {
    expect(getPdConfigPath('/workspace/project')).toBe(
      path.join('/workspace/project', '.pd', 'config.yaml'),
    );
  });
});

// ── Missing config → defaults ────────────────────────────────────────────────

describe('Missing config → defaults', () => {
  it('returns ok=true with source=defaults when config file is absent', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.source).toBe('defaults');
      expect(result.effective.config.version).toBe(1);
      expect(result.effective.config.features.prompt.enabled).toBe(true);
      expect(result.effective.config.features.code_tool_hook.enabled).toBe(true);
      expect(result.effective.config.features.defer_archive.enabled).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('defaults include all MVP core features enabled', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      const { features } = result.effective.config;
      expect(features.prompt.enabled).toBe(true);
      expect(features.prompt.category).toBe('core');
      expect(features.code_tool_hook.enabled).toBe(true);
      expect(features.defer_archive.enabled).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('defaults include gone features disabled', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.effective.config.features.nocturnal.enabled).toBe(false);
      expect(result.effective.config.features.nocturnal.category).toBe('gone');
    } finally { rmTmpDir(tmp); }
  });

  it('defaults include openclaw.default runtime profile', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      expect(Object.hasOwn(result.effective.config.runtimeProfiles, 'openclaw.default')).toBe(true);
    } finally { rmTmpDir(tmp); }
  });
});

// ── Malformed config → fail loud ────────────────────────────────────────────

describe('Malformed config → fail loud', () => {
  it('returns ok=false with errors for YAML parse error', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.source).toBe('malformed');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].reason).toMatch(/YAML parse error/i);
      expect(result.errors[0].nextAction).toBeTruthy();
    } finally { rmTmpDir(tmp); }
  });

  it('returns ok=false with errors for invalid version', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({ version: 99, features: {}, runtimeProfiles: {}, internalAgents: { defaultRuntime: 'x', agents: {} } }));
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.errors.some(e => e.path === 'version')).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('returns ok=false with errors for missing features', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({ version: 1, runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } }, internalAgents: { defaultRuntime: 'openclaw.default', agents: {} } }));
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.errors.some(e => e.path === 'features')).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('returns ok=false with errors for non-boolean enabled', () => {
    const tmp = mkTmpDir();
    const config = yaml.dump({
      version: 1,
      features: { prompt: { category: 'core', enabled: 'yes' } },
      runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
      internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
    });
    writeConfig(tmp, config);
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.errors.some(e => e.path.includes('enabled'))).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('returns ok=false with errors for forbidden secret field', () => {
    const tmp = mkTmpDir();
    const config = yaml.dump({
      version: 1,
      features: { prompt: { category: 'core', enabled: true } },
      runtimeProfiles: {
        'bad.profile': { type: 'openclaw', apiKey: 'sk-1234567890abcdef' },
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
    });
    writeConfig(tmp, config);
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.errors.some(e => e.reason.includes('forbidden secret field'))).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('each error has reason and nextAction', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = loadPdConfig(tmp);
      if (result.ok) throw new Error('Expected error');
      for (const error of result.errors) {
        expect(error.reason.length).toBeGreaterThan(0);
        expect(error.nextAction.length).toBeGreaterThan(0);
      }
    } finally { rmTmpDir(tmp); }
  });

  it('malformed result still provides usable defaults', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = loadPdConfig(tmp);
      if (result.ok) throw new Error('Expected error');
      expect(result.defaults.config.version).toBe(1);
      expect(result.defaults.config.features.prompt.enabled).toBe(true);
    } finally { rmTmpDir(tmp); }
  });
});

// ── Valid config → effective config ──────────────────────────────────────────

describe('Valid config → effective config', () => {
  it('returns ok=true with source=user_config for valid config', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.source).toBe('user_config');
      expect(result.effective.config.version).toBe(1);
    } finally { rmTmpDir(tmp); }
  });

  it('preserves user feature overrides', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.effective.config.features.correction_observer.enabled).toBe(false);
    } finally { rmTmpDir(tmp); }
  });

  it('preserves runtime profiles', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      expect(Object.hasOwn(result.effective.config.runtimeProfiles, 'pd.anthropic-sonnet')).toBe(true);
    } finally { rmTmpDir(tmp); }
  });
});

// ── OpenClaw reference summary ───────────────────────────────────────────────

describe('OpenClaw reference summary', () => {
  it('shows safe label without secrets', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const ocProfile = summary.runtimeProfiles.find(p => p.id === 'openclaw.model.lmstudio.qwen3');
      expect(ocProfile).toBeDefined();
      expect(ocProfile!.type).toBe('openclaw');
      expect(ocProfile!.label).toContain('openclaw');
      expect(ocProfile!.label).toContain('lmstudio');
      expect(ocProfile!.apiKeyEnv).toBeUndefined();
    } finally { rmTmpDir(tmp); }
  });

  it('does not contain raw provider object', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const json = JSON.stringify(summary);
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"gatewayToken"');
    } finally { rmTmpDir(tmp); }
  });
});

// ── PD-local profile summary ────────────────────────────────────────────────

describe('PD-local profile summary', () => {
  it('shows apiKeyEnv name, not value', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic-sonnet');
      expect(pdProfile).toBeDefined();
      expect(pdProfile!.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      const json = JSON.stringify(summary);
      expect(json).not.toContain('sk-ant-');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Per-agent override summary ───────────────────────────────────────────────

describe('Per-agent override summary', () => {
  it('diagnostician uses explicit override, not defaultRuntime', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const diag = summary.agents.find(a => a.name === 'diagnostician');
      expect(diag).toBeDefined();
      expect(diag!.runtimeProfileId).toBe('openclaw.model.lmstudio.qwen3');
      expect(diag!.runtimeProfileLabel).toContain('lmstudio');
    } finally { rmTmpDir(tmp); }
  });

  it('agent without override uses defaultRuntime', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const dreamer = summary.agents.find(a => a.name === 'dreamer');
      expect(dreamer).toBeDefined();
      expect(dreamer!.runtimeProfileId).toBe('openclaw.default');
    } finally { rmTmpDir(tmp); }
  });
});

// ── No secret output ─────────────────────────────────────────────────────────

describe('No secret output', () => {
  it('redacted summary never contains raw API key values', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const json = JSON.stringify(summary);
      expect(json).not.toContain('sk-ant-');
      expect(json).not.toContain('sk-');
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"baseUrl"');
      expect(json).not.toContain('"gatewayToken"');
    } finally { rmTmpDir(tmp); }
  });

  it('load result itself never contains secret values', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const json = JSON.stringify(result);
      // apiKeyEnv is a field name, not a value — the value would be like "sk-ant-..."
      expect(json).not.toMatch(/sk-ant-[a-zA-Z0-9]{8,}/);
    } finally { rmTmpDir(tmp); }
  });
});

// ── Feature flags from config ────────────────────────────────────────────────

describe('Feature flags from config', () => {
  it('computeFlagsFromLoadResult returns MVP core channels enabled', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      const flags = computeFlagsFromLoadResult(result);
      expect(flags.enabledChannels).toContain('prompt');
      expect(flags.enabledChannels).toContain('code_tool_hook');
      expect(flags.enabledChannels).toContain('defer_archive');
    } finally { rmTmpDir(tmp); }
  });

  it('computeFlagsFromLoadResult works with malformed config (uses defaults)', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = loadPdConfig(tmp);
      const flags = computeFlagsFromLoadResult(result);
      expect(flags.enabledChannels).toContain('prompt');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Legacy file detection ────────────────────────────────────────────────────

describe('Legacy file detection', () => {
  it('detects .pd/feature-flags.yaml', () => {
    const tmp = mkTmpDir();
    const pdDir = path.join(tmp, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'feature-flags.yaml'), 'prompt:\n  enabled: true\n', 'utf8');
    try {
      const result = loadPdConfig(tmp);
      expect(result.legacyFilesDetected.length).toBeGreaterThan(0);
      expect(result.legacyFilesDetected[0]).toContain('feature-flags.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('detects .state/workflows.yaml', () => {
    const tmp = mkTmpDir();
    const stateDir = path.join(tmp, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), 'version: 1\n', 'utf8');
    try {
      const result = loadPdConfig(tmp);
      expect(result.legacyFilesDetected.length).toBeGreaterThan(0);
      expect(result.legacyFilesDetected[0]).toContain('workflows.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('includes legacy warning when legacy files detected', () => {
    const tmp = mkTmpDir();
    const pdDir = path.join(tmp, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'feature-flags.yaml'), 'prompt:\n  enabled: true\n', 'utf8');
    try {
      const result = loadPdConfig(tmp);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.warnings.some(w => w.includes('Legacy config files detected'))).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('PRI-404: includes legacyFileNextActions with rm command when legacy files detected', () => {
    const tmp = mkTmpDir();
    const stateDir = path.join(tmp, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), 'version: 1\n', 'utf8');
    try {
      const result = loadPdConfig(tmp);
      expect(result.legacyFileNextActions.length).toBeGreaterThan(0);
      expect(result.legacyFileNextActions[0]).toContain('rm ');
      expect(result.legacyFileNextActions[0]).toContain('workflows.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('PRI-404: legacyFileNextActions is empty when no legacy files', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      expect(result.legacyFileNextActions).toEqual([]);
    } finally { rmTmpDir(tmp); }
  });
});

// ── JSON purity ──────────────────────────────────────────────────────────────

describe('JSON purity', () => {
  it('redacted summary is a single parseable JSON object', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const result = loadPdConfig(tmp);
      const summary = redactLoadResult(result);
      const json = JSON.stringify(summary, null, 2);
      const parsed = JSON.parse(json);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    } finally { rmTmpDir(tmp); }
  });

  it('feature flags result is a single parseable JSON object', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfig(tmp);
      const flags = computeFlagsFromLoadResult(result);
      const json = JSON.stringify(flags, null, 2);
      const parsed = JSON.parse(json);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    } finally { rmTmpDir(tmp); }
  });
});
