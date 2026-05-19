/**
 * TraceRefinerAgent shadow contract tests (PRI-192).
 *
 * TDD tests for:
 *   - createTraceRefinerAgentInput: input construction
 *   - validateTraceRefinerAgentOutput: strict output validation
 *   - applyTraceRefinerAgentShadowResult: shadow-mode application
 *   - SourceRef anti-forgery
 *   - Confidence bounds
 *   - Blocked status handling
 *   - Architecture guard
 */
import { describe, it, expect } from 'vitest';
import {
  createTraceRefinerAgentInput,
  validateTraceRefinerAgentOutput,
  applyTraceRefinerAgentShadowResult,
} from '../trace-refiner-agent.js';
import type {
  TraceRefinerAgentOutput,
} from '../trace-refiner-agent.js';
import type { FullTracePayloadV2 } from '../full-trace-contract.js';
import type { RefinedTracePayload } from '../trace-refiner.js';
import { refineFullTrace } from '../trace-refiner.js';

function makeValidFullTrace(overrides?: Partial<FullTracePayloadV2>): FullTracePayloadV2 {
  return {
    sourceTaskId: 'task_src_001',
    sourcePainId: 'pain-001',
    sourceRunIds: ['run_001', 'run_002'],
    capturedAt: '2026-05-19T00:00:00Z',
    sourceRefs: [
      { kind: 'task', id: 'task_src_001' },
      { kind: 'run', id: 'run_001' },
      { kind: 'run', id: 'run_002' },
      { kind: 'artifact', id: 'artifact_log_001' },
    ],
    timeline: [
      { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Fix the bug' },
      { at: '2026-05-19T00:00:01Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
      { at: '2026-05-19T00:00:02Z', kind: 'tool_result', summary: 'Error from Read', metadata: { toolName: 'Read', error: 'file not found' } },
    ],
    ambiguityNotes: [],
    sanitizationNotes: [],
    ...overrides,
  };
}

function makeValidRefinedTrace(fullTrace: FullTracePayloadV2): RefinedTracePayload {
  return refineFullTrace(fullTrace);
}

function makeValidAgentOutput(
  refinedTrace: RefinedTracePayload,
  overrides?: Partial<TraceRefinerAgentOutput>,
): TraceRefinerAgentOutput {
  return {
    status: 'refined',
    refinedTrace,
    evidenceMap: [
      { claim: 'Tool Read failed with file not found', sourceRefs: ['run:run_001'] },
    ],
    rejectedEvidence: [],
    confidence: 0.85,
    generatedAt: '2026-05-19T00:01:00Z',
    ...overrides,
  };
}

// ── createTraceRefinerAgentInput ──

describe('createTraceRefinerAgentInput', () => {
  it('sets constraints to literal true values and mode=shadow', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');

    expect(input.mode).toBe('shadow');
    expect(input.constraints.preserveSourceRefs).toBe(true);
    expect(input.constraints.doNotInventEvidence).toBe(true);
    expect(input.constraints.redactSecrets).toBe(true);
  });

  it('preserves fullTrace and deterministicRefinedTrace', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'golden_trace_candidate');

    expect(input.fullTrace).toBe(fullTrace);
    expect(input.deterministicRefinedTrace).toBe(refined);
  });

  it('sets objective correctly', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);

    const input1 = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    expect(input1.objective).toBe('diagnosis_input');

    const input2 = createTraceRefinerAgentInput(fullTrace, refined, 'golden_trace_candidate');
    expect(input2.objective).toBe('golden_trace_candidate');

    const input3 = createTraceRefinerAgentInput(fullTrace, refined, 'l2_replay_case');
    expect(input3.objective).toBe('l2_replay_case');
  });
});

// ── validateTraceRefinerAgentOutput: valid refined output ──

describe('validateTraceRefinerAgentOutput: valid output', () => {
  it('valid refined output passes strict validator', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.status).toBe('refined');
      expect(result.output.confidence).toBe(0.85);
    }
  });
});

// ── validateTraceRefinerAgentOutput: claim without sourceRefs ──

