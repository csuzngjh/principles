/**
 * Evidence Triage — PEAT-B1
 *
 * Public API for pre-diagnosis evidence triage.
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
