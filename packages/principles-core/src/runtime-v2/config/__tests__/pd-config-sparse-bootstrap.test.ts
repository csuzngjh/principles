/**
 * PRI-645 — sparse bootstrap config contracts.
 *
 * Fresh configs (installer template, `pd runtime init`) now carry
 * `features: {}`; these tests lock the invariants that make that safe:
 *
 * 1. Effective parity — a sparse config resolves to EXACTLY the same
 *    effective flag map as the old dense default snapshot did.
 * 2. Category semantics — absence follows registry defaults for
 *    core/quiet-on/quiet-off/gone flags, and gone stays un-resurrectable.
 * 3. Registry authority — when the registry default flips, a sparse config
 *    follows the new default while an old-style default snapshot would pin
 *    the stale value (the hazard PRI-645 removes).
 * 4. Observation-window compatibility — the PRI-638 legacy
 *    diagnostician_split_pipeline=false cutover and the PRI-609 aliases keep
 *    working on existing configs regardless of bootstrap sparsification.
 */
import { describe, expect, it } from 'vitest';
import { computeEffectivePdConfig } from '../pd-config-effective.js';
import { getDefaultPdConfig } from '../pd-config-defaults.js';
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_ALIASES,
  computeEffectiveFlags,
} from '../../feature-flags/feature-flag-contract.js';
import type { PdConfig, FeatureFlagEntry } from '../pd-config-types.js';

function sparseConfig(): PdConfig {
  return { ...getDefaultPdConfig(), features: {} };
}

/** Build a config whose features section is exactly the given overrides
 * (typed parameter gives the literal contextual typing — a bare spread
 * widens `category` to string). */
function withFeatures(features: Record<string, FeatureFlagEntry>): PdConfig {
  return { ...getDefaultPdConfig(), features };
}

describe('PRI-645 effective parity — sparse vs dense bootstrap', () => {
  it('features: {} resolves to exactly the registry defaults for ALL registered flags', () => {
    const sparseEffective = computeEffectivePdConfig(sparseConfig());
    // The pre-PRI-645 bootstrap shape: a full registry snapshot in raw config.
    const denseEffective = computeEffectivePdConfig(getDefaultPdConfig());

    expect(Object.keys(sparseEffective.config.features)).toHaveLength(DEFAULT_FEATURE_FLAGS.length);
    for (const flag of DEFAULT_FEATURE_FLAGS) {
      const effective = sparseEffective.config.features[flag.id];
      expect(effective, `flag ${flag.id} missing from sparse effective map`).toBeDefined();
      expect(effective).toEqual({ category: flag.category, enabled: flag.enabled });
      // BEFORE == AFTER: identical to the dense-snapshot effective value.
      expect(effective).toEqual(denseEffective.config.features[flag.id]);
    }
    // No flag may be reported as changed-from-default on a fresh sparse config.
    expect(sparseEffective.featuresChangedFromDefault).toEqual([]);
  });

  it('registry defaults are the values sparse configs resolve to (registry snapshot, not a fixture)', () => {
    // The expected map is read from the canonical registry — never a
    // hand-maintained third copy of defaults (PRI-645 §21 anti-pattern).
    const effective = computeEffectivePdConfig(sparseConfig());
    const registryById = new Map(DEFAULT_FEATURE_FLAGS.map(f => [f.id, f]));
    for (const [id, entry] of Object.entries(effective.config.features)) {
      const def = registryById.get(id);
      expect(def, `effective flag ${id} not registered`).toBeDefined();
      expect(entry.category).toBe(def?.category);
      expect(entry.enabled).toBe(def?.enabled);
    }
  });
});

