/**
 * TraceRefiner read model tests (PRI-191).
 *
 * TDD tests for:
 *   - refineFullTrace: deterministic FullTracePayloadV2 → RefinedTracePayload
 *   - Failure extraction from timeline
 *   - Tool use extraction
 *   - User intent extraction
 *   - Empty timeline handling
 *   - Sanitized trace handling
 *   - Ambiguity notes preservation
 *   - Unrecognized JSON shape timeline entries
 *   - Output size bounding
 *   - Deterministic output
 *   - Invalid input handling
 */
import { describe, it, expect } from 'vitest';
import { refineFullTrace } from '../trace-refiner.js';
import type { FullTracePayloadV2 } from '../full-trace-contract.js';

function makeValidPayload(overrides?: Partial<FullTracePayloadV2>): FullTracePayloadV2 {
  return {
    sourceTaskId: 'task_src_001',
    sourcePainId: 'pain-001',
    sourceRunIds: ['run_001', 'run_002'],
    capturedAt: '2026-05-19T00:00:00Z',
    sourceRefs: [
      { kind: 'task', id: 'task_src_001' },
      { kind: 'run', id: 'run_001' },
      { kind: 'run', id: 'run_002' },
    ],
    timeline: [
      { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'User asked to fix bug' },
      { at: '2026-05-19T00:00:01Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
      { at: '2026-05-19T00:00:02Z', kind: 'tool_result', summary: 'Result from Read' },
      { at: '2026-05-19T00:00:03Z', kind: 'assistant_message', summary: 'I fixed the bug' },
    ],
    ambiguityNotes: [],
    sanitizationNotes: [],
    ...overrides,
  };
}

// ── Failure Extraction ──

describe('refineFullTrace: failure extraction', () => {
  it('tool error in metadata produces failure keyEvent and non-null failureSummary', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Write file', metadata: { toolName: 'Write', error: 'permission denied: /etc/hosts' } },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.failureSummary).not.toBeNull();
    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
    expect(result.keyEvents.find((e) => e.kind === 'failure')?.summary).toContain('Write file');
  });

  it('error keyword in summary produces failure keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_result', summary: 'Error from Bash: command failed with exit code 1' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.failureSummary).not.toBeNull();
    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
  });

  it('timeout in summary produces failure keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_result', summary: 'Operation timed out after 30s' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.failureSummary).not.toBeNull();
    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
  });

  it('exception in summary produces failure keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'unknown', summary: 'Unhandled exception in worker thread' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.failureSummary).not.toBeNull();
    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
  });

  it('failed tool status produces failure keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Edit file', metadata: { toolName: 'Edit', status: 'failed' } },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
  });

  it('failure severity is high for fatal/crash errors', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_result', summary: 'Fatal crash occurred', metadata: { error: 'fatal: process crashed' } },
      ],
    });

    const result = refineFullTrace(payload);

    const failureEvent = result.keyEvents.find((e) => e.kind === 'failure');
    expect(failureEvent).toBeDefined();
    if (failureEvent) {
      expect(failureEvent.severity).toBe('high');
    }
  });

  it('failure severity is medium for timeout/permission errors', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_result', summary: 'Timeout occurred', metadata: { error: 'timeout: operation exceeded 30s' } },
      ],
    });

    const result = refineFullTrace(payload);

    const failureEvent = result.keyEvents.find((e) => e.kind === 'failure');
    expect(failureEvent).toBeDefined();
    if (failureEvent) {
      expect(failureEvent.severity).toBe('medium');
    }
  });
});

// ── Tool Use Extraction ──

describe('refineFullTrace: tool use extraction', () => {
  it('tool_call/tool_result timeline produces toolUseSummary with tool names', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
        { at: '2026-05-19T00:00:01Z', kind: 'tool_result', summary: 'Result from Read', metadata: { toolName: 'Read' } },
        { at: '2026-05-19T00:00:02Z', kind: 'tool_call', summary: 'Edit (succeeded)', metadata: { toolName: 'Edit', status: 'succeeded' } },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.toolUseSummary).toContain('Read (succeeded)');
    expect(result.toolUseSummary).toContain('Edit (succeeded)');
  });

  it('tool_use keyEvents have low severity when succeeded', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
      ],
    });

    const result = refineFullTrace(payload);

    const toolEvent = result.keyEvents.find((e) => e.kind === 'tool_use');
    expect(toolEvent).toBeDefined();
    if (toolEvent) {
      expect(toolEvent.severity).toBe('low');
    }
  });

  it('tool_use keyEvents have evidenceRefs', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Read', metadata: { toolName: 'Read' } },
      ],
    });

    const result = refineFullTrace(payload);

    const toolEvent = result.keyEvents.find((e) => e.kind === 'tool_use');
    expect(toolEvent).toBeDefined();
    if (toolEvent) {
      expect(toolEvent.evidenceRefs.length).toBeGreaterThan(0);
    }
  });
});

