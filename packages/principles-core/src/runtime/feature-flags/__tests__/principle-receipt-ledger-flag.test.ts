import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagDefinition,
} from '../feature-flag-contract.js';
import {
  getDefaultPdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
} from '../../config/index.js';

const FLAG_ID = 'principle_receipt_ledger';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === FLAG_ID);
  if (!flag) {
    throw new Error(`${FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`);
  }
  return flag;
}

describe('principle_receipt_ledger flag registration (PRI-531)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => {
    expect(findFlag()).toBeDefined();
  });

  it('has category "quiet" (not core — must not expand MVP-Core default-on set)', () => {
    expect(findFlag().category).toBe('quiet');
  });

  it('defaults to enabled=true (graduated to default-on, PRI-571)', () => {
    expect(findFlag().enabled).toBe(true);
  });

  it('has since field matching YYYY-MM-DD', () => {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(findFlag().since)).toBe(true);
  });

  it('has a non-empty description', () => {
    expect(findFlag().description).toBeTruthy();
  });

  it('is enabled by default when computing feature flags from a null config (PRI-571 graduation)', () => {
    const effective = computeEffectivePdConfig(null);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
    expect(result.flags[FLAG_ID]?.category).toBe('quiet');
  });

  it('can be disabled via PD config override (config.features.principle_receipt_ledger.enabled = false)', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: false };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
  });
});
