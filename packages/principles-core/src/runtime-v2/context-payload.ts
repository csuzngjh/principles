/**
 * Canonical context payload types for PD Runtime v2.
 *
 * Source: History Retrieval and Context Assembly SPEC, Sections 7.4, 8.3, 9.4
 * Source: Diagnostician v2 Detailed Design, Section 9.4
 * Source: PD Runtime Protocol SPEC v1, Sections 15-17
 *
 * These types define the output contracts for:
 *   - `pd trajectory locate` → TrajectoryLocateResult
 *   - `pd history query` → HistoryQueryResult
 *   - `pd context build` → ContextPayload
 *   - diagnostician context assembly → DiagnosticianContextPayload
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  FullTracePayloadV2Schema as FullTracePayloadV2SchemaImport,
  TraceSourceRefSchema as TraceSourceRefSchemaImport,
  TraceTimelineEntrySchema as TraceTimelineEntrySchemaImport,
  TraceEventKindSchema as TraceEventKindSchemaImport,
  SourceRefKindSchema as SourceRefKindSchemaImport,
  validateFullTracePayload,
  sanitizeFullTracePayload,
  buildFullTraceTimeline,
  buildSourceRefs,
  checkFullTracePayloadSchema,
  TRACE_EVENT_KINDS,
  SOURCE_REF_KINDS,
} from './full-trace-contract.js';
import type {
  FullTracePayloadV2 as FullTracePayloadV2Type,
  TraceSourceRef as TraceSourceRefType,
  TraceTimelineEntry as TraceTimelineEntryType,
  TraceEventKind as TraceEventKindType,
  SourceRefKind as SourceRefKindType,
  FullTraceValidationResult as FullTraceValidationResultType,
  SanitizeFullTraceResult as SanitizeFullTraceResultType,
  RunRecordLike as RunRecordLikeType,
} from './full-trace-contract.js';

// ── History Query Entry (shared building block) ──

export const HistoryQueryEntrySchema = Type.Object({
  ts: Type.String({ minLength: 1 }),
  role: Type.Union([
    Type.Literal('user'),
    Type.Literal('assistant'),
    Type.Literal('tool'),
    Type.Literal('system'),
  ]),
  text: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  toolResultSummary: Type.Optional(Type.String()),
  eventType: Type.Optional(Type.String()),
});

export type HistoryQueryEntry = Static<typeof HistoryQueryEntrySchema>;

// ── Trajectory Locate Result ──

export const TrajectoryLocateQuerySchema = Type.Object({
  painId: Type.Optional(Type.String({ minLength: 1 })),
  taskId: Type.Optional(Type.String({ minLength: 1 })),
  runId: Type.Optional(Type.String({ minLength: 1 })),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  timeRange: Type.Optional(Type.Object({
    start: Type.String({ minLength: 1 }),
    end: Type.String({ minLength: 1 }),
  })),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  executionStatus: Type.Optional(Type.String({ minLength: 1 })),
});

export type TrajectoryLocateQuery = Static<typeof TrajectoryLocateQuerySchema>;

export const TrajectoryCandidateSchema = Type.Object({
  trajectoryRef: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reasons: Type.Array(Type.String({ minLength: 1 })),
  sourceTypes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export type TrajectoryCandidate = Static<typeof TrajectoryCandidateSchema>;

export const TrajectoryLocateResultSchema = Type.Object({
  query: TrajectoryLocateQuerySchema,
  candidates: Type.Array(TrajectoryCandidateSchema),
});

export type TrajectoryLocateResult = Static<typeof TrajectoryLocateResultSchema>;

// ── History Query Result ──

export const HistoryQueryResultSchema = Type.Object({
  sourceRef: Type.String({ minLength: 1 }),
  entries: Type.Array(HistoryQueryEntrySchema),
  truncated: Type.Boolean(),
  nextCursor: Type.Optional(Type.String({ minLength: 1 })),
});

export type HistoryQueryResult = Static<typeof HistoryQueryResultSchema>;

// ── Context Payload (general purpose) ──

export type TraceAvailability =
  | 'available'
  | 'unavailable_with_reason'
  | 'ambiguous';

export interface TraceUnavailableDetail {
  reason: string;
  nextAction: string;
}

export const PainEvidenceEntrySchema = Type.Object({
  sourceRef: Type.String({ minLength: 1 }),
  note: Type.String({ minLength: 1, maxLength: 200 }),
});

export type PainEvidenceEntry = Static<typeof PainEvidenceEntrySchema>;

export const DiagnosisTargetSchema = Type.Object({
  reasonSummary: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  severity: Type.Optional(Type.String()),
  painId: Type.Optional(Type.String({ minLength: 1 })),
  sessionIdHint: Type.Optional(Type.String({ minLength: 1 })),
  provenance: Type.Optional(Type.Union([
    Type.Literal('host_context_bound'),
    Type.Literal('owner_reported_no_host_trace'),
    Type.Literal('automatic_hook'),
  ])),
  /** Codex Governance Closure SPEC §14: the diagnosis target names the evidence host. */
  hostKind: Type.Optional(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')])),
  provenanceReason: Type.Optional(Type.String()),
  traceAvailability: Type.Optional(Type.Union([
    Type.Literal('available'),
    Type.Literal('unavailable_with_reason'),
    Type.Literal('ambiguous'),
  ])),
  traceUnavailableDetail: Type.Optional(Type.Object({
    reason: Type.String(),
    nextAction: Type.String(),
  })),
  evidence: Type.Optional(Type.Array(PainEvidenceEntrySchema)),
});

