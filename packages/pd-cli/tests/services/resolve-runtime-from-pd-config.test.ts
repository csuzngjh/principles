/**
 * Tests for resolve-runtime-from-pd-config.ts — PRI-393, PRI-402
 *
 * Covers:
 *   - buildProfileLabel: pi-ai and openclaw profile label formatting
 *   - resolveRuntimeFromPdConfig: successful config loading, malformed config, legacy warnings
 *   - resolveRuntimeWithOverrides: CLI flag overrides on top of config values
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { isRuntimeConfigError } from '@principles/core/runtime-v2';
import {
  resolveRuntimeFromPdConfig,
  resolveRuntimeWithOverrides,
} from '../../src/services/resolve-runtime-from-pd-config.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-resolve-runtime-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, content: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), content, 'utf8');
}

const mockEnvWithKeys = (name: string): string | undefined => {
  if (name === 'ANTHROPIC_API_KEY') return 'sk-ant-test-key';
  if (name === 'OPENROUTER_API_KEY') return 'sk-or-test-key';
  if (name === 'TEST_API_KEY') return 'sk-test-key';
  return undefined;
};

function makeValidOpenClawConfigYaml(workspaceDir: string): string {
  return yaml.dump({
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    workspace: {
      default: workspaceDir,
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'openclaw.model.lmstudio.qwen3': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.model.lmstudio.qwen3' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
      },
    },
  });
}

function makeValidPiAiConfigYaml(workspaceDir: string): string {
  return yaml.dump({
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    workspace: {
      default: workspaceDir,
    },
    runtimeProfiles: {
      'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000, maxRetries: 3 },
    },
    internalAgents: {
      defaultRuntime: 'pd.anthropic-sonnet',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'pd.anthropic-sonnet' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
      },
    },
  });
}

describe('buildProfileLabel', () => {
  it('formats pi-ai profile with provider and model', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'pi-ai.test': { type: 'pi-ai', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', apiKeyEnv: 'OPENROUTER_API_KEY' },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.test',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.test' },
        },
      },
    }));
    try {
      const result = resolveRuntimeFromPdConfig(tmp, mockEnvWithKeys);
      expect(result.runtimeProfileId).toBe('pi-ai.test');
      expect(result.runtimeProfileLabel).toBe('pi-ai: openrouter/anthropic/claude-sonnet-4');
    } finally { rmTmpDir(tmp); }
  });

  it('returns null profile info when pi-ai profile is missing required provider/model', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'pi-ai.missing': { type: 'pi-ai', apiKeyEnv: 'TEST_API_KEY' },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.missing',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.missing' },
        },
      },
    }));
    try {
      const result = resolveRuntimeFromPdConfig(tmp, mockEnvWithKeys);
      expect(result.runtimeProfileId).toBe(null);
      expect(result.runtimeProfileLabel).toBe(null);
    } finally { rmTmpDir(tmp); }
  });

  it('formats openclaw profile with provider and model', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'openclaw.model.lmstudio.qwen3': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.model.lmstudio.qwen3',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'openclaw.model.lmstudio.qwen3' },
        },
      },
    }));
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(result.runtimeProfileId).toBe('openclaw.model.lmstudio.qwen3');
      expect(result.runtimeProfileLabel).toBe('openclaw: lmstudio: qwen3.6-27b-mtp');
    } finally { rmTmpDir(tmp); }
  });

  it('formats openclaw profile with source when no provider/model', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        },
      },
    }));
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(result.runtimeProfileId).toBe('openclaw.default');
      expect(result.runtimeProfileLabel).toBe('openclaw: default');
    } finally { rmTmpDir(tmp); }
  });
});

describe('resolveRuntimeFromPdConfig', () => {
  it('returns resolved runtime config from valid openclaw config.yaml', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidOpenClawConfigYaml(tmp));
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(isRuntimeConfigError(result.result)).toBe(false);
      expect(result.configSource).toBe('.pd/config.yaml');
      expect(result.legacyWarnings).toEqual([]);
    } finally { rmTmpDir(tmp); }
  });

  it('returns resolved runtime config from valid pi-ai config.yaml with env vars', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
    try {
      const result = resolveRuntimeFromPdConfig(tmp, mockEnvWithKeys);
      expect(isRuntimeConfigError(result.result)).toBe(false);
      expect(result.configSource).toBe('.pd/config.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('returns legacy warnings when legacy files detected', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidOpenClawConfigYaml(tmp));
    const stateDir = path.join(tmp, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), 'version: 1\n', 'utf8');
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(result.legacyWarnings.length).toBeGreaterThan(0);
      expect(result.legacyWarnings[0]).toContain('Legacy config files detected');
      expect(result.legacyWarnings[0]).toContain('workflows.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('returns error result when config.yaml is malformed', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(isRuntimeConfigError(result.result)).toBe(true);
      if (!isRuntimeConfigError(result.result)) throw new Error('Expected RuntimeConfigError');
      expect(result.result.reason).toContain('config_malformed');
      expect(result.runtimeProfileId).toBe(null);
      expect(result.runtimeProfileLabel).toBe(null);
    } finally { rmTmpDir(tmp); }
  });

  it('returns error result when config.yaml validation fails', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({ version: 99, features: {}, runtimeProfiles: {}, internalAgents: { defaultRuntime: 'x', agents: {} } }));
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(isRuntimeConfigError(result.result)).toBe(true);
      if (!isRuntimeConfigError(result.result)) throw new Error('Expected RuntimeConfigError');
      expect(result.result.reason).toContain('config_malformed');
    } finally { rmTmpDir(tmp); }
  });

  it('returns defaults and profile info when config.yaml is missing', () => {
    const tmp = mkTmpDir();
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      // Default profile is openclaw.default (MVP default runtime) → resolves
      // successfully without env var.
      expect(isRuntimeConfigError(result.result)).toBe(false);
      expect(result.configSource).toBe('.pd/config.yaml');
      expect(result.runtimeProfileId).toBe('openclaw.default');
      expect(typeof result.runtimeProfileLabel).toBe('string');
    } finally { rmTmpDir(tmp); }
  });

  it('includes legacy warnings even when config is malformed', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    const stateDir = path.join(tmp, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), 'version: 1\n', 'utf8');
    try {
      const result = resolveRuntimeFromPdConfig(tmp);
      expect(isRuntimeConfigError(result.result)).toBe(true);
      expect(result.legacyWarnings.length).toBeGreaterThan(0);
    } finally { rmTmpDir(tmp); }
  });

  it('returns not_ready error when pi-ai config is valid but apiKeyEnv not set', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
    try {
      const result = resolveRuntimeFromPdConfig(tmp, () => undefined);
      expect(isRuntimeConfigError(result.result)).toBe(true);
      if (!isRuntimeConfigError(result.result)) throw new Error('Expected RuntimeConfigError');
      expect(result.result.reason).toBe('not_ready');
    } finally { rmTmpDir(tmp); }
  });
});

describe('resolveRuntimeWithOverrides', () => {
  it('returns merged config with CLI overrides applied', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
    try {
      const result = resolveRuntimeWithOverrides(tmp, {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      }, mockEnvWithKeys);
      expect(result.mergedConfig).not.toBeNull();
      if (!result.mergedConfig) throw new Error('Expected mergedConfig');
      expect(result.mergedConfig.provider).toBe('openrouter');
      expect(result.mergedConfig.model).toBe('anthropic/claude-sonnet-4');
      expect(result.mergedConfig.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    } finally { rmTmpDir(tmp); }
  });

  it('partial CLI overrides merge with config values', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'pi-ai.test': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000, maxRetries: 3 },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.test',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.test' },
        },
      },
    }));
    try {
      const result = resolveRuntimeWithOverrides(tmp, {
        model: 'claude-3-opus',
      }, mockEnvWithKeys);
      expect(result.mergedConfig).not.toBeNull();
      if (!result.mergedConfig) throw new Error('Expected mergedConfig');
      expect(result.mergedConfig.provider).toBe('anthropic');
      expect(result.mergedConfig.model).toBe('claude-3-opus');
      expect(result.mergedConfig.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(result.mergedConfig.timeoutMs).toBe(300000);
      expect(result.mergedConfig.maxRetries).toBe(3);
    } finally { rmTmpDir(tmp); }
  });

  it('returns mergedConfig as null when config resolution fails', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const result = resolveRuntimeWithOverrides(tmp, { provider: 'openrouter' });
      expect(isRuntimeConfigError(result.result)).toBe(true);
      expect(result.mergedConfig).toBe(null);
    } finally { rmTmpDir(tmp); }
  });

  it('merges maxRetries and timeoutMs with nullish coalescing', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'pi-ai.test': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000, maxRetries: 3 },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.test',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.test' },
        },
      },
    }));
    try {
      const result = resolveRuntimeWithOverrides(tmp, {
        maxRetries: 0,
        timeoutMs: 0,
      }, mockEnvWithKeys);
      expect(result.mergedConfig).not.toBeNull();
      if (!result.mergedConfig) throw new Error('Expected mergedConfig');
      expect(result.mergedConfig.maxRetries).toBe(0);
      expect(result.mergedConfig.timeoutMs).toBe(0);
    } finally { rmTmpDir(tmp); }
  });

  it('returns profile info from config even when CLI overrides are provided', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      workspace: { default: tmp },
      runtimeProfiles: {
        'pi-ai.test': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.test',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.test' },
        },
      },
    }));
    try {
      const result = resolveRuntimeWithOverrides(tmp, {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
      }, mockEnvWithKeys);
      expect(result.runtimeProfileId).toBe('pi-ai.test');
      expect(result.runtimeProfileLabel).toBe('pi-ai: anthropic/claude-3-5-sonnet');
    } finally { rmTmpDir(tmp); }
  });

  describe('empty-string normalization (PRI-402)', () => {
    it('normalizes empty-string provider override to undefined', () => {
      const tmp = mkTmpDir();
      writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
      try {
        const result = resolveRuntimeWithOverrides(tmp, { provider: '' }, mockEnvWithKeys);
        expect(result.mergedConfig).not.toBeNull();
        if (!result.mergedConfig) throw new Error('Expected mergedConfig');
        expect(result.mergedConfig.provider).toBe(undefined);
      } finally { rmTmpDir(tmp); }
    });

    it('normalizes empty-string model override to undefined', () => {
      const tmp = mkTmpDir();
      writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
      try {
        const result = resolveRuntimeWithOverrides(tmp, { model: '' }, mockEnvWithKeys);
        expect(result.mergedConfig).not.toBeNull();
        if (!result.mergedConfig) throw new Error('Expected mergedConfig');
        expect(result.mergedConfig.model).toBe(undefined);
      } finally { rmTmpDir(tmp); }
    });

    it('normalizes empty-string apiKeyEnv override to undefined', () => {
      const tmp = mkTmpDir();
      writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
      try {
        const result = resolveRuntimeWithOverrides(tmp, { apiKeyEnv: '' }, mockEnvWithKeys);
        expect(result.mergedConfig).not.toBeNull();
        if (!result.mergedConfig) throw new Error('Expected mergedConfig');
        expect(result.mergedConfig.apiKeyEnv).toBe(undefined);
      } finally { rmTmpDir(tmp); }
    });

    it('normalizes empty-string baseUrl override to undefined', () => {
      const tmp = mkTmpDir();
      writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
      try {
        const result = resolveRuntimeWithOverrides(tmp, { baseUrl: '' }, mockEnvWithKeys);
        expect(result.mergedConfig).not.toBeNull();
        if (!result.mergedConfig) throw new Error('Expected mergedConfig');
        expect(result.mergedConfig.baseUrl).toBe(undefined);
      } finally { rmTmpDir(tmp); }
    });

    it('preserves non-empty string values', () => {
      const tmp = mkTmpDir();
      writeConfig(tmp, makeValidPiAiConfigYaml(tmp));
      try {
        const result = resolveRuntimeWithOverrides(tmp, {}, mockEnvWithKeys);
        expect(result.mergedConfig).not.toBeNull();
        if (!result.mergedConfig) throw new Error('Expected mergedConfig');
        expect(result.mergedConfig.provider).toBe('anthropic');
        expect(result.mergedConfig.model).toBe('claude-3-5-sonnet');
        expect(result.mergedConfig.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      } finally { rmTmpDir(tmp); }
    });
  });
});