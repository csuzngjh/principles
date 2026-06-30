import { describe, it, expect } from 'vitest';
import { SignalCollectorOutputSchema, type SignalCollectorOutput } from '../types.js';

describe('SignalCollectorOutputSchema', () => {
  it('accepts a valid STRONG correction signal', () => {
    const valid: SignalCollectorOutput = {
      isSignal: true,
      type: 'correction',
      strength: 'STRONG',
      matchedTerms: ['这是错的'],
      matchedPrecision: 'high',
      detectionSource: 'keyword',
      needsLlmConfirmation: false,
      evidence: { excerpt: '这是错的', detectedAt: '2026-06-30T00:00:00.000Z' },
    };
    expect(SignalCollectorOutputSchema.validate(valid)).toBe(true);
  });

  it('accepts a none signal (no feedback detected)', () => {
    const none: SignalCollectorOutput = {
      isSignal: false,
      type: null,
      strength: null,
      matchedTerms: [],
      matchedPrecision: null,
      detectionSource: 'none',
      needsLlmConfirmation: false,
      evidence: { excerpt: '', detectedAt: '2026-06-30T00:00:00.000Z' },
    };
    expect(SignalCollectorOutputSchema.validate(none)).toBe(true);
  });

  it('rejects output with invalid strength value', () => {
    const bad = { isSignal: true, type: 'correction', strength: 'MEDIUM', matchedTerms: [], matchedPrecision: null, detectionSource: 'keyword', needsLlmConfirmation: false, evidence: { excerpt: '', detectedAt: '' } };
    expect(SignalCollectorOutputSchema.validate(bad)).toBe(false);
  });
});
