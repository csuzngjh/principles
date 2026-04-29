/**
 * Canonical diagnostician output schema for PD Runtime v2.
 *
 * Source: Diagnostician v2 Detailed Design, Section 11
 * Source: PD Runtime Protocol SPEC v1, Section 18
 *
 * This is the single structured output contract for diagnosis results.
 * All runtime adapters producing diagnostician output must conform to this schema.
 */
import { Type, type Static } from '@sinclair/typebox';
import type { DiagnosticianContextPayload } from './context-payload.js';

// ── Diagnostician Output V1 ──

export const DiagnosticianViolatedPrincipleSchema = Type.Object({
  principleId: Type.Optional(Type.String({ minLength: 1 })),
  title: Type.Optional(Type.String()),
  rationale: Type.String({ minLength: 1 }),
});
 
export type DiagnosticianViolatedPrinciple = Static<typeof DiagnosticianViolatedPrincipleSchema>;

export const DiagnosticianEvidenceSchema = Type.Object({
  sourceRef: Type.String({ minLength: 1 }),
  note: Type.String({ minLength: 1 }),
});
 
export type DiagnosticianEvidence = Static<typeof DiagnosticianEvidenceSchema>;

export const RecommendationKindSchema = Type.Union([
  Type.Literal('principle'),
  Type.Literal('rule'),
  Type.Literal('implementation'),
  Type.Literal('prompt'),
  Type.Literal('defer'),
]);
 
export type RecommendationKind = Static<typeof RecommendationKindSchema>;

export const DiagnosticianRecommendationSchema = Type.Object({
  kind: RecommendationKindSchema,
  description: Type.String({ minLength: 1 }),
  /** Trigger pattern (regex/keywords) — required when kind is 'principle' */
  triggerPattern: Type.Optional(Type.String()),
  /** Action to take when pattern matches — required when kind is 'principle' */
  action: Type.Optional(Type.String()),
  /** Highly abstracted principle (≤200 chars) — required when kind is 'principle'
   * @see MAX_ABSTRACTED_PRINCIPLE_CHARS in runner/default-validator.ts
   */
  abstractedPrinciple: Type.Optional(Type.String()),
});
 
export type DiagnosticianRecommendation = Static<typeof DiagnosticianRecommendationSchema>;

export const DiagnosticianOutputV1Schema = Type.Object({
  valid: Type.Boolean(),
  diagnosisId: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  rootCause: Type.String({ minLength: 1 }),
  violatedPrinciples: Type.Array(DiagnosticianViolatedPrincipleSchema),
  evidence: Type.Array(DiagnosticianEvidenceSchema),
  recommendations: Type.Array(DiagnosticianRecommendationSchema),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
});
 
export type DiagnosticianOutputV1 = Static<typeof DiagnosticianOutputV1Schema>;

// ── Diagnostician Invocation Input ──

/**
 * TypeBox schema for diagnostician invocation input.
 * The `context` field uses Type.Unknown() because cross-file TypeBox schema
 * references can cause circular dependency issues. The actual type validation
 * is performed separately via DiagnosticianContextPayloadSchema.
 */
export const DiagnosticianInvocationInputSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1 }),
  context: Type.Unknown(), // Validated separately — DiagnosticianContextPayload
  outputSchemaRef: Type.Literal('diagnostician-output-v1'),
  timeoutMs: Type.Number({ minimum: 0 }),
});

/** Typed interface for diagnostician invocation — context references DiagnosticianContextPayload (per D-02). */
export interface DiagnosticianInvocationInput {
  /** Agent identifier — any valid agent ID (e.g., "diagnostician", "main"). */
  agentId: string;
  /** The task being diagnosed. */
  taskId: string;
  /** Pre-assembled context for the diagnosis. */
  context: DiagnosticianContextPayload;
  /** Reference to the output schema version. */
  outputSchemaRef: 'diagnostician-output-v1';
  /** Timeout in milliseconds for this invocation. */
  timeoutMs: number;
}
