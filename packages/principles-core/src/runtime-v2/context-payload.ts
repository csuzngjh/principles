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
});
 
export type HistoryQueryResult = Static<typeof HistoryQueryResultSchema>;

// ── Context Payload (general purpose) ──

export const DiagnosisTargetSchema = Type.Object({
  reasonSummary: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  severity: Type.Optional(Type.String()),
  painId: Type.Optional(Type.String({ minLength: 1 })),
  sessionIdHint: Type.Optional(Type.String({ minLength: 1 })),
});
 
export type DiagnosisTarget = Static<typeof DiagnosisTargetSchema>;

export const ContextPayloadSchema = Type.Object({
  contextId: Type.String({ minLength: 1 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1 })),
  targetAgent: Type.Optional(Type.String({ minLength: 1 })),
  diagnosisTarget: Type.Optional(DiagnosisTargetSchema),
  conversationWindow: Type.Array(HistoryQueryEntrySchema),
  eventSummaries: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
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
  eventSummaries: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
});
 
export type DiagnosticianContextPayload = Static<typeof DiagnosticianContextPayloadSchema>;
