/**
 * PD Config Override Provenance Tests — PRI-637
 *
 * Feature flag config lifecycle: a config override may carry `source` metadata
 * (`owner` | `system`); absence means LEGACY_UNKNOWN. This suite pins the
 * lifecycle contract:
 *
 * - Resolution precedence: registry default ← explicit override; an override's
 *   `enabled` is what wins, provenance never flips the value.
 * - Legacy overrides (no source) are PRESERVED as-is — never promoted to
 *   `owner`, never downgraded to `system`, never guessed from the boolean.
 * - Owner pins (source: 'owner') survive effective computation.
 * - Observation-safety: effective values computed from a pre-PRI-637 config
 *   are identical after applying the provenance contract (idempotent, and no
 *   legacy `enabled` value is rewritten).
 * - Alias conflict keeps existing canonical precedence; the canonical entry's
 *   source is preserved.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
  getDefaultPdConfig,
  DEFAULT_FEATURE_FLAGS,
} from '../index.js';
import { FEATURE_FLAG_ALIASES } from '../../feature-flags/feature-flag-contract.js';
import type { FeatureFlagEntry, FeatureFlagSource, PdConfig } from '../index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function nn<T>(value: T | undefined, msg?: string): T {
  if (value === undefined) throw new Error(msg ?? 'Expected non-undefined');
  return value;
}

function mkConfig(features: Record<string, FeatureFlagEntry>, extra?: Partial<PdConfig>): PdConfig {
  return {
    ...getDefaultPdConfig(),
    features,
    ...extra,
  };
}

describe('PRI-637 override provenance — resolution precedence', () => {
  it('no override → registry default', () => {
    const effective = computeEffectivePdConfig(getDefaultPdConfig());
    for (const [id, def] of Object.entries(DEFAULT_FEATURE_FLAGS)) {
      expect(effective.config.features[id]?.enabled).toBe(def.enabled);
      expect(effective.config.features[id]?.source).toBeUndefined();
    }
  });

  it('owner pin false + default true → false (emergency disable, quiet flag)', () => {
    // Use a real registered quiet flag whose registry default is true.
    const id = 'feedback_channel';
    expect(DEFAULT_FEATURE_FLAGS[id]?.enabled).toBe(true);
    const effective = computeEffectivePdConfig(mkConfig({
      [id]: { category: 'quiet', enabled: false, source: 'owner' },
    }));
    expect(effective.config.features[id]?.enabled).toBe(false);
    expect(effective.config.features[id]?.source).toBe('owner');
  });

  it('owner pin true + default false → true', () => {
    const id = 'intent_engineering';
    expect(DEFAULT_FEATURE_FLAGS[id]?.enabled).toBe(false);
    const effective = computeEffectivePdConfig(mkConfig({
      [id]: { category: 'quiet', enabled: true, source: 'owner' },
    }));
    expect(effective.config.features[id]?.enabled).toBe(true);
    expect(effective.config.features[id]?.source).toBe('owner');
  });

  it('system override respects its enabled value and keeps source', () => {
    const id = 'gfi';
    const effective = computeEffectivePdConfig(mkConfig({
      [id]: { category: 'quiet', enabled: true, source: 'system' },
    }));
    expect(effective.config.features[id]?.enabled).toBe(true);
    expect(effective.config.features[id]?.source).toBe('system');
  });
});

describe('PRI-637 legacy unknown — preserve, never guess', () => {
  it('legacy bare false → preserved, source stays undefined', () => {
    const id = 'painEvidenceAdmission';
    expect(DEFAULT_FEATURE_FLAGS[id]?.enabled).toBe(true);
    const effective = computeEffectivePdConfig(mkConfig({
      [id]: { category: 'quiet', enabled: false },
    }));
    // PRI-637 §5/C: a bare false is NOT auto-called stale — the value is
    // preserved and the entry is classified LEGACY_UNKNOWN (source absent).
    expect(effective.config.features[id]?.enabled).toBe(false);
    expect(effective.config.features[id]?.source).toBeUndefined();
  });

  it('legacy bare true → preserved, source stays undefined', () => {
    const id = 'intent_engineering';
    expect(DEFAULT_FEATURE_FLAGS[id]?.enabled).toBe(false);
    const effective = computeEffectivePdConfig(mkConfig({
      [id]: { category: 'quiet', enabled: true },
    }));
    expect(effective.config.features[id]?.enabled).toBe(true);
    expect(effective.config.features[id]?.source).toBeUndefined();
  });

  it('effective computation is a pure function — repeated runs are idempotent (observation safety)', () => {
    const id = 'diagnostician_llm_degradation';
    const legacy: PdConfig = mkConfig({
      [id]: { category: 'quiet', enabled: false },
    });
    const first = computeEffectivePdConfig(legacy);
    const second = computeEffectivePdConfig(legacy);
    expect(first.config.features[id]?.enabled).toBe(false);
    expect(second.config.features[id]?.enabled).toBe(false);
    expect(first.config.features[id]?.source).toBeUndefined();
    expect(second.config.features[id]?.source).toBeUndefined();
    // No run "migrates" the legacy entry into a pinned state.
    expect(JSON.stringify(second.config.features)).toBe(JSON.stringify(first.config.features));
  });
});

describe('PRI-637 validation — source metadata', () => {
  it('accepts owner/system and rejects any other source value', () => {
    const validSources = ['owner', 'system'] as const;
    for (const source of validSources) {
      const ok = validatePdConfig(mkConfig({
        feedback_channel: { category: 'quiet', enabled: true, source },
      }));
      expect(ok.ok).toBe(true);
    }
    // Deliberately invalid provenance value — the validator must fail loud (rc-3).
    const bad = validatePdConfig(mkConfig({
      feedback_channel: { category: 'quiet', enabled: true, source: 'opener' as FeatureFlagSource },
    }));
    expect(bad.ok).toBe(false);
  });

  it('absent source is legal (LEGACY_UNKNOWN)', () => {
    const result = validatePdConfig(mkConfig({
      feedback_channel: { category: 'quiet', enabled: false },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.features.feedback_channel?.source).toBeUndefined();
  });
});

describe('PRI-637 source reaches the effective feature-flag surface', () => {
  it('computeFeatureFlagsFromConfig surfaces override source', () => {
    const effective = computeEffectivePdConfig(mkConfig({
      feedback_channel: { category: 'quiet', enabled: false, source: 'owner' },
    }));
    const flags = computeFeatureFlagsFromConfig(effective);
    const flag = flags.flags.feedback_channel;
    expect(nn(flag).enabled).toBe(false);
    expect(nn(flag).source).toBe('owner');
  });

  it('registry-default flags have no source on the effective surface', () => {
    const flags = computeFeatureFlagsFromConfig(computeEffectivePdConfig(null));
    for (const flag of Object.values(flags.flags)) {
      expect(flag?.source).toBeUndefined();
    }
  });
});

describe('PRI-637 alias interaction — canonical precedence preserved', () => {
  it('canonical entry wins over its snake_case alias and carries its own source', () => {
    const [alias, canonical] = Object.entries(FEATURE_FLAG_ALIASES)[0] as [string, string];
    if (!alias || !canonical) throw new Error('no alias fixture');
    const effective = computeEffectivePdConfig(mkConfig({
      [canonical]: { category: 'quiet', enabled: false, source: 'owner' },
      [alias]: { category: 'quiet', enabled: true },
    }));
    // Canonical wins (existing PRI-609 precedence); the canonical entry's
    // provenance is the one attached to the effective value.
    expect(effective.config.features[canonical]?.enabled).toBe(false);
    expect(effective.config.features[canonical]?.source).toBe('owner');
  });

  it('alias-only override normalizes onto the canonical ID with its source preserved', () => {
    const [alias, canonical] = Object.entries(FEATURE_FLAG_ALIASES)[0] as [string, string];
    if (!alias || !canonical) throw new Error('no alias fixture');
    const effective = computeEffectivePdConfig(mkConfig({
      [alias]: { category: 'quiet', enabled: false, source: 'owner' },
    }));
    expect(effective.config.features[canonical]?.enabled).toBe(false);
    expect(effective.config.features[canonical]?.source).toBe('owner');
  });
});