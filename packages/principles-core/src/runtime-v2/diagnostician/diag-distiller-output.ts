/**
 * Stage B (Distiller) output schema for the split diagnostician pipeline.
 *
 * The Distiller takes the root-cause artifact from Stage A and produces
 * an abstracted, cross-scenario principle grounded on the T-01..T-10
 * core axiom registry.
 *
 * @see PRI-372 — Split diagnostician into Stage A (Root Cause) + Stage B (Distiller)
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isCorePrincipleId } from '../core-principles/core-principle-registry.js';

// ── Scope literal ─────────────────────────────────────────────────────────

export const DiagDistillerScopeSchema = Type.Union([
  Type.Literal('general'),
  Type.Literal('domain'),
  Type.Literal('scenario'),
]);

/** Scope classification for a distilled principle. */
export type DiagDistillerScope = Static<typeof DiagDistillerScopeSchema>;

// ── Distiller Output V1 ──────────────────────────────────────────────────

/**
 * TypeBox schema for Stage B (Distiller) output.
 *
 * Lineage consistency: `sourceRootCauseArtifactId` must match the artifact
 * produced by Stage A so that the pipeline can trace every distilled
 * principle back to its root-cause diagnosis.
 *
 * `groundedOnCorePrincipleIds` is validated against the T-01..T-10
 * registry at runtime — fabricated IDs cause validation failure.
 *
 * @see PRI-372
 */
export const DiagDistillerOutputV1Schema = Type.Object({
  valid: Type.Boolean(),
  taskId: Type.String({ minLength: 1 }),
  sourceRootCauseArtifactId: Type.String({
    minLength: 1,
    description: 'Lineage consistency check — must match the artifact ID from Stage A',
  }),
  abstractedPrinciple: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'Highly abstracted, cross-scenario principle (≤200 chars)',
  }),
  rationale: Type.String({
    minLength: 1,
    description: 'Why this principle addresses the root cause',
  }),
  groundedOnCorePrincipleIds: Type.Array(Type.String({ minLength: 1 }), {
    description:
      'Subset of T-01..T-10. Validated against registry — fabricated IDs cause validation failure.',
  }),
  scope: DiagDistillerScopeSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  ambiguityNotes: Type.Optional(Type.Array(Type.String())),
});

/** Inferred TypeScript type for Stage B (Distiller) output. */
export type DiagDistillerOutputV1 = Static<typeof DiagDistillerOutputV1Schema>;

// ── Validator ────────────────────────────────────────────────────────────

/**
 * Validator interface for DiagDistillerOutputV1.
 *
 * Accepts `unknown` input — implementations must perform runtime checks (ERR-001).
 *
 * @see PRI-372
 */
export interface DiagDistillerValidator {
  /**
   * Validate untrusted distiller stage output.
   *
   * @param output - Raw output to validate (treated as unknown — ERR-001)
   * @param taskId - Expected taskId for lineage verification (ERR-008)
   * @returns Validation result with valid flag, errors, and optional error category
   */
  validate(
    output: unknown,
    taskId: string,
  ): Promise<{ valid: boolean; errors: string[]; errorCategory?: string; warnings?: string[] }>;
}

/**
 * Default validator for DiagDistillerOutputV1 using TypeBox Value.Check / Value.Errors.
 *
 * Validates:
 *   1. Structural correctness via TypeBox schema
 *   2. taskId lineage match (ERR-008)
 *   3. Core principle registry membership — every id in
 *      groundedOnCorePrincipleIds must pass isCorePrincipleId().
 *      Fabricated IDs (e.g. T-99) produce a validation failure with
 *      errorCategory 'output_invalid'.
 *
 * @see PRI-372
 */
export class DefaultDiagDistillerValidator implements DiagDistillerValidator {
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
    // BUG-007c (mirrored from diag-rootcause-output.ts): if the LLM outputs a
    // taskId with the WRONG diag-stage prefix (or no prefix), re-inject the
    // expected taskId from the caller's trusted `taskId` parameter instead of
    // treating it as a hard error. Real Story A run confirmed the Stage B LLM
    // echoes the Stage A task id (diag_rootcause-diagnosis_pain_...) instead of
    // this stage's diag_distiller-diagnosis_pain_... — same suffix, wrong
    // prefix. The re-injection value MUST come from the caller, never from LLM
    // output (ERR-008).
    if (typeof record.taskId !== 'string' || record.taskId !== taskId) {
      const DIAG_PREFIXES = ['diag_rootcause-', 'diag_distiller-', 'diag_router-'];
      const stripDiagPrefix = (id: string): string => {
        for (const p of DIAG_PREFIXES) {
          if (id.startsWith(p)) return id.slice(p.length);
        }
        return id;
      };
      const expectedSuffix = stripDiagPrefix(taskId);
      const actualSuffix = typeof record.taskId === 'string' ? stripDiagPrefix(record.taskId) : '';
      if (actualSuffix !== '' && actualSuffix === expectedSuffix) {
        // LLM output a sibling/parent stage id with the same suffix — re-inject
        const echoedTaskId = record.taskId as string;
        record.taskId = taskId;
        warnings.push(`taskId re-injected: LLM output "${echoedTaskId}", corrected to "${taskId}" (ERR-008)`);
      } else {
        errors.push(`taskId mismatch: expected ${taskId}, got ${String(record.taskId)}`);
      }
    }

    // ── Step 3: TypeBox schema validation ───────────────────────────────────
    if (!Value.Check(DiagDistillerOutputV1Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagDistillerOutputV1Schema, output)];
      const messages = schemaErrors.map((e) => `${e.path}: ${e.message}`);
      errors.push(...messages);
    }

    // ── Step 4: Core principle registry validation ──────────────────────────
    // This constraint cannot be expressed in a TypeBox schema alone.
    if (Array.isArray(record.groundedOnCorePrincipleIds)) {
      for (const id of record.groundedOnCorePrincipleIds) {
        if (typeof id === 'string' && !isCorePrincipleId(id)) {
          errors.push(`Fabricated axiom ID ${id} not in core principle registry`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, errorCategory: 'output_invalid' };
    }

    return { valid: true, errors: [], warnings };
  }
}
