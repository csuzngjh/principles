import type { PIArtifactRecord, PIArtifactStore } from './pi-artifact.js';

export class MemoryPIArtifactStore implements PIArtifactStore {
  private readonly artifacts = new Map<string, PIArtifactRecord>();

  private readonly idempotencyIndex = new Map<string, string>();

  private static idempotencyKey(sourceTaskId: string, artifactKind: string): string {
    return `${sourceTaskId}::${artifactKind}`;
  }

  async createArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord> {
    const key = MemoryPIArtifactStore.idempotencyKey(record.sourceTaskId, record.artifactKind);
    const existingId = this.idempotencyIndex.get(key);
    if (existingId) {
      throw new Error(
        `Duplicate PIArtifact: sourceTaskId=${record.sourceTaskId} artifactKind=${record.artifactKind} already exists as ${existingId}`,
      );
    }

    this.artifacts.set(record.artifactId, record);
    this.idempotencyIndex.set(key, record.artifactId);
    return record;
  }

  async upsertArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord> {
    const key = MemoryPIArtifactStore.idempotencyKey(record.sourceTaskId, record.artifactKind);
    const existingId = this.idempotencyIndex.get(key);

    if (existingId) {
      this.artifacts.delete(existingId);
      for (const [idxKey, idxVal] of this.idempotencyIndex.entries()) {
        if (idxVal === existingId && idxKey !== key) {
          this.idempotencyIndex.delete(idxKey);
        }
      }
    }

    this.artifacts.set(record.artifactId, record);
    this.idempotencyIndex.set(key, record.artifactId);
    return record;
  }

  async getArtifactById(artifactId: string): Promise<PIArtifactRecord | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listBySourceTaskId(sourceTaskId: string): Promise<PIArtifactRecord[]> {
    const results: PIArtifactRecord[] = [];
    for (const record of this.artifacts.values()) {
      if (record.sourceTaskId === sourceTaskId) {
        results.push(record);
      }
    }
    return results;
  }

  async listLineage(artifactId: string): Promise<PIArtifactRecord[]> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return [];

    const results: PIArtifactRecord[] = [];
    for (const lineageId of artifact.lineageArtifactIds) {
      const found = this.artifacts.get(lineageId);
      if (found) {
        results.push(found);
      }
    }
    return results;
  }

  async updateValidationStatus(artifactId: string, validationStatus: PIArtifactRecord['validationStatus']): Promise<boolean> {
    const existing = this.artifacts.get(artifactId);
    if (!existing) return false;
    this.artifacts.set(artifactId, { ...existing, validationStatus, updatedAt: new Date().toISOString() });
    return true;
  }
}
