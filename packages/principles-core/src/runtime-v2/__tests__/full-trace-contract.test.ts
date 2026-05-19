/**
 * FullTrace quality contract tests (PRI-190).
 *
 * TDD tests for:
 *   - validateFullTracePayload: runtime validation of FullTracePayloadV2
 *   - sanitizeFullTracePayload: PII sanitization with sanitizationNotes tracking
 *   - buildFullTraceTimeline: RunRecord → structured timeline conversion
 *   - buildSourceRefs: task/run → sourceRefs builder
 *   - checkFullTracePayloadSchema: TypeBox schema validation
 */
import { describe, it, expect } from 'vitest';
import {
  validateFullTracePayload,
  sanitizeFullTracePayload,
  buildFullTraceTimeline,
  buildSourceRefs,
  checkFullTracePayloadSchema,
  TRACE_EVENT_KINDS,
  SOURCE_REF_KINDS,
  FullTracePayloadV2Schema,
  TraceEventKindSchema,
  SourceRefKindSchema,
  TraceSourceRefSchema,
  TraceTimelineEntrySchema,
} from '../full-trace-contract.js';
import type {
  FullTracePayloadV2,
  TraceEventKind,
  SourceRefKind,
  RunRecordLike,
} from '../full-trace-contract.js';
import { Value } from '@sinclair/typebox/value';

function makeValidPayload(overrides?: Partial<FullTracePayloadV2>): FullTracePayloadV2 {
  return {
    sourceTaskId: 'task_src_001',
    sourcePainId: 'pain-001',
    sourceRunIds: ['run_001', 'run_002'],
    capturedAt: new Date().toISOString(),
    sourceRefs: [
      { kind: 'task', id: 'task_src_001' },
      { kind: 'run', id: 'run_001' },
    ],
    timeline: [
      { at: '2026-05-19T00:00:00Z', kind: 'user_message', summary: 'User asked to fix bug' },
      { at: '2026-05-19T00:00:01Z', kind: 'tool_call', summary: 'Read (succeeded)', metadata: { toolName: 'Read' } },
      { at: '2026-05-19T00:00:02Z', kind: 'tool_result', summary: 'Result from Read' },
      { at: '2026-05-19T00:00:03Z', kind: 'assistant_message', summary: 'I fixed the bug' },
    ],
    ambiguityNotes: [],
    sanitizationNotes: [],
    ...overrides,
  };
}

// ── Schema Structure Tests ──

