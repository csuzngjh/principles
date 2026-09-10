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
  resolveRuntimeConfigForAgent,
  AGENT_NAME_FOR_TASK_KIND,
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

// ── PRI-719: per-agent resolution (EP002-R2 F4) ──────────────────────────────

describe('resolveRuntimeConfigForAgent (PRI-719 per-agent binding)', () => {
  function makeTwoAgentConfig(): PdConfig {
    const base = getDefaultPdConfig();
    return {
      ...base,
      runtimeProfiles: {
        ...base.runtimeProfiles,
        'scribe-profile': {
          type: 'pi-ai',
          provider: 'prov-scribe',
          model: 'scribe-model',
          apiKeyEnv: 'SCRIBE_KEY',
        },
        'artificer-profile': {
          type: 'pi-ai',
          provider: 'prov-artificer',
          model: 'artificer-model',
          apiKeyEnv: 'ARTIFICER_KEY',
        },
      },
      internalAgents: {
        defaultRuntime: base.internalAgents.defaultRuntime,
        agents: {
          ...base.internalAgents.agents,
          scribe: { enabled: true, runtimeProfile: 'scribe-profile' },
          artificer: { enabled: true, runtimeProfile: 'artificer-profile' },
        },
      },
    };
  }

  const envWithBothKeys = (name: string) =>
    name === 'SCRIBE_KEY' || name === 'ARTIFICER_KEY' ? 'test-key' : undefined;

  it('two agents with different profiles resolve to their OWN provider/model', () => {
    const effective = computeEffectivePdConfig(makeTwoAgentConfig());

    const scribe = resolveRuntimeConfigForAgent(effective, 'scribe', { getEnvVar: envWithBothKeys });
    expect(isRuntimeConfigError(scribe)).toBe(false);
    if (isRuntimeConfigError(scribe)) return;
    expect(scribe.runtimeKind).toBe('pi-ai');
    expect(scribe.provider).toBe('prov-scribe');
    expect(scribe.model).toBe('scribe-model');
    expect(scribe.apiKeyEnv).toBe('SCRIBE_KEY');
    expect(scribe.runtimeProfileId).toBe('scribe-profile');

    const artificer = resolveRuntimeConfigForAgent(effective, 'artificer', { getEnvVar: envWithBothKeys });
    expect(isRuntimeConfigError(artificer)).toBe(false);
    if (isRuntimeConfigError(artificer)) return;
    expect(artificer.provider).toBe('prov-artificer');
    expect(artificer.model).toBe('artificer-model');
    expect(artificer.runtimeProfileId).toBe('artificer-profile');
  });

  it('agent without an explicit binding falls back to defaultRuntime', () => {
    const base = getDefaultPdConfig();
    // Point defaultRuntime at an env-free openclaw profile; evaluator has no
    // per-agent override → resolves the DEFAULT binding.
    const config: PdConfig = {
      ...base,
      runtimeProfiles: {
        ...base.runtimeProfiles,
        'env-free-openclaw': { type: 'openclaw', provider: 'x', model: 'y' },
      },
      internalAgents: {
        defaultRuntime: 'env-free-openclaw',
        agents: {
          ...base.internalAgents.agents,
          // The default config ships evaluator disabled — enable it so the
          // fallback path (no per-agent runtimeProfile) is reachable.
          evaluator: { enabled: true },
        },
      },
    };
    const effective = computeEffectivePdConfig(config);
    const result = resolveRuntimeConfigForAgent(effective, 'evaluator', { getEnvVar: envWithoutKey });
    expect(isRuntimeConfigError(result)).toBe(false);
    if (isRuntimeConfigError(result)) return;
    expect(result.runtimeKind).toBe('openclaw-cli');
    expect(result.runtimeProfileId).toBe('env-free-openclaw');
  });

  it('per-agent readiness failure is observable and does not leak other agents', () => {
    const effective = computeEffectivePdConfig(makeTwoAgentConfig());
    // SCIBE_KEY unset → scribe not ready; artificer (key set) stays ready.
    const scribe = resolveRuntimeConfigForAgent(effective, 'scribe', { getEnvVar: (name) =>
      name === 'ARTIFICER_KEY' ? 'test-key' : undefined });
    expect(isRuntimeConfigError(scribe)).toBe(true);
    if (!isRuntimeConfigError(scribe)) return;
    expect(scribe.reason).toBe('not_ready');
    expect(scribe.message).toContain('SCRIBE_KEY');

    const artificer = resolveRuntimeConfigForAgent(effective, 'artificer', { getEnvVar: (name) =>
      name === 'ARTIFICER_KEY' ? 'test-key' : undefined });
    expect(isRuntimeConfigError(artificer)).toBe(false);
  });

  it('the diagnostician wrapper equals the per-agent call for diagnostician', () => {
    const effective = computeEffectivePdConfig(makeConfigWithPdLocalProfile());
    const viaWrapper = resolveRuntimeConfigFromPdConfig(effective, envWithAnthropicKey);
    const viaAgent = resolveRuntimeConfigForAgent(effective, 'diagnostician', { getEnvVar: envWithAnthropicKey });
    expect(viaWrapper).toEqual(viaAgent);
  });

  it('AGENT_NAME_FOR_TASK_KIND maps the consumer runner kinds (incl. camelCase rolloutReviewer)', () => {
    expect(AGENT_NAME_FOR_TASK_KIND['dreamer']).toBe('dreamer');
    expect(AGENT_NAME_FOR_TASK_KIND['scribe']).toBe('scribe');
    expect(AGENT_NAME_FOR_TASK_KIND['rollout_reviewer']).toBe('rolloutReviewer');
    // Diagnostic stages are owned by the pain-signal bridge, not the map.
    expect(AGENT_NAME_FOR_TASK_KIND['diag_router']).toBeUndefined();
    expect(AGENT_NAME_FOR_TASK_KIND['diagnostician']).toBeUndefined();
  });
});
