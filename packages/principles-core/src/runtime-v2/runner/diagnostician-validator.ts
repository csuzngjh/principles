import type { PDErrorCategory } from '../error-categories.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

/**
 * Result of validating a DiagnosticianOutputV1.
 *
 * Concrete implementation is m4-03 scope. This interface is the contract
 * that DiagnosticianRunner depends on via dependency injection.
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
 * Validator interface consumed by DiagnosticianRunner.
 *
 * m4-01 uses a pass-through implementation.
 * m4-03 implements the full schema + semantic + evidence validation.
 */
export interface DiagnosticianValidator {
  /**
   * Validate a diagnostician output against schema and semantic rules.
   *
   * @param output - The raw diagnostician output to validate
   * @param taskId - Expected taskId for identity verification
   * @returns Validation result with valid flag and any errors
   */
  validate(output: DiagnosticianOutputV1, taskId: string): Promise<DiagnosticianValidationResult>;
}

/**
 * Pass-through validator for m4-01 (accepts all output).
 * m4-03 replaces this with full DiagnosticianOutputV1 validation.
 */
export class PassThroughValidator implements DiagnosticianValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(_output: DiagnosticianOutputV1, _taskId: string): Promise<DiagnosticianValidationResult> {
    return { valid: true, errors: [] };
  }
}
