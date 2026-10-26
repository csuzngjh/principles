import { randomUUID } from 'node:crypto';
import { SqliteDiagnosticianCommitter, PrincipleTreeLedgerAdapter, type RuntimeStateManager } from '@principles/core/runtime-v2';

/** Isolated test fixture: a real diagnosis commit with an explicit persisted recommendation kind. */
export async function seedCandidateMaterial(sm: RuntimeStateManager, candidateId: string, workspaceDir?: string, principleId: string = randomUUID(), recommendationKind: 'principle' | 'rule' = 'principle'): Promise<string> {
  const taskId = `diagnosis-${candidateId}`;
  const now = new Date().toISOString();
  await sm.createTask({ taskId, taskKind: 'diagnostician', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: JSON.stringify({ sourcePainId: `pain-${candidateId}` }) });
  await sm.acquireLease({ taskId, owner: 'isolated-test-fixture', runtimeKind: 'test-double' });
  const [run] = await sm.getRunsByTask(taskId);
  if (!run) throw new Error('Fixture diagnosis run missing');
  await new SqliteDiagnosticianCommitter(sm.connection).commit({ taskId, runId: run.runId, idempotencyKey: `fixture-${candidateId}`, output: {
    valid: true, diagnosisId: `diag-${candidateId}`, summary: 'Test fixture diagnosis', rootCause: 'Test fixture behavior', violatedPrinciples: [],
    evidence: [{ sourceRef: 'test-fixture://trace', note: 'Isolated fixture, no Owner decision' }],
    recommendations: [{ kind: recommendationKind, description: 'Block unsafe system writes', triggerPattern: 'unsafe write', action: 'block' }], confidence: 0.9,
  } });
  const [candidate] = await sm.getCandidatesByTaskId(taskId);
  if (!candidate) throw new Error('Fixture candidate missing');
  // Deterministic fixture key only: the real committer owns all source material and kind.
  sm.connection.getDb().prepare('UPDATE principle_candidates SET candidate_id = ? WHERE candidate_id = ?').run(candidateId, candidate.candidateId);
  await sm.markTaskSucceeded(taskId);
  if (workspaceDir && recommendationKind !== 'principle') throw new Error('Rule fixture cannot create a Principle');
  if (workspaceDir) new PrincipleTreeLedgerAdapter({ stateDir: `${workspaceDir}/.state` }).writeProbationEntry({
    id: principleId, title: 'Test fixture principle', status: 'probation', sourceRef: `candidate://${candidateId}`,
    artifactRef: candidate.artifactId, taskRef: taskId, text: 'Block unsafe system writes', triggerPattern: 'unsafe write', action: 'block', evaluability: 'weak_heuristic', createdAt: now,
  });
  return principleId;
}

/** System-written Scribe evidence fixture; no model supplies identity. */
export async function seedScribeIdentityLineage(sm: RuntimeStateManager, workspaceDir: string, candidateId: string, principleId: string, scribeTaskId: string, scribeArtifactId: string, scribeContent: Record<string, unknown> = {}): Promise<void> {
  await seedCandidateMaterial(sm, candidateId, workspaceDir, principleId);
  const dreamerTaskId = `dreamer-${candidateId}-prompt`;
  const dreamerArtifactId = `pi-art-dreamer-${candidateId}`;
  const now = new Date().toISOString();
  await sm.createTask({ taskId: dreamerTaskId, taskKind: 'dreamer', status: 'succeeded', attemptCount: 0, maxAttempts: 3, diagnosticJson: JSON.stringify({ candidateId }) });
  await sm.piArtifactStore.upsertArtifact({ artifactId: dreamerArtifactId, artifactKind: 'principle', sourceTaskId: dreamerTaskId,
    lineageArtifactIds: [], validationStatus: 'validated', contentJson: '{}', createdAt: now, updatedAt: now });
  await sm.piArtifactStore.upsertArtifact({ artifactId: scribeArtifactId, artifactKind: 'principle', sourceTaskId: scribeTaskId, sourcePrincipleId: principleId,
    lineageArtifactIds: [dreamerArtifactId], validationStatus: 'validated', contentJson: JSON.stringify({ ...scribeContent,
      sourceTrace: { dreamerArtifactId }, identityResolution: { candidateId, basis: 'derived_candidate', principleId },
    }), createdAt: now, updatedAt: now });
}
