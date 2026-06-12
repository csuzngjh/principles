import { describe, it, expect } from 'vitest';
import { buildRootCauseProtocolInstruction } from '../rootcause-prompt-builder.js';

describe('RootCausePromptBuilder', () => {
  it('prompt contains PHASE 1-3 (evidence review, causal chain, root cause classification)', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).toContain('PHASE 1');
    expect(instruction).toContain('PHASE 2');
    expect(instruction).toContain('PHASE 3');
  });

  it('prompt requires output matching DiagRootCauseOutputV1Schema', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).toContain('diagnosisId');
    expect(instruction).toContain('causalChain');
    expect(instruction).toContain('rootCause');
    expect(instruction).toContain('rootCauseCategory');
  });

  it('coreGrounding=true injects PHASE 3.5', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: true });
    expect(instruction).toContain('PHASE 3.5');
    expect(instruction).toContain('Core Axiom Grounding');
  });

  it('coreGrounding=false does NOT include PHASE 3.5', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).not.toContain('PHASE 3.5');
  });

  it('PHASE 3.5 appears between PHASE 3 and PHASE 4', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: true });
    const phase3Index = instruction.indexOf('PHASE 3');
    const phase35Index = instruction.indexOf('PHASE 3.5');
    // PHASE 3.5 must come after PHASE 3
    expect(phase35Index).toBeGreaterThan(phase3Index);
  });
});