// ── User Intent Extraction ──

describe('refineFullTrace: user intent extraction', () => {
  it('user_message timeline produces non-null userIntentSummary', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Fix the authentication bug' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.userIntentSummary).not.toBeNull();
    expect(result.userIntentSummary).toBe('Fix the authentication bug');
  });

  it('user_intent keyEvent is produced', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Refactor the module' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.keyEvents.some((e) => e.kind === 'user_intent')).toBe(true);
  });

  it('only first user_message becomes userIntentSummary', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'First message' },
        { at: '2026-05-19T00:00:01Z', kind: 'user_message', summary: 'Second message' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.userIntentSummary).toBe('First message');
    expect(result.keyEvents.filter((e) => e.kind === 'user_intent').length).toBe(2);
  });
});

// ── Empty Timeline ──

describe('refineFullTrace: empty timeline', () => {
  it('empty timeline produces valid refined payload with empty_timeline refinementNote', () => {
    const payload = makeValidPayload({ timeline: [] });

    const result = refineFullTrace(payload);

    expect(result.sourceTaskId).toBe('task_src_001');
    expect(result.sourcePainId).toBe('pain-001');
    expect(result.keyEvents).toEqual([]);
    expect(result.failureSummary).toBeNull();
    expect(result.toolUseSummary).toEqual([]);
    expect(result.userIntentSummary).toBeNull();
    expect(result.refinementNotes).toContain('empty_timeline');
  });
});

// ── Sanitized Trace ──

describe('refineFullTrace: sanitized trace', () => {
  it('sanitizationNotes are preserved in refined output', () => {
    const payload = makeValidPayload({
      sanitizationNotes: ['timeline[0].summary: secret pattern redacted'],
    });

    const result = refineFullTrace(payload);

    expect(result.sanitizationNotes).toContain('timeline[0].summary: secret pattern redacted');
    expect(result.refinementNotes).toContain('sanitized_input_present');
  });
});

// ── Ambiguity Notes ──

describe('refineFullTrace: ambiguity notes', () => {
  it('ambiguityNotes are preserved in refined output', () => {
    const notes = [
      'Ambiguous source trace for sourcePainId=pain-001: 2 matched candidates',
      'diagnostic_json_unparseable for taskIds: task_003',
    ];
    const payload = makeValidPayload({ ambiguityNotes: notes });

    const result = refineFullTrace(payload);

    expect(result.ambiguityNotes).toEqual(notes);
    expect(result.refinementNotes).toContain('source_trace_ambiguous');
  });
});

// ── Unrecognized JSON Shape ──

describe('refineFullTrace: unrecognized JSON shape timeline', () => {
  it('unknown timeline entries become unknown/system_context keyEvents', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'unknown', summary: '{"prompt":"fix bug"}', metadata: { parseStatus: 'unrecognized_json_shape' } },
      ],
    });

    const result = refineFullTrace(payload);

    const unknownEvent = result.keyEvents.find((e) => e.kind === 'unknown');
    expect(unknownEvent).toBeDefined();
    if (unknownEvent) {
      expect(unknownEvent.summary).toContain('prompt');
    }
  });

  it('system_event timeline becomes system_context keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'system_event', summary: 'Session started' },
      ],
    });

    const result = refineFullTrace(payload);

    const systemEvent = result.keyEvents.find((e) => e.kind === 'system_context');
    expect(systemEvent).toBeDefined();
    if (systemEvent) {
      expect(systemEvent.summary).toBe('Session started');
    }
  });
});

// ── Output Size Bounding ──

