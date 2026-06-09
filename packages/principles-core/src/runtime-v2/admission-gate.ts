import type { DiagnosticianOutputV1, RecommendationKind } from './diagnostician-output.js';
import { isOwnerExplicitManual } from './evidence-guards.js';

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
