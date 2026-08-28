/**
 * PD Config Contract Tests — PRI-304
 *
 * 8 required test scenarios:
 * 1. Missing config → deterministic defaults
 * 2. Valid MVP config → effective config correct
 * 3. Malformed root/object/array/value → structured error
 * 4. OpenClaw runtime reference → summary shows safe label/id only
 * 5. PD-local profile → shows apiKeyEnv, not secret value
 * 6. Per-agent override beats default runtime
 * 7. Feature flags computed from new config contract
 * 8. Redaction does not leak token-like/key-like/raw provider data
 */

import { describe, it, expect } from 'vitest';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  redactPdConfig,
  redactConfigValue,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
  getDefaultPdConfig,
  DEFAULT_RUNTIME_PROFILE_ID,
  PD_CONFIG_VERSION,
  INTERNAL_AGENT_NAMES,
} from '../index.js';
import { DEFAULT_FEATURE_FLAGS as FLAGS_ARRAY } from '../../feature-flags/index.js';
import type {
  PdConfig,
  RuntimeProfile,
} from '../index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Non-null assert for Record<string, T> lookups in tests */
function nn<T>(value: T | undefined, msg?: string): T {
  if (value === undefined) throw new Error(msg ?? 'Expected non-undefined');
  return value;
}

function makeValidConfig(): PdConfig {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: true },
      gfi: { category: 'quiet', enabled: false },
      nocturnal: { category: 'gone', enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'openclaw.model.lmstudio.qwen3': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
      'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000 },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.model.lmstudio.qwen3' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
        signalCollector: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
}

// ── Scenario 1: Missing config → deterministic defaults ────────────────────

describe('Scenario 1: Missing config → deterministic defaults', () => {
  it('null input returns defaults', () => {
    const effective = computeEffectivePdConfig(null);
    expect(effective.source).toBe('defaults');
    expect(effective.config.version).toBe(PD_CONFIG_VERSION);
    expect(effective.warnings).toEqual([]);
  });

  it('undefined input returns defaults', () => {
    const effective = computeEffectivePdConfig(undefined);
    expect(effective.source).toBe('defaults');
    expect(effective.config.version).toBe(PD_CONFIG_VERSION);
  });

  it('defaults include all MVP core features enabled', () => {
    const effective = computeEffectivePdConfig(null);
    const { config } = effective;
    expect(nn(config.features.prompt).enabled).toBe(true);
    expect(nn(config.features.code_tool_hook).enabled).toBe(true);
    expect(nn(config.features.defer_archive).enabled).toBe(true);
    expect(nn(config.features.prompt).category).toBe('core');
    expect(nn(config.features.code_tool_hook).category).toBe('core');
    expect(nn(config.features.defer_archive).category).toBe('core');
  });

  it('defaults include gone features disabled', () => {
    const effective = computeEffectivePdConfig(null);
    expect(nn(effective.config.features.nocturnal).enabled).toBe(false);
    expect(nn(effective.config.features.nocturnal).category).toBe('gone');
    expect(nn(effective.config.features.idle_trigger).enabled).toBe(false);
    expect(nn(effective.config.features.idle_trigger).category).toBe('gone');
  });

  it('defaults use openclaw.default while retaining pd.default as an explicit pi-ai option', () => {
    const effective = computeEffectivePdConfig(null);
    // The active MVP default works through the host OpenClaw runtime.
    expect(Object.hasOwn(effective.config.runtimeProfiles, DEFAULT_RUNTIME_PROFILE_ID)).toBe(true);
    expect(nn(effective.config.runtimeProfiles[DEFAULT_RUNTIME_PROFILE_ID]).type).toBe('openclaw');
    expect(Object.hasOwn(effective.config.runtimeProfiles, 'openclaw.default')).toBe(true);
    expect(nn(effective.config.runtimeProfiles['openclaw.default']).type).toBe('openclaw');
    // Direct pi-ai remains available only after the Owner explicitly configures it.
    expect(nn(effective.config.runtimeProfiles['pd.default']).type).toBe('pi-ai');
  });

  it('defaults include all internal agents', () => {
    const effective = computeEffectivePdConfig(null);
    for (const name of INTERNAL_AGENT_NAMES) {
      expect(Object.hasOwn(effective.config.internalAgents.agents, name)).toBe(true);
    }
  });

  it('defaults are deterministic (same result each call)', () => {
    const a = getDefaultPdConfig();
    const b = getDefaultPdConfig();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── Scenario 2: Valid MVP config → effective config correct ────────────────

describe('Scenario 2: Valid MVP config → effective config correct', () => {
  it('validates a valid config', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.value.version).toBe(1);
  });

  it('effective config preserves user features', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.source).toBe('user_config');
    expect(nn(effective.config.features.prompt).enabled).toBe(true);
    expect(nn(effective.config.features.gfi).enabled).toBe(false);
  });

  it('effective config preserves runtime profiles', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(Object.hasOwn(effective.config.runtimeProfiles, 'openclaw.default')).toBe(true);
    expect(Object.hasOwn(effective.config.runtimeProfiles, 'pd.anthropic-sonnet')).toBe(true);
  });

  it('effective config preserves internal agent bindings', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const diag = nn(effective.config.internalAgents.agents.diagnostician);
    expect(diag.enabled).toBe(true);
    expect(diag.runtimeProfile).toBe('openclaw.model.lmstudio.qwen3');
  });
});

