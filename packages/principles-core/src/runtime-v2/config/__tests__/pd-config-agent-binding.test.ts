/**
 * Agent Runtime Binding Resolution Tests — PRI-306
 *
 * TDD tests for:
 *   - resolveAgentRuntimeBinding() — which RuntimeProfile an agent uses
 *   - checkAgentRuntimeReadiness() — whether a profile is ready to run
 *   - createAdapterConfigFromProfile() — profile → adapter config transform
 *
 * Acceptance criteria coverage:
 *   AC1: Diagnostician runtime can be configured to use an OpenClaw model reference
 *   AC2: Diagnostician runtime can be configured to use a PD-local profile with apiKeyEnv
 *   AC3: Per-agent override beats default runtime
 *   AC4: Missing env var for PD-local profile fails loud with reason + nextAction
 *   AC5: Existing MVP pipeline still runs with defaults
 *   AC6: Tests cover diagnostician + at least one peer runner binding path
 */

import { describe, it, expect } from 'vitest';
import {
  computeEffectivePdConfig,
  getDefaultPdConfig,
  DEFAULT_RUNTIME_PROFILE_ID,
  type PdConfig,
} from '../index.js';
import {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
  createAdapterConfigFromProfile,
} from '../pd-config-agent-binding.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfigWithOverrides(overrides: Partial<PdConfig>): PdConfig {
  const base = getDefaultPdConfig();
  return { ...base, ...overrides };
}

function makeConfigWithPdLocalProfile(): PdConfig {
  return makeConfigWithOverrides({
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'anthropic-claude': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'anthropic-claude' },
        dreamer: { enabled: true },
        philosopher: { enabled: false },
        scribe: { enabled: true },
        artificer: { enabled: true },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        trainer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
  });
}

function makeConfigWithOpenClawProfile(): PdConfig {
  return makeConfigWithOverrides({
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'lmstudio-local': {
        type: 'openclaw',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
      },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'lmstudio-local' },
        dreamer: { enabled: true },
        philosopher: { enabled: false },
        scribe: { enabled: true },
        artificer: { enabled: true },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        trainer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
  });
}

// ── resolveAgentRuntimeBinding ───────────────────────────────────────────────

describe('resolveAgentRuntimeBinding', () => {
  it('AC5: returns default profile when no per-agent override (MVP defaults)', () => {
    const effective = computeEffectivePdConfig(null);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe(DEFAULT_RUNTIME_PROFILE_ID);
    expect(result.profile.type).toBe('openclaw');
    expect(result.source).toBe('default_runtime');
  });

  it('AC1: diagnostician uses OpenClaw model reference when configured', () => {
    const config = makeConfigWithOpenClawProfile();
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe('lmstudio-local');
    expect(result.profile.type).toBe('openclaw');
    if (result.profile.type === 'openclaw') {
      expect(result.profile.provider).toBe('lmstudio');
      expect(result.profile.model).toBe('qwen3.6-27b-mtp');
    }
    expect(result.source).toBe('agent_override');
  });

  it('AC2: diagnostician uses PD-local profile with apiKeyEnv when configured', () => {
    const config = makeConfigWithPdLocalProfile();
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe('anthropic-claude');
    expect(result.profile.type).toBe('pi-ai');
    if (result.profile.type === 'pi-ai') {
      expect(result.profile.provider).toBe('anthropic');
      expect(result.profile.model).toBe('claude-3-5-sonnet');
      expect(result.profile.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    }
    expect(result.source).toBe('agent_override');
  });

  it('AC3: per-agent override beats default runtime', () => {
    const config = makeConfigWithPdLocalProfile();
    const effective = computeEffectivePdConfig(config);

    // diagnostician has explicit override → uses anthropic-claude
    const diagResult = resolveAgentRuntimeBinding(effective, 'diagnostician');
    expect(diagResult.ok).toBe(true);
    if (!diagResult.ok) return;
    expect(diagResult.profileId).toBe('anthropic-claude');
    expect(diagResult.source).toBe('agent_override');

    // dreamer has no override → uses defaultRuntime (openclaw.default)
    const dreamerResult = resolveAgentRuntimeBinding(effective, 'dreamer');
    expect(dreamerResult.ok).toBe(true);
    if (!dreamerResult.ok) return;
    expect(dreamerResult.profileId).toBe('openclaw.default');
    expect(dreamerResult.source).toBe('default_runtime');
  });

  it('AC6: peer runner (dreamer) binding path works', () => {
    const config = makeConfigWithOverrides({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'dreamer-profile': {
          type: 'pi-ai',
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true },
          dreamer: { enabled: true, runtimeProfile: 'dreamer-profile' },
          philosopher: { enabled: false },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          trainer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
        },
      },
    });
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'dreamer');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe('dreamer-profile');
    expect(result.profile.type).toBe('pi-ai');
    if (result.profile.type === 'pi-ai') {
      expect(result.profile.provider).toBe('openrouter');
      expect(result.profile.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    }
    expect(result.source).toBe('agent_override');
  });

  it('returns error when profile ID references missing profile', () => {
    const config = makeConfigWithOverrides({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'nonexistent-profile' },
          dreamer: { enabled: true },
          philosopher: { enabled: false },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          trainer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
        },
      },
    });
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('nonexistent-profile');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns error for disabled agent', () => {
    const effective = computeEffectivePdConfig(null);
    const result = resolveAgentRuntimeBinding(effective, 'philosopher');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.readiness).toBe('disabled');
  });
});