describe('validateTraceRefinerAgentOutput: sourceRefs validation', () => {
  it('claim without sourceRefs fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      evidenceMap: [
        { claim: 'Some claim without refs', sourceRefs: [] },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('sourceRefs'))).toBe(true);
    }
  });

  it('invented source ref not present in input fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      evidenceMap: [
        { claim: 'Claim with invented ref', sourceRefs: ['task:invented_task_999'] },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('invented') || e.includes('allowed'))).toBe(true);
    }
  });

  it('valid sourceRef from fullTrace.sourceRefs passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      evidenceMap: [
        { claim: 'Valid claim', sourceRefs: ['task:task_src_001'] },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });

  it('valid sourceRef from refinedTrace.evidenceRefs passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      evidenceMap: [
        { claim: 'Valid claim from evidenceRefs', sourceRefs: refined.evidenceRefs },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });

  it('valid sourceRef from refinedTrace.keyEvents evidenceRefs passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');

    const keyEventRefs = refined.keyEvents.flatMap((e) => e.evidenceRefs);
    if (keyEventRefs.length === 0) {
      return;
    }
    const output = makeValidAgentOutput(refined, {
      evidenceMap: [
        { claim: 'Valid claim from keyEvents', sourceRefs: keyEventRefs.slice(0, 1) },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });
});

// ── validateTraceRefinerAgentOutput: status=blocked ──

describe('validateTraceRefinerAgentOutput: blocked status', () => {
  it('status=blocked preserves blockedReason and does not replace deterministic trace', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      status: 'blocked',
      blockedReason: 'Insufficient evidence to refine',
      evidenceMap: [],
      confidence: 0,
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.status).toBe('blocked');
      expect(result.output.blockedReason).toBe('Insufficient evidence to refine');
    }
  });

  it('status=blocked without blockedReason fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      status: 'blocked',
      blockedReason: undefined,
      evidenceMap: [],
      confidence: 0,
    } as Partial<TraceRefinerAgentOutput>);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('blockedReason'))).toBe(true);
    }
  });

  it('status=blocked with empty blockedReason fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      status: 'blocked',
      blockedReason: '',
      evidenceMap: [],
      confidence: 0,
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('blockedReason'))).toBe(true);
    }
  });
});

// ── validateTraceRefinerAgentOutput: invalid output ──

describe('validateTraceRefinerAgentOutput: invalid output', () => {
  it('invalid agent output returns agent_output_invalid and selectedTrace remains deterministic', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');

    const result = applyTraceRefinerAgentShadowResult(input, { garbage: true });

    expect(result.mode).toBe('shadow');
    expect(result.selectedTrace).toEqual(refined);
    expect(result.agentRefinedTrace).toBeNull();
    expect(result.acceptedAgentOutput).toBeNull();
    expect(result.telemetry.decision).toBe('agent_output_invalid');
    expect(result.telemetry.errors.length).toBeGreaterThan(0);
  });
});

// ── applyTraceRefinerAgentShadowResult: shadow mode ──

describe('applyTraceRefinerAgentShadowResult: shadow mode', () => {
  it('valid shadow output records agentRefinedTrace but selectedTrace remains deterministic', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const agentOutput = makeValidAgentOutput(refined);

    const result = applyTraceRefinerAgentShadowResult(input, agentOutput);

    expect(result.mode).toBe('shadow');
    expect(result.selectedTrace).toEqual(refined);
    expect(result.selectedTrace).toBe(input.deterministicRefinedTrace);
    expect(result.agentRefinedTrace).not.toBeNull();
    expect(result.acceptedAgentOutput).not.toBeNull();
    expect(result.telemetry.decision).toBe('agent_refined_recorded');
  });

  it('blocked agent output records agent_blocked decision', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const agentOutput = makeValidAgentOutput(refined, {
      status: 'blocked',
      blockedReason: 'Cannot refine',
      evidenceMap: [],
      confidence: 0,
    });

    const result = applyTraceRefinerAgentShadowResult(input, agentOutput);

    expect(result.mode).toBe('shadow');
    expect(result.selectedTrace).toEqual(refined);
    expect(result.telemetry.decision).toBe('agent_blocked');
  });
});

// ── validateTraceRefinerAgentOutput: confidence bounds ──

describe('validateTraceRefinerAgentOutput: confidence bounds', () => {
  it('confidence NaN fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: NaN });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    }
  });

  it('confidence Infinity fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: Infinity });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    }
  });

  it('confidence < 0 fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: -0.1 });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    }
  });

  it('confidence > 1 fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: 1.5 });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    }
  });

  it('confidence 0 passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: 0, evidenceMap: [] });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });

  it('confidence 1 passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { confidence: 1 });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });
});

// ── validateTraceRefinerAgentOutput: refinedTrace evidenceRefs ──

