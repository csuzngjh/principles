/**
 * PD Config reuseEvaluation-section tests — PRI-917 v0.3.2 §8 (Phase 3C-2).
 *
 * The Semantic Reuse Evaluation Capability's DEDICATED config section. Pins:
 *   - a present, valid section survives validation into the effective config;
 *   - a LEGACY config without the section loads unchanged and resolves the
 *     defaults (zero migration — the property that lets 3C-3 ship without
 *     touching a single existing workspace);
 *   - runtimeProfile falls back to the user's internalAgents.defaultRuntime
 *     (not a hard-coded id), and a missing profile warns instead of silently
 *     running on a different LLM;
 *   - boundary validation: unknown keys, wrong types, non-positive timeoutMs
 *     all fail loud (rc-3) — a config key that looks valid while nothing
 *     reads it is how ghost configuration starts.
 *
 * The capability is ADVISORY ONLY (recommendations, never decisions): nothing
 * in this section can block Principle creation, which is why `enabled: false`
 * is a supported, non-destructive setting.
 */
import { describe, it, expect } from 'vitest';
import { validatePdConfig, computeEffectivePdConfig, DEFAULT_REUSE_EVALUATION } from '../index.js';
import type { PdConfig } from '../pd-config-types.js';

function makeValidRawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'pd.custom': { type: 'pi-ai', provider: 'x', model: 'y', apiKeyEnv: 'X_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pd.custom',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
      },
    },
    ...overrides,
  };
}

function effectiveOf(raw: Record<string, unknown>) {
  const validated = validatePdConfig(raw);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(`unexpected validation failure: ${JSON.stringify(validated.errors)}`);
  return computeEffectivePdConfig(validated.value);
}

describe('reuseEvaluation — reading a configured section', () => {
  it('survives validation and resolves the configured values', () => {
    const effective = effectiveOf(makeValidRawConfig({
      reuseEvaluation: { enabled: false, runtimeProfile: 'pd.custom', timeoutMs: 60000 },
    }));
    expect(effective.config.reuseEvaluation).toEqual({
      enabled: false,
      runtimeProfile: 'pd.custom',
      timeoutMs: 60000,
    });
  });

  it('reads a minimal section (enabled only) and resolves the profile fallback', () => {
    const effective = effectiveOf(makeValidRawConfig({ reuseEvaluation: { enabled: true } }));
    // runtimeProfile absent in user config → falls back to internalAgents.defaultRuntime.
    expect(effective.config.reuseEvaluation?.enabled).toBe(true);
    expect(effective.config.reuseEvaluation?.runtimeProfile).toBe('pd.custom');
    expect(effective.config.reuseEvaluation?.timeoutMs).toBeUndefined();
  });

  it('timeoutMs stays absent when unset (the resolved profile timeout applies)', () => {
    const effective = effectiveOf(makeValidRawConfig());
    expect(effective.config.reuseEvaluation?.timeoutMs).toBeUndefined();
  });
});

describe('reuseEvaluation — missing section uses defaults (zero migration)', () => {
  it('a LEGACY config (no reuseEvaluation key) loads unchanged with defaults applied', () => {
    // The exact shape a workspace written before this feature carries.
    const legacy = makeValidRawConfig();
    expect(Object.hasOwn(legacy, 'reuseEvaluation')).toBe(false);

    const effective = effectiveOf(legacy);
    expect(effective.config.reuseEvaluation).toEqual({
      enabled: true,
      runtimeProfile: 'pd.custom',
    });
  });

  it('default enabled=true matches the DEFAULT_REUSE_EVALUATION constant (single truth)', () => {
    expect(DEFAULT_REUSE_EVALUATION.enabled).toBe(true);
    const effective = effectiveOf(makeValidRawConfig());
    expect(effective.config.reuseEvaluation?.enabled).toBe(DEFAULT_REUSE_EVALUATION.enabled);
  });

  it('pure defaults (no user config at all) also carry the section', () => {
    const effective = computeEffectivePdConfig(null);
    expect(effective.config.reuseEvaluation?.enabled).toBe(true);
  });
});

