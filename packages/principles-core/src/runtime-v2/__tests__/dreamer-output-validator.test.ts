import { describe, it, expect } from 'vitest';
import { DefaultDreamerValidator } from '../internalization/dreamer-output.js';
import type { DreamerOutput } from '../internalization/dreamer-output.js';

const TASK_ID = 'task-dreamer-001';

function makeValidOutput(): DreamerOutput {
  return {
    valid: true,
    taskId: TASK_ID,
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'Ignored error handling',
        betterDecision: 'Add try/catch around async calls',
        rationale: 'Error handling prevents unhandled rejections',
        confidence: 0.85,
        riskLevel: 'low',
        strategicPerspective: 'reliability',
      },
    ],
    contextRefs: [],
    generatedAt: '2026-05-01T00:00:00Z',
  };
}

describe('DefaultDreamerValidator (PRI-87)', () => {
  const validator = new DefaultDreamerValidator();

  it('accepts valid Dreamer output', async () => {
    const result = await validator.validate(makeValidOutput(), TASK_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects output with taskId mismatch', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).taskId = 'wrong-task-id';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
  });

  it('rejects output with valid=false', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).valid = false;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('valid must be true'))).toBe(true);
  });

  it('rejects output with missing candidates array', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).candidates = undefined;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('candidates must be an array'))).toBe(true);
  });

  it('rejects output with empty candidates array', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).candidates = [];
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('1-5'))).toBe(true);
  });

  it('rejects candidate with confidence as string', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).confidence = '0.85';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence must be number'))).toBe(true);
  });

  it('rejects candidate with confidence < 0', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).confidence = -0.1;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('[0, 1]'))).toBe(true);
  });

  it('rejects candidate with confidence > 1', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).confidence = 1.5;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('[0, 1]'))).toBe(true);
  });

  it('rejects candidate with unknown riskLevel', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).riskLevel = 'critical';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('riskLevel must be low|medium|high'))).toBe(true);
  });

  it('rejects candidate with empty badDecision', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).badDecision = '  ';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('badDecision must be non-empty'))).toBe(true);
  });

  it('rejects candidate with empty betterDecision', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).betterDecision = '';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('betterDecision must be non-empty'))).toBe(true);
  });

  it('rejects candidate with empty rationale', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).rationale = '';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rationale must be non-empty'))).toBe(true);
  });

  it('rejects candidate with empty strategicPerspective', async () => {
    const output = makeValidOutput();
    (output.candidates[0] as unknown as Record<string, unknown>).strategicPerspective = '  ';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('strategicPerspective must be non-empty'))).toBe(true);
  });

  it('rejects output with missing contextRefs', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).contextRefs = undefined;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('contextRefs must be an array'))).toBe(true);
  });

  it('rejects output with missing generatedAt', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).generatedAt = '';
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('generatedAt must be non-empty'))).toBe(true);
  });

  it('returns errorCategory output_invalid on rejection', async () => {
    const output = makeValidOutput();
    (output as unknown as Record<string, unknown>).valid = false;
    const result = await validator.validate(output, TASK_ID);
    expect(result.errorCategory).toBe('output_invalid');
  });

  it('accepts output with 5 candidates (upper bound)', async () => {
    const output = makeValidOutput();
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      candidateIndex: i,
      badDecision: `Bad ${i}`,
      betterDecision: `Better ${i}`,
      rationale: `Rationale ${i}`,
      confidence: 0.5,
      riskLevel: 'medium' as const,
      strategicPerspective: `perspective ${i}`,
    }));
    (output as unknown as Record<string, unknown>).candidates = candidates;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(true);
  });

  it('rejects output with 6 candidates (exceeds upper bound)', async () => {
    const output = makeValidOutput();
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      candidateIndex: i,
      badDecision: `Bad ${i}`,
      betterDecision: `Better ${i}`,
      rationale: `Rationale ${i}`,
      confidence: 0.5,
      riskLevel: 'medium' as const,
      strategicPerspective: `perspective ${i}`,
    }));
    (output as unknown as Record<string, unknown>).candidates = candidates;
    const result = await validator.validate(output, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('1-5'))).toBe(true);
  });

  it('rejects null output', async () => {
    const result = await validator.validate(null, TASK_ID);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toBe('Output is not an object');
  });
});
