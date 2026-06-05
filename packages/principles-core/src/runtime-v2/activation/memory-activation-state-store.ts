import type { ActivationStateReadModel, ActivationStatusRecord, PIArtifactSnapshot, ActivationArtifactReadModel } from './activation-types.js';

export class MemoryActivationStateStore implements ActivationStateReadModel {
  private readonly activations = new Map<string, ActivationStatusRecord>();

  async getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null> {
    return this.activations.get(idempotencyKey) ?? null;
  }

  async recordActivation(record: ActivationStatusRecord): Promise<void> {
    this.activations.set(record.idempotencyKey, record);
  }

  async listPromptActivations(): Promise<ActivationStatusRecord[]> {
    const result: ActivationStatusRecord[] = [];
    for (const record of this.activations.values()) {
      if (record.channel === 'prompt') {
        result.push(record);
      }
    }
    return result.sort((a, b) => a.activatedAt.localeCompare(b.activatedAt));
  }

  async listAllActivations(): Promise<ActivationStatusRecord[]> {
    const result: ActivationStatusRecord[] = [];
    for (const record of this.activations.values()) {
      result.push(record);
    }
    return result.sort((a, b) => a.activatedAt.localeCompare(b.activatedAt));
  }

  async deactivateActivation(activationId: string, deactivatedAt: string): Promise<boolean> {
    for (const [key, record] of this.activations.entries()) {
      if (record.activationId === activationId && record.deactivatedAt === null) {
        this.activations.set(key, { ...record, deactivatedAt });
        return true;
      }
    }
    return false;
  }
}

export class MemoryArtifactReadModel implements ActivationArtifactReadModel {
  private readonly artifacts = new Map<string, PIArtifactSnapshot>();

  addArtifact(artifact: PIArtifactSnapshot): void {
    this.artifacts.set(artifact.artifactId, artifact);
  }

  async getArtifactById(artifactId: string): Promise<PIArtifactSnapshot | null> {
    return this.artifacts.get(artifactId) ?? null;
  }
}
