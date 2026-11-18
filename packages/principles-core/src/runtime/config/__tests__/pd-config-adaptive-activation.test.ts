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
        replaceableActivationIds: ['act-old-draft'],
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
      replaceableActivationIds: ['act-old-draft'],
    });
  });

  it('keeps timing absent when the Owner never chose one (existing = sync)', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation).not.toHaveProperty('timing');
  });

  it('carries an explicit background timing through validation', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        timing: 'background',
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation?.timing).toBe('background');
  });

  it('rejects an unknown timing value loudly', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        timing: 'later',
      },
    }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.errors.some((error) => error.path === 'adaptiveActivation.timing')).toBe(true);
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

  it('rejects invalid replacement permission lists', () => {
    for (const replaceableActivationIds of ['act', ['act', 'act'], [' act'], [''], [42]]) {
      const result = validatePdConfig(raw({
        adaptiveActivation: {
          endpoint: 'https://decisions.test/alpha/decisions', model: 'fixture-model', apiKeyEnv: 'FIXTURE_KEY',
          replaceableActivationIds,
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ path: 'adaptiveActivation.replaceableActivationIds' }));
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

describe('adaptiveActivation.sendPrincipleContext - Principle Context egress consent (SPEC v1.1 section 6/9.1)', () => {
  it('defaults to absent/false: an omitted key never authorizes egress', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const section = computeEffectivePdConfig(validated.value).config.adaptiveActivation;
    expect(section).not.toHaveProperty('sendPrincipleContext');
  });

  it('carries an explicit true through validation (round-trip preserves the boolean)', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        sendPrincipleContext: true,
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation?.sendPrincipleContext).toBe(true);
  });

  it('carries an explicit false through validation', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        sendPrincipleContext: false,
      },
    }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(computeEffectivePdConfig(validated.value).config.adaptiveActivation?.sendPrincipleContext).toBe(false);
  });

  it.each(['yes', 1, null, 'true', {}])('rejects non-boolean values loudly (%p)', (value) => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        sendPrincipleContext: value,
      },
    }));
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.errors.some((error) => error.path === 'adaptiveActivation.sendPrincipleContext')).toBe(true);
  });

  it('the key is part of the closed whitelist (no unknown-key error for it)', () => {
    const validated = validatePdConfig(raw({
      adaptiveActivation: {
        endpoint: 'https://decisions.example.test/v1/score',
        model: 'decision-model',
        apiKeyEnv: 'DECISION_KEY',
        sendPrincipleContext: true,
      },
    }));
    expect(validated.ok).toBe(true);
    if (validated.ok) return;
    expect(validated.errors).toHaveLength(0);
  });
});
