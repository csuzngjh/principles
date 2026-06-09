/**
 * Shared evidence guard functions for admission gate and pain signal bridge.
 *
 * Both gate and bridge must agree on what constitutes "owner explicit manual" paths.
 * This module is the single source of truth for that logic.
 *
 * PRI-345: input-evidence hard gate + empty-evidence short circuit.
 */
import type { PainProvenance } from './admission-gate.js';

/**
 * Returns true when the provenance indicates an owner explicitly reported
 * the pain signal (e.g. CLI `pd pain` with no authenticated host session).
 *
 * Owner-reported paths are exempt from the input-evidence-empty gate
 * because the owner's intent itself is evidence of a real problem.
 */
export function isOwnerExplicitManual(provenance: PainProvenance | undefined): boolean {
  return provenance === 'owner_reported_no_host_trace';
}

/**
 * Returns true when the pain signal should be short-circuited before
 * calling the diagnostician runner.
 *
 * Conditions for short circuit:
 *  - Input evidence array is empty (no evidence to diagnose)
 *  - Source is NOT one of the owner-initiated channels (manual, pain, skill:pain)
 *
 * Owner-initiated sources bypass the short circuit because the owner's
 * explicit intent is itself a valid reason to run diagnosis even without
 * pre-collected evidence.
 */
export function shouldShortCircuitEmptyEvidence(evidenceLength: number, source: string): boolean {
  return evidenceLength === 0
    && source !== 'manual'
    && source !== 'pain'
    && source !== 'skill:pain';
}
