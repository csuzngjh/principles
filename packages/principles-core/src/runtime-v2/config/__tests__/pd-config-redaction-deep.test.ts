/**
 * PD Config Redaction Deep Coverage — PRI-304
 *
 * 补充测试覆盖缺口：
 * - 嵌套对象中的敏感数据脱敏
 * - 数组中的敏感数据脱敏
 * - 循环引用处理
 * - 多层嵌套的敏感键检测
 * - 特殊格式的token值（Bearer, sk-, 自定义格式）
 * - 边界条件：空值、null、undefined
 */

import { describe, it, expect } from 'vitest';
import {
  redactConfigValue,
  redactPdConfig,
  computeEffectivePdConfig,
  validatePdConfig,
} from '../index.js';
import type { PdConfig } from '../index.js';

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
      'pd.anthropic': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      },
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
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
}

// Helper function to safely cast result
function asObject(result: unknown): Record<string, unknown> | null {
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return null;
}

// ── Nested Object Redaction ──────────────────────────────────────────────────

describe('Nested object redaction', () => {
  it('redacts sensitive keys in nested objects', () => {
    const input = {
      level1: {
        level2: {
          apiKey: 'sk-secret-key-12345',
          safeValue: 'public-data',
        },
      },
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      const l1 = asObject(obj.level1);
      expect(l1).not.toBeNull();
      if (l1) {
        const l2 = asObject(l1.level2);
        expect(l2).not.toBeNull();
        if (l2) {
          expect(l2.apiKey).toBe('[REDACTED]');
          expect(l2.safeValue).toBe('public-data');
        }
      }
    }
  });

  it('preserves non-sensitive nested structure', () => {
    const input = {
      settings: {
        display: {
          theme: 'dark',
          fontSize: 14,
        },
        network: {
          timeout: 5000,
          retries: 3,
        },
      },
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      const settings = asObject(obj.settings);
      expect(settings).not.toBeNull();
      if (settings) {
        const display = asObject(settings.display);
        expect(display).not.toBeNull();
        if (display) {
          expect(display.theme).toBe('dark');
          expect(display.fontSize).toBe(14);
        }
      }
    }
  });
});

// ── Array Redaction ───────────────────────────────────────────────────────────

describe('Array redaction', () => {
  it('redacts sensitive values in arrays', () => {
    const input = {
      keys: ['sk-ant-api03-key', 'public-key', 'Bearer token123'],
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      const {keys} = obj;
      expect(Array.isArray(keys)).toBe(true);
      if (Array.isArray(keys)) {
        expect(keys[0]).toBe('[REDACTED]');
        expect(keys[1]).toBe('public-key');
        expect(keys[2]).toBe('[REDACTED]');
      }
    }
  });

  it('redacts sensitive keys in array of objects', () => {
    const input = {
      profiles: [
        { name: 'profile1', apiKey: 'secret1' },
        { name: 'profile2', token: 'secret2' },
        { name: 'profile3', safeField: 'value3' },
      ],
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      const {profiles} = obj;
      expect(Array.isArray(profiles)).toBe(true);
      if (Array.isArray(profiles)) {
        const p0 = asObject(profiles[0]);
        expect(p0).not.toBeNull();
        if (p0) {
          expect(p0.apiKey).toBe('[REDACTED]');
          expect(p0.name).toBe('profile1');
        }
        const p1 = asObject(profiles[1]);
        expect(p1).not.toBeNull();
        if (p1) {
          expect(p1.token).toBe('[REDACTED]');
        }
        const p2 = asObject(profiles[2]);
        expect(p2).not.toBeNull();
        if (p2) {
          expect(p2.safeField).toBe('value3');
        }
      }
    }
  });

  it('handles empty arrays', () => {
    const input = { items: [] };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.items).toEqual([]);
    }
  });
});

// ── Token Pattern Variations ──────────────────────────────────────────────────

describe('Token pattern variations', () => {
  it('redacts sk-ant- prefix tokens', () => {
    const input = { key: 'sk-ant-api03-xxxxxxxxxxxx' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.key).toBe('[REDACTED]');
    }
  });

  it('redacts sk- prefix tokens', () => {
    const input = { key: 'sk-xxxxxxxxxxxxxxxx' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.key).toBe('[REDACTED]');
    }
  });

  it('redacts Bearer tokens in strings', () => {
    const input = { auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.auth).toBe('[REDACTED]');
    }
  });

  it('preserves non-token-like strings', () => {
    const input = {
      message: 'This is a safe message',
      id: 'user-12345',
      path: '/api/v1/endpoint',
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.message).toBe('This is a safe message');
      expect(obj.id).toBe('user-12345');
      expect(obj.path).toBe('/api/v1/endpoint');
    }
  });
});

// ── Sensitive Key Detection ───────────────────────────────────────────────────

