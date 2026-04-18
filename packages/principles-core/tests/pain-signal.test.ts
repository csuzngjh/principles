import { describe, it, expect } from 'vitest';
import { validatePainSignal, deriveSeverity, PainSignalSchema } from '../src/pain-signal.js';

describe('deriveSeverity', () => {
  it('returns low for scores 0-39', () => {
    expect(deriveSeverity(0)).toBe('low');
    expect(deriveSeverity(20)).toBe('low');
    expect(deriveSeverity(39)).toBe('low');
  });

  it('returns medium for scores 40-69', () => {
    expect(deriveSeverity(40)).toBe('medium');
    expect(deriveSeverity(55)).toBe('medium');
    expect(deriveSeverity(69)).toBe('medium');
  });

  it('returns high for scores 70-89', () => {
    expect(deriveSeverity(70)).toBe('high');
    expect(deriveSeverity(80)).toBe('high');
    expect(deriveSeverity(89)).toBe('high');
  });

  it('returns critical for scores 90-100', () => {
    expect(deriveSeverity(90)).toBe('critical');
    expect(deriveSeverity(95)).toBe('critical');
    expect(deriveSeverity(100)).toBe('critical');
  });
});

describe('validatePainSignal', () => {
  function createValidSignal(overrides = {}) {
    return {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-04-17T00:00:00.000Z',
      reason: 'Tool write failed: ENOENT',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'write(/tmp/nonexistent)',
      domain: 'coding',
      severity: 'high',
      context: {},
      ...overrides,
    };
  }

  it('returns valid=true for a fully-specified PainSignal', () => {
    const result = validatePainSignal(createValidSignal());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.signal).toBeDefined();
    expect(result.signal?.source).toBe('tool_failure');
  });

  it('applies domain default when missing', () => {
    const signal = createValidSignal();
    delete (signal as any).domain;
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.signal?.domain).toBe('coding');
  });

  it('derives severity from score when missing', () => {
    const signal = createValidSignal({ score: 85 });
    delete (signal as any).severity;
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.signal?.severity).toBe('high');
  });

  it('defaults context to empty object when missing', () => {
    const signal = createValidSignal();
    delete (signal as any).context;
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.signal?.context).toEqual({});
  });

  it('returns valid=false for null input', () => {
    const result = validatePainSignal(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false for non-object input', () => {
    expect(validatePainSignal('string').valid).toBe(false);
    expect(validatePainSignal(123).valid).toBe(false);
    expect(validatePainSignal([]).valid).toBe(false);
  });

  it('returns valid=false for missing required field source', () => {
    const signal = createValidSignal();
    delete (signal as any).source;
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('source'))).toBe(true);
  });

  it('returns valid=false for score out of range (< 0)', () => {
    const result = validatePainSignal(createValidSignal({ score: -1 }));
    expect(result.valid).toBe(false);
  });

  it('returns valid=false for score out of range (> 100)', () => {
    const result = validatePainSignal(createValidSignal({ score: 101 }));
    expect(result.valid).toBe(false);
  });

  it('returns valid=false for non-numeric score', () => {
    const result = validatePainSignal(createValidSignal({ score: 'high' as any }));
    expect(result.valid).toBe(false);
  });

  it('boundary: score 39 is low, score 40 is medium', () => {
    expect(deriveSeverity(39)).toBe('low');
    expect(deriveSeverity(40)).toBe('medium');
  });
});
