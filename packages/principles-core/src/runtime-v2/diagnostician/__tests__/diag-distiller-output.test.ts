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
});