// ── Scenario 3: Malformed root/object/array/value → structured error ───────

describe('Scenario 3: Malformed config → structured error', () => {
  it('null root returns structured error', () => {
    const result = validatePdConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(nn(result.errors[0]).reason).toBeTruthy();
    expect(nn(result.errors[0]).nextAction).toBeTruthy();
  });

  it('string root returns structured error', () => {
    const result = validatePdConfig('not an object');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === '')).toBe(true);
  });

  it('array root returns structured error', () => {
    const result = validatePdConfig([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === '')).toBe(true);
  });

  it('missing version returns structured error', () => {
    const raw: Record<string, unknown> = { ...makeValidConfig() };
    delete raw.version;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === 'version')).toBe(true);
  });

  it('wrong version returns structured error', () => {
    const raw = { ...makeValidConfig(), version: 99 };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === 'version')).toBe(true);
  });

  it('non-boolean enabled returns structured error', () => {
    const raw = makeValidConfig();
    raw.features.prompt = { category: 'core', enabled: 'true' as unknown as boolean };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === 'features.prompt.enabled')).toBe(true);
  });

  it('missing features returns structured error', () => {
    const raw: Record<string, unknown> = { ...makeValidConfig() };
    delete raw.features;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path === 'features')).toBe(true);
  });

  it('pi-ai profile missing apiKeyEnv returns structured error', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.test'] = { type: 'pi-ai', provider: 'test', model: 'test-model' } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path.includes('apiKeyEnv'))).toBe(true);
  });

  it('forbidden secret field in openclaw profile returns structured error', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['bad.profile'] = { type: 'openclaw', apiKey: 'sk-1234567890abcdef' } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('forbidden secret field'))).toBe(true);
  });

  it('forbidden secret field in pi-ai profile returns structured error', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['bad.pd'] = { type: 'pi-ai', provider: 'test', model: 'test', apiKeyEnv: 'TEST_KEY', token: 'secret-value' } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('forbidden secret field'))).toBe(true);
  });

  it('gateway_token in pi-ai profile is rejected as forbidden secret field', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['bad.gw'] = { type: 'pi-ai', provider: 'test', model: 'test', apiKeyEnv: 'TEST_KEY', gateway_token: 'gw-secret' } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('forbidden secret field') && e.path.includes('gateway_token'))).toBe(true);
  });

  it('dangerous key at root returns structured error', () => {
    // Use JSON.parse to create an object with 'constructor' as an own property
    // (spread/Object.assign cannot set __proto__ as an own enumerable property)
    const raw = JSON.parse('{"constructor":"evil","version":1,"features":{"prompt":{"category":"core","enabled":true}},"runtimeProfiles":{"openclaw.default":{"type":"openclaw","source":"default"}},"internalAgents":{"defaultRuntime":"openclaw.default","agents":{}}}');
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('dangerous key'))).toBe(true);
  });

  it('each error has reason and nextAction', () => {
    const result = validatePdConfig('bad');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    for (const error of result.errors) {
      expect(error.reason.length).toBeGreaterThan(0);
      expect(error.nextAction.length).toBeGreaterThan(0);
    }
  });
});

// ── Scenario 4: OpenClaw runtime reference → summary shows safe label/id only ──

