/**
 * Root Cause stage (Stage A) output schema for the split diagnostician pipeline.
 *
 * This schema defines the output of the Root Cause stage, which identifies
 * the underlying cause of a pain signal using a 5-Whys causal chain and
 * categorises it into one of four root-cause categories.
 *
 * The taskId field is lineage data re-injected by the runner if stripped
 * by the adapter before LLM validation (ERR-008).
 *
 * @see PRI-372
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ── Sub-schemas ──────────────────────────────────────────────────────────────

/**
 * Root-cause category literal union.
 *
 * Every root cause MUST be classified into exactly one of these four
 * categories. The category prefix in `rootCause` must match this value.
 *
 * @see PRI-372
 */
export const RootCauseCategorySchema = Type.Union([
  Type.Literal('People'),
  Type.Literal('Design'),
  Type.Literal('Assumption'),
  Type.Literal('Tooling'),
]);

/** Root-cause category: People | Design | Assumption | Tooling */
export type RootCauseCategory = Static<typeof RootCauseCategorySchema>;

/**
 * A single entry in the 5-Whys causal chain.
 *
 * `why` is 1-indexed (1 = shallowest, 5 = deepest).
 */
export const CausalChainEntrySchema = Type.Object({
  why: Type.Number({ minimum: 1, maximum: 5 }),
  statement: Type.String({ minLength: 1 }),
  evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

/** A single entry in the 5-Whys causal chain. */
export type CausalChainEntry = Static<typeof CausalChainEntrySchema>;

/**
 * Evidence entry linking a source reference to an explanatory note.
 */
export const DiagRootCauseEvidenceSchema = Type.Object({
  sourceRef: Type.String({ minLength: 1 }),
  note: Type.String({ minLength: 1 }),
});

/** Evidence entry linking a source reference to an explanatory note. */
export type DiagRootCauseEvidence = Static<typeof DiagRootCauseEvidenceSchema>;

// ── Intent Tension sub-schemas (PRI-468, SPEC §16) ──────────────────────────

/**
 * Intent tension source enum (SPEC §16.5).
 *
 * - `none` — no tension detected
 * - `action_drift` — Agent's action appears to drift from INTENT
 * - `intent_suspect` — INTENT itself may be stale, ambiguous, or contradictory
 * - `healthy_tension` — genuine strategic trade-off, no drift
 */
export const IntentTensionSourceSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('action_drift'),
  Type.Literal('intent_suspect'),
  Type.Literal('healthy_tension'),
]);

/** Intent tension source: none | action_drift | intent_suspect | healthy_tension */
export type IntentTensionSource = Static<typeof IntentTensionSourceSchema>;

/**
 * Evidence strength enum (SPEC §16.6).
 *
 * Coarse three-level scale; intentionally NOT a numeric confidence
 * (SPEC §16.3 forbids `intentTension.confidence`).
 */
export const EvidenceStrengthSchema = Type.Union([
  Type.Literal('weak'),
  Type.Literal('moderate'),
  Type.Literal('strong'),
]);

/** Evidence strength: weak | moderate | strong */
export type EvidenceStrength = Static<typeof EvidenceStrengthSchema>;

/**
 * Related INTENT.md field enum (SPEC §16.7).
 *
 * Snake_case keys mirror the INTENT.md section identifiers used in the
 * prompt block. The LLM picks one or more fields that the tension
 * relates to.
 */
export const IntentRelatedFieldSchema = Type.Union([
  Type.Literal('why'),
  Type.Literal('desired_outcome'),
  Type.Literal('non_negotiables'),
  Type.Literal('stop_escalation'),
  Type.Literal('current_strategic_focus'),
]);

/** Related INTENT field: why | desired_outcome | non_negotiables | stop_escalation | current_strategic_focus */
export type IntentRelatedField = Static<typeof IntentRelatedFieldSchema>;

/**
 * Suggested Owner action enum (SPEC §21).
 *
 * PD surfaces tension; the Owner decides value. This field is a
 * SUGGESTION — never auto-applied. The Owner must record a
 * IntentDecisionRecord (PRI-470) before any follow-up action executes.
 */
