import { describe, it, expect } from 'vitest';
import { buildGoldenTraceCandidate } from '../golden-trace-candidate-builder.js';
import type { FullTracePayloadV2 } from '../full-trace-contract.js';
import type { RefinedTracePayload } from '../trace-refiner.js';
import { validateGoldenTrace } from '../golden-trace.js';
import { refineFullTrace } from '../trace-refiner.js';
import { replayGoldenTrace } from '../golden-trace-replay-validator.js';

function makeFullTrace(overrides: Partial<FullTracePayloadV2> = {}): FullTracePayloadV2 {
  return {
    sourceTaskId: 'task-001',
    sourcePainId: 'pain-001',
    sourceRunIds: ['run-001'],
    capturedAt: '2026-05-19T12:00:00.000Z',
    sourceRefs: [
      { kind: 'task', id: 'task-001' },
      { kind: 'run', id: 'run-001' },
    ],
    timeline: [],
    ambiguityNotes: [],
    sanitizationNotes: [],
    ...overrides,
  };
}

function makeRefinedTrace(overrides: Partial<RefinedTracePayload> = {}): RefinedTracePayload {
  return {
    sourceTaskId: 'task-001',
    sourcePainId: 'pain-001',
    sourceRunIds: ['run-001'],
    evidenceRefs: ['task:task-001', 'run:run-001'],
    keyEvents: [],
    failureSummary: null,
    toolUseSummary: [],
    userIntentSummary: null,
    ambiguityNotes: [],
    sanitizationNotes: [],
    refinementNotes: [],
    ...overrides,
  };
}

