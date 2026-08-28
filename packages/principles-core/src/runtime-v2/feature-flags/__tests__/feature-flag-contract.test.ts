import { describe, it, expect } from 'vitest';
import {
  validateFeatureFlagRaw,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_ALIASES,
  type FeatureFlagCategory,
  VALID_CATEGORIES,
} from '../feature-flag-contract.js';

// PRI-571 Feature Graduation (2026-08-24): validated governance capabilities
// promoted to the default experience. Each stays category 'quiet' so the
// rollback path remains an explicit config override in .pd/config.yaml.
const PRI_571_DEFAULT_ON_FLAGS: readonly string[] = [
  'principle_receipt_ledger',
  'principle_receipt_block_copy',
  'diagnostician_llm_degradation',
  'principle_governance_projection_v2',
];

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
      // P0-D (2026-08-18): repair loop promoted to default-on (INV-02 liveness)
      if (flag.id === 'evaluator_artificer_repair_loop') continue;
      // PRI-454: painEvidenceAdmission + painEvidenceAdmissionDefault flipped to default-on
      if (flag.id === 'painEvidenceAdmission') continue;
      if (flag.id === 'painEvidenceAdmissionDefault') continue;
      // Task 7: failed_tasks_observability defaults on (quiet flag, default-on)
      if (flag.id === 'failed_tasks_observability') continue;
      // Governance Recovery v1 (2026-08-24 owner decision): default-on
      if (flag.id === 'failed_task_recovery_console') continue;
      // PRI-571 graduation (2026-08-24): validated capabilities promoted to
      // the default experience; see PRI-571_DEFAULT_ON_FLAGS below.
      if (PRI_571_DEFAULT_ON_FLAGS.includes(flag.id)) continue;
      expect(flag.enabled, `quiet flag ${flag.id} should default off`).toBe(false);
    }
  });

  it('PRI-571: graduates validated governance capabilities to default-on while staying quiet (rollback = config override)', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    for (const id of PRI_571_DEFAULT_ON_FLAGS) {
      const flag = result.flags[id];
      expect(flag, `flag ${id} must stay registered`).toBeDefined();
      expect(flag?.enabled, `graduated flag ${id} should default on`).toBe(true);
      expect(flag?.category, `graduated flag ${id} stays quiet — rollback path is a config override`).toBe('quiet');
    }
  });

  it('PRI-571: each graduated capability can still be disabled via explicit config override', () => {
    for (const id of PRI_571_DEFAULT_ON_FLAGS) {
      const result = computeEffectiveFlags(
        { [id]: { enabled: false, since: '2026-08-24' } },
        DEFAULT_FEATURE_FLAGS,
        '/test/.pd/feature-flags.yaml',
      );
      expect(result.flags[id]?.enabled, `graduated flag ${id} must remain disableable via config`).toBe(false);
    }
  });

  it('enables every approved MVP-Core flag after the RuleCode rollout gate', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    const coreFlags = Object.values(result.flags).filter(f => f.category === 'core');
    for (const flag of coreFlags) {
      expect(flag.enabled, `core flag ${flag.id} has the wrong approved default`).toBe(true);
    }
  });

  it('keeps the rulecode_owner_live_decision emergency disable observable in this loader path too', () => {
    const result = computeEffectiveFlags(
      { rulecode_owner_live_decision: { enabled: false, since: '2026-08-21' } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/feature-flags.yaml',
    );
    expect(result.flags.rulecode_owner_live_decision?.enabled).toBe(false);
    expect(result.warnings.some(w => w.includes('core flag explicitly disabled') && w.includes('rulecode_owner_live_decision'))).toBe(true);
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

  it('contains RuleCode safety controls as an enabled MVP-Core flag', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'rulecode_safety_controls');
    expect(flag).toMatchObject({ category: 'core', enabled: true, since: '2026-08-21' });
  });

  it('contains Owner live decision authority as enabled MVP-Core after rollout acceptance', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'rulecode_owner_live_decision');
    expect(flag).toMatchObject({ category: 'core', enabled: true, since: '2026-08-21' });
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

  it('PRI-609: pain_evidence_admission is NOT registered as an independent capability — it is an alias', () => {
    expect(DEFAULT_FEATURE_FLAGS.find(f => f.id === 'pain_evidence_admission')).toBeUndefined();
    expect(DEFAULT_FEATURE_FLAGS.find(f => f.id === 'pain_evidence_admission_default')).toBeUndefined();
    expect(FEATURE_FLAG_ALIASES.pain_evidence_admission).toBe('painEvidenceAdmission');
    expect(FEATURE_FLAG_ALIASES.pain_evidence_admission_default).toBe('painEvidenceAdmissionDefault');
  });

  it('PRI-609: snake_case alias override controls the canonical runtime flag', () => {
    const result = computeEffectiveFlags(
      { pain_evidence_admission: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.painEvidenceAdmission?.enabled).toBe(false);
    expect(Object.hasOwn(result.flags, 'pain_evidence_admission')).toBe(false);
    expect(result.warnings.some(w => w.includes('conflicting values'))).toBe(false);
  });

  it('PRI-609: canonical + alias with different values is a non-silent conflict; canonical wins (key order independent)', () => {
    // alias first
    const aliasFirst = computeEffectiveFlags(
      { pain_evidence_admission: { enabled: false }, painEvidenceAdmission: { enabled: true } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(aliasFirst.flags.painEvidenceAdmission?.enabled).toBe(true);
    expect(aliasFirst.warnings.some(w => w.includes("feature 'painEvidenceAdmission': conflicting values"))).toBe(true);

    // canonical first
    const canonicalFirst = computeEffectiveFlags(
      { painEvidenceAdmission: { enabled: true }, pain_evidence_admission: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(canonicalFirst.flags.painEvidenceAdmission?.enabled).toBe(true);
    expect(canonicalFirst.warnings.some(w => w.includes("feature 'painEvidenceAdmission': conflicting values"))).toBe(true);
  });

  it('PRI-609: canonical + alias with identical values stays silent', () => {
    const result = computeEffectiveFlags(
      { painEvidenceAdmission: { enabled: false }, pain_evidence_admission: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.painEvidenceAdmission?.enabled).toBe(false);
    expect(result.warnings.some(w => w.includes('conflicting values'))).toBe(false);
  });

  it('PRI-609: inherited enabled values never satisfy alias conflict checks', () => {
    const inheritedOnly = Object.create({ enabled: true }) as Record<string, unknown>;
    const result = computeEffectiveFlags(
      { painEvidenceAdmission: { enabled: true }, pain_evidence_admission: inheritedOnly },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.painEvidenceAdmission?.enabled).toBe(true);
    expect(result.warnings.some(w => w.includes('conflicting values'))).toBe(true);
  });

  it('PRI-609: unknown flag never becomes an effective capability', () => {
    const result = computeEffectiveFlags(
      { totally_unknown_flag: { enabled: true } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(Object.hasOwn(result.flags, 'totally_unknown_flag')).toBe(false);
    expect(result.warnings.some(w => w.includes("flag 'totally_unknown_flag': unknown flag ignored"))).toBe(true);
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

  it('PRI-609: pain_evidence_admission alias config reaches the canonical flag with no unknown warning', () => {
    const userFlags = {
      pain_evidence_admission: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/feature-flags.yaml');
    expect(result.flags.painEvidenceAdmission?.enabled).toBe(true);
    expect(Object.hasOwn(result.flags, 'pain_evidence_admission')).toBe(false);
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

  it('Task 7: failed_tasks_observability is registered as quiet, default-on', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'failed_tasks_observability');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('failed_tasks_observability flag not found');
    expect(flag.category).toBe('quiet');
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-07-04');
    expect(flag.description).toContain('Failed tasks observability');
  });

  it('Governance Recovery v1: failed_task_recovery_console is registered as quiet, default-on (owner decision 2026-08-24)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'failed_task_recovery_console');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('failed_task_recovery_console flag not found');
    expect(flag.category).toBe('quiet');
    // Default on per owner decision (2026-08-24); disable via
    // .pd/config.yaml features.failed_task_recovery_console.enabled: false.
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-08-23');
    expect(flag.description).toContain('recovery');
  });

  it('PRI-584~587: governance_experience_v1 is registered as quiet, default-off', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'governance_experience_v1');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('governance_experience_v1 flag not found');
    expect(flag.category).toBe('quiet');
    // Default off: read-only experience snapshot; flag-off = endpoint 403 before
    // any DB access and legacy Console Focus behavior preserved.
    expect(flag.enabled).toBe(false);
    expect(flag.since).toBe('2026-08-24');
    expect(flag.description).toContain('read-only');
  });

  it('PRI-584~587: governance_experience_v1 can be enabled via config (rollout path)', () => {
    const userFlags = {
      governance_experience_v1: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    const flag = result.flags.governance_experience_v1;
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.enabled).toBe(true);
    }
    expect(result.warnings.some(w => w.includes('governance_experience_v1') && w.includes('unknown'))).toBe(false);
  });

  it('Governance Recovery v1: failed_task_recovery_console can be disabled via config', () => {
    const userFlags = {
      failed_task_recovery_console: { enabled: false },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    const flag = result.flags.failed_task_recovery_console;
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.enabled).toBe(false);
    }
    // unknown-flag warning must not fire for a registered flag
    expect(result.warnings.some(w => w.includes('failed_task_recovery_console') && w.includes('unknown'))).toBe(false);
  });

  it('Task 7: failed_tasks_observability can be explicitly disabled via config', () => {
    const userFlags = {
      failed_tasks_observability: { enabled: false },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    const flag = result.flags.failed_tasks_observability;
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.enabled).toBe(false);
    }
    // quiet flag disable must not emit a core-flag emergency-disable warning
    expect(result.warnings.some(w => w.includes('failed_tasks_observability') && w.includes('core'))).toBe(false);
  });

  it('Task 7: failed_tasks_observability is recognized by computeEffectiveFlags (no unknown warning)', () => {
    const userFlags = {
      failed_tasks_observability: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    expect(result.flags.failed_tasks_observability).toBeDefined();
    expect(result.warnings.some(w => w.includes('failed_tasks_observability') && w.includes('unknown'))).toBe(false);
  });

  // ── PRI-509: Evaluator→Artificer repair loop ─────────────────────────────
  it('PRI-509/P0-D: evaluator_artificer_repair_loop is quiet, default-ON since core-loop closure (INV-02)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'evaluator_artificer_repair_loop');
    expect(flag).toBeDefined();
    if (!flag) throw new Error('evaluator_artificer_repair_loop flag not found');
    expect(flag.category).toBe('quiet');
    // 契约变更 (2026-08-18): needs_revision 必须有自动 revision 出边 (INV-02);
    // flag 保留为运行时 kill-switch (config enabled:false 回滚)
    expect(flag.enabled).toBe(true);
    expect(flag.since).toBe('2026-07-04');
    expect(flag.description).toContain('PRI-509');
  });

  it('PRI-509: evaluator_artificer_repair_loop can be explicitly enabled via config', () => {
    const userFlags = {
      evaluator_artificer_repair_loop: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    const flag = result.flags.evaluator_artificer_repair_loop;
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.enabled).toBe(true);
    }
    // quiet flag enable must not emit a core-flag emergency-disable warning
    expect(result.warnings.some(w => w.includes('evaluator_artificer_repair_loop') && w.includes('core'))).toBe(false);
  });

  it('PRI-509: evaluator_artificer_repair_loop is recognized by computeEffectiveFlags (no unknown warning)', () => {
    const userFlags = {
      evaluator_artificer_repair_loop: { enabled: true },
    };
    const result = computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    expect(result.flags.evaluator_artificer_repair_loop).toBeDefined();
    expect(result.warnings.some(w => w.includes('evaluator_artificer_repair_loop') && w.includes('unknown'))).toBe(false);
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
  // Maintainer-approved MVP-Core (2026-07-01): promoted from MVP-Quiet (default-off)
  // to MVP-Core (default-on) after explicit maintainer approval. As a core flag it
  // defaults ON and cannot be disabled by omission; explicit emergency disable via
  // `enabled: false` is honored with a warning (see computeEffectiveFlags core branch).
  it('Given DEFAULT_FEATURE_FLAGS, When looked up by id, Then new_user_onboarding is registered as core with default-on (maintainer-approved MVP-Core, 2026-07-01)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'new_user_onboarding');
    expect(flag).toBeDefined();
    expect(flag?.category).toBe('core');
    expect(flag?.enabled).toBe(true);
    expect(flag?.since).toBe('2026-07-01');
    expect(flag?.description).toContain('onboarding');
    // description must surface the maintainer-approval milestone so the
    // default-on state is traceable to an explicit decision.
    expect(flag?.description).toContain('Maintainer-approved MVP-Core');
  });

  it('Given a core default-on flag, When config explicitly disables it, Then the emergency disable is honored with a warning', () => {
    const result = computeEffectiveFlags(
      { new_user_onboarding: { enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.new_user_onboarding?.enabled).toBe(false);
    expect(result.warnings.some(w => w.includes('new_user_onboarding') && w.includes('core'))).toBe(true);
  });

  it('Given a core default-on flag, When no config is provided, Then new_user_onboarding stays enabled by default', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');
    expect(result.flags.new_user_onboarding?.enabled).toBe(true);
  });
});

describe('PRI-523 shared host runtime rollout flag', () => {
  it('registers abstraction_layer_v1 as quiet, default-off, and dated to the accepted exception', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'abstraction_layer_v1');
    expect(flag).toMatchObject({
      id: 'abstraction_layer_v1',
      category: 'quiet',
      enabled: false,
      since: '2026-08-13',
    });
  });

  it('honors an explicit abstraction_layer_v1 rollback', () => {
    const result = computeEffectiveFlags(
      { abstraction_layer_v1: { category: 'quiet', enabled: false } },
      DEFAULT_FEATURE_FLAGS,
      '/test/.pd/config.yaml',
    );
    expect(result.flags.abstraction_layer_v1?.enabled).toBe(false);
  });
});

describe('PRI-550 principle governance projection rollout flag', () => {
  it('registers the projection as quiet and default-on after PRI-571 graduation', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(
      candidate => candidate.id === 'principle_governance_projection_v2',
    );

    expect(flag).toMatchObject({
      id: 'principle_governance_projection_v2',
      category: 'quiet',
      enabled: true,
      since: '2026-08-20',
    });
  });

  it('serves the projection enabled when workspace config omits it (PRI-571 graduation)', () => {
    const result = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, '/test/.pd/config.yaml');

    expect(result.flags.principle_governance_projection_v2?.enabled).toBe(true);
  });
});