describe('FullTracePayloadV2 schema structure', () => {
  it('valid fullTrace payload passes TypeBox schema validation', () => {
    const payload = makeValidPayload();
    expect(Value.Check(FullTracePayloadV2Schema, payload)).toBe(true);
  });

  it('valid fullTrace payload passes runtime validation', () => {
    const payload = makeValidPayload();
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('valid fullTrace payload passes checkFullTracePayloadSchema', () => {
    const payload = makeValidPayload();
    expect(checkFullTracePayloadSchema(payload)).toBe(true);
  });
});

// ── TraceEventKind Tests ──

describe('TraceEventKind', () => {
  it('all expected kinds are defined', () => {
    expect(TRACE_EVENT_KINDS).toContain('tool_call');
    expect(TRACE_EVENT_KINDS).toContain('tool_result');
    expect(TRACE_EVENT_KINDS).toContain('assistant_message');
    expect(TRACE_EVENT_KINDS).toContain('user_message');
    expect(TRACE_EVENT_KINDS).toContain('system_event');
    expect(TRACE_EVENT_KINDS).toContain('unknown');
  });

  it('TraceEventKindSchema validates known kinds', () => {
    for (const kind of TRACE_EVENT_KINDS) {
      expect(Value.Check(TraceEventKindSchema, kind)).toBe(true);
    }
  });

  it('TraceEventKindSchema rejects arbitrary string', () => {
    expect(Value.Check(TraceEventKindSchema, 'arbitrary_status')).toBe(false);
  });
});

// ── SourceRefKind Tests ──

describe('SourceRefKind', () => {
  it('all expected kinds are defined', () => {
    expect(SOURCE_REF_KINDS).toContain('task');
    expect(SOURCE_REF_KINDS).toContain('run');
    expect(SOURCE_REF_KINDS).toContain('artifact');
    expect(SOURCE_REF_KINDS).toContain('event');
  });

  it('SourceRefKindSchema validates known kinds', () => {
    for (const kind of SOURCE_REF_KINDS) {
      expect(Value.Check(SourceRefKindSchema, kind)).toBe(true);
    }
  });

  it('SourceRefKindSchema rejects arbitrary string', () => {
    expect(Value.Check(SourceRefKindSchema, 'random_ref')).toBe(false);
  });
});

// ── TraceSourceRef Tests ──

describe('TraceSourceRef', () => {
  it('valid sourceRef passes schema', () => {
    expect(Value.Check(TraceSourceRefSchema, { kind: 'task', id: 'task_001' })).toBe(true);
  });

  it('empty id fails schema', () => {
    expect(Value.Check(TraceSourceRefSchema, { kind: 'task', id: '' })).toBe(false);
  });

  it('invalid kind fails schema', () => {
    expect(Value.Check(TraceSourceRefSchema, { kind: 'invalid', id: 'task_001' })).toBe(false);
  });
});

// ── TraceTimelineEntry Tests ──

describe('TraceTimelineEntry', () => {
  it('valid entry passes schema', () => {
    const entry = { at: '2026-05-19T00:00:00Z', kind: 'tool_call', summary: 'Read file' };
    expect(Value.Check(TraceTimelineEntrySchema, entry)).toBe(true);
  });

  it('entry with null at passes schema', () => {
    const entry = { at: null, kind: 'unknown', summary: 'Something happened' };
    expect(Value.Check(TraceTimelineEntrySchema, entry)).toBe(true);
  });

  it('entry with optional fields passes schema', () => {
    const entry = {
      at: '2026-05-19T00:00:00Z',
      kind: 'tool_call',
      summary: 'Read file',
      rawPreview: 'file content preview',
      metadata: { toolName: 'Read', status: 'succeeded' },
    };
    expect(Value.Check(TraceTimelineEntrySchema, entry)).toBe(true);
  });

  it('invalid timeline kind fails validation', () => {
    const payload = makeValidPayload({
      timeline: [{ at: '2026-05-19T00:00:00Z', kind: 'invalid_kind' as TraceEventKind, summary: 'test' }],
    });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('timeline[0]') && e.includes('kind'))).toBe(true);
  });
});

// ── Validation: Required Fields ──

describe('validateFullTracePayload: required fields', () => {
  it('missing sourcePainId fails validation', () => {
    const payload = makeValidPayload({ sourcePainId: '' });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourcePainId'))).toBe(true);
  });

  it('missing sourceTaskId fails validation', () => {
    const payload = makeValidPayload({ sourceTaskId: '' });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceTaskId'))).toBe(true);
  });

  it('missing capturedAt fails validation', () => {
    const payload = makeValidPayload({ capturedAt: '' });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capturedAt'))).toBe(true);
  });

  it('invalid capturedAt (not ISO) fails validation', () => {
    const payload = makeValidPayload({ capturedAt: 'not-a-date' });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capturedAt') && e.includes('ISO'))).toBe(true);
  });

  it('sourceRefs missing kind fails validation', () => {
    const payload = makeValidPayload({
      sourceRefs: [{ kind: 'invalid' as SourceRefKind, id: 'task_001' }],
    });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceRefs[0]'))).toBe(true);
  });

  it('sourceRefs with empty id fails validation', () => {
    const payload = makeValidPayload({
      sourceRefs: [{ kind: 'task', id: '' }],
    });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceRefs[0]'))).toBe(true);
  });

  it('sourceRunIds with empty string fails validation', () => {
    const payload = makeValidPayload({ sourceRunIds: ['run_001', ''] });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceRunIds'))).toBe(true);
  });

  it('ambiguityNotes as non-string array fails validation', () => {
    const payload = makeValidPayload({ ambiguityNotes: [42 as unknown as string] });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ambiguityNotes'))).toBe(true);
  });

  it('sanitizationNotes as non-string array fails validation', () => {
    const payload = makeValidPayload({ sanitizationNotes: [true as unknown as string] });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sanitizationNotes'))).toBe(true);
  });

  it('non-object input fails validation', () => {
    const result = validateFullTracePayload('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must be an object'))).toBe(true);
  });

  it('null input fails validation', () => {
    const result = validateFullTracePayload(null);
    expect(result.valid).toBe(false);
  });
});