describe('buildGoldenTraceCandidate', () => {
  it('returns insufficient_evidence when no failure evidence exists', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:01.000Z',
        },
      ],
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('insufficient_evidence');
    if (result.decision === 'insufficient_evidence') {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.some((r) => r.includes('failure') || r.includes('negative'))).toBe(true);
    }
  });

  it('returns insufficient_evidence when no positive comparator exists', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Write (failed)',
          rawPreview: '{"file_path":"/etc/passwd","content":"root::0:0"}',
          metadata: { toolName: 'Write', status: 'failed' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Write',
          rawPreview: 'Permission denied',
          metadata: { toolName: 'Write', error: 'Permission denied' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Write (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
      ],
      failureSummary: 'Write: Permission denied',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('insufficient_evidence');
    if (result.decision === 'insufficient_evidence') {
      expect(result.reasons.some((r) => r.includes('positive') || r.includes('comparator'))).toBe(true);
    }
  });

  it('returns insufficient_evidence when tool params are missing', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          metadata: { toolName: 'Bash', status: 'failed', error: 'timeout' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:02.000Z',
        },
      ],
      failureSummary: 'Bash: timeout',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('insufficient_evidence');
    if (result.decision === 'insufficient_evidence') {
      expect(result.reasons.some((r) => r.includes('params') || r.includes('param'))).toBe(true);
    }
  });

  it('creates candidate from failing tool call with positive comparator', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'Permission denied' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          rawPreview: 'Permission denied',
          metadata: { toolName: 'Bash', error: 'Permission denied' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001', 'run:run-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001', 'run:run-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: Permission denied',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      expect(result.goldenTrace).toBeDefined();
      expect(result.evidenceRefs.length).toBeGreaterThan(0);
      expect(result.builderNotes.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('generated GoldenTrace passes validateGoldenTrace', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous command' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous command' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous command',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      const validation = validateGoldenTrace(result.goldenTrace);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    }
  });

  it('preserves source refs in every generated case', () => {
    const fullTrace = makeFullTrace({
      sourceTaskId: 'task-042',
      sourcePainId: 'pain-042',
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Write (failed)',
          rawPreview: '{"file_path":"/etc/shadow","content":"root:x:0:0"}',
          metadata: { toolName: 'Write', status: 'failed', error: 'permission denied' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Write',
          metadata: { toolName: 'Write', error: 'permission denied' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/app.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      sourceTaskId: 'task-042',
      sourcePainId: 'pain-042',
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Write (failed)',
          evidenceRefs: ['task:task-042'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-042'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Write: permission denied',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      for (const c of result.goldenTrace.cases) {
        expect(c.sourceRefs).toBeDefined();
        expect(c.sourceRefs?.painId).toBe('pain-042');
      }
      expect(result.goldenTrace.sourcePainId).toBe('pain-042');
    }
  });

  it('replay validator can consume generated candidate in deterministic mode', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      const blockBashEvaluate = () => ({
        decision: 'block' as const,
        matched: true,
        reason: 'dangerous command',
        confidence: 0.95,
      });
      const replayResult = replayGoldenTrace(blockBashEvaluate, result.goldenTrace.cases);
      expect(replayResult.totalCases).toBe(result.goldenTrace.cases.length);
      expect(typeof replayResult.passed).toBe('boolean');
    }
  });

  it('generated IDs are deterministic for same input', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result1 = buildGoldenTraceCandidate({ fullTrace, refinedTrace });
    const result2 = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result1.decision).toBe('candidate_created');
    expect(result2.decision).toBe('candidate_created');
    if (result1.decision === 'candidate_created' && result2.decision === 'candidate_created') {
      expect(result1.goldenTrace.traceId).toBe(result2.goldenTrace.traceId);
      expect(result1.goldenTrace.cases.map((c) => c.caseId)).toEqual(
        result2.goldenTrace.cases.map((c) => c.caseId),
      );
    }
  });

  it('ambiguous/refinement notes are preserved in builder notes', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
      ambiguityNotes: ['source_trace_ambiguous: multiple runs found'],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
      ambiguityNotes: ['source_trace_ambiguous: multiple runs found'],
      refinementNotes: ['sanitized_input_present'],
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      expect(result.builderNotes.some((n) => n.includes('ambiguous') || n.includes('refinement'))).toBe(true);
    }
  });

  it('negative case has block expectedDecision for failing tool call', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      const negativeCases = result.goldenTrace.cases.filter((c) => c.kind === 'negative');
      expect(negativeCases.length).toBeGreaterThan(0);
      for (const nc of negativeCases) {
        expect(nc.expectedDecision).toBe('block');
        expect(nc.toolName).toBe('Bash');
        expect(nc.params).toBeDefined();
        expect(typeof nc.params).toBe('object');
      }
    }
  });

  it('positive case has allow expectedDecision for non-failing tool call', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      const positiveCases = result.goldenTrace.cases.filter((c) => c.kind === 'positive');
      expect(positiveCases.length).toBeGreaterThan(0);
      for (const pc of positiveCases) {
        expect(pc.expectedDecision).toBe('allow');
        expect(pc.toolName).toBeDefined();
        expect(pc.params).toBeDefined();
      }
    }
  });

  it('works with real refineFullTrace output', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous command blocked' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          rawPreview: 'dangerous command blocked',
          metadata: { toolName: 'Bash', error: 'dangerous command blocked' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = refineFullTrace(fullTrace);

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      const validation = validateGoldenTrace(result.goldenTrace);
      expect(validation.valid).toBe(true);
    }
  });

  it('returns insufficient_evidence when timeline is empty', () => {
    const fullTrace = makeFullTrace({ timeline: [] });
    const refinedTrace = makeRefinedTrace({ keyEvents: [], refinementNotes: ['empty_timeline'] });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('insufficient_evidence');
    if (result.decision === 'insufficient_evidence') {
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('candidate_created includes missing_params in builderNotes when some tool calls lack params', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Grep (failed)',
          metadata: { toolName: 'Grep', status: 'failed', error: 'not found' },
        },
        {
          at: '2026-05-19T12:00:04.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:04.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result = buildGoldenTraceCandidate({ fullTrace, refinedTrace });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      expect(result.builderNotes.some((n) => n.includes('missing_params'))).toBe(true);
      expect(result.builderNotes.some((n) => n.includes('Grep'))).toBe(true);
    }
  });

  it('uses provided createdAt when given', () => {
    const fullTrace = makeFullTrace({
      timeline: [
        {
          at: '2026-05-19T12:00:01.000Z',
          kind: 'tool_call',
          summary: 'Bash (failed)',
          rawPreview: '{"command":"rm -rf /"}',
          metadata: { toolName: 'Bash', status: 'failed', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:02.000Z',
          kind: 'tool_result',
          summary: 'Error from Bash',
          metadata: { toolName: 'Bash', error: 'dangerous' },
        },
        {
          at: '2026-05-19T12:00:03.000Z',
          kind: 'tool_call',
          summary: 'Read (completed)',
          rawPreview: '{"file_path":"/src/main.ts"}',
          metadata: { toolName: 'Read', status: 'completed' },
        },
      ],
    });
    const refinedTrace = makeRefinedTrace({
      keyEvents: [
        {
          kind: 'failure',
          summary: 'Bash (failed)',
          evidenceRefs: ['task:task-001'],
          severity: 'high',
          at: '2026-05-19T12:00:01.000Z',
        },
        {
          kind: 'tool_use',
          summary: 'Read (completed)',
          evidenceRefs: ['task:task-001'],
          severity: 'low',
          at: '2026-05-19T12:00:03.000Z',
        },
      ],
      failureSummary: 'Bash: dangerous',
    });

    const result = buildGoldenTraceCandidate({
      fullTrace,
      refinedTrace,
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    expect(result.decision).toBe('candidate_created');
    if (result.decision === 'candidate_created') {
      expect(result.goldenTrace.createdAt).toBe('2026-06-01T00:00:00.000Z');
    }
  });
});

describe('buildGoldenTraceCandidate architecture guard', () => {
  it('builder module has no plugin import', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../golden-trace-candidate-builder.ts'),
      'utf-8',
    );
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain("from 'fs'");
    expect(src).not.toContain("from 'path'");
    expect(src).not.toContain("from 'node:fs'");
    expect(src).not.toContain("from 'node:path'");
    expect(src).not.toContain("from 'node:process'");
    expect(src).not.toContain("from 'net'");
    expect(src).not.toContain("from 'http'");
  });
});