describe('validateTraceRefinerAgentOutput: refinedTrace evidenceRefs', () => {
  it('refinedTrace evidenceRefs with invented refs fail', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      evidenceRefs: ['task:invented_task_999'],
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('evidenceRefs') || e.includes('invented') || e.includes('allowed'))).toBe(true);
    }
  });

  it('refinedTrace keyEvents evidenceRefs with invented refs fail', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Some failure',
          evidenceRefs: ['run:invented_run_999'],
          severity: 'high',
          at: '2026-05-19T00:00:00Z',
        },
      ],
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('keyEvents') || e.includes('evidenceRefs') || e.includes('invented') || e.includes('allowed'))).toBe(true);
    }
  });
});

// ── validateTraceRefinerAgentOutput: structural validation ──

describe('validateTraceRefinerAgentOutput: structural validation', () => {
  it('null output fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');

    const result = validateTraceRefinerAgentOutput(null, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('missing status fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined);
    delete (output as unknown as Record<string, unknown>).status;

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
  });

  it('missing refinedTrace fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined);
    delete (output as unknown as Record<string, unknown>).refinedTrace;

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
  });

  it('missing generatedAt fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined);
    delete (output as unknown as Record<string, unknown>).generatedAt;

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
  });

  it('invalid status value fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, { status: 'unknown_status' as TraceRefinerAgentOutput['status'] });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
  });
});

// ── Architecture guard ──

describe('PRI-192 TraceRefinerAgent architecture guard', () => {
  it('trace-refiner-agent.ts has no openclaw-plugin import', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('trace-refiner-agent.ts has no fs/path/process/network import', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('node:http');
    expect(src).not.toContain('node:https');
    expect(src).not.toContain('node:net');
    expect(src).not.toContain('fetch(');
  });

  it('trace-refiner-agent.ts has no LLM imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    expect(src).not.toContain('openai');
    expect(src).not.toContain('anthropic');
  });

  it('core barrel exports TraceRefinerAgent types and functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('TraceRefinerAgentInput');
    expect(src).toContain('TraceRefinerAgentOutput');
    expect(src).toContain('createTraceRefinerAgentInput');
    expect(src).toContain('validateTraceRefinerAgentOutput');
    expect(src).toContain('applyTraceRefinerAgentShadowResult');
  });
});

// ── Additional coverage from PR review ──

describe('validateTraceRefinerAgentOutput: rejectedEvidence anti-forgery', () => {
  it('rejectedEvidence with invented sourceRefs fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined, {
      rejectedEvidence: [
        { reason: 'Some rejection', sourceRefs: ['task:invented_task_999'] },
      ],
    });

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('invented') || e.includes('allowed'))).toBe(true);
    }
  });
});

describe('validateTraceRefinerAgentOutput: refinedTrace non-string evidenceRefs', () => {
  it('refinedTrace evidenceRefs with non-string element fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      evidenceRefs: [42 as unknown as string],
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('evidenceRefs') && e.includes('string'))).toBe(true);
    }
  });

  it('refinedTrace keyEvents evidenceRefs with non-string element fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Some failure',
          evidenceRefs: [null as unknown as string],
          severity: 'high',
          at: '2026-05-19T00:00:00Z',
        },
      ],
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('keyEvents') && e.includes('string'))).toBe(true);
    }
  });
});

describe('validateTraceRefinerAgentOutput: refinedTrace lineage validation', () => {
  it('refinedTrace with mismatched sourceTaskId fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      sourceTaskId: 'wrong_task_id',
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('sourceTaskId'))).toBe(true);
    }
  });

  it('refinedTrace with mismatched sourcePainId fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      sourcePainId: 'wrong_pain_id',
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('sourcePainId'))).toBe(true);
    }
  });

  it('refinedTrace with mismatched sourceRunIds fails', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const badRefinedTrace: RefinedTracePayload = {
      ...refined,
      sourceRunIds: ['wrong_run_id'],
    };
    const output = makeValidAgentOutput(badRefinedTrace);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('sourceRunIds'))).toBe(true);
    }
  });

  it('refinedTrace with matching lineage passes', () => {
    const fullTrace = makeValidFullTrace();
    const refined = makeValidRefinedTrace(fullTrace);
    const input = createTraceRefinerAgentInput(fullTrace, refined, 'diagnosis_input');
    const output = makeValidAgentOutput(refined);

    const result = validateTraceRefinerAgentOutput(output, input);

    expect(result.ok).toBe(true);
  });
});
