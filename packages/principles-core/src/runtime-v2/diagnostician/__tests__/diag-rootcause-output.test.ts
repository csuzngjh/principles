import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DiagRootCauseOutputV1Schema, DefaultDiagRootCauseValidator } from '../diag-rootcause-output.js';

describe('DiagRootCauseOutputV1Schema', () => {
  const validOutput = {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: 'task-001',
    summary: 'Test summary',
    causalChain: [
      { why: 1, statement: 'First why', evidenceRefs: ['ref1'] },
      { why: 2, statement: 'Second why', evidenceRefs: [] },
    ],
    rootCause: 'Design: Poor error handling',
    rootCauseCategory: 'Design',
    evidence: [{ sourceRef: 'src1', note: 'note1' }],
    confidence: 0.8,
    ambiguityNotes: ['note1'],
  };

  it('valid root cause output passes Value.Check', () => {
    expect(Value.Check(DiagRootCauseOutputV1Schema, validOutput)).toBe(true);
  });

  it('missing required field fails Value.Check', () => {
    const { summary: _summary, ...missing } = validOutput;
    expect(Value.Check(DiagRootCauseOutputV1Schema, missing)).toBe(false);
  });

  it('extra fields are stripped by Value.Clean', () => {
    const withExtra = { ...validOutput, extraField: 'should be removed' };
    const cleaned = Value.Clean(DiagRootCauseOutputV1Schema, withExtra) as Record<string, unknown>;
    expect(Object.hasOwn(cleaned, 'extraField')).toBe(false);
  });

  it('DefaultDiagRootCauseValidator accepts valid output', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const result = await validator.validate(validOutput, 'task-001');
    expect(result.valid).toBe(true);
  });

  it('DefaultDiagRootCauseValidator rejects invalid output', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const result = await validator.validate({}, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
