import type { PIArtifactKind, PIArtifactValidationStatus } from './peer-runner-contracts.js';

export type { PIArtifactKind, PIArtifactValidationStatus };

export interface PIArtifactRecord {
  artifactId: string;
  artifactKind: PIArtifactKind;
  sourceTaskId: string;
  sourcePrincipleId?: string;
  sourceRuleId?: string;
  lineageArtifactIds: string[];
  validationStatus: PIArtifactValidationStatus;
  contentJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface PIArtifactStore {
  createArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord>;
  upsertArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord>;
  getArtifactById(artifactId: string): Promise<PIArtifactRecord | null>;
  listBySourceTaskId(sourceTaskId: string): Promise<PIArtifactRecord[]>;
  listLineage(artifactId: string): Promise<PIArtifactRecord[]>;
  updateValidationStatus(artifactId: string, validationStatus: PIArtifactValidationStatus): Promise<boolean>;
}
