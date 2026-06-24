/**
 * Raw Observation Adapter — PRI-362 / PRI-446
 *
 * The source-kind resolution logic and RawObservation builders have been
 * migrated to principles-core (runtime-v2/evidence-triage/observation-resolver.ts).
 *
 * This file is now a thin re-export adapter. It preserves the original export
 * names (resolveSourceKind, buildToolFailureObservation, buildLlmDetectionObservation,
 * RawObservation) so all existing import sites and the source-string
 * characterization tests keep working without changes.
 *
 * ERR checklist:
 * - ERR-011: re-export adapter, not a local re-definition of migrated logic.
 */

export {
  resolveSourceKind,
  buildToolFailureObservation,
  buildLlmDetectionObservation,
  buildEmpathyObservation,
  buildManualPainObservation,
} from '@principles/core/runtime-v2';

// Re-export RawObservation for plugin consumers
export type { RawObservation } from './raw-observation-types.js';
