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

  it('PRI-435: honors explicit emergency disable of core flag when deliberately configured', () => {
    const promptDefault = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'prompt');
    // PRI-435 (CodeRabbit P2): fail loud if the prompt flag is missing from defaults
    expect(promptDefault).toBeDefined();
    const userFlags = {
      prompt: { enabled: false, since: '2026-01-01' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const promptFlag = result.flags.prompt;
    // PRI-435 (CodeRabbit P2): fail loud if computeEffectiveFlags drops the flag
    expect(promptFlag).toBeDefined();
    expect(promptFlag?.enabled).toBe(false);
    expect(result.warnings.some(w => w.includes('core') && w.includes('prompt'))).toBe(true);
  });

  it('PRI-435: core flags default ON when config omits enabled value', () => {
    const userFlags = {
      prompt: { category: 'core' },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const promptFlag = result.flags.prompt;
    // PRI-435 (CodeRabbit P2): fail loud if the flag is missing
    expect(promptFlag).toBeDefined();
    expect(promptFlag?.enabled).toBe(true);
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
      if (flag.id === 'internalization_core_grounding') continue;
      if (flag.id === 'internalization_auto_consumer') continue;
      if (flag.id === 'story_a_approval_completion') continue;
      // PRI-454: painEvidenceAdmission + painEvidenceAdmissionDefault flipped to default-on
      if (flag.id === 'painEvidenceAdmission') continue;
      if (flag.id === 'pain_evidence_admission') continue;
      if (flag.id === 'painEvidenceAdmissionDefault') continue;
      if (flag.id === 'pain_evidence_admission_default') continue;
      // new_user_onboarding: default-on quiet flag (guides new users)
      if (flag.id === 'new_user_onboarding') continue;
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

  it('allows diagnostician_split_pipeline to be enabled independently', () => {
    const userFlags = {
      diagnostician_split_pipeline: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const splitFlag = result.flags.diagnostician_split_pipeline;
    if (splitFlag) {
      expect(splitFlag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('invalid combo'))).toBe(false);
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

  it('contains code_rule_capability core flag (PRI-435: promoted to MVP-Core, default on)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'code_rule_capability');
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

  it('PEAT-B1: painEvidenceAdmission is registered as quiet, default-on (PRI-454 flip)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'painEvidenceAdmission');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('painEvidenceAdmission flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-06-06');
    expect(flag.description).toContain('PEAT-B1');
  });

  it('PRI-404: pain_evidence_admission snake_case alias is registered as quiet, default-on (PRI-454 flip)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'pain_evidence_admission');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('pain_evidence_admission flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-06-15');
    expect(flag.description).toContain('Snake-case');
  });

  it('PRI-454: painEvidenceAdmissionDefault is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'painEvidenceAdmissionDefault');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('painEvidenceAdmissionDefault flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-06-24');
    expect(flag.description).toContain('PRI-454');
  });

  it('PRI-454: pain_evidence_admission_default snake_case alias is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'pain_evidence_admission_default');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('pain_evidence_admission_default flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-06-24');
    expect(flag.description).toContain('PRI-454');
  });

  it('PRI-404: pain_evidence_admission is recognized by computeEffectiveFlags (no unknown warning)', () => {
    const userFlags = {
      pain_evidence_admission: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const flag = result.flags.pain_evidence_admission;
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('pain_evidence_admission') && w.includes('unknown'))).toBe(false);
  });

  it('PRI-375: diagnostician_async_cli is registered as quiet, default-off', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_async_cli');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('diagnostician_async_cli flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(false);
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

  it('PRI-419: l2_dreamer is registered as quiet, default-off', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'l2_dreamer');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('l2_dreamer flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(false);
    expect(flag.since).toBe('2026-06-16');
    expect(flag.description).toContain('L2 multi-turn agent loop');
    expect(flag.description).toContain('PRI-419');
  });

  it('PRI-419: l2_dreamer can be explicitly enabled via config', () => {
    const userFlags = {
      l2_dreamer: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const l2Flag = result.flags.l2_dreamer;
    expect(l2Flag).toBeDefined();
    if (l2Flag) {
      expect(l2Flag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('l2_dreamer') && w.includes('unknown'))).toBe(false);
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

describe('new_user_onboarding flag', () => {
  // Given the DEFAULT_FEATURE_FLAGS registry, when looking up new_user_onboarding,
  // then it must be present with quiet category, default-on, a valid since date, and
  // a description mentioning onboarding. This guards the production wiring path
  // (EP-02) and fails loud on missing required fields (EP-03).
  it('Given DEFAULT_FEATURE_FLAGS, When looked up by id, Then new_user_onboarding is registered with quiet category and default true', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'new_user_onboarding');
    expect(flag).toBeDefined();
    expect(flag?.category).toBe('quiet');
    expect(flag?.enabled).toBe(true);
    expect(flag?.since).toBe('2026-07-01');
    expect(flag?.description).toContain('onboarding');
  });

  it('Given a quiet-category flag, When config omits the flag, Then it stays default-on but remains overridable (quiet flag semantics)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'new_user_onboarding');
    expect(flag?.category).toBe('quiet');
    // quiet flags can be overridden by config — verify the override path is honored
    const result = computeEffectiveFlags(
      { new_user_onboarding: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.new_user_onboarding?.enabled).toBe(false);
    expect(result.warnings.some(w => w.includes('new_user_onboarding') && w.includes('unknown'))).toBe(false);
  });
});
