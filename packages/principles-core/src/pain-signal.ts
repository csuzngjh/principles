/**
 * Pain signal schema — re-exported from runtime-v2/types/pain-signal.ts.
 *
 * This file exists for backward compatibility with imports from
 * @principles/core (top-level barrel). The canonical definition
 * lives in runtime-v2/types/pain-signal.ts (PRI-443).
 *
 * The unified schema merges the stricter validations from both versions:
 * - ISO 8601 timestamp format check
 * - Context size limit (10KB)
 * - version field with default
 * - isStringRecord type guard (no `as` bypass)
 */

export {
  PainSeverity,
  PainSignalSchema,
  deriveSeverity,
  validatePainSignal,
} from './runtime-v2/types/pain-signal.js';

export type {
  PainSignal,
  PainSignalValidationResult,
} from './runtime-v2/types/pain-signal.js';
