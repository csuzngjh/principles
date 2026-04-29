/**
 * DefaultDiagnosticianValidator comprehensive test suite.
 *
 * Tests all 7 requirement areas (REQ-2.3a through REQ-2.3g) plus
 * D-01 (fail-fast vs verbose), D-03 (error array format), D-04 (errorCategory).
 */
import { describe, it, expect } from 'vitest';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import { DefaultDiagnosticianValidator } from '../default-validator.js';
import type { DiagnosticianValidationResult } from '../diagnostician-validator.js';

// ── Valid output fixture ────────────────────────────────────────────────────────

function makeValidOutput(overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: 'task-001',
    summary: 'Root cause identified',
    rootCause: 'Missing error handling in X module',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'task-001', note: 'Stack trace shows unhandled promise' }],
    recommendations: [{ kind: 'implementation', description: 'Add try-catch around async call' }],
    confidence: 0.85,
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function assertValid(result: DiagnosticianValidationResult): void {
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
  expect(result.errorCategory).toBeUndefined();
}

function assertInvalid(
  result: DiagnosticianValidationResult,
  expectedCategory: 'output_invalid',
  minErrors: number,
): void {
  expect(result.valid).toBe(false);
  expect(result.errorCategory).toBe(expectedCategory);
  expect(result.errors.length).toBeGreaterThanOrEqual(minErrors);
  // errors[0] is aggregate summary
  expect(result.errors[0]).toMatch(/^\d+ field/);
}

// ── REQ-2.3a: Schema correctness ───────────────────────────────────────────────

describe('schema validation', () => {
  it('valid output passes schema check', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput(), 'task-001');
    assertValid(result);
  });

  it('missing required field fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      { valid: true, diagnosisId: 'diag-001' } as unknown as DiagnosticianOutputV1,
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[0]).toMatch(/schema|invalid/i);
  });

  it('wrong field type fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      { ...makeValidOutput(), confidence: 'not-a-number' } as unknown as DiagnosticianOutputV1,
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
  });

  it('additional unknown fields are ignored by TypeBox', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      { ...makeValidOutput(), unknownField: 'should be ignored' } as unknown as DiagnosticianOutputV1,
      'task-001',
    );
    assertValid(result);
  });

  it('null output fails with guard check', async () => {
    const validator = new DefaultDiagnosticianValidator();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await validator.validate(null as any, 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[1]).toContain('non-null object');
  });

  it('non-object output fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await validator.validate('string-output' as any, 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[1]).toContain('non-null object');
  });
});

// ── REQ-2.3b: Non-empty summary/rootCause ─────────────────────────────────────

describe('non-empty fields', () => {
  it('valid non-empty strings pass', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput(), 'task-001');
    assertValid(result);
  });

  it('empty summary fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ summary: '' }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  it('whitespace-only summary fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ summary: '   \n\t' }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  it('empty rootCause fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ rootCause: '' }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('rootCause'))).toBe(true);
  });

  it('whitespace-only rootCause fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ rootCause: '  \n' }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('rootCause'))).toBe(true);
  });
});

// ── REQ-2.3c: Task identity match ─────────────────────────────────────────────

describe('task identity', () => {
  it('matching taskId passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ taskId: 'task-001' }), 'task-001');
    assertValid(result);
  });

  it('mismatched taskId fails with exact values in error', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ taskId: 'task-001' }), 'task-002');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[1]).toContain('task-001');
    expect(result.errors[1]).toContain('task-002');
    expect(result.errors[1]).toContain('taskId mismatch');
  });

  it('different taskId fails even with valid schema', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ taskId: 'other-task' }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
  });
});

// ── REQ-2.3d: Bounded evidence array ─────────────────────────────────────────

describe('evidence array', () => {
  it('empty array passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ evidence: [] }), 'task-001');
    assertValid(result);
  });

  it('array with valid entries passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [
          { sourceRef: 'task-001', note: 'Error log shows failure' },
          { sourceRef: 'task-002', note: 'Code review confirms bug' },
        ],
      }),
      'task-001',
    );
    assertValid(result);
  });

  it('entry with empty sourceRef fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: '', note: 'Some note' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('sourceRef'))).toBe(true);
  });

  it('entry with whitespace-only sourceRef fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: '   \t', note: 'Some note' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('sourceRef'))).toBe(true);
  });

  it('entry with empty note fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'task-001', note: '' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('note'))).toBe(true);
  });

  it('entry with whitespace-only note fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'task-001', note: '  \n' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('note'))).toBe(true);
  });
});

// ── REQ-2.3e: Recommendations shape ─────────────────────────────────────────

