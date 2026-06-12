import { describe, it, expect } from 'vitest';
import { RouterPromptBuilder } from '../router-prompt-builder.js';
import type { DiagRootCauseOutputV1 } from '../diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diag-distiller-output.js';

const mockRootCauseOutput: DiagRootCauseOutputV1 = {
  valid: true,
  diagnosisId: 'diag-001',
  taskId: 'task-001',
  summary: 'Test summary',
  causalChain: [{ why: 1, statement: 'First why', evidenceRefs: ['ref1'] }],
  rootCause: 'Design: Poor error handling',
  rootCauseCategory: 'Design',
  evidence: [{ sourceRef: 'src1', note: 'note1' }],
  confidence: 0.8,
};

const mockDistillerOutput: DiagDistillerOutputV1 = {
  valid: true,
  taskId: 'task-001',
  sourceRootCauseArtifactId: 'artifact-001',
  abstractedPrinciple: 'Prefer explicit error handling over silent fallbacks',
  rationale: 'Root cause shows silent error swallowing',
  groundedOnCorePrincipleIds: ['T-03'],
  scope: 'general',
  confidence: 0.85,
};

describe('RouterPromptBuilder', () => {
  it('prompt includes Stage A + Stage B artifacts as input', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt({
      rootCauseArtifactId: 'artifact-001',
      rootCauseOutput: mockRootCauseOutput,
      distillerArtifactId: 'artifact-002',
      distillerOutput: mockDistillerOutput,
    });
    expect(result.message).toContain('artifact-001');
    expect(result.message).toContain('artifact-002');
  });

  it('prompt requires output matching DiagnosticianOutputV1Schema', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('violatedPrinciples');
    expect(instruction).toContain('recommendations');
  });

  it('prompt instructs filling violatedPrinciples from A + B', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('violatedPrinciples');
  });

  it('prompt instructs filling recommendations from taxonomy decision', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('principle');
    expect(instruction).toContain('rule');
    expect(instruction).toContain('implementation');
    expect(instruction).toContain('prompt');
    expect(instruction).toContain('defer');
  });
});
