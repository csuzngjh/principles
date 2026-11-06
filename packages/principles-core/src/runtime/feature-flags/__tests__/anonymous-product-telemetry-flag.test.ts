import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURE_FLAGS, computeEffectiveFlags, type FeatureFlagDefinition } from '../feature-flag-contract.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../../config/pd-config-feature-flags.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';

const FLAG_ID = 'anonymous_product_telemetry';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === FLAG_ID);
  if (!flag) { throw new Error(`${FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`); }
  return flag;
}

function effectiveConfigWithFeatures(features: Record<string, unknown>): EffectivePdConfig {
  return { config: { features } } as unknown as EffectivePdConfig;
}

describe('anonymous_product_telemetry flag registration (Anonymous Product Telemetry v1, PRI-595~603)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => { expect(findFlag()).toBeDefined(); });
  it('has category "quiet" (MVP-Quiet per ADR-0014 — unsolicited new code defaults off)', () => {
    expect(findFlag().category).toBe('quiet');
  });
  it('defaults to enabled=false (telemetry ships OFF; export additionally requires explicit consent)', () => {
    expect(findFlag().enabled).toBe(false);
  });
  it('has since field matching YYYY-MM-DD', () => { expect(/^\d{4}-\d{2}-\d{2}$/.test(findFlag().since)).toBe(true); });

  it('is disabled by default with no overrides (contract loader)', () => {
    const r = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(r.flags[FLAG_ID]?.enabled).toBe(false);
  });

  // Production loader path — the resolution host-runtime's
  // loadFeatureFlagFromConfig uses. Registration only counts when the
  // production loader exercises it.
  it('is disabled by default through the production loader (computeFeatureFlagsFromConfig)', () => {
    const r = computeFeatureFlagsFromConfig(effectiveConfigWithFeatures({}));
    expect(isFeatureEnabled(r, FLAG_ID)).toBe(false);
  });

  it('can be enabled via workspace config through the production loader (graduation/opt-in path)', () => {
    const r = computeFeatureFlagsFromConfig(effectiveConfigWithFeatures({
      [FLAG_ID]: { category: 'quiet', enabled: true },
    }));
    expect(isFeatureEnabled(r, FLAG_ID)).toBe(true);
  });

  it('can be explicitly disabled via config (single-flag rollback path)', () => {
    const r = computeFeatureFlagsFromConfig(effectiveConfigWithFeatures({
      [FLAG_ID]: { category: 'quiet', enabled: false },
    }));
    expect(isFeatureEnabled(r, FLAG_ID)).toBe(false);
  });
});
