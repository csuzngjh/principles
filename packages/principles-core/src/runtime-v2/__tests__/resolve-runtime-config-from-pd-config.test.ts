/**
 * resolveRuntimeConfigFromPdConfig Integration Tests — PRI-306
 *
 * Tests the full config-driven runtime resolution path through
 * the pain-signal-runtime-factory, covering the integration of:
 *   resolveAgentRuntimeBinding → checkAgentRuntimeReadiness → createAdapterConfigFromProfile
 *
 * These tests verify the factory-level integration without requiring
 * a real workspace or database.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
} from '../pain-signal-runtime-factory.js';
import {
  computeEffectivePdConfig,
  getDefaultPdConfig,
  type PdConfig,
} from '../config/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfigWithPdLocalProfile(): PdConfig {
  const base = getDefaultPdConfig();
  return {
    ...base,
    runtimeProfiles: {
      ...base.runtimeProfiles,
      'anthropic-claude': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
    },
    internalAgents: {
      defaultRuntime: base.internalAgents.defaultRuntime,
      agents: {
        ...base.internalAgents.agents,
        diagnostician: { enabled: true, runtimeProfile: 'anthropic-claude' },
      },
    },
  };
}

function makeConfigWithOpenClawProfile(): PdConfig {
  const base = getDefaultPdConfig();
  return {
    ...base,
    runtimeProfiles: {
      ...base.runtimeProfiles,
      'lmstudio-local': {
        type: 'openclaw',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
      },
    },
    internalAgents: {
      defaultRuntime: base.internalAgents.defaultRuntime,
      agents: {
        ...base.internalAgents.agents,
        diagnostician: { enabled: true, runtimeProfile: 'lmstudio-local' },
      },
    },
  };
}

const envWithAnthropicKey = (name: string) =>
  name === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-key' : undefined;

const envWithoutKey = (_name: string) => undefined;

// ── resolveRuntimeConfigFromPdConfig ─────────────────────────────────────────

describe('resolveRuntimeConfigFromPdConfig', () => {
  it('AC1: resolves OpenClaw model reference for diagnostician', () => {
    const config = makeConfigWithOpenClawProfile();
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithoutKey);

    expect(isRuntimeConfigError(result)).toBe(false);
    if (isRuntimeConfigError(result)) return;
    expect(result.runtimeKind).toBe('openclaw-cli');
  });

  it('AC2: resolves PD-local profile with apiKeyEnv for diagnostician', () => {
    const config = makeConfigWithPdLocalProfile();
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithAnthropicKey);

    expect(isRuntimeConfigError(result)).toBe(false);
    if (isRuntimeConfigError(result)) return;
    expect(result.runtimeKind).toBe('pi-ai');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
  });

  it('AC3: per-agent override beats default runtime', () => {
    const config = makeConfigWithPdLocalProfile();
    const effective = computeEffectivePdConfig(config);

    // diagnostician has override → pi-ai
    const diagResult = resolveRuntimeConfigFromPdConfig(effective, envWithAnthropicKey);
    expect(isRuntimeConfigError(diagResult)).toBe(false);
    if (isRuntimeConfigError(diagResult)) return;
    expect(diagResult.runtimeKind).toBe('pi-ai');

    // default (no override) → openclaw.default (MVP default runtime), resolves successfully
    const defaultEffective = computeEffectivePdConfig(null);
    const defaultResult = resolveRuntimeConfigFromPdConfig(defaultEffective, envWithoutKey);
    expect(isRuntimeConfigError(defaultResult)).toBe(false);
    if (isRuntimeConfigError(defaultResult)) return;
    expect(defaultResult.runtimeKind).toBe('openclaw-cli');
  });

  it('AC4: missing env var fails loud with reason + nextAction', () => {
    const config = makeConfigWithPdLocalProfile();
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithoutKey);

    expect(isRuntimeConfigError(result)).toBe(true);
    if (!isRuntimeConfigError(result)) return;
    expect(result.reason).toBe('not_ready');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
    expect(result.nextAction).toBeTruthy();
  });

  it('AC5: null config defaults to openclaw runtime, resolves successfully without env var', () => {
    const effective = computeEffectivePdConfig(null);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithoutKey);

    expect(isRuntimeConfigError(result)).toBe(false);
    if (isRuntimeConfigError(result)) return;
    expect(result.runtimeKind).toBe('openclaw-cli');
  });

  it('returns error for disabled agent', () => {
    const base = getDefaultPdConfig();
    const config: PdConfig = {
      ...base,
      internalAgents: {
        defaultRuntime: base.internalAgents.defaultRuntime,
        agents: {
          ...base.internalAgents.agents,
          diagnostician: { enabled: false },
        },
      },
    };
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithoutKey);

    expect(isRuntimeConfigError(result)).toBe(true);
    if (!isRuntimeConfigError(result)) return;
    expect(result.reason).toBe('disabled');
  });

  it('returns error for missing profile reference', () => {
    const base = getDefaultPdConfig();
    // Set diagnostician to use a nonexistent profile via override
    const config: PdConfig = {
      ...base,
      internalAgents: {
        defaultRuntime: base.internalAgents.defaultRuntime,
        agents: {
          ...base.internalAgents.agents,
          diagnostician: { enabled: true, runtimeProfile: 'nonexistent-profile' },
        },
      },
    };
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(effective, envWithoutKey);

    expect(isRuntimeConfigError(result)).toBe(true);
    if (!isRuntimeConfigError(result)) return;
    expect(result.reason).toBe('needs_setup');
    expect(result.message).toContain('nonexistent-profile');
  });

  it('pi-ai profile with baseUrl passes through to result', () => {
    const base = getDefaultPdConfig();
    const config: PdConfig = {
      ...base,
      runtimeProfiles: {
        ...base.runtimeProfiles,
        'custom-endpoint': {
          type: 'pi-ai',
          provider: 'openrouter',
          model: 'openai/gpt-4o',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          timeoutMs: 60_000,
        },
      },
      internalAgents: {
        defaultRuntime: base.internalAgents.defaultRuntime,
        agents: {
          ...base.internalAgents.agents,
          diagnostician: { enabled: true, runtimeProfile: 'custom-endpoint' },
        },
      },
    };
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigFromPdConfig(
      effective,
      (name) => name === 'OPENROUTER_API_KEY' ? 'sk-or-test' : undefined,
    );

    expect(isRuntimeConfigError(result)).toBe(false);
    if (isRuntimeConfigError(result)) return;
    expect(result.runtimeKind).toBe('pi-ai');
    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.timeoutMs).toBe(60_000);
  });
});
