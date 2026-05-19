/**
 * FullTrace quality contract and schema hardening (PRI-190).
 *
 * Defines the structured payload contract for source execution traces
 * consumed by Diagnostician and downstream L2 components (TraceRefiner).
 *
 * Key invariants:
 *   - sourceTaskId / sourcePainId / sourceRunIds provide traceability
 *   - timeline is a structured array, not a string blob
 *   - sourceRefs explicitly record task/run/artifact/event references
 *   - ambiguityNotes preserves PRI-189 missing/mismatch/ambiguous diagnostics
 *   - sanitizationNotes records every redaction action
 *   - capturedAt is an ISO timestamp
 *   - All unknown input is runtime-validated (no `as` casts on untrusted JSON)
 *
 * This module is pure logic — zero I/O, no filesystem/path/process imports, no plugin deps.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ── Trace Event Kind ──

export const TRACE_EVENT_KINDS = [
  'tool_call',
  'tool_result',
  'assistant_message',
  'user_message',
  'system_event',
  'unknown',
] as const;

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export const TraceEventKindSchema = Type.Union(
  TRACE_EVENT_KINDS.map((k) => Type.Literal(k)),
);

// ── Source Ref Kind ──

export const SOURCE_REF_KINDS = [
  'task',
  'run',
  'artifact',
  'event',
] as const;

export type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];

export const SourceRefKindSchema = Type.Union(
  SOURCE_REF_KINDS.map((k) => Type.Literal(k)),
);

// ── Trace Source Ref ──

export const TraceSourceRefSchema = Type.Object({
  kind: SourceRefKindSchema,
  id: Type.String({ minLength: 1 }),
});

export type TraceSourceRef = Static<typeof TraceSourceRefSchema>;

// ── Trace Timeline Entry ──

export const TraceTimelineEntrySchema = Type.Object({
  at: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  kind: TraceEventKindSchema,
  summary: Type.String({ minLength: 1 }),
  rawPreview: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type TraceTimelineEntry = Static<typeof TraceTimelineEntrySchema>;

// ── FullTrace Payload (PRI-190 enhanced) ──

export const FullTracePayloadV2Schema = Type.Object({
  sourceTaskId: Type.String({ minLength: 1 }),
  sourcePainId: Type.String({ minLength: 1 }),
  sourceRunIds: Type.Array(Type.String({ minLength: 1 })),
  capturedAt: Type.String({ minLength: 1 }),
  sourceRefs: Type.Array(TraceSourceRefSchema),
  timeline: Type.Array(TraceTimelineEntrySchema),
  ambiguityNotes: Type.Array(Type.String()),
  sanitizationNotes: Type.Array(Type.String()),
});

export type FullTracePayloadV2 = Static<typeof FullTracePayloadV2Schema>;

// ── Runtime Validation ──

export interface FullTraceValidationResult {
  valid: boolean;
  errors: string[];
}

const TRACE_EVENT_KIND_SET = new Set<string>(TRACE_EVENT_KINDS);
const SOURCE_REF_KIND_SET = new Set<string>(SOURCE_REF_KINDS);

function isValidIsoTimestamp(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === 'string')
  );
}

function isValidSourceRef(ref: unknown): ref is TraceSourceRef {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !SOURCE_REF_KIND_SET.has(r.kind)) return false;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  return true;
}

function isValidTimelineEntry(entry: unknown): { valid: boolean; error?: string } {
  if (typeof entry !== 'object' || entry === null) {
    return { valid: false, error: 'timeline entry must be an object' };
  }
  const e = entry as Record<string, unknown>;

  if (e.at !== null && typeof e.at !== 'string') {
    return { valid: false, error: 'timeline entry.at must be string or null' };
  }
  if (typeof e.at === 'string' && e.at.length === 0) {
    return { valid: false, error: 'timeline entry.at must be non-empty string when present' };
  }

  if (typeof e.kind !== 'string' || !TRACE_EVENT_KIND_SET.has(e.kind)) {
    return {
      valid: false,
      error: `timeline entry.kind must be one of ${TRACE_EVENT_KINDS.join('|')}, got: ${String(e.kind)}`,
    };
  }

  if (typeof e.summary !== 'string' || e.summary.length === 0) {
    return { valid: false, error: 'timeline entry.summary must be a non-empty string' };
  }

  if (e.rawPreview !== undefined && typeof e.rawPreview !== 'string') {
    return { valid: false, error: 'timeline entry.rawPreview must be string if present' };
  }

  if (e.metadata !== undefined && (typeof e.metadata !== 'object' || e.metadata === null || Array.isArray(e.metadata))) {
    return { valid: false, error: 'timeline entry.metadata must be a record if present' };
  }

  return { valid: true };
}

export function validateFullTracePayload(input: unknown): FullTraceValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['FullTracePayload must be an object'] };
  }

  const p = input as Record<string, unknown>;

  if (typeof p.sourceTaskId !== 'string' || p.sourceTaskId.length === 0) {
    errors.push('sourceTaskId must be a non-empty string');
  }

  if (typeof p.sourcePainId !== 'string' || p.sourcePainId.length === 0) {
    errors.push('sourcePainId must be a non-empty string');
  }

  if (!isStringArray(p.sourceRunIds)) {
    errors.push('sourceRunIds must be an array of non-empty strings');
  } else if (p.sourceRunIds.some((id) => id.length === 0)) {
    errors.push('sourceRunIds must not contain empty strings');
  }

  if (typeof p.capturedAt !== 'string' || p.capturedAt.length === 0) {
    errors.push('capturedAt must be a non-empty ISO timestamp string');
  } else if (!isValidIsoTimestamp(p.capturedAt)) {
    errors.push('capturedAt must be a valid ISO 8601 timestamp');
  }

  if (!Array.isArray(p.sourceRefs)) {
    errors.push('sourceRefs must be an array');
  } else {
    for (let i = 0; i < p.sourceRefs.length; i++) {
      if (!isValidSourceRef(p.sourceRefs[i])) {
        errors.push(`sourceRefs[${i}] is invalid: must have { kind: SourceRefKind, id: non-empty string }`);
      }
    }
  }

  if (!Array.isArray(p.timeline)) {
    errors.push('timeline must be an array');
  } else {
    for (let i = 0; i < p.timeline.length; i++) {
      const result = isValidTimelineEntry(p.timeline[i]);
      if (!result.valid) {
        errors.push(`timeline[${i}]: ${result.error}`);
      }
    }
  }

  if (!isStringArray(p.ambiguityNotes)) {
    errors.push('ambiguityNotes must be an array of strings');
  }

  if (!isStringArray(p.sanitizationNotes)) {
    errors.push('sanitizationNotes must be an array of strings');
  }

  return { valid: errors.length === 0, errors };
}

// ── PII Sanitizer ──

const SECRET_KEY_PATTERNS = [
  'apikey', 'api_key', 'api-key',
  'token',
  'authorization',
  'password',
  'secret',
  'bearer',
  'access_token', 'refresh_token', 'auth_token', 'secret_key',
];

function sanitizeString(input: string): { result: string; redacted: boolean } {
  let redacted = false;
  const result = input
    .replace(/\bapi[_-]?key\s*[:=]\s*\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\bapi[_-]?key["']?\s*:\s*["'][^"']*["']/gi, (m) => { redacted = true; const i = m.indexOf(':'); return m.slice(0, i + 1) + '"[REDACTED]"'; })
    .replace(/\btoken\s*[:=]\s*\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\btoken["']?\s*:\s*["'][^"']*["']/gi, (m) => { redacted = true; const i = m.indexOf(':'); return m.slice(0, i + 1) + '"[REDACTED]"'; })
    .replace(/\bbearer\s+\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\bauthorization\s*[:=]\s*\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\bauthorization["']?\s*:\s*["'][^"']*["']/gi, (m) => { redacted = true; const i = m.indexOf(':'); return m.slice(0, i + 1) + '"[REDACTED]"'; })
    .replace(/\bpassword\s*[:=]\s*\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\bpassword["']?\s*:\s*["'][^"']*["']/gi, (m) => { redacted = true; const i = m.indexOf(':'); return m.slice(0, i + 1) + '"[REDACTED]"'; })
    .replace(/\bsecret\s*[:=]\s*\S+/gi, (m) => { redacted = true; return m.replace(/\S+$/, '[REDACTED]'); })
    .replace(/\bsecret["']?\s*:\s*["'][^"']*["']/gi, (m) => { redacted = true; const i = m.indexOf(':'); return m.slice(0, i + 1) + '"[REDACTED]"'; });
  return { result, redacted };
}

function sanitizeObject(obj: unknown): { result: unknown; redactedKeys: string[] } {
  if (typeof obj === 'string') {
    const { result, redacted } = sanitizeString(obj);
    return { result, redactedKeys: redacted ? ['string_value'] : [] };
  }
  if (Array.isArray(obj)) {
    const allRedacted: string[] = [];
    const results = obj.map((item, i) => {
      const { result, redactedKeys } = sanitizeObject(item);
      allRedacted.push(...redactedKeys.map((k) => `[${i}].${k}`));
      return result;
    });
    return { result: results, redactedKeys: allRedacted };
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    const allRedacted: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (SECRET_KEY_PATTERNS.some(
        (p) => keyLower === p || keyLower.endsWith('_' + p) || keyLower.startsWith(p + '_') || keyLower.endsWith('-' + p) || keyLower.startsWith(p + '-'),
      )) {
        result[key] = '[REDACTED]';
        allRedacted.push(key);
      } else {
        const { result: sanitized, redactedKeys } = sanitizeObject(value);
        result[key] = sanitized;
        allRedacted.push(...redactedKeys.map((k) => `${key}.${k}`));
      }
    }
    return { result, redactedKeys: allRedacted };
  }
  return { result: obj, redactedKeys: [] };
}

export interface SanitizeFullTraceResult {
  payload: FullTracePayloadV2;
  sanitizationNotes: string[];
}

export function sanitizeFullTracePayload(input: FullTracePayloadV2): SanitizeFullTraceResult {
  const notes: string[] = [];

  const sanitizedTimeline = input.timeline.map((entry, i) => {
    const { result: sanitizedSummary, redacted: summaryRedacted } = sanitizeString(entry.summary);
    if (summaryRedacted) notes.push(`timeline[${i}].summary: secret pattern redacted`);

    let sanitizedRawPreview = entry.rawPreview;
    if (typeof entry.rawPreview === 'string') {
      const { result, redacted } = sanitizeString(entry.rawPreview);
      sanitizedRawPreview = result;
      if (redacted) notes.push(`timeline[${i}].rawPreview: secret pattern redacted`);
    }

    let sanitizedMetadata = entry.metadata;
    if (entry.metadata) {
      const { result, redactedKeys } = sanitizeObject(entry.metadata);
      sanitizedMetadata = result as Record<string, unknown>;
      for (const key of redactedKeys) {
        notes.push(`timeline[${i}].metadata.${key}: secret key redacted`);
      }
    }

    return {
      ...entry,
      summary: sanitizedSummary,
      rawPreview: sanitizedRawPreview,
      metadata: sanitizedMetadata,
    };
  });

  return {
    payload: {
      ...input,
      timeline: sanitizedTimeline,
      sanitizationNotes: [...input.sanitizationNotes, ...notes],
    },
    sanitizationNotes: notes,
  };
}

// ── Timeline Builder ──

export interface RunRecordLike {
  runId: string;
  inputPayload?: string;
  outputPayload?: string;
  startedAt: string;
  endedAt?: string;
  executionStatus: string;
}

function tryParseJson(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractStringField(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractUserTurnText(parsed: Record<string, unknown>): string | undefined {
  if (Array.isArray(parsed.userTurns)) {
    const texts: string[] = [];
    for (const turn of parsed.userTurns) {
      if (turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).text === 'string') {
        texts.push((turn as Record<string, unknown>).text as string);
      }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return undefined;
}

function extractAssistantTurnText(parsed: Record<string, unknown>): string | undefined {
  if (Array.isArray(parsed.turns)) {
    const texts: string[] = [];
    for (const turn of parsed.turns) {
      if (turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).text === 'string') {
        texts.push((turn as Record<string, unknown>).text as string);
      }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return undefined;
}

export function buildFullTraceTimeline(runs: readonly RunRecordLike[]): TraceTimelineEntry[] {
  const timeline: TraceTimelineEntry[] = [];

  for (const run of runs) {
    const inputParsed = tryParseJson(run.inputPayload);
    const outputParsed = tryParseJson(run.outputPayload);

    const userText = inputParsed
      ? extractStringField(inputParsed, 'text') ?? extractUserTurnText(inputParsed)
      : undefined;

    if (userText) {
      timeline.push({
        at: run.startedAt ?? null,
        kind: 'user_message',
        summary: userText.length > 200 ? userText.slice(0, 200) + '...[truncated]' : userText,
        rawPreview: userText.length > 500 ? userText.slice(0, 500) + '...[truncated]' : undefined,
      });
    }

    const toolCalls = inputParsed?.toolCalls ?? outputParsed?.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue;
        const tcObj = tc as Record<string, unknown>;
        const toolName = typeof tcObj.toolName === 'string' ? tcObj.toolName : typeof tcObj.name === 'string' ? tcObj.name : 'unknown';
        const status = typeof tcObj.status === 'string' ? tcObj.status : undefined;
        timeline.push({
          at: run.startedAt ?? null,
          kind: 'tool_call',
          summary: `${toolName}${status ? ` (${status})` : ''}`,
          rawPreview: tcObj.params ? JSON.stringify(tcObj.params).slice(0, 500) : undefined,
          metadata: {
            toolName,
            ...(status ? { status } : {}),
            ...(tcObj.error ? { error: typeof tcObj.error === 'string' ? tcObj.error : JSON.stringify(tcObj.error) } : {}),
          },
        });

        if (tcObj.result || tcObj.error) {
          timeline.push({
            at: run.endedAt ?? run.startedAt ?? null,
            kind: 'tool_result',
            summary: tcObj.error
              ? `Error from ${toolName}`
              : `Result from ${toolName}`,
            rawPreview: tcObj.result
              ? (typeof tcObj.result === 'string' ? tcObj.result : JSON.stringify(tcObj.result)).slice(0, 500)
              : undefined,
            metadata: tcObj.error
              ? { toolName, error: typeof tcObj.error === 'string' ? tcObj.error : JSON.stringify(tcObj.error) }
              : { toolName },
          });
        }
      }
    } else if (inputParsed) {
      const toolName = extractStringField(inputParsed, 'toolName') ?? extractStringField(inputParsed, 'name');
      if (toolName) {
        timeline.push({
          at: run.startedAt ?? null,
          kind: 'tool_call',
          summary: `${toolName} (${run.executionStatus})`,
          rawPreview: inputParsed.params ? JSON.stringify(inputParsed.params).slice(0, 500) : undefined,
          metadata: { toolName, status: run.executionStatus },
        });
      }
    }

    const assistantText = outputParsed
      ? extractStringField(outputParsed, 'text') ?? extractAssistantTurnText(outputParsed)
      : undefined;

    if (assistantText) {
      timeline.push({
        at: run.endedAt ?? run.startedAt ?? null,
        kind: 'assistant_message',
        summary: assistantText.length > 200 ? assistantText.slice(0, 200) + '...[truncated]' : assistantText,
        rawPreview: assistantText.length > 500 ? assistantText.slice(0, 500) + '...[truncated]' : undefined,
      });
    }

    if (run.inputPayload && !inputParsed && run.inputPayload.trim().length > 0) {
      const text = run.inputPayload.trim();
      timeline.push({
        at: run.startedAt ?? null,
        kind: 'unknown',
        summary: text.length > 200 ? text.slice(0, 200) + '...[truncated]' : text,
        rawPreview: text.length > 500 ? text.slice(0, 500) + '...[truncated]' : undefined,
      });
    }

    if (run.outputPayload && !outputParsed && run.outputPayload.trim().length > 0) {
      const text = run.outputPayload.trim();
      timeline.push({
        at: run.endedAt ?? run.startedAt ?? null,
        kind: 'unknown',
        summary: text.length > 200 ? text.slice(0, 200) + '...[truncated]' : text,
        rawPreview: text.length > 500 ? text.slice(0, 500) + '...[truncated]' : undefined,
      });
    }
  }

  return timeline;
}

// ── Source Refs Builder ──

export function buildSourceRefs(
  sourceTaskId: string,
  sourceRunIds: string[],
): TraceSourceRef[] {
  const refs: TraceSourceRef[] = [
    { kind: 'task', id: sourceTaskId },
  ];
  for (const runId of sourceRunIds) {
    refs.push({ kind: 'run', id: runId });
  }
  return refs;
}

// ── Schema Validation Helper ──

export function checkFullTracePayloadSchema(input: unknown): boolean {
  return Value.Check(FullTracePayloadV2Schema, input);
}