export const SuggestedOwnerActionSchema = Type.Union([
  Type.Literal('confirm_drift'),
  Type.Literal('revise_intent'),
  Type.Literal('observe'),
  Type.Literal('dismiss'),
  Type.Literal('promote_to_principle'),
  Type.Literal('promote_to_rulehost'),
]);

/** Suggested Owner action: confirm_drift | revise_intent | observe | dismiss | promote_to_principle | promote_to_rulehost */
export type SuggestedOwnerAction = Static<typeof SuggestedOwnerActionSchema>;

// ── Type guards for intent enums (PRI-470) ──────────────────────────────────
// Runtime-safe guards so untrusted JSON (HTTP body, DB rows, artifact metadata)
// can be validated without `as` bypasses (ERR-001, ERR-005).

const INTENT_TENSION_SOURCES: readonly IntentTensionSource[] = ['none', 'action_drift', 'intent_suspect', 'healthy_tension'];
const EVIDENCE_STRENGTHS: readonly EvidenceStrength[] = ['weak', 'moderate', 'strong'];
const INTENT_RELATED_FIELDS: readonly IntentRelatedField[] = ['why', 'desired_outcome', 'non_negotiables', 'stop_escalation', 'current_strategic_focus'];
const SUGGESTED_OWNER_ACTIONS: readonly SuggestedOwnerAction[] = ['confirm_drift', 'revise_intent', 'observe', 'dismiss', 'promote_to_principle', 'promote_to_rulehost'];

/** Type guard: is `value` a valid IntentTensionSource? */
export function isIntentTensionSource(value: unknown): value is IntentTensionSource {
  return typeof value === 'string' && (INTENT_TENSION_SOURCES as readonly string[]).includes(value);
}

/** Type guard: is `value` a valid EvidenceStrength? */
export function isEvidenceStrength(value: unknown): value is EvidenceStrength {
  return typeof value === 'string' && (EVIDENCE_STRENGTHS as readonly string[]).includes(value);
}

/** Type guard: is `value` a valid IntentRelatedField? */
export function isIntentRelatedField(value: unknown): value is IntentRelatedField {
  return typeof value === 'string' && (INTENT_RELATED_FIELDS as readonly string[]).includes(value);
}

/** Type guard: is `value` a valid SuggestedOwnerAction? */
export function isSuggestedOwnerAction(value: unknown): value is SuggestedOwnerAction {
  return typeof value === 'string' && (SUGGESTED_OWNER_ACTIONS as readonly string[]).includes(value);
}

/**
 * IntentTension schema (SPEC §16.2).
 *
 * Optional object produced by Stage A when the Agent detects a tension
 * between its action and the Owner-authored INTENT.md.
 *
 * CRITICAL (SPEC §16.3): this object MUST NOT carry a `confidence`
 * field. The Stage A `confidence` (rootCause-level) is the only
 * diagnostician confidence. To enforce this, `additionalProperties: false`
 * is set so any extra property (including `confidence`) is rejected by
 * `Value.Check`.
 *
 * Lineage (SPEC §16.2): `intentDocHash` is optional but, when present,
 * MUST match the hash of the INTENT.md that was injected into the
 * prompt. The Stage A runner enforces this invariant (PRI-468).
 */
export const IntentTensionSchema = Type.Object({
  source: IntentTensionSourceSchema,
  evidenceStrength: EvidenceStrengthSchema,
  relatedIntentFields: Type.Array(IntentRelatedFieldSchema),
  evidence: Type.Array(Type.String(), { maxItems: 3 }),
  explanation: Type.String({ minLength: 1 }),
  suggestedOwnerAction: SuggestedOwnerActionSchema,
  intentDocHash: Type.Optional(Type.String()),
}, { additionalProperties: false });

/**
 * IntentTension — optional Stage A output describing a tension between
 * the Agent's action and the Owner-authored INTENT.md.
 *
 * `confidence` is forbidden on this object (SPEC §16.3).
 */
export type IntentTension = Static<typeof IntentTensionSchema>;

// ── Main output schema ───────────────────────────────────────────────────────

/**
 * TypeBox schema for the Root Cause stage (Stage A) output.
 *
 * Consumed by the next pipeline stage and stored as a RunRecord output.
 * The host layer (runner) is responsible for re-injecting `taskId` if
 * the adapter strips lineage fields before LLM invocation (ERR-008).
 *
 * @see PRI-372
 */
