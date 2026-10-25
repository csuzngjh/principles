import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeStateHandle,
  PrincipleTreeLedgerAdapter,
  SqliteApprovalQueueStore,
  SqliteDiagnosticianCommitter,
  type RuntimeStateHandle,
  type RuleCandidateMaterial,
  type DiagnosticianOutputV1,
} from '@principles/core/runtime-v2';
import { addPrincipleToLedger, appendReuseEvidence, loadLedger } from '@principles/core/principle-tree-ledger';
import { OwnerDecisionConsoleModel } from '../../src/server/models/OwnerDecisionConsoleModel.js';
import { ApprovalsGroupedConsoleModel } from '../../src/server/models/ApprovalsGroupedConsoleModel.js';
import { RuleCandidateBindingConsoleModel } from '../../src/server/models/RuleCandidateBindingConsoleModel.js';
import { createArtifactPrincipleResolutionDeps } from '../../src/server/models/artifact-principle-resolver.js';
import { resolveLedgerPrincipleId } from '../../src/server/models/principle-id-resolution.js';

const NOW = '2026-10-25T00:00:00.000Z';
const PRINCIPLE_ID = '11111111-2222-4222-8222-222222222222';
const RULE_TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const diagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'identity-consumer-diagnosis',
  summary: 'The write accepted an out-of-scope destination.',
  rootCause: 'Design: the operation did not check its authorized scope.',
  violatedPrinciples: [],
  evidence: [],
  confidence: 0.9,
  recommendations: [
    { kind: 'principle', description: 'Keep every write within its authorized scope.' },
    { kind: 'rule', description: 'Reject writes that escape the authorized scope.' },
  ],
};

type Fixture = {
  workspaceDir: string;
  handle: RuntimeStateHandle;
  candidateId: string;
  principleCandidateId: string;
  artifactId: string;
  dreamerArtifactId: string;
  ledgerPrincipleCount: () => number;
};

async function createFixture(): Promise<Fixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-binding-identity-consumers-'));
  const handle = await createRuntimeStateHandle({ workspaceDir });
  await handle.stateManager.createTask({
    taskId: 'diagnosis-task', taskKind: 'diagnostician', status: 'succeeded',
    inputRef: 'owner-provided-evidence', attemptCount: 1, maxAttempts: 3,
  });
  await handle.stateManager.runStore.createRun({
    runId: 'diagnosis-run', taskId: 'diagnosis-task', runtimeKind: 'test-double',
    startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded',
    outputPayload: JSON.stringify(diagnosis),
  });
  await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({
    taskId: 'diagnosis-task', runId: 'diagnosis-run', output: diagnosis,
    idempotencyKey: 'identity-consumer-diagnosis-commit',
  });
  const candidates = await handle.stateManager.getCandidatesByTaskId('diagnosis-task');
  const principleCandidate = candidates.find((candidate) => candidate.rawRecommendationKind === 'principle');
  const ruleCandidate = candidates.find((candidate) => candidate.rawRecommendationKind === 'rule');
  if (!principleCandidate || !ruleCandidate) throw new Error('Real diagnostician commit did not create both candidates.');

  const stateDir = join(workspaceDir, '.state');
  addPrincipleToLedger(stateDir, {
    id: PRINCIPLE_ID, version: 1, text: 'Preserve approved write boundaries.',
    triggerPattern: 'write', action: 'check_scope', status: 'candidate', priority: 'P1',
    scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0,
    painPreventedCount: 0, derivedFromPainIds: [], ruleIds: [], conflictsWithPrincipleIds: [],
    createdAt: NOW, updatedAt: NOW,
  });
  appendReuseEvidence(stateDir, PRINCIPLE_ID, {
    painId: 'pain-identity-consumer', candidateId: principleCandidate.candidateId,
    decision: 'reuse', actor: { kind: 'owner', id: 'owner-test' },
    reason: 'This candidate expresses the existing approved principle.', decidedAt: NOW,
  });

  const dreamerTaskId = 'dreamer-task';
  const dreamerArtifactId = 'pi-art-dreamer-identity-consumer';
  await handle.stateManager.createTask({
    taskId: dreamerTaskId, taskKind: 'dreamer', status: 'succeeded',
    attemptCount: 1, maxAttempts: 3,
    diagnosticJson: JSON.stringify({ candidateId: principleCandidate.candidateId }),
  });
  await handle.stateManager.piArtifactStore.upsertArtifact({
    artifactId: dreamerArtifactId, artifactKind: 'principle', sourceTaskId: dreamerTaskId,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ candidates: [{ betterDecision: 'Keep the write scoped.' }] }),
    createdAt: NOW, updatedAt: NOW,
  });
  const artifactId = 'pi-art-scribe-identity-consumer';
  await handle.stateManager.piArtifactStore.upsertArtifact({
    artifactId, artifactKind: 'principle', sourceTaskId: 'scribe-task',
    lineageArtifactIds: [dreamerArtifactId], validationStatus: 'validated',
    contentJson: JSON.stringify({
      sourceTrace: { dreamerArtifactId },
      principleDraft: { title: 'Scoped writes', statement: 'Keep every write within its authorized scope.' },
    }),
    createdAt: NOW, updatedAt: NOW,
  });
  await new SqliteApprovalQueueStore(handle.stateManager.connection).enqueue({
    artifactId, channel: 'prompt', riskLevel: 'low', confidence: 0.9,
    summary: 'Pending prompt-channel review.',
  }, NOW);

  return {
    workspaceDir, handle, candidateId: principleCandidate.candidateId,
    principleCandidateId: principleCandidate.candidateId,
    artifactId, dreamerArtifactId,
    ledgerPrincipleCount: () => Object.keys(loadLedger(stateDir).tree.principles).length,
  };
}

