/**
 * pd-config-loader (plugin) tests — PRI-307
 *
 * Covers:
 *   - Observer disabled → no start, no noisy logs
 *   - Observer enabled + missing setup → needs_setup + nextAction
 *   - Observer enabled + configured → ready
 *   - No secret output in any result
 *   - Feature flag loading from .pd/config.yaml
 *   - Missing config → defaults
 *   - Malformed config → fail loud
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  loadPdConfigForPlugin,
  loadFeatureFlagFromConfig,
  resolveObserverConfig,
  getPdConfigPath,
  type ObserverConfigResult,
} from '../../src/core/pd-config-loader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-plugin-config-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, content: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), content, 'utf8');
}

function makeValidConfigWithObserverEnabled(): string {
  return yaml.dump({
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: true },
      empathy_observer: { category: 'quiet', enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000 },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: true, runtimeProfile: 'pd.anthropic-sonnet' },
        empathyObserver: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  });
}

function makeValidConfigWithObserverDisabled(): string {
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
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
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

// ── Observer disabled ────────────────────────────────────────────────────────

describe('Observer disabled', () => {
  it('returns readiness=disabled when feature flag is off', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigWithObserverDisabled());
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(false);
      expect(result.readiness).toBe('disabled');
      expect(result.reason).toContain('disabled');
      expect(result.nextAction).toContain('.pd/config.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('returns readiness=disabled when config is missing (defaults)', () => {
    const tmp = mkTmpDir();
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(false);
      expect(result.readiness).toBe('disabled');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Observer enabled + missing setup → needs_setup ──────────────────────────

describe('Observer needs_setup', () => {
  it('returns readiness=needs_setup when API key env is not set', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigWithObserverEnabled());
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(true);
      expect(result.readiness).toBe('needs_setup');
      expect(result.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(result.apiKeyPresent).toBe(false);
      expect(result.nextAction).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      rmTmpDir(tmp);
    }
  });

  it('returns readiness=needs_setup when runtime profile is not found', () => {
    const tmp = mkTmpDir();
    const config = yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        correction_observer: { category: 'quiet', enabled: true },
        empathy_observer: { category: 'quiet', enabled: false },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true },
          dreamer: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true },
          philosopher: { enabled: false },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: true, runtimeProfile: 'nonexistent.profile' },
          empathyObserver: { enabled: false },
        },
      },
    });
    writeConfig(tmp, config);
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(true);
      expect(result.readiness).toBe('needs_setup');
      expect(result.reason).toContain('not found');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Observer ready ───────────────────────────────────────────────────────────

describe('Observer ready', () => {
  it('returns readiness=not_ready when pi-ai profile has API key set', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigWithObserverEnabled());
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(true);
      expect(result.readiness).toBe('not_ready');
      expect(result.apiKeyPresent).toBe(true);
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-3-5-sonnet');
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      else delete process.env.ANTHROPIC_API_KEY;
      rmTmpDir(tmp);
    }
  });

  it('returns readiness=needs_setup for OpenClaw profile (not supported for observers)', () => {
    const tmp = mkTmpDir();
    const config = yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        correction_observer: { category: 'quiet', enabled: true },
        empathy_observer: { category: 'quiet', enabled: false },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true },
          dreamer: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true },
          philosopher: { enabled: false },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: true },
          empathyObserver: { enabled: false },
        },
      },
    });
    writeConfig(tmp, config);
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(true);
      expect(result.readiness).toBe('needs_setup');
      expect(result.runtimeProfileType).toBe('openclaw');
      expect(result.reason).toContain('not supported');
      expect(result.nextAction).toContain('pi-ai');
    } finally { rmTmpDir(tmp); }
  });
});

// ── No secret output ─────────────────────────────────────────────────────────

describe('No secret output', () => {
  it('observer config result never contains API key values', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigWithObserverEnabled());
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      const json = JSON.stringify(result);
      expect(json).not.toContain('sk-ant-test-key');
      expect(json).not.toContain('sk-ant-');
      expect(json).not.toMatch(/"apiKey"\s*:/);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      else delete process.env.ANTHROPIC_API_KEY;
      rmTmpDir(tmp);
    }
  });
});

// ── Feature flag loading ─────────────────────────────────────────────────────

describe('Feature flag loading from .pd/config.yaml', () => {
  it('loadFeatureFlagFromConfig returns enabled for MVP core flags', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadFeatureFlagFromConfig(tmp, 'prompt');
      expect(result.enabled).toBe(true);
      expect(result.source).toBe('defaults');
    } finally { rmTmpDir(tmp); }
  });

  it('loadFeatureFlagFromConfig returns disabled for quiet flags by default', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadFeatureFlagFromConfig(tmp, 'evolution_worker');
      expect(result.enabled).toBe(false);
    } finally { rmTmpDir(tmp); }
  });

  it('loadFeatureFlagFromConfig reads from user config', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigWithObserverEnabled());
    try {
      const result = loadFeatureFlagFromConfig(tmp, 'correction_observer');
      expect(result.enabled).toBe(true);
      expect(result.source).toBe('user_config');
    } finally { rmTmpDir(tmp); }
  });

  it('honors explicit abstraction_layer_v1=false as the OpenClaw legacy rollback', () => {
    const tmp = mkTmpDir();
    const parsed = yaml.load(makeValidConfigWithObserverDisabled()) as Record<string, unknown>;
    const features = parsed.features as Record<string, unknown>;
    features.abstraction_layer_v1 = { category: 'quiet', enabled: false };
    writeConfig(tmp, yaml.dump(parsed));
    try {
      const result = loadFeatureFlagFromConfig(tmp, 'abstraction_layer_v1');
      expect(result).toEqual({ enabled: false, source: 'user_config' });
    } finally { rmTmpDir(tmp); }
  });
});

// ── Plugin config load ───────────────────────────────────────────────────────

describe('Plugin config load', () => {
  it('returns ok=true with defaults when config is missing', () => {
    const tmp = mkTmpDir();
    try {
      const result = loadPdConfigForPlugin(tmp);
      expect(result.ok).toBe(true);
      expect(result.source).toBe('defaults');
      expect(result.effective.config.version).toBe(1);
    } finally { rmTmpDir(tmp); }
  });

  it('returns ok=false with errors for malformed config', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = loadPdConfigForPlugin(tmp);
      expect(result.ok).toBe(false);
      expect(result.source).toBe('malformed');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.effective.config.version).toBe(1); // defaults still available
    } finally { rmTmpDir(tmp); }
  });
});

// ── Config malformed → fail loud ────────────────────────────────────────────

describe('Config malformed → fail loud', () => {
  it('returns readiness=config_malformed when config is invalid YAML', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(false);
      expect(result.readiness).toBe('config_malformed');
      expect(result.reason).toContain('Config validation failed');
      expect(result.nextAction).toBeTruthy();
      expect(result.configErrors).toBeDefined();
      expect(result.configErrors!.length).toBeGreaterThan(0);
    } finally { rmTmpDir(tmp); }
  });

  it('returns readiness=config_malformed for invalid version', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({ version: 99, features: {}, runtimeProfiles: {}, internalAgents: { defaultRuntime: 'x', agents: {} } }));
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.readiness).toBe('config_malformed');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Feature flag vs agent enabled mismatch ──────────────────────────────────

describe('Feature flag vs agent enabled mismatch', () => {
  it('returns readiness=disabled when feature flag is on but agent.enabled=false', () => {
    const tmp = mkTmpDir();
    const config = yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
        correction_observer: { category: 'quiet', enabled: true },  // feature flag ON
        empathy_observer: { category: 'quiet', enabled: false },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true },
          dreamer: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true },
          philosopher: { enabled: false },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: false },  // agent.enabled OFF
          empathyObserver: { enabled: false },
        },
      },
    });
    writeConfig(tmp, config);
    try {
      const result = resolveObserverConfig(tmp, 'correction_observer', 'correctionObserver');
      expect(result.enabled).toBe(false);
      expect(result.readiness).toBe('disabled');
      expect(result.reason).toContain('enabled is false');
      expect(result.nextAction).toContain('internalAgents.agents.correctionObserver.enabled=true');
    } finally { rmTmpDir(tmp); }
  });
});
