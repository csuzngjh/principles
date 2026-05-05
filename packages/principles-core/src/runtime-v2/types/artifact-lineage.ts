/**
 * Artifact lineage types — pure data interfaces for artifact tracking.
 * Extracted from openclaw-plugin nocturnal-artifact-lineage.ts (PRI-51).
 */

export type ArtifactKind = 'behavioral-sample' | 'rule-implementation-candidate';

export interface ArtifactLineageRecord {
  artifactKind: ArtifactKind;
  artifactId: string;
  principleId: string;
  ruleId: string | null;
  sessionId: string;
  sourceSnapshotRef: string;
  sourcePainIds: string[];
  sourceGateBlockIds: string[];
  storagePath: string;
  implementationId: string | null;
  createdAt: string;
}
