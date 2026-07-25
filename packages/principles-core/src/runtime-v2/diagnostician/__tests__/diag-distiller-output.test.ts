import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DiagDistillerOutputV1Schema, DefaultDiagDistillerValidator } from '../diag-distiller-output.js';

describe('DiagDistillerOutputV1Schema', () => {
  const validOutput = {
    valid: true,
    taskId: 'task-001',
    sourceRootCauseArtifactId: 'artifact-001',
    abstractedPrinciple: 'Prefer explicit error handling over silent fallbacks',
    rationale: 'Root cause shows silent error swallowing',
    groundedOnCorePrincipleIds: ['T-03', 'T-05'],
    scope: 'general',
    confidence: 0.85,
    ambiguityNotes: [],
  };

  it('valid distiller output passes Value.Check', () => {
    expect(Value.Check(DiagDistillerOutputV1Schema, validOutput)).toBe(true);
  });

  it('groundedOnCorePrincipleIds accepts valid T-01..T-10', () => {
    const withAllIds = { ...validOutput, groundedOnCorePrincipleIds: ['T-01', 'T-10'] };
    expect(Value.Check(DiagDistillerOutputV1Schema, withAllIds)).toBe(true);
  });

  it('fabricated axiom ID T-99 passes schema but must be caught by validator', async () => {
    const withFake = { ...validOutput, groundedOnCorePrincipleIds: ['T-99'] };
    // Schema accepts any string array — validator catches fabricated IDs
    expect(Value.Check(DiagDistillerOutputV1Schema, withFake)).toBe(true);
    const validator = new DefaultDiagDistillerValidator();
    const result = await validator.validate(withFake, 'task-001');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('T-99'))).toBe(true);
  });

  it('scope accepts general/domain/scenario', () => {
    for (const scope of ['general', 'domain', 'scenario']) {
      const output = { ...validOutput, scope };
      expect(Value.Check(DiagDistillerOutputV1Schema, output)).toBe(true);
    }
  });

  it('DefaultDiagDistillerValidator rejects fabricated IDs in groundedOnCorePrincipleIds', async () => {
    const validator = new DefaultDiagDistillerValidator();
    const withFabricated = { ...validOutput, groundedOnCorePrincipleIds: ['T-01', 'T-99', 'T-05'] };
    const result = await validator.validate(withFabricated, 'task-001');
    expect(result.valid).toBe(false);
  });

  // PRI-518: LLM in split-pipeline Stage B (diag_distiller) tends to echo the
  // parent task ID it saw in the Stage-A context (e.g. "diagnosis_pain_...")
  // instead of this stage's "diag_distiller-diagnosis_pain_..." id. Stage A's
  // validator already re-injects (BUG-007c); Stage B must do the same, else
  // every Stage B output fails taskId lineage → 0 candidates. Found via real
  // Story A run after the adapter schema-ref fix unblocked Stage A.
  describe('taskId lineage re-injection (BUG-007c, PRI-518)', () => {
    it('re-injects the expected stage taskId when LLM outputs the parent (diagnosis_*) id', async () => {
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const parentTaskId = 'diagnosis_pain_123_abc';
      // LLM output carries the PARENT id (what it saw in Stage A context)
      const llmOutput = { ...validOutput, taskId: parentTaskId };

      const result = await validator.validate(llmOutput, stageTaskId);
      expect(result.valid).toBe(true);
      // taskId was corrected in-place to the trusted caller value (ERR-008:
      // re-injection source is the caller's taskId, never LLM output)
      expect((llmOutput as { taskId: string }).taskId).toBe(stageTaskId);
      expect(result.warnings?.some(w => w.includes('re-injected'))).toBe(true);
    });

    it('still rejects a taskId that is neither the stage id nor the parent id', async () => {
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const llmOutput = { ...validOutput, taskId: 'totally-unrelated-task-9' };

      const result = await validator.validate(llmOutput, stageTaskId);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('taskId mismatch'))).toBe(true);
    });

    it('accepts output that already carries the correct stage taskId (no re-injection)', async () => {
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const llmOutput = { ...validOutput, taskId: stageTaskId };

      const result = await validator.validate(llmOutput, stageTaskId);
      expect(result.valid).toBe(true);
      expect(result.warnings?.length ?? 0).toBe(0);
    });
  });
});
