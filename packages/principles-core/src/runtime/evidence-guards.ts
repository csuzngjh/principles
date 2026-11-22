/**
 * Shared evidence guard functions for admission gate and pain signal bridge.
 *
 * Both gate and bridge must agree on what constitutes "owner explicit manual" paths.
 * This module is the single source of truth for that logic.
 *
 * PRI-345: input-evidence hard gate + empty-evidence short circuit.
 */
import type { PainProvenance } from './admission-gate.js';
import { isOwnerManualCorrectionEvidence } from './source-material-authorization.js';

/**
 * Returns true when the provenance indicates a pain signal whose submission
 * the Owner authorized, even though no authenticated host session exists.
 *
 * Two distinct values qualify, for two distinct reasons:
 *  - `owner_reported_no_host_trace` — the Owner reported it personally;
 *  - `agent_reported_owner_approved` — the AGENT observed it and the Owner
 *    authorized the submission (SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.5).
 *
 * The exemption basis for the second value is "the Owner authorized this
 * submission", NOT "the Owner observed the behaviour". Nothing here may be
 * rendered as an Owner statement.
 */
export function isOwnerExplicitManual(provenance: PainProvenance | undefined): boolean {
  return provenance === 'owner_reported_no_host_trace'
    || provenance === 'agent_reported_owner_approved';
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

/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-02 / PRI-1283 round 3 (owner_manual ruling):
 * a correction-evidence payload counts as an explicit Owner statement only
 * when the shared owner_manual judgment says its text is credibly
 * Owner-authored — a direct Owner channel, or an agent-assisted channel with
 * a bound Owner confirmation record. An agent's self-declared
 * `owner_statement` classification (no confirmation) never counts: it is
 * Agent-derived and must not satisfy owner-statement conditions anywhere.
 */
export function isOwnerStatementEvidence(correctionEvidence: unknown): boolean {
  return isOwnerManualCorrectionEvidence(correctionEvidence);
}
