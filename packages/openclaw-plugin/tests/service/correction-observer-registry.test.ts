import { describe, expect, it } from 'vitest';
import { PLUGIN_SURFACE_REGISTRY } from '@principles/core/runtime-v2';
import { DEFAULT_FEATURE_FLAGS, computeEffectiveFlags } from '@principles/core/runtime-v2';

// Renamed from evolution-worker.correction-observer.test.ts in PRI-737: the
// file only ever asserted correction_observer / evolution_worker flag and
// surface-registry governance (no worker code), so it outlives the worker.
describe('Correction Observer Ownership — Feature Flag & Surface Registry Consistency (PRI-293, ERR-027)', () => {
  it('correction_observer feature flag is registered as quiet with enabled:false (MVP-Quiet, disableable runtime kill switch)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'correction_observer');
    expect(flag).toBeDefined();
    expect(flag!.category).toBe('quiet');
    expect(flag!.enabled).toBe(false);
  });

  it('correction_observer can be disabled via workspace config (P1 fix — runtime kill switch)', () => {
    const result = computeEffectiveFlags(
      { correction_observer: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '.pd/config.yaml',
    );
    expect(result.flags['correction_observer'].enabled).toBe(false);
    expect(result.warnings).not.toContain(expect.stringContaining('core flag cannot be disabled'));
  });

  it('service:correction-observer surface is registered as core with enabledByDefault:true', () => {
    const surface = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:correction-observer');
    expect(surface).toBeDefined();
    expect(surface!.category).toBe('core');
    expect(surface!.enabledByDefault).toBe(true);
  });

  it('startup:correction-observer surface is registered as core with enabledByDefault:true', () => {
    const surface = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'startup:correction-observer');
    expect(surface).toBeDefined();
    expect(surface!.category).toBe('core');
    expect(surface!.enabledByDefault).toBe(true);
  });

  // Tombstone guards (PRI-752): the worker was deleted in PRI-737 and its
  // registry residue retired — these assertions keep the ghost from returning.
  it('evolution_worker feature flag is gone/permanently disabled (retired PRI-752)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'evolution_worker');
    expect(flag).toBeDefined();
    expect(flag!.category).toBe('gone');
    expect(flag!.enabled).toBe(false);
  });

  it('evolution-worker surfaces are removed from the registry (retired PRI-752)', () => {
    expect(PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:evolution-worker')).toBeUndefined();
    expect(PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'startup:evolution-worker')).toBeUndefined();
  });
});
