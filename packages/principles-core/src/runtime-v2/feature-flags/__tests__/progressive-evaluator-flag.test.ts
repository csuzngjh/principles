/**
 * Feature-flag registration test for Layer 2 `progressive_evaluator`
 * (design §8, task 9.11, ERR-024).
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §8
 */

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

const FLAG_ID = 'progressive_evaluator';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find((f) => f.id === FLAG_ID);
  if (!flag) throw new Error(`${FLAG_ID} must be registered`);
  return flag;
}

describe('progressive_evaluator flag registration (Layer 2 / PR 4)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => {
    expect(findFlag()).toBeDefined();
  });
  it('has category "quiet"', () => {
    expect(findFlag().category).toBe('quiet');
  });
  it('defaults to enabled=false', () => {
    expect(findFlag().enabled).toBe(false);
  });
  it('has since === 2026-07-26', () => {
    expect(findFlag().since).toBe('2026-07-26');
  });
  it('is disabled by default with no overrides', () => {
    const r = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[FLAG_ID]?.enabled).toBe(false);
  });
  it('can be enabled at the contract layer', () => {
    const r = computeEffectiveFlags({ [FLAG_ID]: { enabled: true } }, DEFAULT_FEATURE_FLAGS, '/test');
    expect(r.flags[FLAG_ID]?.enabled).toBe(true);
  });
});

describe('progressive_evaluator flag propagation through PD config', () => {
  it('is present in getDefaultPdConfig().features with quiet/false', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, FLAG_ID)).toBe(true);
    expect(defaults.features[FLAG_ID]).toEqual({ category: 'quiet', enabled: false });
  });
  it('is disabled by default from null config', () => {
    const result = computeFeatureFlagsFromConfig(computeEffectivePdConfig(null));
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
  });
  it('can be enabled via PD config override', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    const result = computeFeatureFlagsFromConfig(computeEffectivePdConfig(rawConfig));
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
  });
});