describe('recommendations shape', () => {
  it('valid recommendation passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput(), 'task-001');
    assertValid(result);
  });

  it('invalid kind value fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recommendations: [{ kind: 'not-a-kind' as any, description: 'Fix X' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('kind'))).toBe(true);
  });

  it('empty description fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        recommendations: [{ kind: 'implementation', description: '' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('whitespace-only description fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        recommendations: [{ kind: 'implementation', description: '  \n' }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('all valid RecommendationKind values pass', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const kinds = ['rule', 'implementation', 'prompt', 'defer'] as const;
    for (const kind of kinds) {
      const result = await validator.validate(
        makeValidOutput({
          recommendations: [{ kind, description: 'Fix something' }],
        }),
        'task-001',
      );
      assertValid(result);
    }
    // principle kind requires triggerPattern/action/abstractedPrinciple
    const principleResult = await validator.validate(
      makeValidOutput({
        recommendations: [{
          kind: 'principle',
          description: 'Validate tool arguments before execution',
          triggerPattern: 'tool.*argument',
          action: 'Use schema validation',
          abstractedPrinciple: 'Validate inputs before execution',
        }],
      }),
      'task-001',
    );
    assertValid(principleResult);
  });

  it('abstractedPrinciple at 200 chars passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const longPrinciple = 'a'.repeat(200);
    const result = await validator.validate(
      makeValidOutput({
        recommendations: [{
          kind: 'principle',
          description: 'Validate tool arguments before execution',
          triggerPattern: 'tool.*argument',
          action: 'Use schema validation',
          abstractedPrinciple: longPrinciple,
        }],
      }),
      'task-001',
    );
    assertValid(result);
  });

  it('abstractedPrinciple over 200 chars fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const tooLongPrinciple = 'a'.repeat(201);
    const result = await validator.validate(
      makeValidOutput({
        recommendations: [{
          kind: 'principle',
          description: 'Validate tool arguments before execution',
          triggerPattern: 'tool.*argument',
          action: 'Use schema validation',
          abstractedPrinciple: tooLongPrinciple,
        }],
      }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('abstractedPrinciple') && e.includes('200'))).toBe(true);
  });

  it('abstractedPrinciple at 41 chars passes (old 40-char limit increased)', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const principle41 = 'x'.repeat(41);
    const result = await validator.validate(
      makeValidOutput({
        recommendations: [{
          kind: 'principle',
          description: 'Validate tool arguments before execution',
          triggerPattern: 'tool.*argument',
          action: 'Use schema validation',
          abstractedPrinciple: principle41,
        }],
      }),
      'task-001',
    );
    assertValid(result);
  });
});

// ── REQ-2.3f: Confidence range [0, 1] ────────────────────────────────────────

describe('confidence range', () => {
  it('valid value 0 passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: 0 }), 'task-001');
    assertValid(result);
  });

  it('valid value 0.5 passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: 0.5 }), 'task-001');
    assertValid(result);
  });

  it('valid value 1 passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: 1 }), 'task-001');
    assertValid(result);
  });

  it('value -0.001 fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: -0.001 }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('value 1.001 fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: 1.001 }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('negative confidence fails with boundary error message', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: -0.5 }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[1]).toContain('-0.5');
    expect(result.errors[1]).toContain('[0, 1]');
  });

  it('over-confidence fails with boundary error message', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ confidence: 2.0 }), 'task-001');
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors[1]).toContain('2');
    expect(result.errors[1]).toContain('[0, 1]');
  });
});

// ── REQ-2.3g: Evidence sourceRef back-check ──────────────────────────────────

describe('evidence sourceRef back-check', () => {
  it('standard mode: non-empty sourceRef string passes even if not in any context', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'arbitrary-ref', note: 'Some note' }],
      }),
      'task-001',
    );
    assertValid(result); // format check only — no existence check in standard mode
  });

  it('verbose mode: matching sourceRef passes', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'task-001', note: 'Some note' }],
      }),
      'task-001',
      { verbose: true, sourceRefs: ['task-001', 'task-002'] },
    );
    assertValid(result);
  });

  it('verbose mode: non-matching sourceRef fails', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'unknown-ref', note: 'Some note' }],
      }),
      'task-001',
      { verbose: true, sourceRefs: ['task-001', 'task-002'] },
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('unknown-ref'))).toBe(true);
    expect(result.errors.some((e) => e.includes('not found in context'))).toBe(true);
  });

  it('verbose mode: multiple non-matching sourceRefs collect all errors', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [
          { sourceRef: 'ref-a', note: 'Note A' },
          { sourceRef: 'ref-b', note: 'Note B' },
        ],
      }),
      'task-001',
      { verbose: true, sourceRefs: ['task-001'] },
    );
    assertInvalid(result, 'output_invalid', 2);
    expect(result.errors.some((e) => e.includes('ref-a'))).toBe(true);
    expect(result.errors.some((e) => e.includes('ref-b'))).toBe(true);
  });

  it('verbose mode: empty sourceRefs array treats all refs as unmatched', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'task-001', note: 'Some note' }],
      }),
      'task-001',
      { verbose: true, sourceRefs: [] },
    );
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors.some((e) => e.includes('task-001'))).toBe(true);
  });

  it('verbose mode without sourceRefs: skips existence check', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({
        evidence: [{ sourceRef: 'any-ref', note: 'Some note' }],
      }),
      'task-001',
      { verbose: true }, // no sourceRefs provided
    );
    // Should pass because no sourceRefs array means existence check is skipped
    assertValid(result);
  });
});

