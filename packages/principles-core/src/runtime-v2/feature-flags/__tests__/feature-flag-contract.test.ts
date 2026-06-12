import { describe, it, expect } from 'vitest';
import {
  validateFeatureFlagRaw,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagCategory,
  VALID_CATEGORIES,
} from '../feature-flag-contract.js';

describe('validateFeatureFlagRaw', () => {
  it('accepts valid flag with all fields', () => {
    const raw = {
      id: 'gfi',
      category: 'quiet',
      enabled: false,
      since: '2026-05-24',
      description: 'Global Friction Index session scoring',
    };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('gfi');
      expect(result.value.category).toBe('quiet');
      expect(result.value.enabled).toBe(false);
      expect(result.value.since).toBe('2026-05-24');
      expect(result.value.description).toBe('Global Friction Index session scoring');
    }
  });

  it('accepts valid flag without description', () => {
    const raw = {
      id: 'gfi',
      category: 'quiet',
      enabled: false,
      since: '2026-05-24',
    };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = validateFeatureFlagRaw('not an object', 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects null input', () => {
    const result = validateFeatureFlagRaw(null, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects array input', () => {
    const result = validateFeatureFlagRaw([], 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects missing id', () => {
    const raw = { category: 'quiet', enabled: false, since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('id'))).toBe(true);
    }
  });

  it('rejects non-string id', () => {
    const raw = { id: 42, category: 'quiet', enabled: false, since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects empty id', () => {
    const raw = { id: '', category: 'quiet', enabled: false, since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects invalid category', () => {
    const raw = { id: 'gfi', category: 'invalid', enabled: false, since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('category'))).toBe(true);
    }
  });

  it('accepts all valid categories', () => {
    const categories: FeatureFlagCategory[] = ['core', 'quiet', 'gone', 'legacy_retire'];
    for (const category of categories) {
      const raw = { id: `test-${category}`, category, enabled: true, since: '2026-05-24' };
      const result = validateFeatureFlagRaw(raw, `test-${category}`);
      expect(result.ok, `category ${category} should be valid`).toBe(true);
    }
  });

  it('rejects non-boolean enabled', () => {
    const raw = { id: 'gfi', category: 'quiet', enabled: 'false', since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects missing enabled', () => {
    const raw = { id: 'gfi', category: 'quiet', since: '2026-05-24' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects missing since', () => {
    const raw = { id: 'gfi', category: 'quiet', enabled: false };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects non-string since', () => {
    const raw = { id: 'gfi', category: 'quiet', enabled: false, since: 20260524 };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects empty since', () => {
    const raw = { id: 'gfi', category: 'quiet', enabled: false, since: '' };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('rejects non-string description when present', () => {
    const raw = { id: 'gfi', category: 'quiet', enabled: false, since: '2026-05-24', description: 42 };
    const result = validateFeatureFlagRaw(raw, 'test');
    expect(result.ok).toBe(false);
  });

  it('includes source key in errors for traceability', () => {
    const result = validateFeatureFlagRaw({ id: 42 }, 'my-flag');
    if (!result.ok) {
      expect(result.source).toBe('my-flag');
    }
  });
});

describe('computeEffectiveFlags', () => {
  it('returns defaults when no user flags provided', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(result.source).toBe('defaults');
    expect(result.configPath).toBe('/test/.pd/feature-flags.yaml');
    expect(Object.keys(result.flags).length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it('returns workspace_file source when user flags are provided', () => {
    const userFlags = {
      gfi: { enabled: true, since: '2026-05-24' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(result.source).toBe('workspace_file');
  });

  it('does not allow enabling quiet flags from malformed input', () => {
    const userFlags = {
      gfi: { enabled: 'yes', since: '2026-05-24' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const gfiFlag = result.flags.gfi;
    expect(gfiFlag).toBeDefined();
    // Malformed enabled field must NOT enable a quiet flag
    if (gfiFlag) {
      expect(gfiFlag.enabled).toBe(false);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not allow enabling unknown flags', () => {
    const userFlags = {
      totally_made_up: { category: 'quiet', enabled: true, since: '2026-05-24' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(result.flags.totally_made_up).toBeUndefined();
    expect(result.warnings.some(w => w.includes('totally_made_up'))).toBe(true);
  });

  it('preserves core flags as enabled regardless of user config', () => {
    const promptDefault = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'prompt');
    if (!promptDefault) return;
    const userFlags = {
      prompt: { enabled: false, since: '2026-01-01' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const promptFlag = result.flags.prompt;
    if (promptFlag) {
      expect(promptFlag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('core') || w.includes('prompt'))).toBe(true);
  });

  it('allows explicit enable of quiet flag with valid input', () => {
    const userFlags = {
      gfi: { enabled: true, since: '2026-05-24' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const gfiFlag = result.flags.gfi;
    if (gfiFlag) {
      expect(gfiFlag.enabled).toBe(true);
    }
  });

  it('default-off quiet flags are disabled when no config', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const quietFlags = Object.values(result.flags).filter(f => f.category === 'quiet');
    for (const flag of quietFlags) {
      // feedback_channel is a quiet flag that defaults on (MVP seed channel)
      if (flag.id === 'feedback_channel') continue;
      if (flag.id === 'correction_observer') continue;
      if (flag.id === 'diagnostician_async_cli') continue;
      if (flag.id === 'diagnostician_core_grounding') continue;
      if (flag.id === 'diagnostician_split_pipeline') continue;
      expect(flag.enabled, `quiet flag ${flag.id} should default off`).toBe(false);
    }
  });

  it('core flags are enabled by default', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const coreFlags = Object.values(result.flags).filter(f => f.category === 'core');
    for (const flag of coreFlags) {
      expect(flag.enabled, `core flag ${flag.id} should default on`).toBe(true);
    }
  });

  it('gone flags are always disabled regardless of config', () => {
    const goneDefault = DEFAULT_FEATURE_FLAGS.find(f => f.category === 'gone');
    if (!goneDefault) return;
    const userFlags = {
      [goneDefault.id]: { enabled: true, since: '2026-05-24' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const goneFlag = result.flags[goneDefault.id];
    if (goneFlag) {
      expect(goneFlag.enabled).toBe(false);
    }
  });

  // PRI-369: Invalid flag combo — split pipeline requires async_cli
  it('disables diagnostician_split_pipeline when diagnostician_async_cli is not enabled', () => {
    const userFlags = {
      diagnostician_split_pipeline: { enabled: true },
      diagnostician_async_cli: { enabled: false },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const splitFlag = result.flags.diagnostician_split_pipeline;
    expect(splitFlag).toBeDefined();
    if (splitFlag) {
      expect(splitFlag.enabled).toBe(false);
    }
    expect(result.warnings.some(w => w.includes('invalid combo'))).toBe(true);
  });

  it('allows diagnostician_split_pipeline when diagnostician_async_cli is also enabled', () => {
    const userFlags = {
      diagnostician_async_cli: { enabled: true },
      diagnostician_split_pipeline: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const splitFlag = result.flags.diagnostician_split_pipeline;
    const asyncFlag = result.flags.diagnostician_async_cli;
    if (splitFlag) {
      expect(splitFlag.enabled).toBe(true);
    }
    if (asyncFlag) {
      expect(asyncFlag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('invalid combo'))).toBe(false);
  });

  it('allows diagnostician_async_cli to be enabled independently', () => {
    const userFlags = {
      diagnostician_async_cli: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const asyncFlag = result.flags.diagnostician_async_cli;
    if (asyncFlag) {
      expect(asyncFlag.enabled).toBe(true);
    }
  });
});

describe('DEFAULT_FEATURE_FLAGS', () => {
  it('contains prompt core flag', () => {
    const prompt = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'prompt');
    expect(prompt).toBeDefined();
    if (prompt) {
      expect(prompt.category).toBe('core');
      expect(prompt.enabled).toBe(true);
    }
  });

  it('contains code_tool_hook core flag', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'code_tool_hook');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('core');
      expect(flag.enabled).toBe(true);
    }
  });

  it('contains defer_archive core flag', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'defer_archive');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('core');
      expect(flag.enabled).toBe(true);
    }
  });

  it('contains gfi quiet flag (default off)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'gfi');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('quiet');
      expect(flag.enabled).toBe(false);
    }
  });

  it('contains feedback_channel quiet flag (default on)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'feedback_channel');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('quiet');
      expect(flag.enabled).toBe(true);
    }
  });

  it('all flags have valid since dates', () => {
    for (const flag of DEFAULT_FEATURE_FLAGS) {
      expect(flag.since, `flag ${flag.id} since`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('all flags have valid categories', () => {
    for (const flag of DEFAULT_FEATURE_FLAGS) {
      expect(VALID_CATEGORIES).toContain(flag.category);
    }
  });

  it('no duplicate flag ids', () => {
    const ids = DEFAULT_FEATURE_FLAGS.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has description for every flag', () => {
    for (const flag of DEFAULT_FEATURE_FLAGS) {
      expect(flag.description, `flag ${flag.id} needs description`).toBeDefined();
      expect(typeof flag.description).toBe('string');
      if (flag.description) {
        expect(flag.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('PEAT-B1: painEvidenceAdmission is registered as quiet, default-off', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'painEvidenceAdmission');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('painEvidenceAdmission flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(false);
    expect(flag.since).toBe('2026-06-06');
    expect(flag.description).toContain('PEAT-B1');
  });

  it('PRI-369: diagnostician_async_cli is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_async_cli');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('diagnostician_async_cli flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-06-11');
    expect(flag.description).toContain('Async pain-record CLI');
  });

  it('PRI-369: diagnostician_core_grounding is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_core_grounding');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('diagnostician_core_grounding flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
  });

  it('PRI-369: diagnostician_split_pipeline is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_split_pipeline');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('diagnostician_split_pipeline flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
  });
});

describe('VALID_CATEGORIES', () => {
  it('contains exactly core, quiet, gone, legacy_retire', () => {
    expect(VALID_CATEGORIES).toEqual(['core', 'quiet', 'gone', 'legacy_retire']);
  });
});

describe('prototype pollution defense', () => {
  it('rejects constructor key in user flags', () => {
    const userFlags: Record<string, unknown> = { constructor: { enabled: true } };
    const result = computeEffectiveFlags(
      userFlags,
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/feature-flags.yaml',
    );
    expect(result.warnings.some(w => w.includes('constructor'))).toBe(true);
  });

  it('rejects prototype key in user flags', () => {
    const userFlags: Record<string, unknown> = { prototype: { enabled: true } };
    const result = computeEffectiveFlags(
      userFlags,
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/feature-flags.yaml',
    );
    expect(result.warnings.some(w => w.includes('prototype'))).toBe(true);
  });

  it('rejects __proto__ when passed as explicit enumerable key', () => {
    const userFlags: Record<string, unknown> = {};
    Object.defineProperty(userFlags, '__proto__', {
      value: { enabled: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(result.warnings.some(w => w.includes('__proto__'))).toBe(true);
  });

  it('Object.hasOwn used for override reads (not in operator)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'feature-flag-contract.ts'), 'utf-8');
    const overrideReads = src.match(/Object\.hasOwn\(/g);
    expect(overrideReads && overrideReads.length).toBeGreaterThanOrEqual(4);
  });
});
