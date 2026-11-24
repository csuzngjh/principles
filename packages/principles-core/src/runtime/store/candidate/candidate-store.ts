/**
 * CandidateStore — abstract interface for principle candidate queries.
 */
import type { RecommendationKind } from '../../diagnostician-output.js';
import type {
  AdmissionEvaluationRecord,
  AdmissionProcessingRecord,
  CandidateAdmissionDocument,
  CandidatePostProcessingRecoveryInput,
  CandidatePostProcessingRecoveryResult,
  OwnerDecisionRecord,
} from './admission-document.js';

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

  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-03: read the persisted admission document.
   * NULL when the column is empty (pre-CR-03 records — "历史准入处置未记录").
   * Unparseable JSON returns { ok: false, reason } — callers must fail loud,
   * never treat a corrupt document as absent.
   */
  getAdmissionDocument(candidateId: string): Promise<
    { ok: true; document: CandidateAdmissionDocument | null } | { ok: false; reason: string }
  >;

  /**
   * Persist one full-gate evaluation (append-only history, idempotent by
   * material fingerprint + policy version, current pointer moves forward).
   * Returns the resulting document and whether the entry was appended/reused.
   */
  appendAdmissionEvaluation(candidateId: string, evaluation: AdmissionEvaluationRecord): Promise<
    { status: 'appended' | 'reused'; document: CandidateAdmissionDocument } | { status: 'refused'; reason: string }
  >;

  /**
   * Update ONLY the independent processing-progress domain. Never touches
   * evaluation history.
   */
  updateAdmissionProcessing(candidateId: string, processing: AdmissionProcessingRecord): Promise<boolean>;

  /** Atomically authorize and audit recovery of an invalid-raw-kind processing park. */
  authorizeInvalidKindPostProcessingRecovery(candidateId: string, input: CandidatePostProcessingRecoveryInput): Promise<CandidatePostProcessingRecoveryResult>;

  /**
   * Phase 7.2 P1-01 Phase A — persist (or idempotently resume) a typed Owner
   * decision INTENT (`executionStatus: 'pending'`). The park is NOT cleared;
   * only {@link completeOwnerDecision} lifts it, after the execution is
   * durable. BEGIN IMMEDIATE read-modify-write: the intent lands atomically
   * with the document state it was decided against.
   *
   * `resumed` — identical intent already pending (crash re-run; no new record,
   * no re-ask). `superseded` — a DIFFERENT intent replaced a still-pending one
   * (the caller must have proven the old intent unexecuted). The returning
   * `decision` is ALWAYS the now-pending executable record.
   */
  recordOwnerDecision(candidateId: string, intent: OwnerDecisionRecord): Promise<
    | { status: 'appended'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord }
    | { status: 'resumed'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord }
    | { status: 'superseded'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord; supersededDecisionId: string }
    | { status: 'refused'; reason: string }
  >;

  /**
   * Phase 7.2 P1-01 Phase C — atomically finalize an executed Owner decision:
   * mark it `applied` (resultingPrincipleId + executedAt), append the
   * reuse-park release audit evaluation (when one is supplied), and transition
   * processing to `complete` — all in ONE admission_json write, so the park
   * can never be lifted while the decision reads pending (or the reverse).
   *
   * `already_completed` — idempotent Phase C re-run (crash after completion,
   * lost response): nothing is re-executed, the completed result is reported.
   */
  completeOwnerDecision(candidateId: string, decisionId: string, input: {
    resultingPrincipleId: string;
    executedAt?: string;
    releaseEvaluation?: AdmissionEvaluationRecord;
  }): Promise<
    | { status: 'completed'; document: CandidateAdmissionDocument }
    | { status: 'already_completed'; document: CandidateAdmissionDocument }
    | { status: 'refused'; reason: string }
  >;

  /**
   * SPEC §9.1: the diagnosis post-processing backlog (router-candidate aware,
   * orphan-inclusive). See SqliteCandidateStore for the resolution contract.
   */
  listDiagnosisPostProcessingBacklog(options: { limit: number; nowIso?: string }): {
    eligible: { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[];
    corrupt: { candidateId: string; taskId: string; status: string; createdAt: string }[];
  };

}
