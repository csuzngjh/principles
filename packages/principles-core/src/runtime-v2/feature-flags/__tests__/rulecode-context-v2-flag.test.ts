import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURE_FLAGS,
  computeEffectiveFlags,
  type FeatureFlagDefinition,
} from '../feature-flag-contract.js';
import {
  getDefaultPdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
} from '../../config/index.js';

const FLAG_ID = 'rulecode_context_v2';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === FLAG_ID);
  if (!flag) {
    throw new Error(`${FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`);
  }
  return flag;
}

describe('rulecode_context_v2 flag registration (PRI-479)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => {
    expect(findFlag()).toBeDefined();
  });

  it('has category "quiet" (not core — must not expand MVP-Core default-on set)', () => {
    expect(findFlag().category).toBe('quiet');
  });

  it('defaults to enabled=false (default off)', () => {
    expect(findFlag().enabled).toBe(false);
  });

  it('has since field matching YYYY-MM-DD', () => {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(findFlag().since)).toBe(true);
  });

  it('has since === 2026-06-27 (spec approval date)', () => {
    expect(findFlag().since).toBe('2026-06-27');
  });

  it('description references PRI-479 or rulecode context v2', () => {
    const desc = findFlag().description ?? '';
    expect(
      desc.includes('PRI-479') || desc.toLowerCase().includes('rulecode context v2'),
    ).toBe(true);
  });

  it('is disabled by default at the contract layer with no overrides', () => {
    const r = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[FLAG_ID]?.enabled).toBe(false);
  });

  it('can be explicitly enabled at the contract layer', () => {
    const r = computeEffectiveFlags(
      { [FLAG_ID]: { enabled: true } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/feature-flags.yaml',
    );
    expect(r.flags[FLAG_ID]?.enabled).toBe(true);
  });

  it('stays off when explicitly disabled at the contract layer', () => {
    const r = computeEffectiveFlags(
      { [FLAG_ID]: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/feature-flags.yaml',
    );
    expect(r.flags[FLAG_ID]?.enabled).toBe(false);
  });
});

describe('rulecode_context_v2 flag propagation through PD config (PRI-479)', () => {
  it('is present in getDefaultPdConfig().features with quiet/false', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, FLAG_ID)).toBe(true);
    expect(defaults.features[FLAG_ID]).toEqual({ category: 'quiet', enabled: false });
  });

  it('is disabled by default when computing feature flags from a null config', () => {
    const effective = computeEffectivePdConfig(null);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
    expect(result.flags[FLAG_ID]?.category).toBe('quiet');
  });

  it('can be enabled via PD config override (config.features.rulecode_context_v2.enabled = true)', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
    expect(
      result.warnings.some(w => w.includes(FLAG_ID) && w.includes('unknown flag')),
      'flag must be registered (no "unknown flag" warning)',
    ).toBe(false);
  });

  it('stays disabled when config override explicitly sets enabled=false', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: false };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
    expect(
      result.warnings.some(w => w.includes(FLAG_ID) && w.includes('unknown flag')),
      'flag must be registered (no "unknown flag" warning)',
    ).toBe(false);
  });
});