export const DiagRootCauseOutputV1Schema = Type.Object({
  valid: Type.Boolean(),
  diagnosisId: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1, description: 'Lineage — re-injected if stripped; ERR-008' }),
  summary: Type.String({ minLength: 1 }),
  causalChain: Type.Array(CausalChainEntrySchema),
  rootCause: Type.String({
    minLength: 1,
    description: 'MUST include category prefix: "People: ..." or "Design: ..." or "Assumption: ..." or "Tooling: ..."',
  }),
  rootCauseCategory: RootCauseCategorySchema,
  evidence: Type.Array(DiagRootCauseEvidenceSchema),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
  /**
   * Optional intent tension (PRI-468, SPEC §16). Present only when:
   *   1. The `intent_engineering` flag is on, AND
   *   2. The Stage A prompt was built with the INTENT context injected, AND
   *   3. The LLM chose to emit a tension.
   *
   * When absent (flag off or LLM omitted), Stage C passthrough must NOT
   * synthesize one (SPEC §18 — additive only, never generates).
   */
  intentTension: Type.Optional(IntentTensionSchema),
});

/** Typed output of the Root Cause stage (Stage A). */
export type DiagRootCauseOutputV1 = Static<typeof DiagRootCauseOutputV1Schema>;

// ── Validator ────────────────────────────────────────────────────────────────

const VALID_ROOT_CAUSE_CATEGORIES = new Set<string>(['People', 'Design', 'Assumption', 'Tooling']);

/**
 * Validator interface for DiagRootCauseOutputV1.
 *
 * Accepts `unknown` input — implementations must perform runtime checks (ERR-001).
 *
 * @see PRI-372
 */
export interface DiagRootCauseValidator {
  /**
   * Validate untrusted root-cause stage output.
   *
   * @param output - Raw output to validate (treated as unknown — ERR-001)
   * @param taskId - Expected taskId for lineage verification (ERR-008)
   * @returns Validation result with valid flag, errors, and optional error category
   */
  validate(output: unknown, taskId: string): Promise<{ valid: boolean; errors: string[]; errorCategory?: string; warnings?: string[] }>;
}

/**
 * Default validator for DiagRootCauseOutputV1 using TypeBox Value.Check / Value.Errors.
 *
 * Validates:
 *   1. Structural correctness via TypeBox schema
 *   2. taskId lineage match (ERR-008)
 *   3. rootCauseCategory consistency with rootCause prefix
 *   4. causalChain entry ordering (why field 1-5)
 *
 * @see PRI-372
 */
