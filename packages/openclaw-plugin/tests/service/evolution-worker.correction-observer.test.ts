import { describe, expect, it } from 'vitest';
import { PLUGIN_SURFACE_REGISTRY } from '@principles/core/runtime-v2';
import { DEFAULT_FEATURE_FLAGS, computeEffectiveFlags } from '@principles/core/runtime-v2';

describe('Correction Observer Ownership — Feature Flag & Surface Registry Consistency (PRI-293, ERR-027)', () => {
  it('correction_observer feature flag is registered as quiet with enabled:true (disableable runtime kill switch)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'correction_observer');
    expect(flag).toBeDefined();
    expect(flag!.category).toBe('quiet');
    expect(flag!.enabled).toBe(true);
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

  it('evolution_worker feature flag remains quiet with enabled:false', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'evolution_worker');
    expect(flag).toBeDefined();
    expect(flag!.category).toBe('quiet');
    expect(flag!.enabled).toBe(false);
  });

  it('service:evolution-worker surface remains quiet with enabledByDefault:false', () => {
    const surface = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:evolution-worker');
    expect(surface).toBeDefined();
    expect(surface!.category).toBe('quiet');
    expect(surface!.enabledByDefault).toBe(false);
  });
});
