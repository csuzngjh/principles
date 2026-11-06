import type { PDErrorCategory } from '../error-categories.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

/**
 * Result of validating a DiagnosticianOutputV1.
 *
 * This interface is the contract that DiagnosticianRunner depends on via
 * dependency injection.
 */
export interface DiagnosticianValidationResult {
  /** Whether the output passed all validation checks. */
  readonly valid: boolean;
  /** List of validation failure descriptions (empty when valid=true). */
  readonly errors: readonly string[];
  /** Error category for the validation failure (set when valid=false). */
  readonly errorCategory?: PDErrorCategory;
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
 * Validator interface consumed by DiagnosticianRunner.
 *
 * Implemented by DefaultDiagnosticianValidator (default-validator.ts). The
 * former m4-01 PassThroughValidator scaffold was deleted in Test Diet Phase
 * 2.2-B3-C once it had no remaining consumers.
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
    output: DiagnosticianOutputV1,
    taskId: string,
    options?: DiagnosticianValidateOptions,
  ): Promise<DiagnosticianValidationResult>;
}
