/**
 * Raw Observation Types — PRI-362 / PRI-446
 *
 * The RawObservation type has been migrated to principles-core
 * (runtime-v2/evidence-triage/observation-resolver.ts). This file re-exports it
 * so existing plugin import sites keep working unchanged.
 *
 * ERR checklist:
 * - ERR-011: this is a re-export adapter, not a local re-definition.
 */

export type { RawObservation } from '@principles/core/runtime-v2';
