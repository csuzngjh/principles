/**
 * Canonical diagnostician output schema for PD Runtime v2.
 *
 * Source: Diagnostician v2 Detailed Design, Section 11
 * Source: PD Runtime Protocol SPEC v1, Section 18
 *
 * This is the single structured output contract for diagnosis results.
 * All runtime adapters producing diagnostician output must conform to this schema.
 */
import { type Static } from '@sinclair/typebox';
import type { DiagnosticianContextPayload } from './context-payload.js';
export declare const DiagnosticianViolatedPrincipleSchema: import("@sinclair/typebox").TObject<{
    principleId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    rationale: import("@sinclair/typebox").TString;
}>;
export type DiagnosticianViolatedPrinciple = Static<typeof DiagnosticianViolatedPrincipleSchema>;
export declare const DiagnosticianEvidenceSchema: import("@sinclair/typebox").TObject<{
    sourceRef: import("@sinclair/typebox").TString;
    note: import("@sinclair/typebox").TString;
}>;
export type DiagnosticianEvidence = Static<typeof DiagnosticianEvidenceSchema>;
export declare const RecommendationKindSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"principle">, import("@sinclair/typebox").TLiteral<"rule">, import("@sinclair/typebox").TLiteral<"implementation">, import("@sinclair/typebox").TLiteral<"prompt">, import("@sinclair/typebox").TLiteral<"defer">]>;
export type RecommendationKind = Static<typeof RecommendationKindSchema>;
export declare const DiagnosticianRecommendationSchema: import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"principle">, import("@sinclair/typebox").TLiteral<"rule">, import("@sinclair/typebox").TLiteral<"implementation">, import("@sinclair/typebox").TLiteral<"prompt">, import("@sinclair/typebox").TLiteral<"defer">]>;
    description: import("@sinclair/typebox").TString;
}>;
export type DiagnosticianRecommendation = Static<typeof DiagnosticianRecommendationSchema>;
export declare const DiagnosticianOutputV1Schema: import("@sinclair/typebox").TObject<{
    valid: import("@sinclair/typebox").TBoolean;
    diagnosisId: import("@sinclair/typebox").TString;
    taskId: import("@sinclair/typebox").TString;
    summary: import("@sinclair/typebox").TString;
    rootCause: import("@sinclair/typebox").TString;
    violatedPrinciples: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        principleId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        rationale: import("@sinclair/typebox").TString;
    }>>;
    evidence: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        sourceRef: import("@sinclair/typebox").TString;
        note: import("@sinclair/typebox").TString;
    }>>;
    recommendations: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"principle">, import("@sinclair/typebox").TLiteral<"rule">, import("@sinclair/typebox").TLiteral<"implementation">, import("@sinclair/typebox").TLiteral<"prompt">, import("@sinclair/typebox").TLiteral<"defer">]>;
        description: import("@sinclair/typebox").TString;
    }>>;
    confidence: import("@sinclair/typebox").TNumber;
    ambiguityNotes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
}>;
export type DiagnosticianOutputV1 = Static<typeof DiagnosticianOutputV1Schema>;
/**
 * TypeBox schema for diagnostician invocation input.
 * The `context` field uses Type.Unknown() because cross-file TypeBox schema
 * references can cause circular dependency issues. The actual type validation
 * is performed separately via DiagnosticianContextPayloadSchema.
 */
export declare const DiagnosticianInvocationInputSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TLiteral<"diagnostician">;
    taskId: import("@sinclair/typebox").TString;
    context: import("@sinclair/typebox").TUnknown;
    outputSchemaRef: import("@sinclair/typebox").TLiteral<"diagnostician-output-v1">;
    timeoutMs: import("@sinclair/typebox").TNumber;
}>;
/** Typed interface for diagnostician invocation — context references DiagnosticianContextPayload (per D-02). */
export interface DiagnosticianInvocationInput {
    /** Agent identifier (always "diagnostician"). */
    agentId: 'diagnostician';
    /** The task being diagnosed. */
    taskId: string;
    /** Pre-assembled context for the diagnosis. */
    context: DiagnosticianContextPayload;
    /** Reference to the output schema version. */
    outputSchemaRef: 'diagnostician-output-v1';
    /** Timeout in milliseconds for this invocation. */
    timeoutMs: number;
}
//# sourceMappingURL=diagnostician-output.d.ts.map