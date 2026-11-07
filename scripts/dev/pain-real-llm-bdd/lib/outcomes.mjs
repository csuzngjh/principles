/**
 * PRI-1147 harness — per-sample execution outcome taxonomy (P1-1).
 *
 * A real-LLM BDD sample ends in exactly ONE of these outcomes, and the
 * distinction is load-bearing for the acceptance metrics:
 *
 *   admitted                  terminal marker 'admitted' + pain row (real verdict or STRONG direct)
 *   resolved_none             terminal marker 'resolved_none' — a VALID NONE: the model was
 *                             really called and returned none with confidence ≥ threshold
 *   stage1_not_admitted       the pipeline legitimately did not admit at Stage 1: zero
 *                             keyword hit (not_a_signal, no marker) or a pre-pending ingress
 *                             refusal (abandoned marker, ingress reason). For an expected
 *                             correction this is a REAL detection miss (Stage-1 coverage
 *                             boundary) — never an infrastructure failure.
 *   abandoned_low_confidence  bounded-retry budget exhausted on real low-confidence verdicts
 *                             (unresolved — excluded from Stage-2 accuracy)
 *   abandoned_llm_error       bounded-retry budget exhausted on error verdicts (never NONE)
 *   pending_unresolved        Stage-2 cycle budget (maxCycles) reached while the marker is
 *                             still pending_llm_review — NOT a completed NONE
 *   classifier_unavailable    the workspace-resolved classifier could not be built (config/
 *                             env) — no verdict existed, so pain_created=false here must
 *                             NEVER be read as a NONE
 *   execution_error           hook failure, missing observation, missing admission state or
 *                             any post-pending anomaly — infrastructure, not semantics
 */

export const SAMPLE_OUTCOMES = Object.freeze([
  'admitted',
  'resolved_none',
  'stage1_not_admitted',
  'abandoned_low_confidence',
  'abandoned_llm_error',
  'pending_unresolved',
  'classifier_unavailable',
  'execution_error',
]);

/** Outcomes that represent a completed, model-verified Stage-2 adjudication. */
export const STAGE2_DECIDED_OUTCOMES = Object.freeze(['admitted', 'resolved_none']);

/** Outcomes that mean the run infrastructure itself failed (exit-code relevant). */
export const EXECUTION_FAILURE_OUTCOMES = Object.freeze([
  'pending_unresolved',
  'classifier_unavailable',
  'execution_error',
]);

/**
 * Pure classifier for the final persisted state of one sample.
 *
 * @param {object} input
 * @param {boolean} input.hookFailed           processHookInvocation threw or exited non-zero
 * @param {boolean} input.observationPersisted governance_observations row exists for the key
 * @param {boolean} input.pendingExisted       marker was pending_llm_review before Stage 2
 * @param {boolean} input.classifierUnavailable classifier resolution failed while pending existed
 * @param {boolean} input.stage2Unfinished     maxCycles reached with the marker still pending
 * @param {string|null} input.markerDecision   final governance_signal_admissions.decision
 * @param {string|null} input.markerReason     final marker reason
 * @returns {{outcome: string, reason: string}}
 */
export function classifySampleOutcome({
  hookFailed,
  observationPersisted,
  pendingExisted,
  classifierUnavailable,
  stage2Unfinished,
  markerDecision,
  markerReason,
}) {
  if (hookFailed) return { outcome: 'execution_error', reason: `hook_failed:${markerReason ?? 'no_detail'}` };
  if (!observationPersisted) return { outcome: 'execution_error', reason: 'observation_missing: ingestion did not persist the expected governance_observations row' };
  if (pendingExisted && classifierUnavailable) return { outcome: 'classifier_unavailable', reason: markerReason ?? 'classifier resolution failed' };
  if (pendingExisted && stage2Unfinished && markerDecision === 'pending_llm_review') {
    return { outcome: 'pending_unresolved', reason: 'stage2 max cycles reached with marker still pending_llm_review' };
  }
  if (markerDecision === 'admitted') return { outcome: 'admitted', reason: markerReason ?? null };
  if (markerDecision === 'resolved_none') return { outcome: 'resolved_none', reason: markerReason ?? null };
  if (markerDecision === 'abandoned') {
    if (markerReason === 'low_confidence') return { outcome: 'abandoned_low_confidence', reason: markerReason };
    if (markerReason === 'llm_error') return { outcome: 'abandoned_llm_error', reason: markerReason };
    if (!pendingExisted) return { outcome: 'stage1_not_admitted', reason: `ingress_abandoned:${markerReason ?? 'unknown'}` };
    return { outcome: 'execution_error', reason: `post_pending_abandon_anomaly:${markerReason ?? 'unknown'}` };
  }
  if (markerDecision === 'pending_llm_review') {
    // pending without pendingExisted is impossible; without stage2Unfinished
    // this is a caller bookkeeping error — treat as unresolved anomaly.
    return { outcome: 'pending_unresolved', reason: 'marker still pending after stage2 driver finished' };
  }
  if (markerDecision === null || markerDecision === undefined) {
    return { outcome: 'stage1_not_admitted', reason: 'no admission marker: not_a_signal (Stage-1 zero-hit)' };
  }
  return { outcome: 'execution_error', reason: `unknown_marker_decision:${String(markerDecision)}` };
}
