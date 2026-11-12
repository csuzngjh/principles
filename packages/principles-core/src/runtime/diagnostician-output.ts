/**
 * Canonical diagnostician output schema for PD Runtime.
 *
 * Source: Diagnostician v2 Detailed Design, Section 11
 * Source: PD Runtime Protocol SPEC v1, Section 18
 * Source: SPEC-PD-RULE-ASSOCIATION-005 v0.6 (V2 Only / Clean Break, PRI-1146)
 *
 * This is the single structured output contract for diagnosis results.
 * All runtime adapters producing diagnostician output must conform to this
 * schema. `DiagnosticianOutputV1` was fully retired in PRI-1146: V2 is the
 * only production contract, and no V1 compatibility path exists.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DiagnosticianContextPayload } from './context-payload.js';
import { IntentTensionSchema } from './diagnostician/diag-rootcause-output.js';

// ── Business field schemas ──

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

/**
 * Upper bound for `abstractedPrinciple` (P1-3). Single source of truth: the
 * TypeBox contract and the semantic validator both read this constant, so the
 * structural limit and the reported violation can never drift apart.
 */
export const MAX_ABSTRACTED_PRINCIPLE_CHARS = 200 as const;

/**
 * Base properties shared by every V2 recommendation variant. Internal to this
 * module — the public contract is the discriminated `DiagnosticianRecommendationV2Schema`.
 *
 * `abstractedPrinciple` is optional here because the `kind: "principle"` variant
 * also keeps it structurally optional: the VALUE is Stage B distiller artifact
 * data, injected by DiagRouterRunner.postFetchTransform before validation, and
 * DefaultDiagnosticianValidator is the final non-empty gate. The adapter's
 * structural Value.Check runs BEFORE any transform, so a structural requirement
 * would reject a model output that (correctly) omitted the field and the runner
 * would never receive it — structural requirement and deterministic inheritance
 * are mutually exclusive. Do not make this field structurally required.
 */
const DiagnosticianRecommendationBaseSchema = Type.Object({
  kind: RecommendationKindSchema,
  description: Type.String({ minLength: 1 }),
  triggerPattern: Type.Optional(Type.String({ description: 'Required when kind is "rule". Regex or keyword pattern for interception.' })),
  action: Type.Optional(Type.String({ description: 'Required when kind is "rule". Action to take when pattern matches.' })),
  abstractedPrinciple: Type.Optional(Type.String({ description: 'Required when kind is "principle". Highly abstracted, reusable wisdom (≤200 chars).' })),
});

// ── Principle association (rule recommendations, SPEC v0.6 §4) ──

/**
 * Artifact-local, model-declared relation between a rule recommendation and a
 * principle. `recommendation_ref` targets must point at the unique
 * `kind: "principle"` recommendation inside the SAME artifact;
 * `canonical_principle` targets must be a principleId the system actually
 * exposed to the model in the trusted context of this run (verified
 * downstream against the trustedContextReceipt — never against the model's
 * own claim).
 */
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

export type PrincipleAssociation = Static<typeof PrincipleAssociationSchema>;

// ── Diagnostician Output V2 (the only production contract) ──

/**
 * V2 recommendation: every entry carries an artifact-locally-unique
 * `recommendationRef`. Each kind family is a discriminated variant so required
 * per-kind fields are enforced STRUCTURALLY:
 *   - `kind: "rule"`           → triggerPattern + action + principleAssociation
 *   - `kind: "principle"`      → recommendationRef + description
 *                                (abstractedPrinciple is injected from Stage B,
 *                                 see the variant comment below)
 *   - all other kinds          → recommendationRef + description
 * Only `kind: "rule"` may carry a `principleAssociation` (enforced
 * structurally: the other variants have `additionalProperties: false` without
 * the field).
 */
