import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURE_FLAGS, computeEffectiveFlags, type FeatureFlagDefinition } from '../feature-flag-contract.js';

const INTENT_FLAG_ID = 'intent_engineering';

function findIntentFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === INTENT_FLAG_ID);
  if (!flag) { throw new Error(`${INTENT_FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`); }
  return flag;
}

describe('intent_engineering flag registration (PRI-466)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => { expect(findIntentFlag()).toBeDefined(); });
  it('has category "quiet"', () => { expect(findIntentFlag().category).toBe('quiet'); });
  it('defaults to enabled=false', () => { expect(findIntentFlag().enabled).toBe(false); });
  it('has since field matching YYYY-MM-DD', () => { expect(/^\d{4}-\d{2}-\d{2}$/.test(findIntentFlag().since)).toBe(true); });
  it('description contains PRI-465', () => { expect((findIntentFlag().description ?? '').includes('PRI-465')).toBe(true); });
  it('is disabled by default with no overrides', () => {
    const r = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[INTENT_FLAG_ID]?.enabled).toBe(false);
  });
  it('can be explicitly enabled', () => {
    const r = computeEffectiveFlags({ [INTENT_FLAG_ID]: { enabled: true } }, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[INTENT_FLAG_ID]?.enabled).toBe(true);
  });
  it('stays off when explicitly disabled', () => {
    const r = computeEffectiveFlags({ [INTENT_FLAG_ID]: { enabled: false } }, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[INTENT_FLAG_ID]?.enabled).toBe(false);
  });
});