/**
 * Config field dropout — no declared profile field may be silently dropped.
 *
 * Incident (2026-11-10): `validatePdLocalProfile` built its result from a
 * hand-maintained per-field whitelist. `systemPrompt` was declared on
 * `PdLocalRuntimeProfile` and consumed downstream
 * (`createAdapterConfigFromProfile` → adapter config), but was never copied by
 * the validator: a configured system prompt vanished on load with `ok: true`
 * and no warning. `InternalAgentBinding.splitPipelineTimeoutMs` is the same
 * class of ghost configuration — declared on the type, never read anywhere.
 *
 * Structural protection (two layers, deliberately different):
 *   1. Production: `PROFILE_FIELDS: Record<keyof PdLocalRuntimeProfile, true>`
 *      is a compile-time exhaustive table, and the validator self-checks
 *      "supplied field ⊆ validated result". Adding a field to the interface
 *      fails typechecking until the table is updated, and the runtime
 *      self-check then fails loud if the constructor forgets to copy it.
 *   2. This fixture uses `Required<PdLocalRuntimeProfile>`, so the same type
 *      change also forces this test to supply every field. The assertion below
 *      is therefore a runtime test for "forgot to copy", while the exhaustiveness
 *      itself is enforced by the TYPE SYSTEM, not by the test.
 */

import { describe, it, expect } from 'vitest';
import { validatePdConfig } from '../pd-config-validate.js';
import type { PdConfig, PdLocalRuntimeProfile } from '../pd-config-types.js';

function makeValidConfig(): PdConfig {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: true },
      gfi: { category: 'quiet', enabled: false },
      nocturnal: { category: 'gone', enabled: false },
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
        signalCollector: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
}

/** Adds a key the typed fixture cannot express (input that is unknown to the type). */
function withExtraKey<T extends object>(value: T, key: string, extra: unknown): T {
  return { ...value, [key]: extra };
}

/**
 * Every field of `PdLocalRuntimeProfile`, required by the type system.
 * A newly declared field makes this fixture fail to compile until it is added
 * here — which is what keeps the assertion below honest for future fields.
 */
const FULL_PD_PROFILE: Required<PdLocalRuntimeProfile> = {
  type: 'pi-ai',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrl: 'https://api.example.com/v1',
  timeoutMs: 30000,
  maxRetries: 2,
  maxTokens: 4096,
  reasoning: 'low',
  systemPrompt: 'You are a diagnostician.',
};

describe('config field dropout — PdLocalRuntimeProfile', () => {
  it('keeps every declared field; the exclusion set is empty today', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.full'] = FULL_PD_PROFILE;

    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const validated = result.value.runtimeProfiles['pd.full'];
    expect(validated).toBeDefined();
    for (const key of Object.keys(FULL_PD_PROFILE)) {
      expect(
        Object.hasOwn(validated as object, key),
        `profile field '${key}' was accepted by the validator but silently dropped from the result`,
      ).toBe(true);
    }
    expect(validated).toEqual(FULL_PD_PROFILE);
  });

  it('rejects an unknown profile key instead of silently ignoring it', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.typo'] = withExtraKey(
      { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      'systemPromt',
      'misspelled key',
    );

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path.endsWith('.systemPromt'))).toBe(true);
  });

  it('fails loud on a non-string systemPrompt', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.bad-prompt'] = withExtraKey(
      { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      'systemPrompt',
      42,
    );

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path.endsWith('.systemPrompt'))).toBe(true);
  });
});

describe('config field dropout — InternalAgentBinding', () => {
  it('rejects splitPipelineTimeoutMs, which never had a consumer', () => {
    const raw = makeValidConfig();
    raw.internalAgents.agents.diagnostician = withExtraKey(
      raw.internalAgents.agents.diagnostician,
      'splitPipelineTimeoutMs',
      60000,
    );

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path.endsWith('.splitPipelineTimeoutMs'))).toBe(true);
  });

  it('keeps enabled and runtimeProfile for a known binding', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.local'] = {
      type: 'pi-ai',
      provider: 'lmstudio',
      model: 'qwen3.6-27b-mtp',
      apiKeyEnv: 'LMSTUDIO_API_KEY',
    };
    raw.internalAgents.agents.diagnostician = { enabled: true, runtimeProfile: 'pd.local' };

    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.internalAgents.agents.diagnostician).toEqual({
      enabled: true,
      runtimeProfile: 'pd.local',
    });
  });
});