describe('reuseEvaluation — profile fallback and warning', () => {
  it('falls back to the user defaultRuntime, not the hard-coded default', () => {
    const effective = effectiveOf(makeValidRawConfig({
      internalAgents: {
        defaultRuntime: 'pd.custom',
        agents: { diagnostician: { enabled: true } },
      },
    }));
    expect(effective.config.reuseEvaluation?.runtimeProfile).toBe('pd.custom');
  });

  it('warns (never silently substitutes) when the resolved profile is not configured', () => {
    const effective = effectiveOf(makeValidRawConfig({
      reuseEvaluation: { enabled: true, runtimeProfile: 'does.not.exist' },
    }));
    expect(effective.config.reuseEvaluation?.runtimeProfile).toBe('does.not.exist');
    expect(effective.warnings.some((w) => w.includes('reuseEvaluation') && w.includes('does.not.exist'))).toBe(true);
  });

  it('does NOT warn when the section is disabled (a disabled capability needs no profile)', () => {
    const effective = effectiveOf(makeValidRawConfig({
      reuseEvaluation: { enabled: false, runtimeProfile: 'does.not.exist' },
    }));
    expect(effective.warnings.some((w) => w.includes('reuseEvaluation'))).toBe(false);
  });
});

describe('reuseEvaluation — boundary validation (rc-3, fail loud)', () => {
  it('rejects an unknown key in the section', () => {
    const result = validatePdConfig(makeValidRawConfig({
      reuseEvaluation: { enabled: true, model: 'gpt-4' },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some((e) => e.path === 'reuseEvaluation.model')).toBe(true);
  });

  it('rejects a non-boolean enabled', () => {
    const result = validatePdConfig(makeValidRawConfig({ reuseEvaluation: { enabled: 'yes' } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some((e) => e.path === 'reuseEvaluation.enabled')).toBe(true);
  });

  it('rejects an empty or non-string runtimeProfile', () => {
    for (const runtimeProfile of ['', '   ', 42]) {
      const result = validatePdConfig(makeValidRawConfig({ reuseEvaluation: { enabled: true, runtimeProfile } }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.errors.some((e) => e.path === 'reuseEvaluation.runtimeProfile')).toBe(true);
    }
  });

  it('rejects non-positive or non-numeric timeoutMs', () => {
    for (const timeoutMs of [0, -1, '60000', null]) {
      const result = validatePdConfig(makeValidRawConfig({ reuseEvaluation: { enabled: true, timeoutMs } }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.errors.some((e) => e.path === 'reuseEvaluation.timeoutMs')).toBe(true);
    }
  });

  it('rejects a non-object section', () => {
    const result = validatePdConfig(makeValidRawConfig({ reuseEvaluation: 'enabled' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.some((e) => e.path === 'reuseEvaluation')).toBe(true);
  });

  it('is NOT a feature flag: it lives outside features and creates no flag entry', () => {
    const effective = effectiveOf(makeValidRawConfig({ reuseEvaluation: { enabled: false } }));
    // No capability registry, no features entry — a dedicated section only.
    expect(Object.hasOwn(effective.config.features, 'reuseEvaluation')).toBe(false);
    expect(Object.hasOwn(effective.config, 'capabilities')).toBe(false);
    const raw = makeValidRawConfig({ reuseEvaluation: { enabled: false } });
    expect(Object.hasOwn(raw.features as Record<string, unknown>, 'reuseEvaluation')).toBe(false);
  });

  it('the section is independent of agent registration (no reuseJudge agent)', () => {
    // SPEC v0.3.1: the capability is NOT an agent — INTERNAL_AGENT_NAMES and
    // AGENT_IDS stay untouched, so no agent-level wiring can drift in later.
    const effective = effectiveOf(makeValidRawConfig());
    const agentNames = Object.keys(effective.config.internalAgents.agents);
    expect(agentNames.some((n) => n.toLowerCase().includes('reuse'))).toBe(false);
  });

  it('a PdConfig built without the section still type-checks as valid config (optional field)', () => {
    const config: PdConfig = {
      version: 1,
      features: {},
      runtimeProfiles: {},
      internalAgents: { defaultRuntime: 'x', agents: {} as never },
      ui: { diagnostics: { mode: 'simple' } },
    };
    expect(config.reuseEvaluation).toBeUndefined();
  });
});
