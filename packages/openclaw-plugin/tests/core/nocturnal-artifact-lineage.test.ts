import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendCandidateArtifactLineageRecord,
  listArtifactLineageRecords,
} from '../../src/core/nocturnal-artifact-lineage.js';
import { safeRmDir } from '../test-utils.js';

describe('nocturnal-artifact-lineage', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-lineage-'));
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('appends a candidate lineage record with explicit pain and gate refs', () => {
    appendCandidateArtifactLineageRecord(workspaceDir, {
      artifactId: 'artifact-1',
      principleId: 'P-001',
      ruleId: 'R-001',
      sessionId: 'session-1',
      sourceSnapshotRef: 'snapshot-1',
      sourcePainIds: ['pain:gate:1', 'pain:tool:2'],
      sourceGateBlockIds: ['gate:write:1'],
      storagePath: path.join(workspaceDir, '.state', 'principles', 'implementations', 'IMPL-1'),
      implementationId: 'IMPL-1',
      createdAt: '2026-04-08T00:00:00.000Z',
    });

    const records = listArtifactLineageRecords(
      workspaceDir,
      'rule-implementation-candidate'
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      artifactKind: 'rule-implementation-candidate',
      artifactId: 'artifact-1',
      principleId: 'P-001',
      ruleId: 'R-001',
      sourceSnapshotRef: 'snapshot-1',
      sourcePainIds: ['pain:gate:1', 'pain:tool:2'],
      sourceGateBlockIds: ['gate:write:1'],
      implementationId: 'IMPL-1',
    });
  });
});
