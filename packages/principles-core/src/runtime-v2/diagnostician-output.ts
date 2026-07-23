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
import { IntentTensionSchema } from './diagnostician/diag-rootcause-output.js';

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
  triggerPattern: Type.Optional(Type.String({ description: 'Required when kind is "rule". Regex or keyword pattern for interception.' })),
  action: Type.Optional(Type.String({ description: 'Required when kind is "rule". Action to take when pattern matches.' })),
  abstractedPrinciple: Type.Optional(Type.String({ description: 'Required when kind is "principle". Highly abstracted, reusable wisdom (≤200 chars).' })),
});
 
export type DiagnosticianRecommendation = Static<typeof DiagnosticianRecommendationSchema>;

export const DiagnosticianOutputV1Schema = Type.Object({
  valid: Type.Boolean(),
  diagnosisId: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  rootCause: Type.String({ minLength: 1, description: 'MUST include category prefix: "Design: ..." or "People: ..." or "Assumption: ..." or "Tooling: ..."' }),
  violatedPrinciples: Type.Array(DiagnosticianViolatedPrincipleSchema),
  evidence: Type.Array(DiagnosticianEvidenceSchema),
  // PRI-518 / rc-9-no-silent-fallback: a `valid: true` diagnosis MUST carry at
  // least one recommendation. An empty array previously committed zero
  // owner-reviewable candidates and marked the task *succeeded* — the silent
  // zero-candidate root cause. When the diagnostician intentionally has no
  // actionable principle, it MUST emit a single `{ kind: 'defer', ... }`
  // recommendation so the decision is explicit and reviewable, not silent.
  recommendations: Type.Array(DiagnosticianRecommendationSchema, { minItems: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: 'A number between 0.0 and 1.0 (NOT a string, NOT a percentage)' }),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
  /**
   * PRI-468: Optional intent tension passed through from Stage A.
   *
   * Present only when:
   *   1. The `intent_engineering` flag is on, AND
   *   2. Stage A emitted an intentTension, AND
   *   3. Stage C additive passthrough copied it here.
   *
   * Stage C MUST NOT generate intentTension when Stage A omitted it
   * (SPEC §18.2 — additive only, never generates).
   *
   * This field is additive — existing consumers that don't know about
   * intentTension will ignore it (SPEC §18.3 — don't break downstream).
   */
  intentTension: Type.Optional(IntentTensionSchema),
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
