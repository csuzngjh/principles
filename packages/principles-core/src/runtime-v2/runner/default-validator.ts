/**
 * DefaultDiagnosticianValidator — full schema + semantic validation of DiagnosticianOutputV1.
 *
 * Validates across 7 requirement areas (REQ-2.3a through REQ-2.3g):
 *   REQ-2.3a — TypeBox schema correctness
 *   REQ-2.3b — Non-empty summary and rootCause
 *   REQ-2.3c — Task identity match (output.taskId === expected taskId)
 *   REQ-2.3d — Evidence array bounded shape (each entry has non-empty sourceRef + note)
 *   REQ-2.3e — Recommendations shape (valid kind union + non-empty description)
 *   REQ-2.3f — Confidence in [0, 1] closed interval
 *   REQ-2.3g — Evidence sourceRef back-check (standard=format, verbose=existence)
 *
 * Validation order: semantic checks run BEFORE schema validation so that
 * human-readable error messages (with actual values) are returned first.
 * Schema validation acts as a fallback for structural issues not caught semantically.
 *
 * Error format:
 *   - errors[0] = aggregate summary ("N fields invalid: ...")
 *   - errors[1..N] = per-field detail messages
 *   - All failures use errorCategory = 'output_invalid'
 *
 * Modes:
 *   - Standard (verbose !== true): fail-fast — return on first error
 *   - Verbose (verbose === true): collect all errors before returning
 */
import { Value } from '@sinclair/typebox/value';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import { DiagnosticianOutputV1Schema, RecommendationKindSchema } from '../diagnostician-output.js';
import type {
  DiagnosticianValidationResult,
  DiagnosticianValidateOptions,
  DiagnosticianValidator,
} from './diagnostician-validator.js';

export const MAX_ABSTRACTED_PRINCIPLE_CHARS = 200 as const;

const ERROR_CATEGORY_OUTPUT_INVALID = 'output_invalid' as const;

function buildResult(valid: false, aggregateSummary: string, detailErrors: string[]): DiagnosticianValidationResult {
  return {
    valid: false,
    errors: [aggregateSummary, ...detailErrors],
    errorCategory: ERROR_CATEGORY_OUTPUT_INVALID,
  };
}

function buildValidResult(): DiagnosticianValidationResult {
  return { valid: true, errors: [] };
}

/**
 * DefaultDiagnosticianValidator — full schema + semantic validation.
 */
export class DefaultDiagnosticianValidator implements DiagnosticianValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(
    output: DiagnosticianOutputV1,
    taskId: string,
    options?: DiagnosticianValidateOptions,
  ): Promise<DiagnosticianValidationResult> {
    // ── Step 1: Guard ──────────────────────────────────────────────────────────
    if (typeof output !== 'object' || output === null) {
      return buildResult(false, '1 field invalid: output must be a non-null object', [
        'output must be a non-null object',
      ]);
    }

    const isVerbose = options?.verbose === true;
    const detailErrors: string[] = [];

    // ── Step 2: Semantic checks FIRST (better error messages with actual values) ──

    // 2a: Task identity
    if (output.taskId !== taskId) {
      const msg = `taskId mismatch: output.taskId "${output.taskId}" does not match expected "${taskId}"`;
      if (!isVerbose) return buildResult(false, '1 field invalid: taskId', [msg]);
      detailErrors.push(msg);
    }

    // 2b: Confidence boundary [0, 1]
    if (output.confidence < 0 || output.confidence > 1) {
      const msg = `confidence ${output.confidence} outside [0, 1] closed interval`;
      if (!isVerbose) return buildResult(false, '1 field invalid: confidence', [msg]);
      detailErrors.push(msg);
    }

    // 2c: Non-empty summary
    if (!output.summary || output.summary.trim() === '') {
      const msg = 'summary must be a non-empty string';
      if (!isVerbose) return buildResult(false, '1 field invalid: summary', [msg]);
      detailErrors.push(msg);
    }

    // 2d: Non-empty rootCause
    if (!output.rootCause || output.rootCause.trim() === '') {
      const msg = 'rootCause must be a non-empty string';
      if (!isVerbose) return buildResult(false, '1 field invalid: rootCause', [msg]);
      detailErrors.push(msg);
    }

    // 2e: Evidence array shape
    for (const ev of output.evidence) {
      if (!ev.sourceRef || ev.sourceRef.trim() === '') {
        const msg = 'evidence[].sourceRef must be a non-empty string';
        if (!isVerbose) return buildResult(false, '1 field invalid: evidence', [msg]);
        detailErrors.push(msg);
      }
      if (!ev.note || ev.note.trim() === '') {
        const msg = 'evidence[].note must be a non-empty string';
        if (!isVerbose) return buildResult(false, '1 field invalid: evidence', [msg]);
        detailErrors.push(msg);
      }
    }

    // 2f: Recommendations shape + principle structural fields
    for (const rec of output.recommendations) {
      if (!Value.Check(RecommendationKindSchema, rec.kind)) {
        const msg = `recommendations[].kind "${rec.kind}" is not a valid RecommendationKind`;
        if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
        detailErrors.push(msg);
      }
      if (!rec.description || rec.description.trim() === '') {
        const msg = 'recommendations[].description must be a non-empty string';
        if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
        detailErrors.push(msg);
      }
      // Principle recommendations require structural fields (triggerPattern, action, abstractedPrinciple)
      if (rec.kind === 'principle') {
        if (!rec.triggerPattern || rec.triggerPattern.trim() === '') {
          const msg = 'recommendations[].triggerPattern is required when kind is "principle"';
          if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
          detailErrors.push(msg);
        }
        if (!rec.action || rec.action.trim() === '') {
          const msg = 'recommendations[].action is required when kind is "principle"';
          if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
          detailErrors.push(msg);
        }
        if (!rec.abstractedPrinciple || rec.abstractedPrinciple.trim() === '') {
          const msg = 'recommendations[].abstractedPrinciple is required when kind is "principle"';
          if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
          detailErrors.push(msg);
        }
        if (rec.abstractedPrinciple && rec.abstractedPrinciple.length > MAX_ABSTRACTED_PRINCIPLE_CHARS) {
          const msg = `recommendations[].abstractedPrinciple must be ${MAX_ABSTRACTED_PRINCIPLE_CHARS} characters or fewer`;
          if (!isVerbose) return buildResult(false, '1 field invalid: recommendations', [msg]);
          detailErrors.push(msg);
        }
      }
    }

    // 2g: Evidence sourceRef existence check (verbose mode only)
    if (isVerbose && options?.sourceRefs) {
      const refSet = new Set(options.sourceRefs);
      for (const ev of output.evidence) {
        if (ev.sourceRef && !refSet.has(ev.sourceRef)) {
          const msg = `evidence[].sourceRef "${ev.sourceRef}" not found in context sourceRefs`;
          detailErrors.push(msg);
        }
      }
    }

    // ── Step 3: Schema validation as fallback ─────────────────────────────────
    if (!Value.Check(DiagnosticianOutputV1Schema, output)) {
      const schemaErrors = [...Value.Errors(DiagnosticianOutputV1Schema, output)];
      const messages = schemaErrors.map((e) => `${e.path}: ${e.message}`);
      if (!isVerbose) {
        return buildResult(false, '1 field invalid: schema', messages);
      }
      detailErrors.push(...messages);
    }

    // ── Return ────────────────────────────────────────────────────────────────
    if (detailErrors.length === 0) {
      return buildValidResult();
    }

    const count = detailErrors.length;
    const summary = `${count} field${count > 1 ? 's' : ''} invalid`;
    return buildResult(false, summary, detailErrors);
  }
}
