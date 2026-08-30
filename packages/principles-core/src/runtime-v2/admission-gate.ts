import type { DiagnosticianOutputV1, RecommendationKind } from './diagnostician-output.js';
import { isOwnerExplicitManual } from './evidence-guards.js';

export type PainProvenance =
  | 'host_context_bound'
  | 'owner_reported_no_host_trace'
  | 'automatic_hook';

/**
 * Codex Governance Closure SPEC rev 2 §12: `host_context_bound` + hostKind is
 * the current provenance value; `openclaw_context_bound` is the legacy spelling
 * written before Slice B and remains valid on read. Reads of persisted
 * provenance normalize the legacy value instead of rewriting history.
 */
export function normalizePainProvenance(value: unknown): PainProvenance | undefined {
  if (value === 'host_context_bound' || value === 'owner_reported_no_host_trace' || value === 'automatic_hook') {
    return value;
  }
  if (value === 'openclaw_context_bound') return 'host_context_bound';
  return undefined;
}

export type AdmissionDecision = 'admitted' | 'needs_evidence' | 'deferred';

export const ADMISSION_CONFIDENCE_THRESHOLD = 0.5;

export interface AdmissionGateInput {
  recommendationKind: RecommendationKind;
  confidence: number;
  evidenceCount: number;
  inputEvidenceCount: number;
  provenance: PainProvenance | undefined;
}

export interface AdmissionGateResult {
  decision: AdmissionDecision;
  reason: string;
  nextAction: string;
  evidenceStatus: string;
}

export function evaluateAdmission(input: AdmissionGateInput): AdmissionGateResult {
  if (input.recommendationKind === 'defer') {
    return {
      decision: 'deferred',
      reason: 'recommendation_kind_defer_not_actionable',
      nextAction: 'review_defer_disposition_manually',
      evidenceStatus: input.provenance ?? 'unknown',
    };
  }

  if (input.inputEvidenceCount === 0 && !isOwnerExplicitManual(input.provenance)) {
    return {
      decision: 'needs_evidence',
      reason: 'input_evidence_empty',
      nextAction: 'collect_evidence_before_diagnosis',
      evidenceStatus: input.provenance ?? 'unknown',
    };
  }

  if (input.confidence < ADMISSION_CONFIDENCE_THRESHOLD) {
    return {
      decision: 'needs_evidence',
      reason: `confidence_below_threshold:${input.confidence.toFixed(2)}<${ADMISSION_CONFIDENCE_THRESHOLD}`,
      nextAction: 'provide_additional_evidence_or_manual_review',
      evidenceStatus: input.provenance ?? 'unknown',
    };
  }

  if (input.evidenceCount === 0) {
    return {
      decision: 'needs_evidence',
      reason: 'evidence_array_empty',
      nextAction: 'provide_source_evidence_for_diagnosis',
      evidenceStatus: input.provenance ?? 'unknown',
    };
  }

  return {
    decision: 'admitted',
    reason: 'evidence_sufficient',
    nextAction: 'none',
    evidenceStatus: input.provenance ?? 'unknown',
  };
}

export interface CandidateAdmissionResult {
  candidateId: string;
  recommendationKind: RecommendationKind;
  admission: AdmissionGateResult;
}

export function evaluateCandidateAdmissions(
  candidates: readonly { candidateId: string; recommendationKind: RecommendationKind }[],
  output: DiagnosticianOutputV1,
  options: { provenance?: PainProvenance; inputEvidenceCount?: number } = {},
): CandidateAdmissionResult[] {
  const { provenance, inputEvidenceCount = 0 } = options;
  return candidates.map((candidate) => {
    const gateInput: AdmissionGateInput = {
      recommendationKind: candidate.recommendationKind,
      confidence: output.confidence,
      evidenceCount: output.evidence.length,
      inputEvidenceCount,
      provenance,
    };
    return {
      candidateId: candidate.candidateId,
      recommendationKind: candidate.recommendationKind,
      admission: evaluateAdmission(gateInput),
    };
  });
}

/**
 * CLI-time admission gate check using only the candidate record's stored fields.
 *
 * This is a CONSERVATIVE PARTIAL check that prevents CLI commands (intake /
 * repair / internalization-backfill) from bypassing the admission gate's
 * strongest signals. It covers:
 *   - `recommendationKind === 'defer'`  → deferred (definitive)
 *   - `confidence === null`             → needs_evidence (fail loud: rc-3)
 *   - `confidence < threshold`          → needs_evidence (definitive)
 *
 * It does NOT re-check evidence-level gates (inputEvidenceCount === 0 or
 * evidenceCount === 0) because those require the diagnostician output and
 * pain signal, which are not stored on the candidate record. The production
 * path (PainSignalBridge.onDiagnosisComplete) already ran those checks when
 * the candidate was created.
 *
 * Runtime Contract:
 *   - rc-3-fail-loud-missing: null confidence fails loud, not silent
 *   - rc-9-no-silent-fallback: refusal includes reason + nextAction
 *
 * @param candidate - fields available on CandidateRecord
 * @returns AdmissionGateResult with decision, reason, nextAction
 */
export function evaluateCandidateAdmissionFromRecord(candidate: {
  recommendationKind: RecommendationKind;
  confidence: number | null;
}): AdmissionGateResult {
  if (candidate.recommendationKind === 'defer') {
    return {
      decision: 'deferred',
      reason: 'recommendation_kind_defer_not_actionable',
      nextAction: 'review_defer_disposition_manually',
      evidenceStatus: 'unknown',
    };
  }

  if (candidate.confidence === null) {
    return {
      decision: 'needs_evidence',
      reason: 'confidence_missing_on_candidate_record',
      nextAction: 're_run_diagnosis_to_populate_confidence_or_manual_review',
      evidenceStatus: 'unknown',
    };
  }

  if (candidate.confidence < ADMISSION_CONFIDENCE_THRESHOLD) {
    return {
      decision: 'needs_evidence',
      reason: `confidence_below_threshold:${candidate.confidence.toFixed(2)}<${ADMISSION_CONFIDENCE_THRESHOLD}`,
      nextAction: 'provide_additional_evidence_or_manual_review',
      evidenceStatus: 'unknown',
    };
  }

  return {
    decision: 'admitted',
    reason: 'cli_partial_check_passed_confidence_and_kind',
    nextAction: 'none',
    evidenceStatus: 'unknown',
  };
}
