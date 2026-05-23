import {
  type PainSeverity as CorePainSeverity,
  type PainSignal as CorePainSignal,
  type PainSignalValidationResult as CorePainSignalValidationResult,
  PainSeveritySchema,
  PainSignalSchema,
  deriveSeverity,
  validatePainSignal,
} from '@principles/core/runtime-v2';

export type PainSeverity = CorePainSeverity;
export const PainSeverity = PainSeveritySchema;

export type PainSignal = CorePainSignal;
export type PainSignalValidationResult = CorePainSignalValidationResult;

export {
  PainSignalSchema,
  deriveSeverity,
  validatePainSignal,
};

