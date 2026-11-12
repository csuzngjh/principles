import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleActivationsRoute, disposeActivationsModels } from '../../../src/server/routes/activations.js';
import { ActivationsConsoleModel } from '../../../src/server/models/ActivationsConsoleModel.js';
import type { OwnerPromotionActor } from '@principles/core/runtime';
import { createRuntimeStateHandle, SqliteDiagnosticianCommitter, PrincipleTreeLedgerAdapter, SqliteApprovalQueueStore, SqliteActivationStateStore, createPITaskDiagnosticJson, hydratePITaskRecord } from '@principles/core/runtime';
import { addPrincipleToLedger } from '@principles/core/principle-tree-ledger';
import { validateApprovedRuleRevisionPreview } from '../../../src/shared/approved-rule-revision-contract.js';

const actor: OwnerPromotionActor = { principal: { kind: 'configured_owner', ownerId: 'real-owner' }, authentication: { method: 'console_token', credentialId: 'real-credential' } };
const input = { expectedArtifactId: 'approved-artifact', expectedArtifactDigest: 'sha256:' + 'a'.repeat(64), expectedBindingRevision: 2,
  expectedControlVersion: 1, expectedTaskRevisionEpoch: 3, requestId: 'request-1', feedback: 'Keep official recovery operations reachable.' };
const preview = { status: 'ready' as const, activationId: 'activation-1', candidateId: 'candidate-1', principleId: 'principle-1', artificerTaskId: 'artificer-1', ...input };

/** Real production stores and Ledger binding; no mocked identity/lock/SQL. */
async function seedApprovedRule(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir });
  try {
  const manager = handle.stateManager;
  const now = '2026-11-01T00:00:00.000Z';
  const principleId = '11111111-1111-4111-8111-111111111111';
  await manager.createTask({ taskId: 'diagnosis', taskKind: 'diagnostician', inputRef: 'owner-original-pain', status: 'succeeded', attemptCount: 1, maxAttempts: 3 });
  const output = { schemaVersion: 'diagnostician-output-v2' as const, valid: true, diagnosisId: 'diagnosis', summary: 'Owner required approval.', rootCause: 'Skipped design.', violatedPrinciples: [], evidence: [], confidence: 0.9, recommendations: [
    { kind: 'rule' as const, recommendationRef: 'rule-1', description: 'Require approval before governed changes.', triggerPattern: 'governed change', action: 'require approval',
      // No evidence entries in this fixture output → no linkable evidenceRefs.
      principleAssociation: { status: 'unresolved' as const, reason: 'no_supported_target' as const } },
    { kind: 'principle' as const, recommendationRef: 'principle-1', description: 'Respect approved change boundaries.', abstractedPrinciple: 'Respect approved change boundaries.' },
  ] };
  await manager.runStore.createRun({ runId: 'diagnosis-run', taskId: 'diagnosis', runtimeKind: 'test-double', startedAt: now, attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(output) });
  await new SqliteDiagnosticianCommitter(manager.connection).commit({ taskId: 'diagnosis', runId: 'diagnosis-run', output, idempotencyKey: 'fixture' });
  const candidates = await manager.getCandidatesByTaskId('diagnosis');
  const candidate = candidates.find(row => row.rawRecommendationKind === 'rule');
  const principleCandidate = candidates.find(row => row.rawRecommendationKind === 'principle');
  if (!candidate || !principleCandidate) throw new Error('Missing fixture candidate');
  addPrincipleToLedger(path.join(workspaceDir, '.state'), { id: principleId, version: 1, text: 'Respect approved change boundaries.', triggerPattern: 'write', action: 'check_scope', status: 'candidate', priority: 'P1', scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [principleCandidate.candidateId], ruleIds: [], conflictsWithPrincipleIds: [], createdAt: now, updatedAt: now });
  const ledger = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state'), reviewSources: {
    loadCandidateMaterial: async id => {
      const material = await manager.getCandidate(id);
      if (!material) return null;
      const [task, run, artifact] = await Promise.all([manager.getTask(material.taskId), manager.getRun(material.sourceRunId), manager.getArtifact(material.artifactId)]);
      return { candidate: material, task, run, artifact };
    },
  } });
  const review = await ledger.createRuleCandidateBindingReview(candidate.candidateId);
  if (!review.ok) throw new Error(review.reason);
  const target = review.eligibleTargets.find(entry => entry.principle.id === principleId);
  if (!target) throw new Error('Missing principle target');
  const binding = await ledger.mutateRuleCandidateBinding({ candidateId: candidate.candidateId, owner: { actorId: 'real-owner', source: 'authenticated_console' }, request: {
    action: 'bind', principleId, expectedRevision: 0, expectedCandidateDigest: review.reviewedCandidateDigest, expectedPrincipleDigest: target.reviewedPrincipleDigest, reason: 'Reviewed original principle.', requestId: 'bind-fixture', resumeOnce: true,
  } });
  if (!binding.ok) throw new Error(binding.reason);
  await manager.createTask({ taskId: 'dreamer', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: JSON.stringify({ candidateId: candidate.candidateId }) });
  for (const [kind, dependency] of [['philosopher', 'dreamer'], ['scribe', 'philosopher'], ['artificer', 'scribe'], ['evaluator', 'artificer'], ['rollout_reviewer', 'evaluator']] as const) {
    await manager.createTask({ taskId: kind, taskKind: kind, status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ channel: 'code_tool_hook', dependencyTaskIds: [dependency], inputArtifactRefs: [], outputArtifactRefs: [], timeoutMs: 1234, correlationId: candidate.candidateId }) });
  }
  await manager.piArtifactStore.createArtifact({ artifactId: 'approved-artifact', artifactKind: 'rule', sourceTaskId: 'evaluator', sourcePrincipleId: principleId, lineageArtifactIds: [], validationStatus: 'validated', createdAt: now, updatedAt: now, contentJson: JSON.stringify({ identityResolution: { candidateId: candidate.candidateId, principleId, basis: 'owner_rule_binding', bindingRevision: binding.binding.revision, decisionId: binding.binding.decisionId }, implementationCode: 'old-noncompliant-code' }) });
  const approvals = new SqliteApprovalQueueStore(manager.connection);
  const queued = await approvals.enqueue({ artifactId: 'approved-artifact', channel: 'code_tool_hook', riskLevel: 'high' }, now);
  if (!(await approvals.approve(queued.approvalId, 'real-owner')).ok) throw new Error('Fixture approval failed');
  await new SqliteActivationStateStore(manager.connection).recordActivation({ activationId: 'activation-1', artifactId: 'approved-artifact', idempotencyKey: 'fixture-shadow', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'impl://old', activatedAt: now, deactivatedAt: null });
  return handle;
  } catch (error) { await handle.close(); throw error; }
}

