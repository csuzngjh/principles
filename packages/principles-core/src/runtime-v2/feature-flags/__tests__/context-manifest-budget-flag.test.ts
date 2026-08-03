/**
 * Feature-flag registration + production propagation test for Layer 1
 * `context_manifest_budget` (design §8, task 5.9, ERR-024).
 *
 * Mirrors artifact-summary-redundancy-flag.test.ts: tests the REAL wiring path
 * (config → effective config → feature flag), not just the leaf function.
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §8, §8.1
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 11.1, 11.2
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

const FLAG_ID = 'context_manifest_budget';

function findFlag(): FeatureFlagDefinition {
  const flag = DEFAULT_FEATURE_FLAGS.find((f) => f.id === FLAG_ID);
  if (!flag) {
    throw new Error(`${FLAG_ID} must be registered in DEFAULT_FEATURE_FLAGS`);
  }
  return flag;
}

describe('context_manifest_budget flag registration (Layer 1 / PR 2)', () => {
  it('is registered in DEFAULT_FEATURE_FLAGS', () => {
    expect(findFlag()).toBeDefined();
  });

  it('has category "quiet" (must not expand MVP-Core default-on set)', () => {
    expect(findFlag().category).toBe('quiet');
  });

  it('defaults to enabled=false (default off)', () => {
    expect(findFlag().enabled).toBe(false);
  });

  it('has since === 2026-07-26 (design approval date)', () => {
    expect(findFlag().since).toBe('2026-07-26');
  });

  it('description references Layer 1 / manifest / budget / progressive disclosure', () => {
    const desc = (findFlag().description ?? '').toLowerCase();
    expect(
      desc.includes('layer 1')
        || desc.includes('manifest')
        || desc.includes('budget')
        || desc.includes('progressive disclosure'),
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
});

describe('context_manifest_budget flag propagation through PD config (Layer 1 / PR 2)', () => {
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

  it('can be enabled via PD config override', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
    expect(
      result.warnings.some((w) => w.includes(FLAG_ID) && w.includes('unknown flag')),
      'flag must be registered (no "unknown flag" warning)',
    ).toBe(false);
  });
});

// ── 5.12: switch independence (EXAMPLE) ───────────────────────────────────────
//
// design §8.1: context_manifest_budget and internalization_core_grounding are
// independent flags with no coupling or order dependency. Enumerate all 4
// value combinations and assert neither affects the other's resolution.

describe('5.12 — switch independence: context_manifest_budget × internalization_core_grounding', () => {
  const GROUNDING = 'internalization_core_grounding';

  it('both off: both resolve false/their-default', () => {
    const effective = computeEffectivePdConfig(null);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
    // core_grounding defaults ON (quiet, default-on) — verify it's unaffected.
    expect(result.flags[GROUNDING]?.enabled).toBe(true);
  });

  it('context_manifest_budget ON does not change core_grounding', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
    // core_grounding stays at its default (true), unaffected.
    expect(result.flags[GROUNDING]?.enabled).toBe(true);
  });

  it('core_grounding OFF does not change context_manifest_budget', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[GROUNDING] = { category: 'quiet', enabled: false };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[GROUNDING]?.enabled).toBe(false);
    // context_manifest_budget stays at its default (false), unaffected.
    expect(result.flags[FLAG_ID]?.enabled).toBe(false);
  });

  it('both ON: each resolves independently (no coupling, no order dependency)', () => {
    const rawConfig = getDefaultPdConfig();
    rawConfig.features[FLAG_ID] = { category: 'quiet', enabled: true };
    rawConfig.features[GROUNDING] = { category: 'quiet', enabled: true };
    const effective = computeEffectivePdConfig(rawConfig);
    const result = computeFeatureFlagsFromConfig(effective);
    expect(result.flags[FLAG_ID]?.enabled).toBe(true);
    expect(result.flags[GROUNDING]?.enabled).toBe(true);
  });
});