// ── checkAgentRuntimeReadiness ───────────────────────────────────────────────

describe('checkAgentRuntimeReadiness', () => {
  it('returns ready for openclaw profile with source=default', () => {
    const result = checkAgentRuntimeReadiness(
      { type: 'openclaw', source: 'default' },
      () => undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('returns ready for openclaw profile with provider+model', () => {
    const result = checkAgentRuntimeReadiness(
      { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
      () => undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('returns needs_setup for openclaw profile without provider or model', () => {
    const result = checkAgentRuntimeReadiness(
      { type: 'openclaw' },
      () => undefined,
    );
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toBeTruthy();
    expect(result.nextAction).toBeTruthy();
  });

  it('AC4: returns not_ready for pi-ai profile when apiKeyEnv is missing from env', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'MISSING_API_KEY',
      },
      (name) => name === 'MISSING_API_KEY' ? undefined : 'some-value',
    );
    expect(result.readiness).toBe('not_ready');
    expect(result.reason).toContain('MISSING_API_KEY');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns ready for pi-ai profile when apiKeyEnv exists in env', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      (name) => name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('returns not_ready for pi-ai profile when apiKeyEnv is set but empty', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      (name) => name === 'ANTHROPIC_API_KEY' ? '' : undefined,
    );
    expect(result.readiness).toBe('not_ready');
    expect(result.reason).toContain('empty');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns needs_setup for pi-ai profile with empty provider', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: '',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      } as never, // intentionally malformed for test
      (name) => name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined,
    );
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('provider');
  });
});

// ── createAdapterConfigFromProfile ───────────────────────────────────────────

describe('createAdapterConfigFromProfile', () => {
  it('creates PiAiRuntimeAdapterConfig from pi-ai profile', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        baseUrl: 'https://custom-api.example.com',
        timeoutMs: 120_000,
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    expect(result.baseUrl).toBe('https://custom-api.example.com');
    expect(result.timeoutMs).toBe(120_000);
    expect(result.workspace).toBe('/workspace/test');
  });

  it('creates OpenClawCliRuntimeAdapter config from openclaw profile', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('openclaw-cli');
    if (result.runtimeKind !== 'openclaw-cli') return;
    expect(result.workspaceDir).toBe('/workspace/test');
  });

  it('creates openclaw config with source=default (delegated mode)', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
        source: 'default',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('openclaw-cli');
  });

  it('pi-ai profile without baseUrl still produces valid config', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'openrouter',
        model: 'openai/gpt-4o',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.provider).toBe('openrouter');
    expect(result.baseUrl).toBeUndefined();
  });
});
