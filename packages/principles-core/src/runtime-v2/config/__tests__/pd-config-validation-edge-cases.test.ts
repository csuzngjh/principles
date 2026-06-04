/**
 * PD Config Validation Edge Cases — PRI-304
 *
 *补充测试覆盖缺口：
 * - 空字符串 provider/model/apiKeyEnv 验证
 * - 特殊字符在 profile ID 中的处理
 * - 多个并发错误同时发生时的错误收集
 * - 超长字符串和边界值处理
 * - 循环引用和不存在的 profile 引用
 */

import { describe, it, expect } from 'vitest';
import {
  validatePdConfig,
  computeEffectivePdConfig,
} from '../index.js';
import type { PdConfig, RuntimeProfile } from '../index.js';

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
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        trainer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
}

// ── Empty String Validation ────────────────────────────────────────────────

describe('Empty string validation in pi-ai profiles', () => {
  it('rejects empty provider string', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.empty-provider'] = {
      type: 'pi-ai',
      provider: '',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('provider') &&
      e.reason.includes('non-empty string')
    )).toBe(true);
  });

  it('rejects empty model string', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.empty-model'] = {
      type: 'pi-ai',
      provider: 'test-provider',
      model: '',
      apiKeyEnv: 'TEST_KEY',
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('model') &&
      e.reason.includes('non-empty string')
    )).toBe(true);
  });

  it('rejects empty apiKeyEnv string', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.empty-key'] = {
      type: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: '',
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('apiKeyEnv') &&
      e.reason.includes('non-empty string')
    )).toBe(true);
  });

  it('accepts whitespace-only provider (current behavior - no trim)', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.whitespace-provider'] = {
      type: 'pi-ai',
      provider: '   ',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    // Current validation only checks non-empty string, does not trim
    // Whitespace-only strings are technically non-empty
    expect(result.ok).toBe(true);
  });
});

// ── Special Characters in Profile IDs ───────────────────────────────────────

describe('Special characters in profile IDs', () => {
  it('accepts profile ID with dots', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.test.profile'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('accepts profile ID with hyphens', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd-test-profile'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('accepts profile ID with underscores', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd_test_profile'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('handles profile ID with Unicode characters', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd测试profile'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    // Unicode should be accepted (no restriction on profile ID charset)
    expect(result.ok).toBe(true);
  });
});

// ── Multiple Concurrent Errors ──────────────────────────────────────────────

