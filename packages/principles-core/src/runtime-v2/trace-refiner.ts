/**
 * Deterministic TraceRefiner read model (PRI-191).
 *
 * Converts FullTracePayloadV2 into a compact, evidence-preserving,
 * prompt-safe RefinedTracePayload for Diagnostician / GoldenTrace consumption.
 *
 * Key invariants:
 *   - Deterministic: same input always produces deep-equal output
 *   - No LLM calls, no I/O, no filesystem/path/process/network imports
 *   - No plugin dependency
 *   - Preserves sourceTaskId/sourcePainId/sourceRunIds lineage
 *   - Preserves evidenceRefs from sourceRefs
 *   - Bounded output: keyEvents max 20, summary max 300 chars
 *   - Invalid input returns structured refinementNotes, never throws randomly
 *   - Does not modify FullTracePayloadV2 contract
 */
import type { FullTracePayloadV2, TraceTimelineEntry, TraceSourceRef } from './full-trace-contract.js';
import { validateFullTracePayload } from './full-trace-contract.js';

// ── Refined Trace Event ──

export const REFINED_EVENT_KINDS = [
  'failure',
  'tool_use',
  'user_intent',
  'assistant_action',
  'system_context',
  'unknown',
] as const;

export type RefinedEventKind = (typeof REFINED_EVENT_KINDS)[number];

export const SEVERITY_LEVELS = ['low', 'medium', 'high'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export interface RefinedTraceEvent {
  kind: RefinedEventKind;
  summary: string;
  evidenceRefs: string[];
  severity: SeverityLevel;
  at: string | null;
}

// ── Refined Trace Payload ──

export interface RefinedTracePayload {
  sourceTaskId: string;
  sourcePainId: string;
  sourceRunIds: string[];
  evidenceRefs: string[];
  keyEvents: RefinedTraceEvent[];
  failureSummary: string | null;
  toolUseSummary: string[];
  userIntentSummary: string | null;
  ambiguityNotes: string[];
  sanitizationNotes: string[];
  refinementNotes: string[];
}

// ── Options ──

export interface TraceRefinerOptions {
  maxKeyEvents?: number;
  maxSummaryLength?: number;
}

const DEFAULT_MAX_KEY_EVENTS = 20;
const DEFAULT_MAX_SUMMARY_LENGTH = 300;

// ── Failure Signal Detection ──

const FAILURE_SIGNALS = [
  'error',
  'failed',
  'exception',
  'timeout',
  'timed out',
  'permission denied',
  'denied',
  'crashed',
  'fatal',
  'abort',
  'unreachable',
];

function containsFailureSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return FAILURE_SIGNALS.some((signal) => lower.includes(signal));
}

function extractMetadataError(entry: TraceTimelineEntry): string | undefined {
  if (!entry.metadata || typeof entry.metadata !== 'object') return undefined;
  const meta = entry.metadata as Record<string, unknown>;
  if (typeof meta.error === 'string' && meta.error.length > 0) return meta.error;
  if (typeof meta.error === 'object' && meta.error !== null) {
    try { return JSON.stringify(meta.error); } catch { return undefined; }
  }
  return undefined;
}

function extractToolName(entry: TraceTimelineEntry): string | undefined {
  if (!entry.metadata || typeof entry.metadata !== 'object') return undefined;
  const meta = entry.metadata as Record<string, unknown>;
  if (typeof meta.toolName === 'string' && meta.toolName.length > 0) return meta.toolName;
  return undefined;
}

function extractToolStatus(entry: TraceTimelineEntry): string | undefined {
  if (!entry.metadata || typeof entry.metadata !== 'object') return undefined;
  const meta = entry.metadata as Record<string, unknown>;
  if (typeof meta.status === 'string' && meta.status.length > 0) return meta.status;
  return undefined;
}