describe('refineFullTrace: output size bounding', () => {
  it('keyEvents exceeding max are truncated with refinementNote', () => {
    const timeline = Array.from({ length: 25 }, (_, i) => ({
      at: `2026-05-19T00:00:${String(i).padStart(2, '0')}Z`,
      kind: 'tool_call' as const,
      summary: `Tool call ${i}`,
      metadata: { toolName: `Tool${i}` },
    }));
    const payload = makeValidPayload({ timeline });

    const result = refineFullTrace(payload, { maxKeyEvents: 20 });

    expect(result.keyEvents.length).toBe(20);
    expect(result.refinementNotes.some((n) => n.startsWith('truncated_key_events'))).toBe(true);
  });

  it('summary is truncated when exceeding maxSummaryLength', () => {
    const longSummary = 'A'.repeat(500);
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: longSummary },
      ],
    });

    const result = refineFullTrace(payload, { maxSummaryLength: 300 });

    const userEvent = result.keyEvents.find((e) => e.kind === 'user_intent');
    expect(userEvent).toBeDefined();
    if (userEvent) {
      expect(userEvent.summary.length).toBeLessThanOrEqual(300);
    }
  });

  it('default maxKeyEvents is 20', () => {
    const timeline = Array.from({ length: 25 }, (_, i) => ({
      at: `2026-05-19T00:00:${String(i).padStart(2, '0')}Z`,
      kind: 'tool_call' as const,
      summary: `Tool call ${i}`,
      metadata: { toolName: `Tool${i}` },
    }));
    const payload = makeValidPayload({ timeline });

    const result = refineFullTrace(payload);

    expect(result.keyEvents.length).toBe(20);
  });
});

// ── Deterministic Output ──

describe('refineFullTrace: deterministic output', () => {
  it('same input produces deep-equal output', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Fix bug' },
        { at: '2026-05-19T00:00:01Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
        { at: '2026-05-19T00:00:02Z', kind: 'tool_result', summary: 'Error from Read', metadata: { toolName: 'Read', error: 'file not found' } },
      ],
    });

    const result1 = refineFullTrace(payload);
    const result2 = refineFullTrace(payload);

    expect(result1).toEqual(result2);
  });

  it('deterministic across different option objects with same values', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Fix bug' },
      ],
    });

    const result1 = refineFullTrace(payload, { maxKeyEvents: 10 });
    const result2 = refineFullTrace(payload, { maxKeyEvents: 10 });

    expect(result1).toEqual(result2);
  });
});

// ── Invalid Input Handling ──

describe('refineFullTrace: invalid input handling', () => {
  it('invalid fullTrace returns structured refinementNotes, not random throw', () => {
    const invalidPayload = {
      sourceTaskId: '',
      sourcePainId: '',
      sourceRunIds: [],
      capturedAt: 'not-a-date',
      sourceRefs: [],
      timeline: [],
      ambiguityNotes: [],
      sanitizationNotes: [],
    } as unknown as FullTracePayloadV2;

    const result = refineFullTrace(invalidPayload);

    expect(result.refinementNotes).toContain('invalid_full_trace_input');
    expect(result.refinementNotes.some((n) => n.startsWith('validation_error'))).toBe(true);
    expect(result.keyEvents).toEqual([]);
  });

  it('null input returns structured error', () => {
    const result = refineFullTrace(null as unknown as FullTracePayloadV2);

    expect(result.refinementNotes).toContain('invalid_full_trace_input');
  });

  it('partially valid input preserves extractable fields', () => {
    const partial = {
      sourceTaskId: 'task_001',
      sourcePainId: 'pain-001',
      sourceRunIds: ['run_001'],
      capturedAt: 'not-a-date',
      sourceRefs: [],
      timeline: [],
      ambiguityNotes: ['some ambiguity'],
      sanitizationNotes: [],
    } as unknown as FullTracePayloadV2;

    const result = refineFullTrace(partial);

    expect(result.sourceTaskId).toBe('task_001');
    expect(result.sourcePainId).toBe('pain-001');
    expect(result.ambiguityNotes).toContain('some ambiguity');
    expect(result.refinementNotes).toContain('invalid_full_trace_input');
  });
});

// ── Evidence Refs / Source Lineage ──