// ── Sanitization Tests ──

describe('sanitizeFullTracePayload', () => {
  it('sanitizer removes secrets and records sanitizationNotes', () => {
    const payload = makeValidPayload({
      timeline: [
        {
          at: '2026-05-19T00:00:00Z',
          kind: 'tool_call',
          summary: 'Called API with apiKey=sk-proj-secret123',
          rawPreview: 'Authorization: Bearer tok_live_xxx',
          metadata: { api_key: 'pk_live_12345', user_password: 'hunter2' },
        },
      ],
    });

    const { payload: sanitized, sanitizationNotes } = sanitizeFullTracePayload(payload);

    expect(sanitized.timeline[0]?.summary).not.toContain('sk-proj-secret123');
    expect(sanitized.timeline[0]?.rawPreview).not.toContain('tok_live_xxx');
    expect(sanitized.timeline[0]?.metadata?.api_key).toBe('[REDACTED]');
    expect(sanitized.timeline[0]?.metadata?.user_password).toBe('[REDACTED]');
    expect(sanitizationNotes.length).toBeGreaterThan(0);
    expect(sanitized.sanitizationNotes.length).toBeGreaterThan(0);
  });

  it('sanitizer does not over-sanitize safe keys like tokenizer/tokenCount', () => {
    const payload = makeValidPayload({
      timeline: [
        {
          at: '2026-05-19T00:00:00Z',
          kind: 'tool_call',
          summary: 'Processing text',
          metadata: { tokenizer: 'gpt-4', tokenCount: 42 },
        },
      ],
    });

    const { payload: sanitized } = sanitizeFullTracePayload(payload);

    expect(sanitized.timeline[0]?.metadata?.tokenizer).toBe('gpt-4');
    expect(sanitized.timeline[0]?.metadata?.tokenCount).toBe(42);
  });

  it('sanitizer preserves payload structure when no secrets present', () => {
    const payload = makeValidPayload();
    const { payload: sanitized, sanitizationNotes } = sanitizeFullTracePayload(payload);

    expect(sanitizationNotes).toEqual([]);
    expect(sanitized.sourceTaskId).toBe(payload.sourceTaskId);
    expect(sanitized.sourcePainId).toBe(payload.sourcePainId);
    expect(sanitized.timeline).toEqual(payload.timeline);
  });

  it('sanitizer appends notes to existing sanitizationNotes', () => {
    const payload = makeValidPayload({
      sanitizationNotes: ['pre-existing note'],
      timeline: [
        {
          at: '2026-05-19T00:00:00Z',
          kind: 'tool_call',
          summary: 'password=supersecret',
        },
      ],
    });

    const { payload: sanitized } = sanitizeFullTracePayload(payload);

    expect(sanitized.sanitizationNotes).toContain('pre-existing note');
    expect(sanitized.sanitizationNotes.length).toBeGreaterThan(1);
  });
});

// ── Timeline Builder Tests ──

