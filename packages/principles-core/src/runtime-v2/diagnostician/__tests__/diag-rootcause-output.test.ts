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
});
