/**
 * CandidateStore — abstract interface for principle candidate queries.
 */
import type { RecommendationKind } from '../../diagnostician-output.js';

export interface CandidateRecord {
  candidateId: string;
  artifactId: string;
  taskId: string;
  sourceRunId: string;
  title: string;
  description: string;
  confidence: number | null;
  sourceRecommendationJson: string;
  /**
   * FAIL-OPEN normalized view of {@link rawRecommendationKind}, retained for
   * read / display compatibility (unknown → 'principle').
   *
   * DO NOT use this field for write-boundary decisions: it cannot distinguish a
   * genuine `'principle'` from an unrecognized or malformed kind. Use
   * `isPrincipleLedgerEligibleKind(rawRecommendationKind)` instead.
   */
  recommendationKind: RecommendationKind;
  /**
   * The persisted `principle_candidates.recommendation_kind` value with NO
   * normalization applied — the provenance anchor for the Principle Ledger
   * write boundary (Phase 1 / PR1).
   *
   * `CandidateIntakeService.intake()` refuses to write the ledger unless this
   * value passes `isPrincipleLedgerEligibleKind()` (i.e. is exactly
   * `'principle'`), which is what makes unknown / missing kinds FAIL CLOSED
   * instead of collapsing to a principle.
   */
  rawRecommendationKind: string;
  status: 'pending' | 'consumed' | 'expired';
  createdAt: string;
}

export interface CandidateStore {
  /**
   * Returns all principle candidates reachable via tasks→runs→commits chain for a given taskId.
   */
  getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]>;

  /**
   * Returns a single candidate by ID, or null if not found.
   */
  getCandidate(candidateId: string): Promise<CandidateRecord | null>;

  /**
   * Updates the status of a candidate by ID.
   * @returns true if the candidate was found and updated; false if not found.
   */
  updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean>;

  /**
   * Atomically transitions a candidate's status from `expectedStatus` to `newStatus`.
   * Prevents TOCTOU races by checking and updating in a single DB operation.
   * @returns true if the transition succeeded; false if the candidate was not found
   *          or its current status did not match `expectedStatus`.
   */
  transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean>;

}