async function readArtifact(handle: RuntimeStateHandle, artifactId: string) {
  const artifact = await handle.stateManager.piArtifactStore.getArtifactById(artifactId);
  if (!artifact) throw new Error(`Missing fixture artifact ${artifactId}.`);
  return artifact;
}

function groupFor(groups: Array<{ principleId: string; records: Array<{ artifactId: string }> }>, artifactId: string) {
  return groups.find((group) => group.records.some((record) => record.artifactId === artifactId));
}

describe('rule-binding identity consumers follow canonical Ledger identity', () => {
  let fixture: Fixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => {
    await fixture.handle.close();
    rmSync(fixture.workspaceDir, { recursive: true, force: true });
  });

  function dependencies() {
    return createArtifactPrincipleResolutionDeps(
      fixture.handle.stateManager.connection,
      fixture.handle.stateManager.piArtifactStore,
      fixture.workspaceDir,
    );
  }

  it('links a null-sourcePrincipleId Scribe approval to the Owner-reused canonical UUID through every consumer', async () => {
    const artifact = await readArtifact(fixture.handle, fixture.artifactId);
    expect(artifact.sourcePrincipleId ?? null).toBeNull();
    expect(fixture.ledgerPrincipleCount()).toBe(1);

    const deps = dependencies();
    expect(await resolveLedgerPrincipleId(artifact, deps)).toEqual({
      status: 'resolved', principleId: PRINCIPLE_ID, how: 'candidate_lineage',
    });
    const ownerItems = await new OwnerDecisionConsoleModel(fixture.workspaceDir).listOwnerDecisionItems();
    expect(ownerItems.items.find((item) => item.kind === 'activation_approval' && item.taskId === fixture.artifactId))
      .toMatchObject({ principleId: PRINCIPLE_ID, reasonCode: 'activation_approval_pending' });
    const grouped = await new ApprovalsGroupedConsoleModel(fixture.workspaceDir).getApprovalsGrouped();
    expect(groupFor(grouped.groups, fixture.artifactId)?.principleId).toBe(PRINCIPLE_ID);

    const approvalRows = fixture.handle.stateManager.connection.getDb()
      .prepare('SELECT status, channel FROM approvals WHERE artifact_id = ?').all(fixture.artifactId) as Array<{ status: string; channel: string }>;
    expect(approvalRows).toEqual([{ status: 'pending', channel: 'prompt' }]);
    expect(fixture.handle.stateManager.connection.getDb().prepare('SELECT COUNT(*) AS count FROM activations').get())
      .toMatchObject({ count: 0 });
    expect(fixture.ledgerPrincipleCount()).toBe(1);
  });

  it('refuses to link when derived and Owner-reuse evidence name different Principles', async () => {
    addPrincipleToLedger(join(fixture.workspaceDir, '.state'), {
      id: '22222222-3333-4333-8333-444444444444', version: 1,
      text: 'Conflicting derived authority.', triggerPattern: 'write', action: 'stop',
      status: 'candidate', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [fixture.candidateId], ruleIds: [], conflictsWithPrincipleIds: [],
      createdAt: NOW, updatedAt: NOW,
    });
    const principleCountBeforeRead = fixture.ledgerPrincipleCount();
    const artifact = await readArtifact(fixture.handle, fixture.artifactId);
    const resolution = await resolveLedgerPrincipleId(artifact, dependencies());
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'conflicting_authorities' });

    const ownerItems = await new OwnerDecisionConsoleModel(fixture.workspaceDir).listOwnerDecisionItems();
    expect(ownerItems.items.find((item) => item.kind === 'activation_approval' && item.taskId === fixture.artifactId))
      .not.toHaveProperty('principleId');
    const grouped = await new ApprovalsGroupedConsoleModel(fixture.workspaceDir).getApprovalsGrouped();
    expect(groupFor(grouped.groups, fixture.artifactId)?.principleId).toBe(`unlinked:${fixture.artifactId}`);
    expect(fixture.ledgerPrincipleCount()).toBe(principleCountBeforeRead);
  });

  it('keeps approval consumers visibly unlinked while the Ledger is unreadable', async () => {
    writeFileSync(join(fixture.workspaceDir, '.state', 'principle_training_state.json'), '{truncated', 'utf8');
    const artifact = await readArtifact(fixture.handle, fixture.artifactId);
    expect(await resolveLedgerPrincipleId(artifact, dependencies())).toMatchObject({
      status: 'unresolved', reason: 'ledger_unavailable',
    });
    const ownerItems = await new OwnerDecisionConsoleModel(fixture.workspaceDir).listOwnerDecisionItems();
    expect(ownerItems.items.find((item) => item.kind === 'activation_approval' && item.taskId === fixture.artifactId))
      .not.toHaveProperty('principleId');
    const grouped = await new ApprovalsGroupedConsoleModel(fixture.workspaceDir).getApprovalsGrouped();
    expect(groupFor(grouped.groups, fixture.artifactId)?.principleId).toBe(`unlinked:${fixture.artifactId}`);
  });

  it('does not relink an old rule-binding receipt after the Owner revokes its binding', async () => {
    addPrincipleToLedger(join(fixture.workspaceDir, '.state'), {
      id: RULE_TARGET_ID, version: 1, text: 'Existing governed rule target.',
      triggerPattern: 'write', action: 'check_scope', status: 'candidate', priority: 'P1',
      scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0,
      painPreventedCount: 0, derivedFromPainIds: [fixture.principleCandidateId],
      ruleIds: [], conflictsWithPrincipleIds: [], createdAt: NOW, updatedAt: NOW,
    });
    const adapter = new PrincipleTreeLedgerAdapter({
      stateDir: join(fixture.workspaceDir, '.state'),
      reviewSources: {
        loadCandidateMaterial: async (candidateId) => {
          const candidate = await fixture.handle.stateManager.getCandidate(candidateId);
          if (!candidate) return null;
          const task = await fixture.handle.stateManager.getTask(candidate.taskId);
          const run = await fixture.handle.stateManager.runStore.getRun(candidate.sourceRunId);
          const rawArtifact: unknown = fixture.handle.stateManager.connection.getDb()
            .prepare('SELECT artifact_id, run_id, task_id, artifact_kind, content_json, created_at FROM artifacts WHERE artifact_id = ?')
            .get(candidate.artifactId);
          const artifact = typeof rawArtifact === 'object' && rawArtifact !== null
            ? rawArtifact as { artifact_id: string; run_id: string; task_id: string; artifact_kind: string; content_json: string; created_at: string }
            : null;
          return task && run && artifact ? {
            candidate, task, run,
            artifact: {
              artifactId: artifact.artifact_id, runId: artifact.run_id,
              taskId: artifact.task_id, artifactKind: artifact.artifact_kind,
              contentJson: artifact.content_json, createdAt: artifact.created_at,
            },
          } : null;
        },
      },
    });
    const review = await adapter.createRuleCandidateBindingReview(
      (await fixture.handle.stateManager.getCandidatesByTaskId('diagnosis-task'))
        .find((candidate) => candidate.rawRecommendationKind === 'rule')?.candidateId ?? '',
    );
    if (!review.ok) throw new Error(`Could not establish the rule binding fixture: ${review.reason}`);
    const target = review.eligibleTargets.find((entry) => entry.principle.id === RULE_TARGET_ID);
    if (!target) throw new Error('The canonical target was not eligible for the real binding mutation.');
    const ruleCandidateId = review.candidateId;
    const binding = await adapter.mutateRuleCandidateBinding({
      candidateId: ruleCandidateId,
      owner: { actorId: 'owner-test', source: 'authenticated_console' },
      request: {
        action: 'bind', principleId: RULE_TARGET_ID, expectedRevision: 0,
        expectedCandidateDigest: review.reviewedCandidateDigest,
        expectedPrincipleDigest: target.reviewedPrincipleDigest,
        reason: 'Bind this rule to the reviewed existing principle.',
        requestId: 'bind-rule-receipt', resumeOnce: true,
      },
    });
    if (!binding.ok) throw new Error(`Could not create binding receipt: ${binding.reason}`);
    expect(binding.status).toBe('bound');
    const revoked = await adapter.mutateRuleCandidateBinding({
      candidateId: ruleCandidateId,
      owner: { actorId: 'owner-test', source: 'authenticated_console' },
      request: {
        action: 'revoke', expectedRevision: 1, reason: 'Withdraw the binding.',
        requestId: 'revoke-rule-receipt', resumeOnce: false,
      },
    });
    if (!revoked.ok) throw new Error(`Could not revoke binding fixture: ${revoked.reason}`);
    expect(revoked.status).toBe('revoked');

    const dreamerTaskId = `dreamer-${ruleCandidateId}-code_tool_hook`;
    const dreamerArtifactId = 'pi-art-dreamer-revoked-rule';
    await fixture.handle.stateManager.createTask({
      taskId: dreamerTaskId, taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ candidateId: ruleCandidateId }),
    });
    await fixture.handle.stateManager.piArtifactStore.upsertArtifact({
      artifactId: dreamerArtifactId, artifactKind: 'principle', sourceTaskId: dreamerTaskId,
      lineageArtifactIds: [], validationStatus: 'validated', contentJson: '{}', createdAt: NOW, updatedAt: NOW,
    });
    const oldArtifactId = 'pi-art-scribe-revoked-rule';
    const oldReceiptArtifact = await fixture.handle.stateManager.piArtifactStore.upsertArtifact({
      artifactId: oldArtifactId, artifactKind: 'principle', sourceTaskId: 'scribe-revoked-rule',
      lineageArtifactIds: [dreamerArtifactId], validationStatus: 'validated',
      contentJson: JSON.stringify({
        sourceTrace: { dreamerArtifactId },
        identityResolution: {
          candidateId: ruleCandidateId, basis: 'owner_rule_binding', principleId: RULE_TARGET_ID,
          bindingRevision: binding.binding.revision, decisionId: binding.binding.decisionId,
        },
        principleDraft: { title: 'Old linked artifact', statement: 'Its binding has since been revoked.' },
      }),
      createdAt: NOW, updatedAt: NOW,
    });
    await new SqliteApprovalQueueStore(fixture.handle.stateManager.connection).enqueue({
      artifactId: oldArtifactId, channel: 'code_tool_hook', riskLevel: 'high', confidence: 0.9,
    }, NOW);

    const principleCountBeforeRead = fixture.ledgerPrincipleCount();
    expect(await resolveLedgerPrincipleId(oldReceiptArtifact, dependencies())).toMatchObject({
      status: 'unresolved', reason: 'binding_revoked',
    });
    const ownerItems = await new OwnerDecisionConsoleModel(fixture.workspaceDir).listOwnerDecisionItems();
    expect(ownerItems.items.find((item) => item.kind === 'activation_approval' && item.taskId === oldArtifactId))
      .not.toHaveProperty('principleId');
    const grouped = await new ApprovalsGroupedConsoleModel(fixture.workspaceDir).getApprovalsGrouped();
    expect(groupFor(grouped.groups, oldArtifactId)?.principleId).toBe(`unlinked:${oldArtifactId}`);
    expect(fixture.ledgerPrincipleCount()).toBe(principleCountBeforeRead);
    expect(fixture.handle.stateManager.connection.getDb().prepare('SELECT COUNT(*) AS count FROM activations').get())
      .toMatchObject({ count: 0 });
  });

  it('surfaces rule candidates from split diag_router provenance in the binding queue', async () => {
    const directRule = (await fixture.handle.stateManager.getCandidatesByTaskId('diagnosis-task'))
      .find((candidate) => candidate.rawRecommendationKind === 'rule');
    if (!directRule) throw new Error('Fixture rule candidate missing.');
    // Split provenance: the router sub-task commits its own run/artifact and is
    // parented (inputRef) by the succeeded diagnostician above.
    const db = fixture.handle.stateManager.connection.getDb();
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, diagnostic_json, input_ref)
      VALUES ('router-task', 'diag_router', 'succeeded', ?, ?, 1, '{}', 'diagnosis-task')`).run(NOW, NOW);
    db.prepare(`INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, attempt_number, output_payload, created_at, updated_at)
      VALUES ('router-run', 'router-task', 'test-double', 'succeeded', ?, ?, 1, ?, ?, ?)`).run(NOW, NOW, JSON.stringify(diagnosis), NOW, NOW);
    db.prepare(`INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES ('router-artifact', 'router-run', 'router-task', 'diagnostician_output', ?, ?)`).run(JSON.stringify(diagnosis), NOW);
    // getCandidatesByTaskId joins commits — the router's own commit row.
    db.prepare(`INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at)
      VALUES ('commit-router-rule', 'router-task', 'router-run', 'router-artifact', 'idem-commit-router', 'committed', ?)`).run(NOW);
    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description,
        confidence, source_recommendation_json, idempotency_key, status, created_at, consumed_at, recommendation_kind, abstracted_principle)
      VALUES ('router-rule-candidate', 'router-artifact', 'router-task', 'router-run', 'Split rule', 'Reject out-of-scope writes from the routed diagnosis.',
        0.9, ?, 'idem-router-rule', 'consumed', ?, ?, 'rule', NULL)`)
      .run(JSON.stringify({ kind: 'rule', description: 'Reject out-of-scope writes from the routed diagnosis.' }), NOW, NOW);

    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const ids = queue.items.map((item) => item.candidateId);
    expect(ids).toContain(directRule.candidateId);
    expect(ids).toContain('router-rule-candidate');
    expect(queue.items.find((item) => item.candidateId === 'router-rule-candidate')).toMatchObject({ reason: 'missing' });
  });
});
