import * as fs from 'fs';
import * as path from 'path';
import { resolveNocturnalDir } from './nocturnal-paths.js';
import { withLock } from '../utils/file-lock.js';

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

function getLineageRegistryPath(workspaceDir: string): string {
  return path.join(resolveNocturnalDir(workspaceDir, 'ROOT'), 'artifact-lineage.json');
}

function readArtifactLineageRegistry(workspaceDir: string): ArtifactLineageRecord[] {
  const registryPath = getLineageRegistryPath(workspaceDir);
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as ArtifactLineageRecord[];
  } catch {
    return [];
  }
}

function writeArtifactLineageRegistry(
  workspaceDir: string,
  records: ArtifactLineageRecord[]
): void {
  const registryPath = getLineageRegistryPath(workspaceDir);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

export function appendArtifactLineageRecord(
  workspaceDir: string,
  record: ArtifactLineageRecord
): ArtifactLineageRecord {
  const registryPath = getLineageRegistryPath(workspaceDir);

  return withLock(registryPath, () => {
    const records = readArtifactLineageRegistry(workspaceDir);
    const nextRecord: ArtifactLineageRecord = {
      ...record,
      sourcePainIds: [...record.sourcePainIds],
      sourceGateBlockIds: [...record.sourceGateBlockIds],
      storagePath: path.normalize(record.storagePath),
    };
    records.push(nextRecord);
    writeArtifactLineageRegistry(workspaceDir, records);
    return nextRecord;
  });
}

export function listArtifactLineageRecords(
  workspaceDir: string,
  artifactKind?: ArtifactKind
): ArtifactLineageRecord[] {
  const records = readArtifactLineageRegistry(workspaceDir);
  const filtered =
    artifactKind === undefined
      ? records
      : records.filter((record) => record.artifactKind === artifactKind);

  return filtered.sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
}
