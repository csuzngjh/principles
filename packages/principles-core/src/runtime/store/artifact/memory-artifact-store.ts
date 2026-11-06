/**
 * ArtifactStore — in-memory test double using a Map.
 */
import type { ArtifactRecord, ArtifactWithCandidates, ArtifactStore } from './artifact-store.js';
import type { CandidateRecord } from '../candidate/candidate-store.js';

export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly candidatesByArtifact = new Map<string, CandidateRecord[]>();

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async getArtifactWithCandidates(artifactId: string): Promise<ArtifactWithCandidates | null> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return null;
    return {
      artifact,
      candidates: this.candidatesByArtifact.get(artifactId) ?? [],
    };
  }

  insert(record: ArtifactRecord, candidates: CandidateRecord[] = []): void {
    this.artifacts.set(record.artifactId, record);
    this.candidatesByArtifact.set(record.artifactId, candidates);
  }

  clear(): void {
    this.artifacts.clear();
    this.candidatesByArtifact.clear();
  }
}
