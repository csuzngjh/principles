import { describe, it, expect } from 'vitest';
import {
  PainSignalSchema,
  validatePainSignal,
  deriveSeverity,
  type PainSignal,
} from '../../src/core/pain-signal.js';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produces a valid minimal PainSignal object. */
function validSignal(overrides: Partial<PainSignal> = {}): PainSignal {
  return {
    source: 'tool_failure',
    score: 75,
    timestamp: '2026-04-17T00:00:00.000Z',
    reason: 'Build failed with exit code 1',
    sessionId: 'session-001',
    agentId: 'main',
    traceId: 'trace-abc',
    triggerTextPreview: 'npm run build',
    domain: 'coding',
    severity: 'high',
    context: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PainSignalSchema
// ---------------------------------------------------------------------------

describe('PainSignalSchema', () => {
  it('accepts a valid signal', () => {
    const signal = validSignal();
    expect(Value.Check(PainSignalSchema, signal)).toBe(true);
  });

  it('rejects signal with missing required source', () => {
    const signal = validSignal();
    delete (signal as Record<string, unknown>).source;
    expect(Value.Check(PainSignalSchema, signal)).toBe(false);
  });

  it('rejects signal with missing required reason', () => {
    const signal = validSignal();
    delete (signal as Record<string, unknown>).reason;
    expect(Value.Check(PainSignalSchema, signal)).toBe(false);
  });

  it('rejects score below 0', () => {
    const signal = validSignal({ score: -1 });
    expect(Value.Check(PainSignalSchema, signal)).toBe(false);
  });

  it('rejects score above 100', () => {
    const signal = validSignal({ score: 101 });
    expect(Value.Check(PainSignalSchema, signal)).toBe(false);
  });

  it('rejects empty source string', () => {
    const signal = validSignal({ source: '' });
    expect(Value.Check(PainSignalSchema, signal)).toBe(false);
  });

  it('accepts empty optional fields (sessionId, agentId, etc.)', () => {
    const signal = validSignal({
      sessionId: '',
      agentId: '',
      traceId: '',
      triggerTextPreview: '',
    });
    expect(Value.Check(PainSignalSchema, signal)).toBe(true);
  });

  it('accepts any string for domain', () => {
    const signal = validSignal({ domain: 'writing' });
    expect(Value.Check(PainSignalSchema, signal)).toBe(true);
  });

  it('accepts context with mixed value types', () => {
    const signal = validSignal({ context: { filePath: '/src/index.ts', lineCount: 42 } });
    expect(Value.Check(PainSignalSchema, signal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveSeverity
// ---------------------------------------------------------------------------

describe('deriveSeverity', () => {
  it('returns "low" for scores 0-39', () => {
    expect(deriveSeverity(0)).toBe('low');
    expect(deriveSeverity(20)).toBe('low');
    expect(deriveSeverity(39)).toBe('low');
  });

  it('returns "medium" for scores 40-69', () => {
    expect(deriveSeverity(40)).toBe('medium');
    expect(deriveSeverity(55)).toBe('medium');
    expect(deriveSeverity(69)).toBe('medium');
  });

  it('returns "high" for scores 70-89', () => {
    expect(deriveSeverity(70)).toBe('high');
    expect(deriveSeverity(80)).toBe('high');
    expect(deriveSeverity(89)).toBe('high');
  });

  it('returns "critical" for scores 90-100', () => {
    expect(deriveSeverity(90)).toBe('critical');
    expect(deriveSeverity(95)).toBe('critical');
    expect(deriveSeverity(100)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// validatePainSignal
// ---------------------------------------------------------------------------

describe('validatePainSignal', () => {
  it('validates a correct signal and returns it typed', () => {
    const input = validSignal();
    const result = validatePainSignal(input);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.signal).toEqual(input);
  });

  it('fills default domain when missing', () => {
    const input = validSignal();
    delete (input as Record<string, unknown>).domain;
    const result = validatePainSignal(input);
    expect(result.valid).toBe(true);
    expect(result.signal?.domain).toBe('coding');
  });

  it('fills default severity from score when missing', () => {
    const input = validSignal({ score: 45 });
    delete (input as Record<string, unknown>).severity;
    const result = validatePainSignal(input);
    expect(result.valid).toBe(true);
    expect(result.signal?.severity).toBe('medium');
  });

  it('fills default context when missing', () => {
    const input = validSignal();
    delete (input as Record<string, unknown>).context;
    const result = validatePainSignal(input);
    expect(result.valid).toBe(true);
    expect(result.signal?.context).toEqual({});
  });

  it('rejects non-object input', () => {
    const result = validatePainSignal('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Input must be a non-null object');
  });

  it('rejects null input', () => {
    const result = validatePainSignal(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Input must be a non-null object');
  });

  it('rejects array input', () => {
    const result = validatePainSignal([1, 2, 3]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Input must be a non-null object');
  });

  it('reports errors for missing required fields', () => {
    const result = validatePainSignal({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid score type', () => {
    const result = validatePainSignal({ ...validSignal(), score: 'high' });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid severity value', () => {
    const result = validatePainSignal({ ...validSignal(), severity: 'extreme' });
    expect(result.valid).toBe(false);
  });
});