export const DiagnosticianRecommendationV2Schema = Type.Union([
  Type.Object({
    ...DiagnosticianRecommendationBaseSchema.properties,
    kind: Type.Literal('rule'),
    recommendationRef: Type.String({ minLength: 1 }),
    triggerPattern: Type.String({ minLength: 1 }),
    action: Type.String({ minLength: 1 }),
    principleAssociation: PrincipleAssociationSchema,
  }, { additionalProperties: false }),
  // P1-3 (corrected): `abstractedPrinciple` stays STRUCTURALLY OPTIONAL for
  // `kind: "principle"`. Authority split, by design:
  //   - the VALUE belongs to Stage B (distiller artifact, deterministic system
  //     data) — DiagRouterRunner.postFetchTransform copies it in;
  //   - the ADAPTER runs Value.Check BEFORE any transform, so making it
  //     structurally required would reject every model output that (correctly)
  //     omitted it, and the runner would never get the output — the two
  //     mechanisms are mutually exclusive;
  //   - DefaultDiagnosticianValidator is the LAST gate and still rejects an
  //     empty/missing value (kind:"principle" → non-empty abstractedPrinciple).
  // Do not turn this back into a structural requirement: that fails the whole
  // round instead of deterministically inheriting Stage B's value.
  Type.Object({
    ...DiagnosticianRecommendationBaseSchema.properties,
    kind: Type.Literal('principle'),
    recommendationRef: Type.String({ minLength: 1 }),
    abstractedPrinciple: Type.Optional(Type.String({
      maxLength: MAX_ABSTRACTED_PRINCIPLE_CHARS,
      description: 'Filled by the orchestrator from the Stage B distiller artifact; the model should not rewrite it. The validator requires it to be non-empty for kind "principle".',
    })),
  }, { additionalProperties: false }),
  Type.Object({
    ...DiagnosticianRecommendationBaseSchema.properties,
    kind: Type.Union([Type.Literal('implementation'), Type.Literal('prompt'), Type.Literal('defer')]),
    recommendationRef: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export type DiagnosticianRecommendationV2 = Static<typeof DiagnosticianRecommendationV2Schema>;

export const DiagnosticianOutputV2Schema = Type.Object({
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
  recommendations: Type.Array(DiagnosticianRecommendationV2Schema, { minItems: 1 }),
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
   */
  intentTension: Type.Optional(IntentTensionSchema),
  schemaVersion: Type.Literal('diagnostician-output-v2'),
}, { additionalProperties: false });

export type DiagnosticianOutputV2 = Static<typeof DiagnosticianOutputV2Schema>;

// ── Persisted-envelope reader (single source for consumers) ──────────────────

/**
 * Envelope keys the router adds around the committed output inside
 * `artifacts.content_json` / `pi_artifacts.contentJson`. The run's own
 * `outputPayload` is always the bare output; committed artifacts carry the
 * envelope. The V2 root is closed (`additionalProperties: false`), so readers
 * MUST go through `readDiagnosticianOutputFromEnvelope` instead of checking
 * persisted artifact JSON against the schema directly.
 */
export const DIAGNOSTICIAN_ENVELOPE_KEYS = ['trustedContextReceipt', 'associationValidation'] as const;

/**
 * Read a persisted diagnostician payload as a validated DiagnosticianOutputV2.
 *
 * Accepts either shape a consumer can legitimately encounter:
 *   1. the bare V2 output (run `outputPayload`, and artifact rows written
 *      without the receipt envelope);
 *   2. the router artifact envelope — the V2 output plus the receipt keys —
 *      by stripping `DIAGNOSTICIAN_ENVELOPE_KEYS` before validation.
 *
 * Returns `undefined` for anything else — including retired V1 payloads
 * (PRI-1146 Clean Break: they are not readable, callers fail loud/structured).
 */
export function readDiagnosticianOutputFromEnvelope(value: unknown): DiagnosticianOutputV2 | undefined {
  if (Value.Check(DiagnosticianOutputV2Schema, value)) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, 'trustedContextReceipt')) return undefined;
  const { trustedContextReceipt: _receipt, associationValidation: _association, ...core } = value as Record<string, unknown>;
  return Value.Check(DiagnosticianOutputV2Schema, core) ? core : undefined;
}

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
  outputSchemaRef: Type.Literal('diagnostician-output'),
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
  outputSchemaRef: 'diagnostician-output';
  /** Timeout in milliseconds for this invocation. */
  timeoutMs: number;
}