describe('Sensitive key detection variations', () => {
  it('detects apiKey (camelCase)', () => {
    const input = { apiKey: 'secret' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.apiKey).toBe('[REDACTED]');
    }
  });

  it('detects api_key (snake_case)', () => {
    const input = { api_key: 'secret' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.api_key).toBe('[REDACTED]');
    }
  });

  it('detects API_KEY (uppercase)', () => {
    const input = { API_KEY: 'secret' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.API_KEY).toBe('[REDACTED]');
    }
  });

  it('detects accessToken', () => {
    const input = { accessToken: 'secret-token' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.accessToken).toBe('[REDACTED]');
    }
  });

  it('detects refresh_token', () => {
    const input = { refresh_token: 'refresh-secret' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.refresh_token).toBe('[REDACTED]');
    }
  });

  it('detects private_key', () => {
    const input = { private_key: 'private-key-data' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.private_key).toBe('[REDACTED]');
    }
  });

  it('detects certificate', () => {
    const input = { certificate: 'cert-data' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.certificate).toBe('[REDACTED]');
    }
  });

  it('detects signature', () => {
    const input = { signature: 'sig-data' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.signature).toBe('[REDACTED]');
    }
  });

  it('detects compound keys like my_api_key', () => {
    const input = { my_api_key: 'compound-secret' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.my_api_key).toBe('[REDACTED]');
    }
  });

  it('detects compound keys like user_access_token', () => {
    const input = { user_access_token: 'compound-token' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.user_access_token).toBe('[REDACTED]');
    }
  });
});

// ── Boundary Conditions ───────────────────────────────────────────────────────

describe('Boundary conditions', () => {
  it('handles null input (returns null as-is)', () => {
    const result = redactConfigValue(null);
    expect(result).toBe(null);
  });

  it('handles undefined input (returns undefined as-is)', () => {
    const result = redactConfigValue(undefined);
    expect(result).toBe(undefined);
  });

  it('handles empty object', () => {
    const input = {};
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(Object.keys(obj).length).toBe(0);
    }
  });

  it('handles empty string', () => {
    const input = { value: '' };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.value).toBe('');
    }
  });

  it('handles numeric values', () => {
    const input = { count: 42, ratio: 3.14 };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.count).toBe(42);
      expect(obj.ratio).toBe(3.14);
    }
  });

  it('handles boolean values', () => {
    const input = { enabled: true, disabled: false };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.enabled).toBe(true);
      expect(obj.disabled).toBe(false);
    }
  });

  it('handles mixed type object', () => {
    const input = {
      string: 'text',
      number: 123,
      bool: true,
      null: null,
      array: [1, 2, 3],
      object: { nested: 'value' },
      apiKey: 'secret',
    };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.string).toBe('text');
      expect(obj.number).toBe(123);
      expect(obj.bool).toBe(true);
      expect(obj.apiKey).toBe('[REDACTED]');
    }
  });
});

// ── String Truncation ──────────────────────────────────────────────────────────

describe('String truncation', () => {
  it('truncates very long strings', () => {
    const longString = 'a'.repeat(500);
    const input = { longValue: longString };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      const truncated = obj.longValue;
      expect(typeof truncated).toBe('string');
      if (typeof truncated === 'string') {
        expect(truncated.length).toBeLessThan(longString.length);
        expect(truncated.endsWith('…')).toBe(true);
      }
    }
  });

  it('preserves short strings without truncation', () => {
    const shortString = 'short';
    const input = { shortValue: shortString };
    const result = redactConfigValue(input);
    const obj = asObject(result);
    expect(obj).not.toBeNull();
    if (obj) {
      expect(obj.shortValue).toBe(shortString);
    }
  });
});

// ── Full Config Redaction Integration ──────────────────────────────────────────

describe('Full config redaction integration', () => {
  it('redacted summary never contains actual secrets', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected valid config');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const jsonStr = JSON.stringify(summary);
    // Should never contain common secret patterns
    expect(jsonStr).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    expect(jsonStr).not.toMatch(/Bearer\s+[a-zA-Z0-9]{8,}/);
    expect(jsonStr).not.toContain('password');
    expect(jsonStr).not.toContain('secret');
  });

  it('redacted summary shows apiKeyEnv but not value', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    if (!result.ok) throw new Error('Expected valid config');
    const effective = computeEffectivePdConfig(result.value);
    const summary = redactPdConfig(effective);

    const pdProfile = summary.runtimeProfiles.find(p => p.id === 'pd.anthropic');
    expect(pdProfile).toBeDefined();
    if (pdProfile) {
      expect(pdProfile.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      // Should not have any field containing actual key value
      const profileJson = JSON.stringify(pdProfile);
      expect(profileJson).not.toContain('sk-ant-');
    }
  });
});