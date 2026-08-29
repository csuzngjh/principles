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
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
        signalCollector: { enabled: false },
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
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
        signalCollector: { enabled: false },
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
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
          signalCollector: { enabled: false },
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
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
          signalCollector: { enabled: false },
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

  // ── Additional edge cases for runtimeProfile resolution ──────────────────────

  it('treats explicit override equal to defaultRuntime as default_runtime source', () => {
    // Edge case: when runtimeProfile === defaultRuntime, it's NOT an override
    const config = makeConfigWithOverrides({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'custom-profile': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
          dreamer: { enabled: true },
          philosopher: { enabled: false },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
          signalCollector: { enabled: false },
        },
      },
    });
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    // runtimeProfile === defaultRuntime → source='default_runtime', not 'agent_override'
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe('openclaw.default');
    expect(result.source).toBe('default_runtime');
  });

  it('returns error when defaultRuntime references missing profile', () => {
    // Edge case: defaultRuntime itself references a nonexistent profile
    const config = makeConfigWithOverrides({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'nonexistent-default',
        agents: {
          diagnostician: { enabled: true },
          dreamer: { enabled: true },
          philosopher: { enabled: false },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
          signalCollector: { enabled: false },
        },
      },
    });
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('nonexistent-default');
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
      // Empty provider is type-valid string but semantically invalid — tests runtime validation
      {
        type: 'pi-ai',
        provider: '',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      (name) => name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined,
    );
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('provider');
  });

  // ── Additional edge cases for readiness checking ──────────────────────────────

  it('returns needs_setup for pi-ai profile with empty model', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: '',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      (name) => name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined,
    );
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('model');
  });

  it('returns needs_setup for pi-ai profile with empty apiKeyEnv', () => {
    // Edge case: apiKeyEnv is empty string (type-valid but semantically invalid)
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: '',
      },
      () => 'some-value',
    );
    expect(result.readiness).toBe('needs_setup');
    expect(result.reason).toContain('apiKeyEnv');
  });

  it('returns ready for pi-ai profile with optional baseUrl', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'openrouter',
        model: 'openai/gpt-4o',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
      (name) => name === 'OPENROUTER_API_KEY' ? 'sk-or-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('returns ready for pi-ai profile with optional timeoutMs', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        timeoutMs: 60000,
      },
      (name) => name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('distinguishes unset vs empty apiKeyEnv correctly', () => {
    // Regression test for EP-01: empty string env var is set but invalid; undefined means not set
    // apiKeyEnv='EMPTY_VAR' with getEnvVar returning '' → not_ready (set but empty)
    const resultEmpty = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'EMPTY_VAR',
      },
      (name) => name === 'EMPTY_VAR' ? '' : undefined,
    );
    expect(resultEmpty.readiness).toBe('not_ready');
    expect(resultEmpty.reason).toContain('empty');

    // apiKeyEnv='UNSET_VAR' with getEnvVar returning undefined → not_ready (not set)
    const resultUnset = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'UNSET_VAR',
      },
      (name) => name === 'UNSET_VAR' ? undefined : 'some-value',
    );
    expect(resultUnset.readiness).toBe('not_ready');
    expect(resultUnset.reason).toContain('not set');
  });

  it('returns plain ready for deepseek without explicit maxTokens — heuristic hint retired (PRI-621)', () => {
    // The provider-name reasoning-model hint was removed with the heuristic
    // budget: without explicit maxTokens, pi-ai's native defaulting picks the
    // model's catalog ceiling, so no guidance is needed.
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      (name) => name === 'DEEPSEEK_API_KEY' ? 'sk-ds-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
    expect(result.reason).toBeUndefined();
  });

  it('returns plain ready for deepseek with explicit maxTokens', () => {
    // When maxTokens is explicitly configured, the value threads through to
    // the adapter unchanged and readiness stays a plain ready result.
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        maxTokens: 16000,
      },
      (name) => name === 'DEEPSEEK_API_KEY' ? 'sk-ds-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
    // Plain ready result has no reason field (guidance branch skipped).
    expect(result.reason).toBeUndefined();
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
    // Explicit provider+model → openclawMode='local' (not delegated)
    expect(result.openclawMode).toBe('local');
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
    if (result.runtimeKind !== 'openclaw-cli') return;
    // source='default' → openclawMode='default' (delegate to OpenClaw's own mode resolution)
    expect(result.openclawMode).toBe('default');
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

  it('TC4: pi-ai profile with systemPrompt passes it to adapter config', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        systemPrompt: 'You are a diagnostician.',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.systemPrompt).toBe('You are a diagnostician.');
  });

  it('TC5: pi-ai profile without systemPrompt omits it from adapter config', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.systemPrompt).toBeUndefined();
  });

  // ── Additional edge cases for adapter config creation ───────────────────────

  it('pi-ai profile without timeoutMs still produces valid config', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.timeoutMs).toBeUndefined();
  });

  it('openclaw profile with explicit provider+model uses local mode', () => {
    // Regression test: explicit provider+model → openclawMode='local' (not 'default')
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
    expect(result.openclawMode).toBe('local');
    expect(result.workspaceDir).toBe('/workspace/test');
  });

  it('openclaw profile with source=default uses default mode', () => {
    // Regression test: source='default' → openclawMode='default' (delegate to OpenClaw)
    const result = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
        source: 'default',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('openclaw-cli');
    if (result.runtimeKind !== 'openclaw-cli') return;
    expect(result.openclawMode).toBe('default');
  });

  it('openclaw profile without source or provider+model uses local mode', () => {
    // Edge case: incomplete openclaw profile defaults to 'local' mode
    const result = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('openclaw-cli');
    if (result.runtimeKind !== 'openclaw-cli') return;
    // No source='default', so defaults to 'local'
    expect(result.openclawMode).toBe('local');
  });

  it('openclaw profile with source=default ignores provider+model for mode', () => {
    // Edge case: source='default' wins over provider+model for mode selection
    const result = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
        source: 'default',
        provider: 'lmstudio',
        model: 'qwen3',
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('openclaw-cli');
    if (result.runtimeKind !== 'openclaw-cli') return;
    // source='default' → openclawMode='default' regardless of provider+model
    expect(result.openclawMode).toBe('default');
  });

  it('preserves workspace directory in all adapter configs', () => {
    const piAiResult = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
      '/custom/workspace/path',
    );

    expect(piAiResult.runtimeKind).toBe('pi-ai');
    if (piAiResult.runtimeKind !== 'pi-ai') return;
    expect(piAiResult.workspace).toBe('/custom/workspace/path');

    const openclawResult = createAdapterConfigFromProfile(
      {
        type: 'openclaw',
        source: 'default',
      },
      '/another/workspace/path',
    );

    expect(openclawResult.runtimeKind).toBe('openclaw-cli');
    if (openclawResult.runtimeKind !== 'openclaw-cli') return;
    expect(openclawResult.workspaceDir).toBe('/another/workspace/path');
  });

  // ── pi-ai.lmstudio profile resolution ─────────────────────────────────────

  it('pi-ai.lmstudio profile resolves to runtimeKind=pi-ai with baseUrl', () => {
    const result = createAdapterConfigFromProfile(
      {
        type: 'pi-ai',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        apiKeyEnv: 'LMSTUDIO_API_KEY',
        baseUrl: 'http://localhost:12341/v1',
        timeoutMs: 600_000,
      },
      '/workspace/test',
    );

    expect(result.runtimeKind).toBe('pi-ai');
    if (result.runtimeKind !== 'pi-ai') return;
    expect(result.provider).toBe('lmstudio');
    expect(result.model).toBe('qwen3.6-27b-mtp');
    expect(result.apiKeyEnv).toBe('LMSTUDIO_API_KEY');
    expect(result.baseUrl).toBe('http://localhost:12341/v1');
    expect(result.timeoutMs).toBe(600_000);
  });

  it('pi-ai.lmstudio readiness check with LMSTUDIO_API_KEY set', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        apiKeyEnv: 'LMSTUDIO_API_KEY',
        baseUrl: 'http://localhost:12341/v1',
        timeoutMs: 600_000,
      },
      (name) => name === 'LMSTUDIO_API_KEY' ? 'lm-test-key' : undefined,
    );
    expect(result.readiness).toBe('ready');
  });

  it('pi-ai.lmstudio readiness check with LMSTUDIO_API_KEY missing', () => {
    const result = checkAgentRuntimeReadiness(
      {
        type: 'pi-ai',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        apiKeyEnv: 'LMSTUDIO_API_KEY',
        baseUrl: 'http://localhost:12341/v1',
        timeoutMs: 600_000,
      },
      () => undefined,
    );
    expect(result.readiness).toBe('not_ready');
    expect(result.reason).toContain('LMSTUDIO_API_KEY');
    expect(result.nextAction).toBeTruthy();
  });

  it('diagnostician resolves to pi-ai.lmstudio when configured', () => {
    const config = makeConfigWithOverrides({
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'pi-ai.lmstudio': {
          type: 'pi-ai',
          provider: 'lmstudio',
          model: 'qwen3.6-27b-mtp',
          apiKeyEnv: 'LMSTUDIO_API_KEY',
          baseUrl: 'http://localhost:12341/v1',
          timeoutMs: 600_000,
        },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.lmstudio' },
          dreamer: { enabled: true },
          philosopher: { enabled: false },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: false },
          rolloutReviewer: { enabled: false },
          correctionObserver: { enabled: false },
          empathyObserver: { enabled: false },
          signalCollector: { enabled: false },
        },
      },
    });
    const effective = computeEffectivePdConfig(config);
    const result = resolveAgentRuntimeBinding(effective, 'diagnostician');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profileId).toBe('pi-ai.lmstudio');
    expect(result.profile.type).toBe('pi-ai');
    if (result.profile.type === 'pi-ai') {
      expect(result.profile.provider).toBe('lmstudio');
      expect(result.profile.model).toBe('qwen3.6-27b-mtp');
      expect(result.profile.baseUrl).toBe('http://localhost:12341/v1');
    }
    expect(result.source).toBe('agent_override');
  });
});
