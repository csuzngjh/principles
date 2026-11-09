/**
 * DefaultDiagnosticianValidator — full schema + semantic + association-structure
 * validation of DiagnosticianOutputV2 (PRI-1146 V2 Only).
 *
 * Validates across the original 6 requirement areas (REQ-2.3a..REQ-2.3g,
 * excluding REQ-2.3c) plus the V2 association areas (SPEC v0.6 §4/§7):
 *   REQ-2.3a — TypeBox schema correctness (V2, root closed)
 *   REQ-2.3b — Non-empty summary and rootCause
 *   REQ-2.3d — Evidence array bounded shape (each entry has non-empty sourceRef + note)
 *   REQ-2.3e — Recommendations shape (valid kind union + non-empty description)
 *   REQ-2.3f — Confidence in [0, 1] closed interval
 *   REQ-2.3g — Evidence sourceRef back-check (standard=format, verbose=existence)
 *   ASSC-1   — recommendationRef present, non-empty, unique within the artifact
 *   ASSC-2   — rule recommendations carry a principleAssociation whose
 *              recommendation_ref target exists, is unique, and has kind "principle"
 *   ASSC-3   — association evidenceRefs reference evidence[].sourceRef of the SAME output
 *   ASSC-4   — non-rule recommendations do NOT carry a principleAssociation
 *
 * REQ-2.3c (task identity match) was removed in PRI-272 because taskId is
 * lineage data owned by the runner, not LLM output.
 *
 * Schema Validity vs Association Validity (SPEC v0.6 §7): failures are
 * reported with `invalidAreas` distinguishing the two classes; both are
 * `output_invalid` for the state machine. Structural association validity
 * does NOT evaluate semantic correctness — `semanticCorrectness` stays
 * `not_evaluated` downstream and is never implied by a pass here.
 *
 * Validation order: semantic checks run BEFORE schema validation so that
 * human-readable error messages (with actual values) are returned first.
 *
 * Modes:
 *   - Standard (verbose !== true): fail-fast — return on first error
 *   - Verbose (verbose === true): collect all errors before returning
 */
import { Value } from '@sinclair/typebox/value';
import type { DiagnosticianOutputV2, DiagnosticianRecommendationV2 } from '../diagnostician-output.js';
import { DiagnosticianOutputV2Schema, RecommendationKindSchema } from '../diagnostician-output.js';
import type {
  DiagnosticianValidationResult,
  DiagnosticianValidateOptions,
  DiagnosticianValidator,
} from './diagnostician-validator.js';

export const MAX_ABSTRACTED_PRINCIPLE_CHARS = 200 as const;

const ERROR_CATEGORY_OUTPUT_INVALID = 'output_invalid' as const;

function buildFailure(
  aggregateSummary: string,
  detailErrors: readonly string[],
  invalidAreas: readonly ('schema' | 'association')[],
): DiagnosticianValidationResult {
  return {
    valid: false,
    errors: [aggregateSummary, ...detailErrors],
    errorCategory: ERROR_CATEGORY_OUTPUT_INVALID,
    invalidAreas,
  };
}

function buildValidResult(): DiagnosticianValidationResult {
  return { valid: true, errors: [] };
}

/**
 * DefaultDiagnosticianValidator — full schema + semantic + association validation.
 */
