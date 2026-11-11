/**
 * PD Config adaptiveActivation-section tests — PRI-1182.
 *
 * The Adaptive Activation decision endpoint is its own dedicated section, so
 * pin the contract that makes it safe to add:
 *   - absent ⇒ the section is undefined (Native path unchanged, no migration);
 *   - a valid section survives into the effective config;
 *   - provider is optional, everything else is required;
 *   - malformed input fails loud (rc-3) instead of silently disabling Adaptive
 *     with a config that looks configured.
 */
import { describe, it, expect } from 'vitest';
import { validatePdConfig, computeEffectivePdConfig } from '../index.js';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: { defaultRuntime: 'openclaw.default', agents: {} },
    ...overrides,
  };
}

describe('adaptiveActivation — dedicated Adaptive decision endpoint', () => {
  it('is absent by default and does not invent a section', () => {
    const validated = validatePdConfig(raw());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation).toBeUndefined();
  });

  it('carries a valid section through validation into the effective config', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        model: 'respan/span-01-lite:free',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        provider: 'Respan',
        responseModels: ['respan/span-01-lite:free', 'respan/span-01-lite-20260925'],
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation).toEqual({
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'respan/span-01-lite:free',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      provider: 'Respan',
      responseModels: ['respan/span-01-lite:free', 'respan/span-01-lite-20260925'],
    });
  });

  it('rejects an empty or non-string responseModels allowlist', () => {
    for (const responseModels of [[], ['ok', ''], 'model-id', [42]]) {
      const validated = validatePdConfig(raw({
        adaptiveActivation: {
          endpoint: 'https://decisions.example.test/v1/score',
          model: 'decision-model',
          apiKeyEnv: 'DECISION_KEY',
          responseModels,
        },
      }));
      expect(validated.ok).toBe(false);
      if (validated.ok) continue;
      expect(validated.errors.some((error) => error.path === 'adaptiveActivation.responseModels')).toBe(true);
    }
  });

  it('accepts a section without provider', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
      },
    }));
    expect(validated.ok).toBe(true);
  });

  it('rejects a non-https endpoint', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'http://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
      },
    }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.errors.some((error) => error.path === 'adaptiveActivation.endpoint')).toBe(true);
  });

  it('rejects unknown keys instead of ignoring ghost configuration', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        maxTokens: 512,
      },
    }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.errors.some((error) => error.path === 'adaptiveActivation.maxTokens')).toBe(true);
  });

  it('rejects a missing model and a missing apiKeyEnv', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: { endpoint: 'https://decisions.example.test/v1/score' },
    }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    const paths = validated.errors.map((error) => error.path);
    expect(paths).toContain('adaptiveActivation.model');
    expect(paths).toContain('adaptiveActivation.apiKeyEnv');
  });
});
