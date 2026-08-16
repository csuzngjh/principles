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

const FLAG_ID = 'principle_receipt_block_copy';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === FLAG_ID);
  if (!flag) {
    throw new Error(`${FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`);
  }
  return flag;
}

describe('principle_receipt_block_copy flag registration (PRI-530)', () => {
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

  it('has a non-empty description', () => {
    expect(findFlag().description).toBeTruthy();
  });

  it('is disabled by default when computing feature flags from a null config', () => {
    const effective = computeEffectivePdConfig(null);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
    expect(result.flags[FLAG_ID]?.category).toBe('quiet');
  });

  it('can be enabled via PD config override (config.features.principle_receipt_block_copy.enabled = true)', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
  });
});