describe('refineFullTrace: evidence refs and source lineage', () => {
  it('sourceTaskId/sourcePainId/sourceRunIds are preserved', () => {
    const payload = makeValidPayload();

    const result = refineFullTrace(payload);

    expect(result.sourceTaskId).toBe('task_src_001');
    expect(result.sourcePainId).toBe('pain-001');
    expect(result.sourceRunIds).toEqual(['run_001', 'run_002']);
  });

  it('evidenceRefs are derived from sourceRefs', () => {
    const payload = makeValidPayload({
      sourceRefs: [
        { kind: 'task', id: 'task_src_001' },
        { kind: 'run', id: 'run_001' },
        { kind: 'run', id: 'run_002' },
        { kind: 'artifact', id: 'artifact_log_001' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.evidenceRefs).toContain('task:task_src_001');
    expect(result.evidenceRefs).toContain('run:run_001');
    expect(result.evidenceRefs).toContain('artifact:artifact_log_001');
  });

  it('keyEvents carry evidenceRefs', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Read', metadata: { toolName: 'Read' } },
      ],
    });

    const result = refineFullTrace(payload);

    for (const event of result.keyEvents) {
      expect(event.evidenceRefs.length).toBeGreaterThan(0);
    }
  });
});

// ── No Failure Evidence Note ──

describe('refineFullTrace: no failure evidence note', () => {
  it('non-empty timeline without failures produces no_failure_evidence refinementNote', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Hello' },
        { at: '2026-05-19T00:00:01Z', kind: 'assistant_message', summary: 'Hi there' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.refinementNotes).toContain('no_failure_evidence');
    expect(result.failureSummary).toBeNull();
  });
});

// ── Assistant Action ──

describe('refineFullTrace: assistant action', () => {
  it('assistant_message produces assistant_action keyEvent', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'assistant_message', summary: 'I will fix the bug now' },
      ],
    });

    const result = refineFullTrace(payload);

    expect(result.keyEvents.some((e) => e.kind === 'assistant_action')).toBe(true);
    expect(result.keyEvents.find((e) => e.kind === 'assistant_action')?.summary).toBe('I will fix the bug now');
  });
});

// ── Combined Scenario ──

describe('refineFullTrace: combined scenario', () => {
  it('full trace with mixed events produces correct refined output', () => {
    const payload = makeValidPayload({
      timeline: [
        { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'Fix the login bug' },
        { at: '2026-05-19T00:00:01Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read', status: 'succeeded' } },
        { at: '2026-05-19T00:00:02Z', kind: 'tool_result', summary: 'Result from Read' },
        { at: '2026-05-19T00:00:03Z', kind: 'tool_call', summary: 'Edit (failed)', metadata: { toolName: 'Edit', status: 'failed', error: 'permission denied' } },
        { at: '2026-05-19T00:00:04Z', kind: 'assistant_message', summary: 'The edit was not applied due to permissions' },
        { at: '2026-05-19T00:00:05Z', kind: 'system_event', summary: 'Session initialized' },
        { at: '2026-05-19T00:00:06Z', kind: 'unknown', summary: '{"raw":"data"}' },
      ],
      ambiguityNotes: ['Multiple candidates found'],
      sanitizationNotes: ['timeline[3].metadata: secret key redacted'],
    });

    const result = refineFullTrace(payload);

    expect(result.sourceTaskId).toBe('task_src_001');
    expect(result.sourcePainId).toBe('pain-001');
    expect(result.failureSummary).not.toBeNull();
    expect(result.failureSummary).toContain('permission denied');
    expect(result.toolUseSummary.length).toBeGreaterThanOrEqual(2);
    expect(result.userIntentSummary).toBe('Fix the login bug');
    expect(result.ambiguityNotes).toEqual(['Multiple candidates found']);
    expect(result.sanitizationNotes).toEqual(['timeline[3].metadata: secret key redacted']);
    expect(result.refinementNotes).toContain('sanitized_input_present');
    expect(result.refinementNotes).toContain('source_trace_ambiguous');
    expect(result.keyEvents.some((e) => e.kind === 'failure')).toBe(true);
    expect(result.keyEvents.some((e) => e.kind === 'tool_use')).toBe(true);
    expect(result.keyEvents.some((e) => e.kind === 'user_intent')).toBe(true);
    expect(result.keyEvents.some((e) => e.kind === 'assistant_action')).toBe(true);
    expect(result.keyEvents.some((e) => e.kind === 'system_context')).toBe(true);
    expect(result.keyEvents.some((e) => e.kind === 'unknown')).toBe(true);
  });
});
