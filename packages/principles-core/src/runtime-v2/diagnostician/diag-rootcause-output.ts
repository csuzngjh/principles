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
  validate(output: unknown, taskId: string): Promise<{ valid: boolean; errors: string[]; errorCategory?: string }>;
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
  ): Promise<{ valid: boolean; errors: string[]; errorCategory?: string }> {
    const errors: string[] = [];

    // ── Step 1: Object guard ────────────────────────────────────────────────
    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // Narrow to Record for property access — all fields still treated as untrusted.
    const record = output as Record<string, unknown>;

    // ── Step 2: taskId lineage check (ERR-008) ──────────────────────────────
    if (typeof record.taskId !== 'string' || record.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(record.taskId)}`);
    }

    // ── Step 3: valid flag must be true ─────────────────────────────────────
    if (record.valid !== true) {
      errors.push('output.valid must be true');
    }

    // ── Step 4: rootCauseCategory semantic check ────────────────────────────
    if (typeof record.rootCauseCategory !== 'string' || !VALID_ROOT_CAUSE_CATEGORIES.has(record.rootCauseCategory)) {
      errors.push(`rootCauseCategory must be one of People|Design|Assumption|Tooling, got ${String(record.rootCauseCategory)}`);
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

    // ── Step 7: TypeBox schema validation as fallback ───────────────────────
    if (!Value.Check(DiagRootCauseOutputV1Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagRootCauseOutputV1Schema, output)];
      const messages = schemaErrors.map((e) => `${e.path}: ${e.message}`);
      errors.push(...messages);
    }

    if (errors.length > 0) {
      return { valid: false, errors, errorCategory: 'output_invalid' };
    }

    return { valid: true, errors: [] };
  }
}