describe('Scenario 4: OpenClaw runtime reference → safe summary', () => {
  it('OpenClaw profile summary shows label without secrets', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const ocProfile = summary.runtimeProfiles.find(p => p.id === 'openclaw.model.lmstudio.qwen3');
    expect(ocProfile).toBeDefined();
    expect(nn(ocProfile).type).toBe('openclaw');
    expect(nn(ocProfile).label).toContain('openclaw');
    expect(nn(ocProfile).label).toContain('lmstudio');
    expect(nn(ocProfile).label).toContain('qwen3.6-27b-mtp');
    // No apiKeyEnv for openclaw profiles
    expect(nn(ocProfile).apiKeyEnv).toBeUndefined();
  });

  it('OpenClaw default profile shows source label', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const defaultProfile = summary.runtimeProfiles.find(p => p.id === 'openclaw.default');
    expect(defaultProfile).toBeDefined();
    expect(nn(defaultProfile).label).toContain('openclaw');
  });

  it('OpenClaw profile summary does not contain raw provider object', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const summaryStr = JSON.stringify(summary);
    // Should not contain raw provider config objects (apiKey as a field name, not apiKeyEnv)
    expect(summaryStr).not.toContain('"apiKey"');
    expect(summaryStr).not.toContain('"gatewayToken"');
    expect(summaryStr).not.toContain('"baseUrl"');
  });
});

// ── Scenario 5: PD-local profile → shows apiKeyEnv, not secret value ───────

describe('Scenario 5: PD-local profile → apiKeyEnv shown, not value', () => {
  it('pi-ai profile summary shows apiKeyEnv name', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic-sonnet');
    expect(pdProfile).toBeDefined();
    expect(nn(pdProfile).apiKeyEnv).toBe('ANTHROPIC_API_KEY');
  });

  it('pi-ai profile summary does not contain secret value', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const summaryStr = JSON.stringify(summary);
    // Should not contain actual API key values
    expect(summaryStr).not.toContain('sk-ant-');
    expect(summaryStr).not.toContain('sk-');
  });

  it('pi-ai profile label shows provider/model', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic-sonnet');
    expect(nn(pdProfile).label).toContain('pi-ai');
    expect(nn(pdProfile).label).toContain('anthropic');
    expect(nn(pdProfile).label).toContain('claude-3-5-sonnet');
  });
});

// ── Scenario 6: Per-agent override beats default runtime ───────────────────

describe('Scenario 6: Per-agent override beats default runtime', () => {
  it('diagnostician uses explicit override, not defaultRuntime', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);

    // diagnostician has explicit runtimeProfile: 'openclaw.model.lmstudio.qwen3'
    expect(nn(effective.config.internalAgents.agents.diagnostician).runtimeProfile).toBe('openclaw.model.lmstudio.qwen3');
    // defaultRuntime is 'openclaw.default'
    expect(effective.config.internalAgents.defaultRuntime).toBe('openclaw.default');
  });

  it('agent without override uses defaultRuntime', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);

    // dreamer has no explicit runtimeProfile, so it should use defaultRuntime
    expect(nn(effective.config.internalAgents.agents.dreamer).runtimeProfile).toBe('openclaw.default');
  });

  it('agent without override uses user-configured defaultRuntime, not hard-coded default', () => {
    const raw = makeValidConfig();
    // User configures a custom defaultRuntime
    raw.internalAgents.defaultRuntime = 'pd.anthropic-sonnet';
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);

    // dreamer has no explicit runtimeProfile, so it should use the user's defaultRuntime
    expect(nn(effective.config.internalAgents.agents.dreamer).runtimeProfile).toBe('pd.anthropic-sonnet');
    // scribe also has no explicit runtimeProfile
    expect(nn(effective.config.internalAgents.agents.scribe).runtimeProfile).toBe('pd.anthropic-sonnet');
    // diagnostician has explicit override, so it keeps its own profile
    expect(nn(effective.config.internalAgents.agents.diagnostician).runtimeProfile).toBe('openclaw.model.lmstudio.qwen3');
  });

  it('redacted summary reflects per-agent override', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const diag = summary.agents.find(a => a.name === 'diagnostician');
    expect(nn(diag).runtimeProfileId).toBe('openclaw.model.lmstudio.qwen3');
    expect(nn(diag).runtimeProfileLabel).toContain('lmstudio');

    const dreamer = summary.agents.find(a => a.name === 'dreamer');
    expect(nn(dreamer).runtimeProfileId).toBe('openclaw.default');
  });
});

