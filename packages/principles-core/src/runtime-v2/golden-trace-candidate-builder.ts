import type { FullTracePayloadV2, TraceTimelineEntry } from './full-trace-contract.js';
import type { RefinedTracePayload } from './trace-refiner.js';
import type { GoldenTrace, GoldenTraceCase } from './golden-trace.js';

export type GoldenTraceCandidateDecision =
  | 'candidate_created'
  | 'insufficient_evidence';

export interface GoldenTraceCandidateBuilderInput {
  fullTrace: FullTracePayloadV2;
  refinedTrace: RefinedTracePayload;
  createdAt?: string;
}

export interface GoldenTraceCandidateRefusal {
  decision: 'insufficient_evidence';
  reasons: string[];
  evidenceRefs: string[];
}

export interface GoldenTraceCandidateCreated {
  decision: 'candidate_created';
  goldenTrace: GoldenTrace;
  evidenceRefs: string[];
  builderNotes: string[];
}

export type GoldenTraceCandidateBuilderResult =
  | GoldenTraceCandidateCreated
  | GoldenTraceCandidateRefusal;

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

function extractMetadataString(entry: TraceTimelineEntry, field: string): string | undefined {
  if (!entry.metadata || typeof entry.metadata !== 'object') return undefined;
  const meta = entry.metadata as Record<string, unknown>;
  const value = meta[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isFailureEntry(entry: TraceTimelineEntry): boolean {
  const errorText = extractMetadataString(entry, 'error');
  if (errorText) return true;
  if (containsFailureSignal(entry.summary)) return true;
  if (entry.rawPreview && containsFailureSignal(entry.rawPreview)) return true;
  const status = extractMetadataString(entry, 'status');
  if (status && containsFailureSignal(status)) return true;
  return false;
}

function tryParseJsonParams(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface ToolCallEvidence {
  toolName: string;
  params: Record<string, unknown>;
  isFailure: boolean;
  timelineIndex: number;
}

function hasFailureResult(
  timeline: TraceTimelineEntry[],
  toolCallIndex: number,
  toolName: string,
): boolean {
  for (let i = toolCallIndex + 1; i < timeline.length; i++) {
    const entry = timeline[i];
    if (!entry) continue;
    if (entry.kind === 'tool_result') {
      const resultToolName = extractMetadataString(entry, 'toolName');
      if (resultToolName === toolName) {
        return isFailureEntry(entry);
      }
    }
    if (entry.kind === 'tool_call') break;
  }
  return false;
}

function extractToolCallEvidence(timeline: TraceTimelineEntry[]): ToolCallEvidence[] {
  const results: ToolCallEvidence[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (!entry || entry.kind !== 'tool_call') continue;

    const toolName = extractMetadataString(entry, 'toolName');
    if (!toolName) continue;

    const params = tryParseJsonParams(entry.rawPreview);
    if (!params) continue;

    const isFailure = isFailureEntry(entry) || hasFailureResult(timeline, i, toolName);

    results.push({
      toolName,
      params,
      isFailure,
      timelineIndex: i,
    });
  }

  return results;
}

function deterministicHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function buildGoldenTraceCandidate(
  input: GoldenTraceCandidateBuilderInput,
): GoldenTraceCandidateBuilderResult {
  const { fullTrace, refinedTrace } = input;
  const reasons: string[] = [];
  const builderNotes: string[] = [];

  const toolCallEvidence = extractToolCallEvidence(fullTrace.timeline);

  const failureEvidence = toolCallEvidence.filter((e) => e.isFailure);
  const positiveEvidence = toolCallEvidence.filter((e) => !e.isFailure);

  if (failureEvidence.length === 0) {
    reasons.push('no_failure_evidence: trace contains no failing tool calls with extractable params');
  }

  if (positiveEvidence.length === 0) {
    reasons.push('no_positive_comparator: trace contains no non-failing tool calls with extractable params');
  }

  const noParamsEvidence = fullTrace.timeline.filter(
    (e) => e.kind === 'tool_call' && extractMetadataString(e, 'toolName') && !tryParseJsonParams(e.rawPreview),
  );
  if (noParamsEvidence.length > 0) {
    const toolNames = noParamsEvidence
      .map((e) => extractMetadataString(e, 'toolName'))
      .filter((n): n is string => n !== undefined);
    const missingParamsNote = `missing_params: tool calls without extractable params: ${toolNames.join(', ')}`;
    reasons.push(missingParamsNote);
    builderNotes.push(missingParamsNote);
  }

  if (failureEvidence.length === 0 || positiveEvidence.length === 0) {
    return {
      decision: 'insufficient_evidence',
      reasons,
      evidenceRefs: [...refinedTrace.evidenceRefs],
    };
  }

  if (refinedTrace.ambiguityNotes.length > 0) {
    builderNotes.push(...refinedTrace.ambiguityNotes.map((n) => `ambiguous: ${n}`));
  }

  if (refinedTrace.refinementNotes.length > 0) {
    builderNotes.push(...refinedTrace.refinementNotes.map((n) => `refinement: ${n}`));
  }

  if (refinedTrace.sanitizationNotes.length > 0) {
    builderNotes.push(...refinedTrace.sanitizationNotes.map((n) => `sanitized: ${n}`));
  }

  const { sourcePainId } = fullTrace;
  const { sourceTaskId } = fullTrace;
  const evidenceRefs = [...refinedTrace.evidenceRefs];

  const cases: GoldenTraceCase[] = [];

  let negativeIndex = 0;
  for (const evidence of failureEvidence) {
    negativeIndex++;
    const caseId = `neg-${deterministicHash(`${sourceTaskId}:${evidence.toolName}:${negativeIndex}`)}`;
    cases.push({
      caseId,
      kind: 'negative',
      toolName: evidence.toolName,
      params: { ...evidence.params },
      expectedDecision: 'block',
      sourceRefs: {
        painId: sourcePainId,
        candidateId: sourceTaskId,
      },
    });
  }

  let positiveIndex = 0;
  for (const evidence of positiveEvidence) {
    positiveIndex++;
    const caseId = `pos-${deterministicHash(`${sourceTaskId}:${evidence.toolName}:${positiveIndex}`)}`;
    cases.push({
      caseId,
      kind: 'positive',
      toolName: evidence.toolName,
      params: { ...evidence.params },
      expectedDecision: 'allow',
      sourceRefs: {
        painId: sourcePainId,
        candidateId: sourceTaskId,
      },
    });
  }

  const traceId = `gtc-${deterministicHash(`${sourceTaskId}:${sourcePainId}:${failureEvidence.map((e) => e.toolName).join(',')}`)}`;
  const createdAt = input.createdAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

  const goldenTrace: GoldenTrace = {
    traceId,
    sourcePainId,
    sourceCandidateId: sourceTaskId,
    cases,
    createdAt,
    version: 1,
  };

  return {
    decision: 'candidate_created',
    goldenTrace,
    evidenceRefs,
    builderNotes,
  };
}