// ── D-01: fail-fast vs verbose collect-all ─────────────────────────────────────

describe('fail-fast vs verbose', () => {
  it('standard mode: returns single error (first encountered)', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong-id', confidence: -0.5 }),
      'task-001',
    );
    // Should fail on first error: taskId mismatch (checked before confidence)
    assertInvalid(result, 'output_invalid', 1);
    expect(result.errors).toHaveLength(2); // summary + one detail
    expect(result.errors[1]).toContain('taskId mismatch');
  });

  it('verbose mode: returns all errors collected', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong-id', confidence: -0.5 }),
      'task-001',
      { verbose: true },
    );
    assertInvalid(result, 'output_invalid', 2);
    // Multiple errors should be present
    expect(result.errors.length).toBeGreaterThan(2);
    expect(result.errors.some((e) => e.includes('taskId mismatch'))).toBe(true);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('standard mode with multiple errors: first error only', async () => {
    const validator = new DefaultDiagnosticianValidator();
    // Multiple errors: taskId mismatch, confidence out of range, empty summary
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong', confidence: 2, summary: '' }),
      'task-001',
    );
    assertInvalid(result, 'output_invalid', 1);
    // Only first error
    expect(result.errors[1]).toContain('taskId mismatch');
  });

  it('verbose mode with multiple errors across all checks: all collected', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong', confidence: 2, summary: '', rootCause: '' }),
      'task-001',
      { verbose: true },
    );
    assertInvalid(result, 'output_invalid', 4);
    expect(result.errors.some((e) => e.includes('taskId mismatch'))).toBe(true);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
    expect(result.errors.some((e) => e.includes('rootCause'))).toBe(true);
  });
});

// ── D-03: errors[0]=aggregate, errors[1..N]=detail ─────────────────────────────

describe('error array format', () => {
  it('errors[0] contains aggregate summary with count', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ taskId: 'wrong' }), 'task-001');
    expect(result.errors[0]).toMatch(/^\d+ field/);
    expect(result.errors[0]).toMatch(/taskId|invalid/i);
  });

  it('errors[1..N] contain per-field detail messages', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput({ taskId: 'wrong' }), 'task-001');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors[1]).toContain('taskId');
  });

  it('when no errors: errors array is empty and valid=true', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput(), 'task-001');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('verbose mode: errors[0] aggregate reflects total error count', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong', rootCause: 'valid root cause' }),
      'task-001',
      { verbose: true },
    );
    // Only taskId mismatch → 1 semantic error (no schema errors)
    expect(result.errors[0]).toMatch(/1 field invalid/);
    expect(result.errors).toHaveLength(2); // summary + 1 detail
  });
});

// ── D-04: errorCategory='output_invalid' on all failures ─────────────────────

describe('errorCategory', () => {
  it('all failures have errorCategory=output_invalid', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const cases: DiagnosticianOutputV1[] = [
      makeValidOutput({ taskId: 'wrong' }),
      makeValidOutput({ confidence: -0.1 }),
      makeValidOutput({ summary: '' }),
      makeValidOutput({ evidence: [{ sourceRef: '', note: 'x' }] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...makeValidOutput({ recommendations: [{ kind: 'bad' as any, description: 'x' }] }) },
    ];
    for (const output of cases) {
      const result = await validator.validate(output, 'task-001');
      expect(result.errorCategory).toBe('output_invalid');
    }
  });

  it('valid output has no errorCategory (undefined)', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(makeValidOutput(), 'task-001');
    expect(result.errorCategory).toBeUndefined();
  });

  it('verbose mode failures also have output_invalid category', async () => {
    const validator = new DefaultDiagnosticianValidator();
    const result = await validator.validate(
      makeValidOutput({ taskId: 'wrong', confidence: -0.1 }),
      'task-001',
      { verbose: true },
    );
    expect(result.errorCategory).toBe('output_invalid');
  });
});