describe('buildFullTraceTimeline', () => {
  it('builds timeline from tool calls array', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        inputPayload: JSON.stringify({
          toolCalls: [
            { toolName: 'Read', status: 'succeeded', params: { file: '/src/main.ts' } },
            { toolName: 'Edit', status: 'succeeded', params: { file: '/src/main.ts', content: 'fixed' }, result: 'OK' },
          ],
        }),
        outputPayload: '{}',
        startedAt: '2026-05-19T00:00:00Z',
        endedAt: '2026-05-19T00:00:05Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    expect(timeline.length).toBeGreaterThanOrEqual(2);
    expect(timeline.some((e) => e.kind === 'tool_call' && e.summary.includes('Read'))).toBe(true);
    expect(timeline.some((e) => e.kind === 'tool_call' && e.summary.includes('Edit'))).toBe(true);
    expect(timeline.some((e) => e.kind === 'tool_result' && e.summary.includes('Edit'))).toBe(true);
  });

  it('builds timeline from user/assistant turns', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        inputPayload: JSON.stringify({
          userTurns: [{ turnIndex: 1, text: 'fix the bug' }],
        }),
        outputPayload: JSON.stringify({
          turns: [{ text: 'I fixed the bug' }],
        }),
        startedAt: '2026-05-19T00:00:00Z',
        endedAt: '2026-05-19T00:00:05Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    expect(timeline.some((e) => e.kind === 'user_message')).toBe(true);
    expect(timeline.some((e) => e.kind === 'assistant_message')).toBe(true);
  });

  it('builds timeline from plain text payloads', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        inputPayload: 'This is just plain text',
        outputPayload: 'Response text',
        startedAt: '2026-05-19T00:00:00Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    expect(timeline.some((e) => e.kind === 'unknown')).toBe(true);
  });

  it('returns empty timeline for runs with no payloads', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        startedAt: '2026-05-19T00:00:00Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    expect(timeline).toEqual([]);
  });

  it('timeline entries have valid kinds', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        inputPayload: JSON.stringify({
          userTurns: [{ text: 'hello' }],
          toolCalls: [{ toolName: 'Read', status: 'succeeded' }],
        }),
        outputPayload: JSON.stringify({
          turns: [{ text: 'done' }],
        }),
        startedAt: '2026-05-19T00:00:00Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    for (const entry of timeline) {
      expect(TRACE_EVENT_KINDS).toContain(entry.kind);
    }
  });

  it('synthesizes tool_call from single toolName input', () => {
    const runs: RunRecordLike[] = [
      {
        runId: 'run_001',
        inputPayload: JSON.stringify({ toolName: 'WriteFile', params: { path: '/tmp/test' } }),
        outputPayload: '{}',
        startedAt: '2026-05-19T00:00:00Z',
        executionStatus: 'succeeded',
      },
    ];

    const timeline = buildFullTraceTimeline(runs);

    expect(timeline.some((e) => e.kind === 'tool_call' && e.summary.includes('WriteFile'))).toBe(true);
  });
});

// ── Source Refs Builder Tests ──

describe('buildSourceRefs', () => {
  it('builds sourceRefs from task and runs', () => {
    const refs = buildSourceRefs('task_001', ['run_001', 'run_002']);

    expect(refs).toEqual([
      { kind: 'task', id: 'task_001' },
      { kind: 'run', id: 'run_001' },
      { kind: 'run', id: 'run_002' },
    ]);
  });

  it('builds sourceRefs with no runs', () => {
    const refs = buildSourceRefs('task_001', []);

    expect(refs).toEqual([{ kind: 'task', id: 'task_001' }]);
  });

  it('all sourceRefs pass schema validation', () => {
    const refs = buildSourceRefs('task_001', ['run_001']);
    for (const ref of refs) {
      expect(Value.Check(TraceSourceRefSchema, ref)).toBe(true);
    }
  });
});

// ── Ambiguity Notes Preservation ──

describe('ambiguityNotes preservation', () => {
  it('ambiguityNotes from SourceTraceLocator are preserved in payload', () => {
    const notes = [
      'Ambiguous source trace for sourcePainId=pain-001: 2 matched candidates',
      'diagnostic_json_unparseable for taskIds: task_003',
    ];
    const payload = makeValidPayload({ ambiguityNotes: notes });

    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(true);
    expect(payload.ambiguityNotes).toEqual(notes);
  });

  it('empty ambiguityNotes is valid', () => {
    const payload = makeValidPayload({ ambiguityNotes: [] });
    const result = validateFullTracePayload(payload);
    expect(result.valid).toBe(true);
  });
});

// ── Backward Compatibility ──

describe('backward compatibility', () => {
  it('FullTracePayloadV2Schema validates payload without optional legacy fields', () => {
    const payload = makeValidPayload();
    expect(Value.Check(FullTracePayloadV2Schema, payload)).toBe(true);
  });

  it('FullTracePayloadV2Schema is a strict subset - all required fields present', () => {
    const payload = makeValidPayload();
    const requiredFields = [
      'sourceTaskId', 'sourcePainId', 'sourceRunIds', 'capturedAt',
      'sourceRefs', 'timeline', 'ambiguityNotes', 'sanitizationNotes',
    ];
    for (const field of requiredFields) {
      expect(payload).toHaveProperty(field);
    }
  });
});
