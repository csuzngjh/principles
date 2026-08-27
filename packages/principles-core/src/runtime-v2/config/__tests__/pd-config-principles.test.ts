/**
 * PD Config principles-section tests — PRI-336 / PRI-606.
 *
 * `principles.outputLanguage` is the canonical language SSOT. It must survive
 * validatePdConfig into the returned PdConfig (and therefore into
 * loadPdConfigForPlugin's effective config) — the validator previously
 * dropped the section entirely, silently disabling the SSOT for every loader
 * consumer (prompt injection read the legacy PainConfig language instead).
 */

import { describe, it, expect } from 'vitest';
import { validatePdConfig, computeEffectivePdConfig } from '../index.js';

function makeValidRawConfig(): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
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
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
  };
}

describe('validatePdConfig: principles section (PRI-606 canonical language SSOT)', () => {
  it('preserves a valid principles.outputLanguage into the validated config', () => {
    const raw = { ...makeValidRawConfig(), principles: { outputLanguage: 'en' } };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.principles?.outputLanguage).toBe('en');
    }
  });

  it('preserves zh-CN outputLanguage', () => {
    const raw = { ...makeValidRawConfig(), principles: { outputLanguage: 'zh-CN' } };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.principles?.outputLanguage).toBe('zh-CN');
    }
  });

  it('accepts an empty principles section (legitimate default downstream)', () => {
    const raw = { ...makeValidRawConfig(), principles: {} };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.principles).toEqual({});
    }
  });

  it('rejects an invalid outputLanguage with a structured error (fail loud, ERR-009)', () => {
    const raw = { ...makeValidRawConfig(), principles: { outputLanguage: 'fr' } };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find(err => err.path === 'principles.outputLanguage');
      expect(e).toBeDefined();
      expect(e?.reason).toContain('fr');
      expect(e?.nextAction).toContain('zh-CN');
    }
  });

  it('rejects a non-object principles section', () => {
    const raw = { ...makeValidRawConfig(), principles: 'en' };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(err => err.path === 'principles')).toBe(true);
    }
  });

  it('effective config carries the validated principles through computeEffectivePdConfig', () => {
    const raw = { ...makeValidRawConfig(), principles: { outputLanguage: 'en' } };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const effective = computeEffectivePdConfig(result.value);
      expect(effective.config.principles?.outputLanguage).toBe('en');
    }
  });
});