describe('PRI-645 category semantics under config absence', () => {
  it('core flag absence → registry default ON (prompt)', () => {
    const effective = computeEffectivePdConfig(sparseConfig());
    expect(effective.config.features.prompt).toEqual({ category: 'core', enabled: true });
  });

  it('quiet ON-default flag absence → registry default ON (feedback_channel)', () => {
    const effective = computeEffectivePdConfig(sparseConfig());
    const def = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'feedback_channel');
    expect(def?.enabled).toBe(true);
    expect(effective.config.features.feedback_channel).toEqual({ category: 'quiet', enabled: true });
  });

  it('quiet OFF-default flag absence → registry default OFF (gfi)', () => {
    const effective = computeEffectivePdConfig(sparseConfig());
    const def = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'gfi');
    expect(def?.enabled).toBe(false);
    expect(effective.config.features.gfi).toEqual({ category: 'quiet', enabled: false });
  });

  it('gone flag absence → gone behavior, and config cannot resurrect it', () => {
    const absent = computeEffectivePdConfig(sparseConfig());
    expect(absent.config.features.nocturnal).toEqual({ category: 'gone', enabled: false });

    // Explicit resurrection attempt is refused observably — with or without
    // a sparse bootstrap, gone semantics live in the resolver, never in
    // config presence.
    const resurrect = computeEffectivePdConfig(withFeatures({
      nocturnal: { category: 'gone', enabled: true },
    }));
    expect(resurrect.config.features.nocturnal).toEqual({ category: 'gone', enabled: false });
    expect(resurrect.warnings.some(w => w.includes("gone flag cannot be re-enabled"))).toBe(true);
  });
});

describe('PRI-645 registry authority — sparse config does not pin old defaults', () => {
  it('a registry default flip reaches sparse configs but not old default snapshots', () => {
    // Pure merge seam: computeEffectiveFlags takes the registry as a
    // parameter, so a graduation flip is simulated without rewriting the
    // production constant (no brittle source rewriting).
    const flippedRegistry = DEFAULT_FEATURE_FLAGS.map(f =>
      f.id === 'gfi' ? { ...f, enabled: !f.enabled } : f,
    );
    const gfiDefaultBefore = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'gfi')?.enabled;
    const gfiDefaultAfter = flippedRegistry.find(f => f.id === 'gfi')?.enabled;
    expect(gfiDefaultAfter).toBe(!gfiDefaultBefore);

    // Sparse fresh config follows the NEW registry default.
    const sparse = computeEffectiveFlags({}, flippedRegistry, 'sparse-test');
    expect(sparse.flags.gfi?.enabled).toBe(gfiDefaultAfter);

    // The pre-PRI-645 bootstrap shape (a materialized default snapshot)
    // would keep serving the OLD value after the flip — frozen default.
    const oldSnapshot = computeEffectiveFlags(
      { gfi: { category: 'quiet', enabled: gfiDefaultBefore ?? false } },
      flippedRegistry,
      'dense-test',
    );
    expect(oldSnapshot.flags.gfi?.enabled).toBe(gfiDefaultBefore);
  });
});

describe('PRI-645 existing-config compatibility preserved', () => {
  it('PRI-638 legacy diagnostician_split_pipeline=false still folds Diagnostician off', () => {
    const config = withFeatures({
      diagnostician_split_pipeline: { category: 'quiet', enabled: false },
    });
    const effective = computeEffectivePdConfig(config);
    expect(effective.config.internalAgents.agents.diagnostician?.enabled).toBe(false);
    expect(effective.warnings.some(w => w.includes('PRI-638 cutover'))).toBe(true);
  });

  it('PRI-609 snake_case aliases still normalize onto canonical IDs', () => {
    expect(Object.keys(FEATURE_FLAG_ALIASES).length).toBeGreaterThan(0);
    for (const [alias, canonical] of Object.entries(FEATURE_FLAG_ALIASES)) {
      const config = withFeatures({
        [alias]: { category: 'quiet', enabled: false },
      });
      const effective = computeEffectivePdConfig(config);
      // Alias key controls the canonical flag's effective value.
      expect(effective.config.features[canonical]?.enabled).toBe(false);
      // The alias key itself never becomes a capability entry.
      expect(Object.hasOwn(effective.config.features, alias)).toBe(false);
    }
  });

  it('explicit owner overrides keep their source on a sparse-config workspace', () => {
    const config = withFeatures({
      intent_engineering: { category: 'quiet', enabled: true, source: 'owner' },
    });
    const effective = computeEffectivePdConfig(config);
    expect(effective.config.features.intent_engineering).toEqual({
      category: 'quiet',
      enabled: true,
      source: 'owner',
    });
    expect(effective.featuresChangedFromDefault).toContain('intent_engineering');
  });
});
