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

// Opt-in shadow contract. Existing generation and validation remain on V1.
export const PrincipleAssociationSchema = Type.Union([
  Type.Object({
    status: Type.Literal('linked'),
    relation: Type.Literal('implements'),
    target: Type.Union([
      Type.Object({ type: Type.Literal('recommendation_ref'), recommendationRef: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('canonical_principle'), principleId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ]),
    rationale: Type.String({ minLength: 1 }),
    evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('unresolved'),
    reason: Type.Union([
      Type.Literal('no_supported_target'), Type.Literal('ambiguous_target'),
      Type.Literal('insufficient_evidence'), Type.Literal('principle_not_in_context'),
    ]),
    candidateRecommendationRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  }, { additionalProperties: false }),
]);

export const DiagnosticianRecommendationV2Schema = Type.Union([
  Type.Object({
    ...DiagnosticianRecommendationSchema.properties,
    kind: Type.Literal('rule'),
    recommendationRef: Type.String({ minLength: 1 }),
    triggerPattern: Type.String({ minLength: 1 }),
    action: Type.String({ minLength: 1 }),
    principleAssociation: PrincipleAssociationSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ...DiagnosticianRecommendationSchema.properties,
    kind: Type.Union([Type.Literal('principle'), Type.Literal('implementation'), Type.Literal('prompt'), Type.Literal('defer')]),
    recommendationRef: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export const DiagnosticianOutputV2Schema = Type.Object({
  ...DiagnosticianOutputV1Schema.properties,
  schemaVersion: Type.Literal('diagnostician-output-v2'),
  recommendations: Type.Array(DiagnosticianRecommendationV2Schema, { minItems: 1 }),
}, { additionalProperties: false });

export type DiagnosticianOutputV2 = Static<typeof DiagnosticianOutputV2Schema>;

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
