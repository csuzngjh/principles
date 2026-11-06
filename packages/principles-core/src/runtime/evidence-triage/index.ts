/**
 * Evidence Triage — PEAT-B1 → B2
 *
 * Public API for pre-diagnosis evidence triage and trigger control.
 * Pure types and policy — no I/O, no plugin imports.
 */

// Types
export type {
  SourceKind,
  TriageDecision,
  TriageResult,
  TriageInput,
} from './types.js';

export { isSourceKind } from './types.js';

// Source descriptors
export type { SourceDescriptor } from './source-descriptors.js';
export { SOURCE_DESCRIPTORS, getSourceDescriptor } from './source-descriptors.js';

// Triage policy
export { evaluateTriage } from './triage-policy.js';

// Observation resolver — PRI-446 (migrated from plugin raw-observation-adapter)
// Pain Phase 0: buildLlmDetectionObservation / buildEmpathyObservation removed
// (zero production callers; live builders below keep their consumers).
export type { RawObservation } from './observation-resolver.js';
export {
  resolveSourceKind,
  buildToolFailureObservation,
  buildManualPainObservation,
} from './observation-resolver.js';

// Trigger controller — PEAT-B2
export type {
  TriggerOutcome,
  TriggerDecision,
  TriggerControllerInput,
} from './trigger-controller.js';
export {
  evaluateTriggerController,
  shouldCreateTask,
  isAdmittedOutcome,
  isSkippedOutcome,
} from './trigger-controller.js';
