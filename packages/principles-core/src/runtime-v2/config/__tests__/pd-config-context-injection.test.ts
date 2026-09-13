import { describe, it, expect } from 'vitest';
import {
  validatePdConfig,
  computeEffectivePdConfig,
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
        signalCollector: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
}

describe('ContextInjection config validation', () => {
  it('accepts minimal contextInjection with only thinkingOs', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: true,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.resolvedContextInjection.thinkingOs).toBe(true);
    expect(effective.resolvedContextInjection.projectFocus).toBe('off');
  });

  it('accepts contextInjection with only projectFocus', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      projectFocus: 'summary',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.resolvedContextInjection.projectFocus).toBe('summary');
  });

  it('accepts full contextInjection config', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: false,
      projectFocus: 'off',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.resolvedContextInjection.thinkingOs).toBe(false);
    expect(effective.resolvedContextInjection.projectFocus).toBe('off');
  });

  it('tolerates legacy evolutionContext with a removal warning (PRI-772)', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      evolutionContext: {
        enabled: false,
        maxMessages: 10,
        maxCharsPerMessage: 500,
      },
    } as unknown as PdConfig['contextInjection'];
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.warnings.some(w => w.includes('evolutionContext'))).toBe(true);
    const effective = computeEffectivePdConfig(result.value);
    expect(Object.hasOwn(effective.resolvedContextInjection, 'evolutionContext')).toBe(false);
  });

  it('tolerates legacy evolutionContext regardless of value shape', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      evolutionContext: 'enabled',
    } as unknown as PdConfig['contextInjection'];
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.warnings.some(w => w.includes('retired no-op'))).toBe(true);
  });

  it('emits no evolutionContext warning when the key is absent', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: true,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.warnings.some(w => w.includes('evolutionContext'))).toBe(false);
  });

  it('rejects contextInjection with non-boolean thinkingOs', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: 'yes' as unknown as boolean,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('thinkingOs') &&
      e.reason.includes('boolean')
    )).toBe(true);
  });

  it('rejects contextInjection with invalid projectFocus', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      projectFocus: 'invalid' as unknown as 'full',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('projectFocus')
    )).toBe(true);
  });

  it('rejects contextInjection with numeric projectFocus', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      projectFocus: 123 as unknown as 'full',
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('projectFocus')
    )).toBe(true);
  });

  it('rejects contextInjection with dangerous key', () => {
    const raw = makeValidConfig();
    const ctxInj: Record<string, unknown> = { thinkingOs: true };
    Object.defineProperty(ctxInj, '__proto__', { value: { polluted: true }, enumerable: true });
    raw.contextInjection = ctxInj;
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('__proto__')
    )).toBe(true);
  });

  it('rejects contextInjection with unknown top-level key', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: true,
      unknownKey: 'value',
    } as unknown as PdConfig['contextInjection'];
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('unknownKey') &&
      e.reason.includes('unknown key')
    )).toBe(true);
  });

  it('rejects contextInjection with non-object type', () => {
    const raw = makeValidConfig();
    raw.contextInjection = 'enabled' as unknown as PdConfig['contextInjection'];
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error');
    expect(result.errors.some(e =>
      e.path.includes('contextInjection') &&
      e.reason.includes('object')
    )).toBe(true);
  });

  it('provides defaults when contextInjection is not provided', () => {
    const raw = makeValidConfig();
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.resolvedContextInjection.thinkingOs).toBe(false);
    expect(effective.resolvedContextInjection.projectFocus).toBe('off');
  });

  it('merges partial contextInjection with defaults', () => {
    const raw = makeValidConfig();
    raw.contextInjection = {
      thinkingOs: false,
    };
    const result = validatePdConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    const effective = computeEffectivePdConfig(result.value);
    expect(effective.resolvedContextInjection.thinkingOs).toBe(false);
    expect(effective.resolvedContextInjection.projectFocus).toBe('off');
  });
});
