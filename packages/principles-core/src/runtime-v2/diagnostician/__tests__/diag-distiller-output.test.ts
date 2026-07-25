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
    it('re-injects when LLM outputs the Stage A id (diag_rootcause- prefix, same suffix)', async () => {
      // Real Story A bug: Stage B LLM echoes the Stage A task id
      // (diag_rootcause-diagnosis_pain_...) instead of this stage's
      // diag_distiller-diagnosis_pain_... — same suffix, wrong prefix.
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const echoedStageAId = 'diag_rootcause-diagnosis_pain_123_abc';
      const llmOutput = { ...validOutput, taskId: echoedStageAId };

      const result = await validator.validate(llmOutput, stageTaskId);
      expect(result.valid).toBe(true);
      expect((llmOutput as { taskId: string }).taskId).toBe(stageTaskId);
      expect(result.warnings?.some(w => w.includes('re-injected'))).toBe(true);
    });

    it('re-injects when LLM outputs the parent (diagnosis_*) id (no diag prefix)', async () => {
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const parentTaskId = 'diagnosis_pain_123_abc';
      const llmOutput = { ...validOutput, taskId: parentTaskId };

      const result = await validator.validate(llmOutput, stageTaskId);
      expect(result.valid).toBe(true);
      expect((llmOutput as { taskId: string }).taskId).toBe(stageTaskId);
    });

    it('still rejects a taskId with a different suffix', async () => {
      const validator = new DefaultDiagDistillerValidator();
      const stageTaskId = 'diag_distiller-diagnosis_pain_123_abc';
      const llmOutput = { ...validOutput, taskId: 'diag_rootcause-totally-different-9' };

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