export class DefaultDiagnosticianValidator implements DiagnosticianValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(
    output: DiagnosticianOutputV2,
    _taskId: string,
    options?: DiagnosticianValidateOptions,
  ): Promise<DiagnosticianValidationResult> {
    // ── Step 1: Guard ──────────────────────────────────────────────────────────
    if (typeof output !== 'object' || output === null) {
      return buildFailure('1 field invalid: output must be a non-null object', [
        'output must be a non-null object',
      ], ['schema']);
    }

    const isVerbose = options?.verbose === true;
    const detailErrors: string[] = [];
    const areas = new Set<'schema' | 'association'>();
    const fail = (area: 'schema' | 'association', msg: string): DiagnosticianValidationResult => {
      if (!isVerbose) {
        return buildFailure(`1 field invalid: ${area === 'association' ? 'association' : 'field'}`, [msg], [area]);
      }
      areas.add(area);
      detailErrors.push(msg);
      return undefined as unknown as DiagnosticianValidationResult;
    };

    // ── Step 2: Semantic checks FIRST (better error messages with actual values) ──

    // 2a: Confidence boundary [0, 1]
    if (typeof output.confidence !== 'number' || output.confidence < 0 || output.confidence > 1) {
      const failed = fail('schema', `confidence ${output.confidence} outside [0, 1] closed interval`);
      if (failed) return failed;
    }

    // 2c: Non-empty summary
    if (!output.summary || output.summary.trim() === '') {
      const failed = fail('schema', 'summary must be a non-empty string');
      if (failed) return failed;
    }

    // 2d: Non-empty rootCause
    if (!output.rootCause || output.rootCause.trim() === '') {
      const failed = fail('schema', 'rootCause must be a non-empty string');
      if (failed) return failed;
    }

    // 2e: Evidence array shape
    // Guard: record a structural error when evidence is not an array (e.g. LLM
    // returned a string "none"), then iterate only over a real array. Without
    // this guard, malformed output would throw `X is not iterable` at the
    // for...of below instead of returning a categorized output_invalid result.
    if (!Array.isArray(output.evidence)) {
      const failed = fail('schema', 'evidence must be an array');
      if (failed) return failed;
    }
    for (const ev of Array.isArray(output.evidence) ? output.evidence : []) {
      if (!ev.sourceRef || ev.sourceRef.trim() === '') {
        const failed = fail('schema', 'evidence[].sourceRef must be a non-empty string');
        if (failed) return failed;
      }
      if (!ev.note || ev.note.trim() === '') {
        const failed = fail('schema', 'evidence[].note must be a non-empty string');
        if (failed) return failed;
      }
    }

    // 2e-bis: Recommendations must be non-empty (PRI-518 / rc-9-no-silent-fallback).
    // A `valid: true` diagnosis with zero recommendations previously committed
    // zero owner-reviewable candidates and marked the task succeeded — the
    // silent zero-candidate root cause. An intentional "no action" decision
    // MUST be expressed as a `{ kind: 'defer', ... }` recommendation so it is
    // explicit and reviewable, not silent.
    if (!Array.isArray(output.recommendations) || output.recommendations.length === 0) {
      const failed = fail('schema', 'recommendations must contain at least one entry; emit a { kind: "defer", ... } recommendation when no action is warranted');
      if (failed) return failed;
    }

    // ── ASSC-1: pre-pass — map recommendationRef → rec before any target check.
    // Targets may point at recommendations declared later in the array, so the
    // map must be complete before ASSC-2 resolves refs. Duplicates keep the
    // FIRST occurrence (matching the committer's candidate order) and are
    // reported as association errors.
    const recommendations: readonly DiagnosticianRecommendationV2[] = Array.isArray(output.recommendations) ? output.recommendations : [];
    const refsByRef = new Map<string, DiagnosticianRecommendationV2>();
    let duplicateRefReported = false;
    for (const rec of recommendations) {
      if (!rec.recommendationRef || rec.recommendationRef.trim() === '') {
        const failed = fail('association', `recommendations[].recommendationRef must be a non-empty string (kind "${rec.kind}")`);
        if (failed) return failed;
      } else if (refsByRef.has(rec.recommendationRef)) {
        if (!duplicateRefReported) {
          const failed = fail('association', `recommendations[].recommendationRef "${rec.recommendationRef}" is duplicated within this artifact; refs must be unique`);
          if (failed) return failed;
          duplicateRefReported = true;
        }
      } else {
        refsByRef.set(rec.recommendationRef, rec);
      }
    }

    const evidenceSourceRefs = new Set(
      (Array.isArray(output.evidence) ? output.evidence : []).map((ev) => ev.sourceRef),
    );

    // 2f: Recommendations shape + association structure (ASSC-2/3/4)
    for (const rec of recommendations) {
      if (!Value.Check(RecommendationKindSchema, rec.kind)) {
        const failed = fail('schema', `recommendations[].kind "${rec.kind}" is not a valid RecommendationKind`);
        if (failed) return failed;
      }
      if (!rec.description || rec.description.trim() === '') {
        const failed = fail('schema', 'recommendations[].description must be a non-empty string');
        if (failed) return failed;
      }
      // Principle: only abstractedPrinciple required (triggerPattern/action optional)
      if (rec.kind === 'principle') {
        if (!rec.abstractedPrinciple || rec.abstractedPrinciple.trim() === '') {
          const failed = fail('schema', 'recommendations[].abstractedPrinciple is required when kind is "principle"');
          if (failed) return failed;
        }
        if (rec.abstractedPrinciple && rec.abstractedPrinciple.length > MAX_ABSTRACTED_PRINCIPLE_CHARS) {
          const failed = fail('schema', `recommendations[].abstractedPrinciple must be ${MAX_ABSTRACTED_PRINCIPLE_CHARS} characters or fewer`);
          if (failed) return failed;
        }
      }
      // Rule: triggerPattern + action + association required (deterministic constraint)
      if (rec.kind === 'rule') {
        if (!rec.triggerPattern || rec.triggerPattern.trim() === '') {
          const failed = fail('schema', 'recommendations[].triggerPattern is required when kind is "rule"');
          if (failed) return failed;
        }
        if (!rec.action || rec.action.trim() === '') {
          const failed = fail('schema', 'recommendations[].action is required when kind is "rule"');
          if (failed) return failed;
        }
        // ASSC-2/3: artifact-local association integrity. Trusted-context
        // membership (canonical_principle ids actually exposed this run) is
        // validated downstream against the trustedContextReceipt — never here,
        // because this validator sees only the output.
        if (rec.principleAssociation === undefined) {
          const failed = fail('association', `rule recommendation "${rec.recommendationRef}" is missing principleAssociation (required for kind "rule")`);
          if (failed) return failed;
        } else if (rec.principleAssociation.status === 'linked') {
          if (rec.principleAssociation.target.type === 'recommendation_ref') {
            const targetRef = rec.principleAssociation.target.recommendationRef;
            const target = refsByRef.get(targetRef);
            if (target === undefined) {
              const failed = fail('association', `rule recommendation "${rec.recommendationRef}" targets recommendationRef "${targetRef}" which does not exist in this artifact`);
              if (failed) return failed;
            } else if (target.kind !== 'principle') {
              const failed = fail('association', `rule recommendation "${rec.recommendationRef}" targets recommendationRef "${targetRef}" of kind "${target.kind}" (must be kind "principle")`);
              if (failed) return failed;
            }
          }
          for (const evidenceRef of rec.principleAssociation.evidenceRefs) {
            if (!evidenceSourceRefs.has(evidenceRef)) {
              const failed = fail('association', `rule recommendation "${rec.recommendationRef}" references evidenceRef "${evidenceRef}" not present in this output's evidence[].sourceRef`);
              if (failed) return failed;
            }
          }
        }
      } else if (Object.hasOwn(rec, 'principleAssociation')) {
        // ASSC-4: the V2 schema already rejects this structurally; surface a
        // precise message for repair quality.
        const failed = fail('association', `recommendation "${rec.recommendationRef}" of kind "${rec.kind}" must not carry principleAssociation (rule-only field)`);
        if (failed) return failed;
      }
    }

    // 2g: Evidence sourceRef existence check (verbose mode only)
    if (isVerbose && options?.sourceRefs) {
      const refSet = new Set(options.sourceRefs);
      for (const ev of Array.isArray(output.evidence) ? output.evidence : []) {
        if (ev.sourceRef && !refSet.has(ev.sourceRef)) {
          const failed = fail('schema', `evidence[].sourceRef "${ev.sourceRef}" not found in context sourceRefs`);
          if (failed) return failed;
        }
      }
    }

    // ── Step 3: Schema validation as fallback ─────────────────────────────────
    if (!Value.Check(DiagnosticianOutputV2Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagnosticianOutputV2Schema, output)];
      const messages = schemaErrors.map((e) => `${e.path}: ${e.message}`);
      if (!isVerbose) {
        return buildFailure('1 field invalid: schema', messages, ['schema']);
      }
      areas.add('schema');
      detailErrors.push(...messages);
    }

    // ── Return ────────────────────────────────────────────────────────────────
    if (detailErrors.length === 0) {
      return buildValidResult();
    }

    const count = detailErrors.length;
    const summary = `${count} field${count > 1 ? 's' : ''} invalid`;
    return buildFailure(summary, detailErrors, [...areas]);
  }
}