export class DefaultDiagRootCauseValidator implements DiagRootCauseValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(
    output: unknown,
    taskId: string,
  ): Promise<{ valid: boolean; errors: string[]; errorCategory?: string; warnings?: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // ── Step 1: Object guard ────────────────────────────────────────────────
    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // Narrow to Record for property access — all fields still treated as untrusted.
    const record = output as Record<string, unknown>;

    // ── Step 2: taskId lineage check (ERR-008) ──────────────────────────────
    // BUG-007c: If LLM outputs the parent task ID (without diag_rootcause- prefix),
    // re-inject the expected taskId from the caller (trusted source) instead of
    // treating it as a hard error. The re-injection value MUST come from the
    // caller's `taskId` parameter, never from LLM output (ERR-008).
    if (typeof record.taskId !== 'string' || record.taskId !== taskId) {
      const DIAG_ROOTCAUSE_PREFIX = 'diag_rootcause-';
      if (
        typeof record.taskId === 'string'
        && taskId.startsWith(DIAG_ROOTCAUSE_PREFIX)
        && record.taskId === taskId.slice(DIAG_ROOTCAUSE_PREFIX.length)
      ) {
        // LLM output the parent task ID — re-inject the expected stage taskId
        const parentTaskId = record.taskId;
        record.taskId = taskId;
        warnings.push(`taskId re-injected: LLM output parent ID "${parentTaskId}", corrected to "${taskId}" (ERR-008)`);
      } else {
        errors.push(`taskId mismatch: expected ${taskId}, got ${String(record.taskId)}`);
      }
    }

    // ── Step 3: valid flag must be true ─────────────────────────────────────
    if (record.valid !== true) {
      errors.push('output.valid must be true');
    }

    // ── Step 4: rootCauseCategory semantic check ────────────────────────────
    if (typeof record.rootCauseCategory !== 'string' || !VALID_ROOT_CAUSE_CATEGORIES.has(record.rootCauseCategory)) {
      errors.push(`rootCauseCategory must be one of People|Design|Assumption|Tooling, got ${String(record.rootCauseCategory)}`);
    }

    // ── Step 4b: rootCause prefix must match rootCauseCategory ──────────────
    if (
      typeof record.rootCause === 'string'
      && typeof record.rootCauseCategory === 'string'
      && VALID_ROOT_CAUSE_CATEGORIES.has(record.rootCauseCategory)
    ) {
      const expectedPrefix = `${record.rootCauseCategory}: `;
      if (!record.rootCause.startsWith(expectedPrefix)) {
        errors.push(`rootCause must start with "${expectedPrefix}" (matching rootCauseCategory "${record.rootCauseCategory}"), got: "${record.rootCause.slice(0, 40)}${record.rootCause.length > 40 ? '...' : ''}"`);
      }
    }

    // ── Step 5: causalChain entry-level checks ──────────────────────────────
    if (Array.isArray(record.causalChain)) {
      for (let i = 0; i < record.causalChain.length; i++) {
        const entry = record.causalChain[i] as Record<string, unknown> | undefined;
        if (!entry || typeof entry !== 'object') {
          errors.push(`causalChain[${i}] must be an object`);
          continue;
        }
        if (typeof entry.why !== 'number' || entry.why < 1 || entry.why > 5) {
          errors.push(`causalChain[${i}].why must be a number in [1, 5]`);
        }
        if (typeof entry.statement !== 'string' || entry.statement.trim() === '') {
          errors.push(`causalChain[${i}].statement must be a non-empty string`);
        }
        if (!Array.isArray(entry.evidenceRefs)) {
          errors.push(`causalChain[${i}].evidenceRefs must be an array`);
        } else if (entry.evidenceRefs.length === 0) {
          errors.push(`causalChain[${i}].evidenceRefs must have at least 1 item`);
        }
      }
    }

    // ── Step 6: evidence entry-level checks ─────────────────────────────────
    if (Array.isArray(record.evidence)) {
      for (let i = 0; i < record.evidence.length; i++) {
        const ev = record.evidence[i] as Record<string, unknown> | undefined;
        if (!ev || typeof ev !== 'object') {
          errors.push(`evidence[${i}] must be an object`);
          continue;
        }
        if (typeof ev.sourceRef !== 'string' || ev.sourceRef.trim() === '') {
          errors.push(`evidence[${i}].sourceRef must be a non-empty string`);
        }
        if (typeof ev.note !== 'string' || ev.note.trim() === '') {
          errors.push(`evidence[${i}].note must be a non-empty string`);
        }
      }
    }

    // ── Step 6b: intentTension element-level checks (PRI-468, SPEC §16) ─────
    // Provide clearer error messages than the TypeBox fallback for the most
    // critical SPEC §16.3 violation (forbidden `confidence` field) and for
    // non-object intentTension. The TypeBox schema (with additionalProperties:
    // false) catches these as well, but the explicit check produces a
    // human-readable message that references the SPEC clause.
    if (Object.hasOwn(record, 'intentTension')) {
      const tension = record.intentTension;
      if (tension === null || typeof tension !== 'object') {
        errors.push('intentTension must be an object when present');
      } else {
        const tensionRecord = tension as Record<string, unknown>;
        if (Object.hasOwn(tensionRecord, 'confidence')) {
          errors.push('intentTension.confidence is forbidden (SPEC §16.3); use rootCause-level confidence instead');
        }
      }
    }

    // ── Step 7: TypeBox schema validation as fallback ───────────────────────
    if (!Value.Check(DiagRootCauseOutputV1Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagRootCauseOutputV1Schema, output)];
      const messages = schemaErrors.map((e) => `${e.path}: ${e.message}`);
      errors.push(...messages);
    }

    if (errors.length > 0) {
      return { valid: false, errors, errorCategory: 'output_invalid', warnings };
    }

    return { valid: true, errors: [], warnings };
  }
}
