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
// PRI-446: upgrade thresholds (single source of truth, migrated from plugin)
export { RISKY_HIGH_SCORE_THRESHOLD, REPEATED_FAILURE_THRESHOLD } from './triage-policy.js';

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

// Admission events — PEAT-B2
export type {
  AdmissionDecisionEvent,
  DiagnosisTaskCreatedEvent,
  EvidenceOnlyRecordedEvent,
  SkippedRefusedEvent,
  AdmissionEvent,
} from './admission-events.js';
export {
  createAdmissionDecisionEvent,
  createDiagnosisTaskCreatedEvent,
  createEvidenceOnlyRecordedEvent,
  createSkippedRefusedEvent,
  serializeAdmissionEvent,
  validateEventPrivacy,
} from './admission-events.js';