describe('approved shadow RuleCode revision official Console entry', () => {
  let server: Server;
  let workspace: string;
  let url: string;
  let owner: OwnerPromotionActor | null;
  beforeEach(async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'pd-approved-revision-route-'));
    owner = actor;
    server = createServer((req, res) => { void handleActivationsRoute(req, res, workspace, new URL(req.url ?? '/', 'http://localhost').pathname, { ownerActor: owner, breakGlassActor: actor }); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local HTTP address');
    url = `http://127.0.0.1:${address.port}/activation-1`;
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    disposeActivationsModels(); vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true });
  });
  it('preview is a read-only route, not a revision mutation', async () => {
    const read = vi.spyOn(ActivationsConsoleModel.prototype, 'previewApprovedRuleRevision').mockResolvedValue(preview);
    const write = vi.spyOn(ActivationsConsoleModel.prototype, 'reviseApprovedRuleOnce');
    const response = await fetch(`${url}/rule-revision-preview`);
    expect(response.status).toBe(200); expect(read).toHaveBeenCalledWith('activation-1');
    expect(write).not.toHaveBeenCalled(); expect(readdirSync(workspace)).toEqual([]);
  });
  it('uninitialized workspace preview cannot bootstrap state or claim eligibility', async () => {
    const response = await fetch(`${url}/rule-revision-preview`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: 'rule_revision_unavailable' });
    expect(readdirSync(workspace)).toEqual([]);
  });
  it('passes exact reviewed CAS fields and server Owner, never client actor/principle', async () => {
    const write = vi.spyOn(ActivationsConsoleModel.prototype, 'reviseApprovedRuleOnce').mockResolvedValue({ status: 'started', artificerTaskId: 'artificer-1', causeId: 'cause-1', taskRevisionEpoch: 4 });
    const response = await fetch(`${url}/revise-rule-once`, { method: 'POST', body: JSON.stringify({ ...input, actor: 'spoof', candidateId: 'other-candidate', principleId: 'other-principle' }) });
    expect(response.status).toBe(200); expect(write).toHaveBeenCalledExactlyOnceWith('activation-1', input, actor);
  });
  it('break-glass authority cannot authorize a revision or its preview', async () => {
    owner = null;
    const write = vi.spyOn(ActivationsConsoleModel.prototype, 'reviseApprovedRuleOnce');
    for (const [suffix, method] of [['revise-rule-once', 'POST'], ['rule-revision-preview', 'GET']]) {
      expect((await fetch(`${url}/${suffix}`, { method, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) })).status).toBe(403);
    }
    expect(write).not.toHaveBeenCalled(); expect(readdirSync(workspace)).toEqual([]);
  });
  it.each([
    { expectedControlVersion: '1' }, { expectedBindingRevision: -1 }, { expectedTaskRevisionEpoch: 1.2 },
    { expectedArtifactDigest: ['sha256:' + 'a'.repeat(64)] }, { expectedArtifactId: '' }, { requestId: '' },
    { feedback: ' ' }, { feedback: 'x'.repeat(4001) },
  ])('invalid request fails before opening writable state: %j', async change => {
    const write = vi.spyOn(ActivationsConsoleModel.prototype, 'reviseApprovedRuleOnce');
    const response = await fetch(`${url}/revise-rule-once`, { method: 'POST', body: JSON.stringify({ ...input, ...change }) });
    expect(response.status).toBe(400); expect(write).not.toHaveBeenCalled(); expect(readdirSync(workspace)).toEqual([]);
  });
  it('domain refusal is surfaced without claiming generation or approval', async () => {
    vi.spyOn(ActivationsConsoleModel.prototype, 'reviseApprovedRuleOnce').mockResolvedValue({ status: 'refused', reason: 'stale_digest', nextAction: 'Refresh review.' });
    const response = await fetch(`${url}/revise-rule-once`, { method: 'POST', body: JSON.stringify(input) });
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'refused', reason: 'stale_digest', nextAction: 'Refresh review.' } });
  });
  it('real HTTP→model→Ledger lock→SQLite revises precisely once and preserves prior approval/activation', async () => {
    const handle = await seedApprovedRule(workspace);
    try {
      const approvals = new SqliteApprovalQueueStore(handle.stateManager.connection);
      const activations = new SqliteActivationStateStore(handle.stateManager.connection);
      const before = { approvals: await approvals.listAll(), activations: await activations.listAllActivations(), tasks: await handle.stateManager.listTasks() };
      const raw: unknown = await (await fetch(`${url}/rule-revision-preview`)).json();
      const data: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'data') : null;
      const ready = validateApprovedRuleRevisionPreview(data);
      if (ready?.status !== 'ready') throw new Error(JSON.stringify(raw));
      expect(await handle.stateManager.listTasks()).toEqual(before.tasks);
      const body = { ...ready, requestId: 'official-repair', feedback: input.feedback };
      const stale = await fetch(`${url}/revise-rule-once`, { method: 'POST', body: JSON.stringify({ ...body, expectedControlVersion: ready.expectedControlVersion + 1 }) });
      expect(await stale.json()).toMatchObject({ success: true, data: { status: 'refused', reason: 'revision_snapshot_stale' } });
      expect(await handle.stateManager.listTasks()).toEqual(before.tasks);
      const post = () => fetch(`${url}/revise-rule-once`, { method: 'POST', body: JSON.stringify(body) });
      expect(await (await post()).json()).toMatchObject({ success: true, data: { status: 'started', artificerTaskId: 'artificer', taskRevisionEpoch: 1 } });
      expect(await (await post()).json()).toMatchObject({ success: true, data: { status: 'already_started', artificerTaskId: 'artificer', taskRevisionEpoch: 1 } });
      const artificer = await handle.stateManager.getTask('artificer');
      const pi = artificer ? hydratePITaskRecord(artificer) : null;
      expect(artificer?.status).toBe('pending');
      expect(pi?.approvedRuleRevisions).toMatchObject([{ ownerId: 'real-owner', credentialId: 'real-credential', feedback: input.feedback }]);
      expect((await handle.stateManager.listTasks()).filter(task => task.taskId !== 'artificer')).toEqual(before.tasks.filter(task => task.taskId !== 'artificer'));
      expect(await approvals.listAll()).toEqual(before.approvals); expect(await activations.listAllActivations()).toEqual(before.activations);
    } finally { await handle.close(); }
  });
});
