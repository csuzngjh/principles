import type { PDErrorCategory } from '../error-categories.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';

/**
 * Result of validating a DiagnosticianOutputV2 (PRI-1146 V2 Only).
 *
 * `invalidAreas` distinguishes Schema Validity from Association Validity
 * (SPEC v0.6 §7): a structurally valid artifact may still carry invalid rule
 * associations, and the two failure classes have different repair paths.
 */
export interface DiagnosticianValidationResult {
  /** Whether the output passed all validation checks. */
  readonly valid: boolean;
  /** List of validation failure descriptions (empty when valid=true). */
  readonly errors: readonly string[];
  /** Error category for the validation failure (set when valid=false). */
  readonly errorCategory?: PDErrorCategory;
  /** Which requirement areas failed (set when valid=false). */
  readonly invalidAreas?: readonly ('schema' | 'association')[];
}

/**
 * Options for DiagnosticianValidator.validate().
 */
export interface DiagnosticianValidateOptions {
  /**
   * When true, collect all errors before returning (verbose mode).
   * When false/undefined, return immediately on first error (fail-fast).
   */
  readonly verbose?: boolean;
  /**
   * Valid sourceRef values from DiagnosticianContextPayload.sourceRefs.
   * Used for evidence sourceRef existence check in verbose mode.
   */
  readonly sourceRefs?: readonly string[];
}

/**
 * Validator interface consumed by the router runner (Stage C) and the split
 * runner's cache-hit gate.
 *
 * Implemented by DefaultDiagnosticianValidator (default-validator.ts).
 */
export interface DiagnosticianValidator {
  /**
   * Validate a diagnostician output against schema and semantic rules.
   *
   * @param output - The raw diagnostician output to validate
   * @param taskId - Expected taskId for identity verification
   * @param options - Optional options (verbose mode, sourceRefs for evidence back-check)
   * @returns Validation result with valid flag and any errors
   */
  validate(
    output: DiagnosticianOutputV2,
    taskId: string,
    options?: DiagnosticianValidateOptions,
  ): Promise<DiagnosticianValidationResult>;
}