function sourceRefToString(ref: TraceSourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

function truncateSummary(summary: string, maxLength: number): string {
  if (summary.length <= maxLength) return summary;
  return summary.slice(0, maxLength - 3) + '...';
}

function classifySeverity(entry: TraceTimelineEntry, kind: RefinedEventKind): SeverityLevel {
  if (kind === 'failure') {
    const errorText = extractMetadataError(entry);
    if (errorText) {
      const lower = errorText.toLowerCase();
      if (lower.includes('fatal') || lower.includes('crash')) return 'high';
      if (lower.includes('timeout') || lower.includes('permission denied')) return 'medium';
    }
    return 'high';
  }
  if (kind === 'tool_use') {
    const status = extractToolStatus(entry);
    if (status) {
      const lower = status.toLowerCase();
      if (lower.includes('fail') || lower.includes('error')) return 'high';
      if (lower.includes('partial') || lower.includes('timeout')) return 'medium';
    }
    return 'low';
  }
  if (kind === 'unknown') return 'low';
  if (kind === 'system_context') return 'low';
  return 'low';
}

function mapTimelineKindToRefinedKind(entry: TraceTimelineEntry): RefinedEventKind {
  switch (entry.kind) {
    case 'tool_call':
    case 'tool_result':
      return 'tool_use';
    case 'user_message':
      return 'user_intent';
    case 'assistant_message':
      return 'assistant_action';
    case 'system_event':
      return 'system_context';
    case 'unknown':
    default:
      return 'unknown';
  }
}

function isFailureEntry(entry: TraceTimelineEntry): boolean {
  if (extractMetadataError(entry)) return true;
  if (containsFailureSignal(entry.summary)) return true;
  if (entry.rawPreview && containsFailureSignal(entry.rawPreview)) return true;
  const status = extractToolStatus(entry);
  if (status && containsFailureSignal(status)) return true;
  return false;
}

// ── Main Refiner Function ──

export function refineFullTrace(
  fullTrace: FullTracePayloadV2,
  options?: TraceRefinerOptions,
): RefinedTracePayload {
  const maxKeyEvents = options?.maxKeyEvents ?? DEFAULT_MAX_KEY_EVENTS;
  const maxSummaryLength = options?.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH;
  const refinementNotes: string[] = [];

  if (fullTrace === null || fullTrace === undefined || typeof fullTrace !== 'object') {
    return {
      sourceTaskId: '',
      sourcePainId: '',
      sourceRunIds: [],
      evidenceRefs: [],
      keyEvents: [],
      failureSummary: null,
      toolUseSummary: [],
      userIntentSummary: null,
      ambiguityNotes: [],
      sanitizationNotes: [],
      refinementNotes: ['invalid_full_trace_input', 'validation_error: FullTracePayload must be an object'],
    };
  }

  const validation = validateFullTracePayload(fullTrace);
  if (!validation.valid) {
    const p = fullTrace as Record<string, unknown>;
    return {
      sourceTaskId: typeof p.sourceTaskId === 'string' ? p.sourceTaskId : '',
      sourcePainId: typeof p.sourcePainId === 'string' ? p.sourcePainId : '',
      sourceRunIds: Array.isArray(p.sourceRunIds) ? (p.sourceRunIds as string[]) : [],
      evidenceRefs: [],
      keyEvents: [],
      failureSummary: null,
      toolUseSummary: [],
      userIntentSummary: null,
      ambiguityNotes: Array.isArray((fullTrace as Record<string, unknown>).ambiguityNotes)
        ? ((fullTrace as Record<string, unknown>).ambiguityNotes as string[])
        : [],
      sanitizationNotes: Array.isArray((fullTrace as Record<string, unknown>).sanitizationNotes)
        ? ((fullTrace as Record<string, unknown>).sanitizationNotes as string[])
        : [],
      refinementNotes: [
        'invalid_full_trace_input',
        ...validation.errors.map((e) => `validation_error: ${e}`),
      ],
    };
  }

  const { timeline } = fullTrace;
  const evidenceRefs = fullTrace.sourceRefs.map(sourceRefToString);

  if (timeline.length === 0) {
    refinementNotes.push('empty_timeline');
  }

  const keyEvents: RefinedTraceEvent[] = [];
  const toolUseSummaries: string[] = [];
  const failureSummaries: string[] = [];
  let userIntentText: string | null = null;

  for (const entry of timeline) {
    const isFailure = isFailureEntry(entry);
    const refinedKind = isFailure ? 'failure' : mapTimelineKindToRefinedKind(entry);
    const severity = classifySeverity(entry, refinedKind);

    const summary = truncateSummary(entry.summary, maxSummaryLength);
    const entryEvidenceRefs: string[] = [];

    const toolName = extractToolName(entry);
    if (toolName) {
      const runRef = fullTrace.sourceRefs.find((r) => r.kind === 'run');
      if (runRef) entryEvidenceRefs.push(sourceRefToString(runRef));
    }
    if (entryEvidenceRefs.length === 0 && evidenceRefs.length > 0) {
      entryEvidenceRefs.push(...evidenceRefs);
    }

    keyEvents.push({
      kind: refinedKind,
      summary,
      evidenceRefs: entryEvidenceRefs,
      severity,
      at: entry.at,
    });

    if (refinedKind === 'failure') {
      const errorDetail = extractMetadataError(entry);
      if (errorDetail) {
        failureSummaries.push(truncateSummary(errorDetail, maxSummaryLength));
      } else {
        failureSummaries.push(summary);
      }
    }

    if (refinedKind === 'tool_use') {
      const status = extractToolStatus(entry);
      if (toolName) {
        toolUseSummaries.push(status ? `${toolName} (${status})` : toolName);
      } else {
        toolUseSummaries.push(status ? `unknown_tool (${status})` : 'unknown_tool');
      }
    }

    if (refinedKind === 'user_intent' && userIntentText === null) {
      userIntentText = truncateSummary(entry.summary, maxSummaryLength);
    }
  }

  if (failureSummaries.length === 0 && timeline.length > 0) {
    refinementNotes.push('no_failure_evidence');
  }

  if (fullTrace.sanitizationNotes.length > 0) {
    refinementNotes.push('sanitized_input_present');
  }

  if (fullTrace.ambiguityNotes.length > 0) {
    refinementNotes.push('source_trace_ambiguous');
  }

  let truncatedKeyEvents = keyEvents;
  if (keyEvents.length > maxKeyEvents) {
    truncatedKeyEvents = keyEvents.slice(0, maxKeyEvents);
    refinementNotes.push(`truncated_key_events: ${keyEvents.length} total, kept ${maxKeyEvents}`);
  }

  const failureSummary = failureSummaries.length > 0
    ? truncateSummary(failureSummaries.join('; '), maxSummaryLength)
    : null;

  return {
    sourceTaskId: fullTrace.sourceTaskId,
    sourcePainId: fullTrace.sourcePainId,
    sourceRunIds: [...fullTrace.sourceRunIds],
    evidenceRefs,
    keyEvents: truncatedKeyEvents,
    failureSummary,
    toolUseSummary: toolUseSummaries,
    userIntentSummary: userIntentText,
    ambiguityNotes: [...fullTrace.ambiguityNotes],
    sanitizationNotes: [...fullTrace.sanitizationNotes],
    refinementNotes,
  };
}
