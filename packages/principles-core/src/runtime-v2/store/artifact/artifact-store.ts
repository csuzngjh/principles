/**
 * ArtifactStore — abstract interface for artifact queries.
 */
import type { CandidateRecord } from '../candidate/candidate-store.js';

// Re-export CandidateRecord so consumers can import it from this module
export type { CandidateRecord } from '../candidate/candidate-store.js';

export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  taskId: string;
  artifactKind: string;
  contentJson: string;
  createdAt: string;
}

export interface ArtifactWithCandidates {
  artifact: ArtifactRecord;
  candidates: CandidateRecord[];
}

export interface ArtifactStore {
  /**
   * Returns a single artifact by ID, or null if not found.
   */
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;

  /**
   * Returns an artifact with its inline candidate array, or null if artifact not found.
   */
  getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null>;
}