// ── Scenario 7: Feature flags computed from new config contract ────────────

describe('Scenario 7: Feature flags from new config contract', () => {
  it('feature flags include MVP core channels enabled', () => {
    const effective = computeEffectivePdConfig(null);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(flags.enabledChannels).toContain('prompt');
    expect(flags.enabledChannels).toContain('code_tool_hook');
    expect(flags.enabledChannels).toContain('defer_archive');
    expect(isFeatureEnabled(flags, 'rulecode_safety_controls')).toBe(true);
    expect(isFeatureEnabled(flags, 'rulecode_owner_live_decision')).toBe(true);
  });

  it('isFeatureEnabled works for known flags', () => {
    const effective = computeEffectivePdConfig(null);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(isFeatureEnabled(flags, 'prompt')).toBe(true);
    expect(isFeatureEnabled(flags, 'nocturnal')).toBe(false);
    expect(isFeatureEnabled(flags, 'nonexistent')).toBe(false);
  });

  it('PRI-435: core flags can be explicitly emergency-disabled via config with warning', () => {
    const raw = makeValidConfig();
    raw.features.prompt = { category: 'core', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.prompt).enabled).toBe(false);
    expect(effective.warnings.some(w => w.includes('core flag explicitly disabled') && w.includes('prompt'))).toBe(true);
  });

  it('keeps the RuleCode Owner decision disable path observable after rollout', () => {
    const raw = makeValidConfig();
    raw.features.rulecode_owner_live_decision = { category: 'core', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.rulecode_owner_live_decision).enabled).toBe(false);
    expect(effective.warnings.some(w => w.includes('core flag explicitly disabled') && w.includes('rulecode_owner_live_decision'))).toBe(true);
  });

  it('F14-1: core flag emergency disable preserves category as core (not userEntry.category)', () => {
    // Previously `category: userEntry.category` allowed an operator to
    // override a core flag's category to 'gone' or 'quiet' — a privilege
    // escalation. The category must be preserved as defaultFlag.category.
    const raw = makeValidConfig();
    // Operator attempts to emergency-disable prompt AND demote its category
    raw.features.prompt = { category: 'gone', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.prompt).enabled).toBe(false);
    expect(nn(flags.flags.prompt).category).toBe('core');
    expect(effective.warnings.some(w => w.includes('core flag explicitly disabled'))).toBe(true);
  });

  it('F14-1: core flag emergency disable with quiet category still preserves core', () => {
    const raw = makeValidConfig();
    raw.features.code_tool_hook = { category: 'quiet', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.code_tool_hook).enabled).toBe(false);
    expect(nn(flags.flags.code_tool_hook).category).toBe('core');
  });

  it('gone flags cannot be re-enabled via config', () => {
    const raw = makeValidConfig();
    raw.features.nocturnal = { category: 'gone', enabled: true };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.nocturnal).enabled).toBe(false);
    expect(effective.warnings.some(w => w.includes('gone flag cannot be re-enabled'))).toBe(true);
  });

  it('quiet flags can be toggled', () => {
    const raw = makeValidConfig();
    raw.features.gfi = { category: 'quiet', enabled: true };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.gfi).enabled).toBe(true);
  });

  it('unknown flags are diagnosed but never become effective capabilities (PRI-609)', () => {
    const raw = makeValidConfig();
    raw.features.custom_flag = { category: 'quiet', enabled: true };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(Object.hasOwn(flags.flags, 'custom_flag')).toBe(false);
    expect(effective.warnings.some(w => w.includes("feature 'custom_flag': unknown flag ignored"))).toBe(true);
  });

  it('snake_case alias config controls the canonical flag the production consumer reads (PRI-609)', () => {
    const raw = makeValidConfig();
    raw.features.pain_evidence_admission = { category: 'quiet', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(Object.hasOwn(flags.flags, 'pain_evidence_admission')).toBe(false);
    expect(nn(flags.flags.painEvidenceAdmission).enabled).toBe(false);
    expect(effective.warnings.some(w => w.includes('pain_evidence_admission'))).toBe(false);
  });

  it('canonical + alias configured with different values is a non-silent conflict; canonical wins (PRI-609)', () => {
    const raw = makeValidConfig();
    raw.features.painEvidenceAdmission = { category: 'quiet', enabled: true };
    raw.features.pain_evidence_admission = { category: 'quiet', enabled: false };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(nn(flags.flags.painEvidenceAdmission).enabled).toBe(true);
    expect(effective.warnings.some(w => w.includes("feature 'painEvidenceAdmission': conflicting values"))).toBe(true);
  });
});

