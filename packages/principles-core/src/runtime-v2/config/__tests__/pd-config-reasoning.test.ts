/**
 * PRI-758: profile `reasoning` field plumbing tests.
 *
 * Always-thinking zai models (e.g. glm-5.3-flash) reject the
 * `thinking: {type: "disabled"}` request pi-ai sends when no reasoning level
 * is configured. These tests lock the config-surface plumbing that lets a
 * profile carry an explicit reasoning level through validation and the
 * adapter-config mapping.
 */
import { describe, it, expect } from 'vitest';
import { validatePdConfig } from '../pd-config-validate.js';
import { computeEffectivePdConfig, PD_CONFIG_VERSION } from '../index.js';
import { createAdapterConfigFromProfile } from '../pd-config-agent-binding.js';
import { isRuntimeConfigError, resolveRuntimeConfigForAgent } from '../../pain-signal-runtime-factory.js';

function makeRawConfigWithReasoning(reasoning: unknown): Record<string, unknown> {
  return {
    version: PD_CONFIG_VERSION,
    features: {},
    runtimeProfiles: {
      'zai-glm': {
        type: 'pi-ai',
        provider: 'zai',
        model: 'glm-5.3-flash',
        apiKeyEnv: 'ZAI_API_KEY',
        ...(reasoning !== undefined ? { reasoning } : {}),
      },
    },
    internalAgents: {
      defaultRuntime: 'zai-glm',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'zai-glm' },
        dreamer: { enabled: true },
        philosopher: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        evaluator: { enabled: true },
        rolloutReviewer: { enabled: true },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
        signalCollector: { enabled: false },
      },
    },
  };
}

describe('PRI-758: pi-ai profile reasoning plumbing', () => {
  it('validatePdConfig accepts reasoning level and preserves it on the profile', () => {
    const result = validatePdConfig(makeRawConfigWithReasoning('low'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const profile = result.value.runtimeProfiles['zai-glm'];
      expect(profile).toMatchObject({ reasoning: 'low' });
    }
  });

  it('validatePdConfig accepts reasoning=false (explicit disable on supporting models)', () => {
    const result = validatePdConfig(makeRawConfigWithReasoning(false));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.runtimeProfiles['zai-glm']).toMatchObject({ reasoning: false });
    }
  });

  it('validatePdConfig rejects an unknown reasoning level', () => {
    const result = validatePdConfig(makeRawConfigWithReasoning('bogus'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.endsWith('.reasoning'))).toBe(true);
    }
  });

  it('createAdapterConfigFromProfile carries reasoning into the adapter config', () => {
    const validated = validatePdConfig(makeRawConfigWithReasoning('low'));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const effective = computeEffectivePdConfig(validated.value);
    const profile = effective.config.runtimeProfiles['zai-glm'];
    if (!profile) throw new Error('expected zai-glm profile in effective config');
    const adapterConfig = createAdapterConfigFromProfile(profile, '/tmp/workspace');
    expect(adapterConfig.runtimeKind).toBe('pi-ai');
    if (adapterConfig.runtimeKind === 'pi-ai') {
      expect(adapterConfig.reasoning).toBe('low');
    }
  });

  it('resolveRuntimeConfigForAgent surfaces reasoning on the RuntimeConfig', () => {
    const validated = validatePdConfig(makeRawConfigWithReasoning('low'));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const effective = computeEffectivePdConfig(validated.value);
    const resolved = resolveRuntimeConfigForAgent(effective, 'diagnostician', {
      getEnvVar: (name) => (name === 'ZAI_API_KEY' ? 'test-key' : undefined),
    });
    expect(isRuntimeConfigError(resolved)).toBe(false);
    if (isRuntimeConfigError(resolved)) return;
    expect(resolved.runtimeKind).toBe('pi-ai');
    expect(resolved.reasoning).toBe('low');
  });
});
