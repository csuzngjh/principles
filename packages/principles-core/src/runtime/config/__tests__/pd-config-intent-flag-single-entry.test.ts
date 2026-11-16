/**
 * P2-2 — `intent_engineering` has exactly ONE runtime entry point.
 *
 * Before this guard `DiagRootCauseRunner` resolved the flag with its own
 * `computeFeatureFlagsFromConfig()` + `isFeatureEnabled()` pair while Dreamer /
 * Philosopher / Scribe used `isIntentAnchoringEnabled()`. Two spellings of the
 * same switch is how a "flag off" run drifts: one stage reads on, another off.
 *
 * The source scan is deliberate: a behavioural test cannot see a second local
 * copy that happens to agree today.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computeEffectivePdConfig } from '../index.js';
import { isIntentAnchoringEnabled } from '../pd-config-feature-flags.js';
import type { EffectivePdConfig } from '../pd-config-types.js';

const SRC_ROOT = join(__dirname, '..', '..', '..');
const FLAG = 'intent_engineering';

/** Files allowed to name the flag: the predicate, its typed contract, the registry. */
const ALLOWED = [
  'runtime/config/pd-config-feature-flags.ts',
  'runtime/feature-flags/feature-flag-contract.ts',
  'runtime/feature-flags/feature-flag-lifecycle.ts',
];

function effective(enabled: boolean): EffectivePdConfig {
  const base = computeEffectivePdConfig(null);
  return {
    ...base,
    config: {
      ...base.config,
      features: { ...base.config.features, [FLAG]: { category: 'quiet', enabled } },
    },
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('isIntentAnchoringEnabled — the single predicate', () => {
  it('is safe with no effective config (legacy default-off, never accidental enable)', () => {
    expect(isIntentAnchoringEnabled(undefined)).toBe(false);
  });

  it('follows the flag in both directions', () => {
    expect(isIntentAnchoringEnabled(effective(false))).toBe(false);
    expect(isIntentAnchoringEnabled(effective(true))).toBe(true);
  });

  it('reads only its own flag', () => {
    const base = computeEffectivePdConfig(null);
    const other: EffectivePdConfig = {
      ...base,
      config: {
        ...base.config,
        features: { ...base.config.features, diagnostician_core_grounding: { category: 'quiet', enabled: true } },
      },
    };
    expect(isIntentAnchoringEnabled(other)).toBe(false);
  });

  it('has no second runtime copy of the flag name', () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes(`'${FLAG}'`) || readFileSync(file, 'utf8').includes(`"${FLAG}"`))
      .map((file) => file.slice(SRC_ROOT.length + 1).split('\\').join('/'))
      .filter((relative) => !ALLOWED.includes(relative));
    expect(offenders).toEqual([]);
  });
});