// ── Scenario 8: Redaction does not leak secrets ────────────────────────────

describe('Scenario 8: Redaction does not leak secrets', () => {
  it('redactConfigValue redacts sensitive keys', () => {
    expect(redactConfigValue('sk-ant-secret123456789', 'apiKey')).toBe('[REDACTED]');
    expect(redactConfigValue('secret-value', 'token')).toBe('[REDACTED]');
    expect(redactConfigValue('secret-value', 'password')).toBe('[REDACTED]');
    expect(redactConfigValue('secret-value', 'auth_token')).toBe('[REDACTED]');
  });

  it('redactConfigValue preserves non-sensitive keys', () => {
    expect(redactConfigValue('hello', 'name')).toBe('hello');
    expect(redactConfigValue(42, 'count')).toBe(42);
    expect(redactConfigValue(true, 'enabled')).toBe(true);
  });

  it('redactConfigValue redacts token-like values in strings', () => {
    const result = redactConfigValue('key=sk-ant-1234567890abcdef', 'description');
    expect(result).not.toContain('sk-ant-');
    expect(result).toContain('[REDACTED]');
  });

  it('redactConfigValue redacts Bearer tokens in strings', () => {
    const result = redactConfigValue('Authorization: Bearer abc123def456ghi789', 'header');
    expect(result).not.toContain('abc123def456ghi789');
  });

  it('redactConfigValue handles nested objects with sensitive keys', () => {
    const input = {
      provider: 'anthropic',
      apiKey: 'sk-ant-super-secret-key',
      model: 'claude-3-5-sonnet',
    };
    const result = redactConfigValue(input) as Record<string, unknown>;
    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.model).toBe('claude-3-5-sonnet');
  });

  it('redacted summary never contains raw provider secrets', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const summaryStr = JSON.stringify(summary);
    // No raw key values
    expect(summaryStr).not.toContain('sk-ant-');
    expect(summaryStr).not.toContain('sk-');
    // No raw provider objects (baseUrl, apiKey, etc.)
    expect(summaryStr).not.toContain('"apiKey"');
    expect(summaryStr).not.toContain('"baseUrl"');
    expect(summaryStr).not.toContain('"gatewayToken"');
  });

  it('redacted summary shows apiKeyEnv name but not value', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic-sonnet');
    expect(nn(pdProfile).apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    // The summary should NOT contain any actual key value
    const summaryStr = JSON.stringify(summary);
    expect(summaryStr).not.toContain('sk-ant-api03-');
  });

  it('redactConfigValue truncates long strings', () => {
    const longValue = 'a'.repeat(300);
    const result = redactConfigValue(longValue, 'description');
    expect(typeof result === 'string' && result.length <= 203).toBe(true); // 200 + '…'
  });

  it('redactConfigValue handles dangerous keys', () => {
    const input = { __proto__: 'evil', constructor: 'bad', normal: 'ok' };
    const result = redactConfigValue(input) as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(Object.hasOwn(result, 'constructor')).toBe(false);
    expect(result.normal).toBe('ok');
  });
});

