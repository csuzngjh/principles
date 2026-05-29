import type { DiagnosticianOutputV1, RecommendationKind } from './diagnostician-output.js';

export type PainProvenance =
  | 'openclaw_context_bound'
  | 'owner_reported_no_host_trace'
  | 'automatic_hook';

export type AdmissionDecision = 'admitted' | 'needs_evidence' | 'deferred';

export const ADMISSION_CONFIDENCE_THRESHOLD = 0.5;

export interface AdmissionGateInput {
  recommendationKind: RecommendationKind;
  confidence: number;
  evidenceCount: number;
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

  if (input.provenance === 'owner_reported_no_host_trace') {
    return {
      decision: 'needs_evidence',
      reason: 'provenance_owner_reported_no_host_trace',
      nextAction: 'provide_host_session_evidence_or_manual_review',
      evidenceStatus: 'owner_reported_no_host_trace',
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
  provenance: PainProvenance | undefined,
): CandidateAdmissionResult[] {
  return candidates.map((candidate) => {
    const gateInput: AdmissionGateInput = {
      recommendationKind: candidate.recommendationKind,
      confidence: output.confidence,
      evidenceCount: output.evidence.length,
      provenance,
    };
    return {
      candidateId: candidate.candidateId,
      recommendationKind: candidate.recommendationKind,
      admission: evaluateAdmission(gateInput),
    };
  });
}
