import { describe, it, expect } from 'vitest';
import { DistillerPromptBuilder, buildDistillerProtocolInstruction } from '../distiller-prompt-builder.js';
import type { DiagRootCauseOutputV1 } from '../diag-rootcause-output.js';

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

describe('DistillerPromptBuilder', () => {
  it('prompt includes Stage A root cause artifact as input', () => {
    const builder = new DistillerPromptBuilder();
    const result = builder.buildPrompt({
      rootCauseArtifactId: 'artifact-001',
      rootCauseOutput: mockRootCauseOutput,
    });
    expect(result.message).toContain('artifact-001');
  });

  it('prompt includes CORE_PRINCIPLES when coreGrounding=true', () => {
    const instruction = buildDistillerProtocolInstruction({ coreGrounding: true });
    expect(instruction).toContain('T-01');
    expect(instruction).toContain('T-10');
  });

  it('prompt instructs LLM to only reference given axiom IDs, prohibit fabrication', () => {
    const instruction = buildDistillerProtocolInstruction({ coreGrounding: true });
    expect(instruction).toContain('fabricat');
  });

  it('prompt requires output matching DiagDistillerOutputV1Schema', () => {
    const instruction = buildDistillerProtocolInstruction({ coreGrounding: false });
    expect(instruction).toContain('abstractedPrinciple');
    expect(instruction).toContain('groundedOnCorePrincipleIds');
    expect(instruction).toContain('sourceRootCauseArtifactId');
  });
});
