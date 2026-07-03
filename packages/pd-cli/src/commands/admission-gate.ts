/**
 * Shared admission gate helper for CLI commands that call intakeService.intake().
 *
 * PRI-442 Stage 4 / PRI-503: previously only `candidate.ts` checked the gate;
 * `pain-retry.ts` and `diagnose.ts` bypassed it (ERR-089 sibling-branch defect).
 * This shared helper is the single entry point so future CLI commands that
 * call intake() can reuse it instead of re-implementing (or skipping) the check.
 *
 * Runtime Contract: rc-9-no-silent-fallback — refusal includes reason + nextAction
 * (callers MUST surface these in their structured CLI output).
 */
import { evaluateCandidateAdmissionFromRecord, type AdmissionGateResult } from '@principles/core/runtime-v2';

/**
 * Check admission gate for a candidate. Returns null if admitted (caller may
 * proceed); returns AdmissionGateResult with reason + nextAction if refused
 * (caller must refuse and surface reason/nextAction in CLI output).
 *
 * @param candidate - Must carry recommendationKind and confidence from the candidate record
 */
export function checkAdmissionGate(
  candidate: { recommendationKind: string; confidence: number | null },
): AdmissionGateResult | null {
  const admission = evaluateCandidateAdmissionFromRecord({
    recommendationKind: candidate.recommendationKind as Parameters<typeof evaluateCandidateAdmissionFromRecord>[0]['recommendationKind'],
    confidence: candidate.confidence,
  });
  if (admission.decision === 'admitted') return null;
  return admission;
}