export type DiagnosisTarget = Static<typeof DiagnosisTargetSchema>;

// ── Full Trace Payload (PRI-171) ──

export const ToolCallEntrySchema = Type.Object({
  toolName: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  params: Type.Optional(Type.String()),
  resultSummary: Type.Optional(Type.String()),
  errorSummary: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
});

export type ToolCallEntry = Static<typeof ToolCallEntrySchema>;

export const PainContextSchema = Type.Object({
  painId: Type.Optional(Type.String({ minLength: 1 })),
  severity: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  reasonSummary: Type.Optional(Type.String()),
  sessionIdHint: Type.Optional(Type.String()),
});

export type PainContext = Static<typeof PainContextSchema>;

export const FullTracePayloadSchema = Type.Object({
  painContext: PainContextSchema,
  scratchpad: Type.Array(Type.String()),
  toolCallHistory: Type.Array(ToolCallEntrySchema),
});

export type FullTracePayload = Static<typeof FullTracePayloadSchema>;

// ── FullTrace V2 Payload (PRI-190) ──

export const FullTracePayloadV2Schema = FullTracePayloadV2SchemaImport;
export const TraceSourceRefSchema = TraceSourceRefSchemaImport;
export const TraceTimelineEntrySchema = TraceTimelineEntrySchemaImport;
export const TraceEventKindSchema = TraceEventKindSchemaImport;
export const SourceRefKindSchema = SourceRefKindSchemaImport;

export type FullTracePayloadV2 = FullTracePayloadV2Type;
export type TraceSourceRef = TraceSourceRefType;
export type TraceTimelineEntry = TraceTimelineEntryType;
export type TraceEventKind = TraceEventKindType;
export type SourceRefKind = SourceRefKindType;
export type FullTraceValidationResult = FullTraceValidationResultType;
export type SanitizeFullTraceResult = SanitizeFullTraceResultType;
export type RunRecordLike = RunRecordLikeType;

export {
  validateFullTracePayload,
  sanitizeFullTracePayload,
  buildFullTraceTimeline,
  buildSourceRefs,
  checkFullTracePayloadSchema,
  TRACE_EVENT_KINDS,
  SOURCE_REF_KINDS,
};

export const ContextPayloadSchema = Type.Object({
  contextId: Type.String({ minLength: 1 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1 })),
  targetAgent: Type.Optional(Type.String({ minLength: 1 })),
  diagnosisTarget: Type.Optional(DiagnosisTargetSchema),
  conversationWindow: Type.Array(HistoryQueryEntrySchema),
  artifactRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
  summary: Type.String({ minLength: 1 }),
});

export type ContextPayload = Static<typeof ContextPayloadSchema>;

// ── Diagnostician-specific Context Payload ──

export const DiagnosticianContextPayloadSchema = Type.Object({
  contextId: Type.String({ minLength: 1 }),
  contextHash: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1 }),
  workspaceDir: Type.String({ minLength: 1 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1 })),
  diagnosisTarget: DiagnosisTargetSchema,
  conversationWindow: Type.Array(HistoryQueryEntrySchema),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
  fullTrace: Type.Optional(Type.Union([FullTracePayloadSchema, FullTracePayloadV2SchemaImport, Type.Null()])),
});

export type DiagnosticianContextPayload = Static<typeof DiagnosticianContextPayloadSchema>;