// ── Additional edge cases ───────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty features object passes validation but effective config fills defaults', () => {
    const raw = makeValidConfig();
    raw.features = {};
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    // Defaults should fill in
    expect(nn(effective.config.features.prompt).enabled).toBe(true);
  });

  it('negative timeoutMs fails validation', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.bad-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: -1,
    } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path.includes('timeoutMs'))).toBe(true);
  });

  it('zero timeoutMs fails validation', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.zero-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 0,
    } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
  });

  it('NaN timeoutMs fails validation', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.nan-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: NaN,
    } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
  });

  it('Infinity timeoutMs fails validation', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.inf-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: Infinity,
    } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
  });

  it('unknown profile type fails validation', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['bad.type'] = { type: 'unknown' } as unknown as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('type must be one of'))).toBe(true);
  });

  it('unknown agent key in internalAgents produces error', () => {
    const raw: unknown = { ...makeValidConfig() };
    const rawObj = raw as Record<string, unknown>;
    const ia = rawObj.internalAgents as Record<string, unknown>;
    const agentsObj = { ...(ia.agents as object), unknownAgent: { enabled: true } };
    ia.agents = agentsObj;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.reason.includes('unknown agent key'))).toBe(true);
  });

  it('invalid diagnostics mode fails validation', () => {
    const raw = makeValidConfig();
    raw.ui = { diagnostics: { mode: 'expert' as unknown as 'simple' | 'advanced' } };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e => e.path.includes('mode'))).toBe(true);
  });

  it('missing ui section is ok (defaults applied)', () => {
    const raw: Record<string, unknown> = { ...makeValidConfig() };
    delete raw.ui;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.config.ui.diagnostics.mode).toBe('simple');
  });

  it('agent referencing non-existent profile gets warning', () => {
    const raw = makeValidConfig();
    raw.internalAgents.agents.diagnostician = { enabled: true, runtimeProfile: 'nonexistent.profile' };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.warnings.some(w => w.includes('not found'))).toBe(true);
  });

  it('openclaw profile with only source=default is ready', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);
    const defaultProfile = summary.runtimeProfiles.find(p => p.id === 'openclaw.default');
    expect(nn(defaultProfile).readiness).toBe('ready');
  });

  it('disabled agent has readiness=disabled', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);
    const philosopher = summary.agents.find(a => a.name === 'philosopher');
    expect(nn(philosopher).enabled).toBe(false);
    expect(nn(philosopher).readiness).toBe('disabled');
  });

  it('pi-ai profile with all required fields has readiness=unknown (runtime unavailable to static redaction)', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);
    const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic-sonnet');
    // pi-ai profile is "unknown" because static redaction cannot access env vars
    expect(nn(pdProfile).readiness).toBe('unknown');
  });

  it('openclaw profile without provider/model has readiness=needs_setup', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['oc.minimal'] = { type: 'openclaw' };
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);
    const minimal = summary.runtimeProfiles.find(p => p.id === 'oc.minimal');
    expect(nn(minimal).readiness).toBe('needs_setup');
  });
});

// ── Regression: Flag Registry Consistency ────────────────────────────────────

describe('Regression: Flag Registry Consistency', () => {
  /**
   * All flags registered in feature-flag-contract.ts (FLAGS_ARRAY) MUST be
   * present in pd-config-defaults.ts (getDefaultPdConfig().features).
   *
   * This prevents a bug where isFeatureEnabled() returns false for registered
   * flags because they were missing from the defaults record used by
   * computeFeatureFlagsFromConfig().
   */
  it('all registered flags match the config defaults exactly in category and enabled status', () => {
    const defaults = getDefaultPdConfig();
    for (const flagDef of FLAGS_ARRAY) {
      const configEntry = defaults.features[flagDef.id];
      expect(configEntry, `flag ${flagDef.id} must be in config defaults`).toBeDefined();
      if (configEntry) {
        expect(configEntry.category, `flag ${flagDef.id} category`).toBe(flagDef.category);
        expect(configEntry.enabled, `flag ${flagDef.id} enabled`).toBe(flagDef.enabled);
      }
    }
  });

  it('PRI-375: diagnostician_async_cli is in defaults as disabled', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, 'diagnostician_async_cli')).toBe(true);
    expect(defaults.features.diagnostician_async_cli).toEqual({ category: 'quiet', enabled: false });
  });

  it('diagnostician_split_pipeline is in defaults', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, 'diagnostician_split_pipeline')).toBe(true);
    expect(defaults.features.diagnostician_split_pipeline).toEqual({ category: 'quiet', enabled: true });
  });

  it('diagnostician_core_grounding is in defaults', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, 'diagnostician_core_grounding')).toBe(true);
    expect(defaults.features.diagnostician_core_grounding).toEqual({ category: 'quiet', enabled: true });
  });

  it('internalization_core_grounding is in defaults', () => {
    const defaults = getDefaultPdConfig();
    expect(Object.hasOwn(defaults.features, 'internalization_core_grounding')).toBe(true);
    expect(defaults.features.internalization_core_grounding).toEqual({ category: 'quiet', enabled: true });
  });
});
