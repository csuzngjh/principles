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
      { why: 2, statement: 'Second why', evidenceRefs: ['ref1'] },
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

  it('rejects rootCause without category prefix', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, rootCause: 'Poor error handling', rootCauseCategory: 'Design' };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('must start with "Design: "'))).toBe(true);
  });

  it('accepts rootCause with matching category prefix', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, rootCause: 'People: Insufficient review process', rootCauseCategory: 'People' };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(true);
  });

  // ── BUG-007c: taskId re-injection tests (PRI-401) ───────────────────────────

  it('re-injects taskId when LLM outputs parent task ID (BUG-007c)', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'diagnosis_manual_xxx' };
    const expectedTaskId = 'diag_rootcause-diagnosis_manual_xxx';
    const result = await validator.validate(output, expectedTaskId);
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toContain('re-injected');
    // Verify the output was mutated to have the correct taskId
    expect(output.taskId).toBe(expectedTaskId);
  });

  it('re-injection value comes from caller expectedTaskId, not LLM output (ERR-008)', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'diagnosis_manual_xxx' };
    const expectedTaskId = 'diag_rootcause-diagnosis_manual_xxx';
    await validator.validate(output, expectedTaskId);
    // The re-injected value must be the caller's expectedTaskId
    expect(output.taskId).toBe(expectedTaskId);
  });

  it('still errors on truly mismatched taskId (not parent/child relationship)', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'completely-different-task' };
    const result = await validator.validate(output, 'diag_rootcause-diagnosis_manual_xxx');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('taskId mismatch'))).toBe(true);
  });

  it('still errors when taskId matches but other fields are invalid', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'task-001', rootCauseCategory: 'InvalidCategory' };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
  });

  // PRI-401 regression tests — taskId re-injection edge cases
  it('re-injects taskId when LLM outputs parent task ID with different prefix', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'diagnosis_manual_yyy' };
    const expectedTaskId = 'diag_rootcause-diagnosis_manual_yyy';
    const result = await validator.validate(output, expectedTaskId);
    expect(result.valid).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(output.taskId).toBe(expectedTaskId);
  });

  it('does not re-inject when taskId is completely different (not parent-child relationship)', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: 'completely_different_task' };
    const expectedTaskId = 'diag_rootcause-diagnosis_manual_zzz';
    const result = await validator.validate(output, expectedTaskId);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('taskId mismatch'))).toBe(true);
    // taskId should NOT be modified
    expect(output.taskId).toBe('completely_different_task');
  });

  it('handles empty taskId gracefully', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: '' };
    const result = await validator.validate(output, 'diag_rootcause-diagnosis_manual_empty');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('taskId mismatch'))).toBe(true);
  });

  it('handles null taskId gracefully', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, taskId: null };
    const result = await validator.validate(output, 'diag_rootcause-diagnosis_manual_null');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('taskId mismatch'))).toBe(true);
  });

  it('handles undefined taskId gracefully', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    // Create a copy without taskId property
    const output = { ...validOutput, taskId: undefined };
    const result = await validator.validate(output, 'diag_rootcause-diagnosis_manual_undefined');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('taskId mismatch'))).toBe(true);
  });

  it('validates causalChain ordering (why field must be 1-5)', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = {
      ...validOutput,
      causalChain: [
        { why: 0, statement: 'Invalid why', evidenceRefs: ['ref1'] }, // why < 1
        { why: 6, statement: 'Invalid why', evidenceRefs: ['ref2'] }, // why > 5
      ],
    };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('why must be a number in [1, 5]'))).toBe(true);
  });

  it('validates causalChain evidenceRefs must have at least 1 item', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = {
      ...validOutput,
      causalChain: [
        { why: 1, statement: 'Valid why', evidenceRefs: [] }, // Empty evidenceRefs
      ],
    };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('evidenceRefs must have at least 1 item'))).toBe(true);
  });

  it('validates causalChain statement must be non-empty', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = {
      ...validOutput,
      causalChain: [
        { why: 1, statement: '', evidenceRefs: ['ref1'] }, // Empty statement
      ],
    };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('statement must be a non-empty string'))).toBe(true);
  });

  it('validates evidence sourceRef must be non-empty', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = {
      ...validOutput,
      evidence: [
        { sourceRef: '', note: 'valid note' }, // Empty sourceRef
      ],
    };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('sourceRef must be a non-empty string'))).toBe(true);
  });

  it('validates evidence note must be non-empty', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = {
      ...validOutput,
      evidence: [
        { sourceRef: 'valid-ref', note: '' }, // Empty note
      ],
    };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('note must be a non-empty string'))).toBe(true);
  });

  it('validates confidence must be in [0, 1]', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, confidence: 1.5 }; // Out of range
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    // TypeBox schema validation should catch this
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates valid flag must be true', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, valid: false };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('valid must be true'))).toBe(true);
  });

  it('handles missing causalChain gracefully', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    // Create a copy without causalChain property
    const output = { ...validOutput, causalChain: undefined };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    // TypeBox schema validation should catch missing required field
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles missing evidence gracefully', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    // Create a copy without evidence property
    const output = { ...validOutput, evidence: undefined };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    // TypeBox schema validation should catch missing required field
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles all rootCauseCategory values correctly', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const categories: Array<'People' | 'Design' | 'Assumption' | 'Tooling'> = ['People', 'Design', 'Assumption', 'Tooling'];

    for (const category of categories) {
      const output = {
        ...validOutput,
        rootCause: `${category}: Some root cause`,
        rootCauseCategory: category,
      };
      const result = await validator.validate(output, 'task-001');
      expect(result.valid).toBe(true);
    }
  });

  it('rejects rootCauseCategory that is not in the allowed set', async () => {
    const validator = new DefaultDiagRootCauseValidator();
    const output = { ...validOutput, rootCauseCategory: 'UnknownCategory' };
    const result = await validator.validate(output, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('People|Design|Assumption|Tooling'))).toBe(true);
  });
});