describe('Multiple concurrent errors collection', () => {
  it('collects all errors when multiple fields are invalid', () => {
    const raw = makeValidConfig();
    // Add multiple invalid profiles
    raw.runtimeProfiles['pd.error1'] = {
      type: 'pi-ai',
      provider: '',
      model: '',
      apiKeyEnv: '',
    } as RuntimeProfile;
    raw.runtimeProfiles['pd.error2'] = {
      type: 'pi-ai',
      provider: 'valid',
      model: '',
      apiKeyEnv: '',
    } as RuntimeProfile;

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');

    // Should have multiple errors, not just the first one
    expect(result.errors.length).toBeGreaterThan(3);
    expect(result.errors.some(e => e.path.includes('error1'))).toBe(true);
    expect(result.errors.some(e => e.path.includes('error2'))).toBe(true);
  });

  it('collects errors from both features and profiles', () => {
    const raw: Record<string, unknown> = {
      version: 1,
      features: {
        prompt: { category: 'core', enabled: 'not-boolean' as unknown as boolean },
      },
      runtimeProfiles: {
        'pd.error': {
          type: 'pi-ai',
          provider: '',
          model: '',
          apiKeyEnv: '',
        },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {},
      },
      ui: { diagnostics: { mode: 'simple' } },
    };

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');

    // Should have errors from both features and profiles
    expect(result.errors.some(e => e.path.includes('features'))).toBe(true);
    expect(result.errors.some(e => e.path.includes('runtimeProfiles'))).toBe(true);
  });

  it('continues validation after first error (does not short-circuit)', () => {
    const raw = makeValidConfig();
    // First error: invalid feature
    raw.features.prompt = { category: 'core', enabled: 'invalid' as unknown as boolean };
    // Second error: invalid profile
    raw.runtimeProfiles['pd.error'] = {
      type: 'pi-ai',
      provider: '',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
    } as RuntimeProfile;
    // Third error: invalid internalAgents.defaultRuntime (empty string)
    raw.internalAgents.defaultRuntime = '' as unknown as string;

    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');

    // Should have collected all three error categories
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Boundary Values ──────────────────────────────────────────────────────────

describe('Boundary values and extreme inputs', () => {
  it('handles very long provider strings', () => {
    const raw = makeValidConfig();
    const longProvider = 'a'.repeat(1000);
    raw.runtimeProfiles['pd.long-provider'] = {
      type: 'pi-ai',
      provider: longProvider,
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    // Long strings should be accepted (no length limit in validation)
    expect(result.ok).toBe(true);
  });

  it('handles very long model strings', () => {
    const raw = makeValidConfig();
    const longModel = 'model-'.repeat(200);
    raw.runtimeProfiles['pd.long-model'] = {
      type: 'pi-ai',
      provider: 'test',
      model: longModel,
      apiKeyEnv: 'TEST_KEY',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('handles very large timeoutMs values', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.large-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 86400000, // 24 hours in ms
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('rejects extremely large timeoutMs (Infinity)', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.infinity-timeout'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: Infinity,
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('timeoutMs') &&
      e.reason.includes('finite')
    )).toBe(true);
  });

  it('handles baseUrl with special characters', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.special-url'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      baseUrl: 'https://api.example.com:8080/v1/path?query=value',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });
});

// ── Profile Reference Validation ─────────────────────────────────────────────

describe('Profile reference validation in agents', () => {
  it('accepts agent referencing valid profile', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.custom'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    };
    raw.internalAgents.agents.diagnostician = {
      enabled: true,
      runtimeProfile: 'pd.custom',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('accepts agent referencing non-existent profile (warning in effective config)', () => {
    const raw = makeValidConfig();
    raw.internalAgents.agents.diagnostician = {
      enabled: true,
      runtimeProfile: 'pd.nonexistent',
    };
    const result = validatePdConfig(raw);
    // Validation passes (profile existence is checked in effective config)
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    const effective = computeEffectivePdConfig(result.value);
    // Effective config should have a warning about missing profile
    expect(effective.warnings.some(w =>
      w.includes('nonexistent') || w.includes('not found')
    )).toBe(true);
  });

  it('accepts defaultRuntime referencing non-existent profile (warning)', () => {
    const raw = makeValidConfig();
    raw.internalAgents.defaultRuntime = 'pd.nonexistent-default';
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    const effective = computeEffectivePdConfig(result.value);
    expect(effective.warnings.length).toBeGreaterThan(0);
  });
});

// ── Type Coercion Edge Cases ─────────────────────────────────────────────────

describe('Type coercion edge cases', () => {
  it('rejects numeric provider (type mismatch)', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.numeric-provider'] = {
      type: 'pi-ai',
      provider: 123 as unknown as string,
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('provider') &&
      e.reason.includes('string')
    )).toBe(true);
  });

  it('rejects boolean apiKeyEnv', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['pd.bool-key'] = {
      type: 'pi-ai',
      provider: 'test',
      model: 'test-model',
      apiKeyEnv: true as unknown as string,
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('apiKeyEnv') &&
      e.reason.includes('string')
    )).toBe(true);
  });

  it('rejects object as enabled value', () => {
    const raw = makeValidConfig();
    raw.features.prompt = {
      category: 'core',
      enabled: { value: true } as unknown as boolean,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('enabled') &&
      e.reason.includes('boolean')
    )).toBe(true);
  });

  it('rejects null as category value', () => {
    const raw = makeValidConfig();
    raw.features.prompt = {
      category: null as unknown as 'core',
      enabled: true,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('category')
    )).toBe(true);
  });
});

// ── OpenClaw Profile Edge Cases ──────────────────────────────────────────────

describe('OpenClaw profile edge cases', () => {
  it('accepts OpenClaw profile with only type', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['openclaw.minimal'] = {
      type: 'openclaw',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('accepts OpenClaw profile with all optional fields', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['openclaw.full'] = {
      type: 'openclaw',
      provider: 'lmstudio',
      model: 'qwen3',
      source: 'custom',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
  });

  it('rejects numeric source in OpenClaw profile', () => {
    const raw = makeValidConfig();
    raw.runtimeProfiles['openclaw.bad-source'] = {
      type: 'openclaw',
      source: 123 as unknown as string,
    } as RuntimeProfile;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('source') &&
      e.reason.includes('string')
    )).toBe(true);
  });
});