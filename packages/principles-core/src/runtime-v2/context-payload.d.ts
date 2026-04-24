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
import { type Static } from '@sinclair/typebox';
export declare const HistoryQueryEntrySchema: import("@sinclair/typebox").TObject<{
    ts: import("@sinclair/typebox").TString;
    role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"assistant">, import("@sinclair/typebox").TLiteral<"tool">, import("@sinclair/typebox").TLiteral<"system">]>;
    text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    toolName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    toolResultSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    eventType: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type HistoryQueryEntry = Static<typeof HistoryQueryEntrySchema>;
export declare const TrajectoryLocateQuerySchema: import("@sinclair/typebox").TObject<{
    painId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    taskId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    runId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeRange: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        start: import("@sinclair/typebox").TString;
        end: import("@sinclair/typebox").TString;
    }>>;
    workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    executionStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type TrajectoryLocateQuery = Static<typeof TrajectoryLocateQuerySchema>;
export declare const TrajectoryCandidateSchema: import("@sinclair/typebox").TObject<{
    trajectoryRef: import("@sinclair/typebox").TString;
    confidence: import("@sinclair/typebox").TNumber;
    reasons: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    sourceTypes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
}>;
export type TrajectoryCandidate = Static<typeof TrajectoryCandidateSchema>;
export declare const TrajectoryLocateResultSchema: import("@sinclair/typebox").TObject<{
    query: import("@sinclair/typebox").TObject<{
        painId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        taskId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        runId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeRange: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            start: import("@sinclair/typebox").TString;
            end: import("@sinclair/typebox").TString;
        }>>;
        workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        executionStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    candidates: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        trajectoryRef: import("@sinclair/typebox").TString;
        confidence: import("@sinclair/typebox").TNumber;
        reasons: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        sourceTypes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    }>>;
}>;
export type TrajectoryLocateResult = Static<typeof TrajectoryLocateResultSchema>;
export declare const HistoryQueryResultSchema: import("@sinclair/typebox").TObject<{
    sourceRef: import("@sinclair/typebox").TString;
    entries: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"assistant">, import("@sinclair/typebox").TLiteral<"tool">, import("@sinclair/typebox").TLiteral<"system">]>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolResultSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        eventType: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    truncated: import("@sinclair/typebox").TBoolean;
    nextCursor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type HistoryQueryResult = Static<typeof HistoryQueryResultSchema>;
export declare const DiagnosisTargetSchema: import("@sinclair/typebox").TObject<{
    reasonSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    severity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    painId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionIdHint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type DiagnosisTarget = Static<typeof DiagnosisTargetSchema>;
export declare const ContextPayloadSchema: import("@sinclair/typebox").TObject<{
    contextId: import("@sinclair/typebox").TString;
    sourceRefs: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    targetAgent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    diagnosisTarget: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        reasonSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        severity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        painId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionIdHint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    conversationWindow: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"assistant">, import("@sinclair/typebox").TLiteral<"tool">, import("@sinclair/typebox").TLiteral<"system">]>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolResultSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        eventType: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    eventSummaries: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>>>;
    artifactRefs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    ambiguityNotes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    summary: import("@sinclair/typebox").TString;
}>;
export type ContextPayload = Static<typeof ContextPayloadSchema>;
export declare const DiagnosticianContextPayloadSchema: import("@sinclair/typebox").TObject<{
    contextId: import("@sinclair/typebox").TString;
    contextHash: import("@sinclair/typebox").TString;
    taskId: import("@sinclair/typebox").TString;
    workspaceDir: import("@sinclair/typebox").TString;
    sourceRefs: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    diagnosisTarget: import("@sinclair/typebox").TObject<{
        reasonSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        severity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        painId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionIdHint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    conversationWindow: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"assistant">, import("@sinclair/typebox").TLiteral<"tool">, import("@sinclair/typebox").TLiteral<"system">]>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        toolResultSummary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        eventType: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    eventSummaries: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>>>;
    ambiguityNotes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
}>;
export type DiagnosticianContextPayload = Static<typeof DiagnosticianContextPayloadSchema>;
//# sourceMappingURL=context-payload.d.ts.map