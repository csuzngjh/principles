/**
 * CandidateStore — abstract interface for principle candidate queries.
 */
export interface CandidateRecord {
  candidateId: string;
  artifactId: string;
  taskId: string;
  sourceRunId: string;
  title: string;
  description: string;
  confidence: number | null;
  sourceRecommendationJson: string;
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
   */
  updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<void>;
}
