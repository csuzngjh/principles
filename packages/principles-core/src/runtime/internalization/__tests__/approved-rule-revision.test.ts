import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { SqliteDiagnosticianCommitter } from '../../store/commit/diagnostician-committer.js';
import { SqliteActivationStateStore } from '../../activation/sqlite-activation-state-store.js';
import { SqliteApprovalQueueStore } from '../../activation/sqlite-approval-store.js';
import { previewApprovedRuleRevision, reviseApprovedRuleOnce, type ReviseApprovedRuleOnceArgs, type ApprovedRuleRevisionLedger } from '../approved-rule-revision.js';
import { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata, parsePITaskMetadata } from '../pitask-metadata.js';
import type { CandidatePrincipleIdentityResolution } from '../../types/rule-candidate-binding.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { PrincipleTreeLedgerAdapter } from '../../adapter/principle-tree-ledger-adapter.js';
import { getLedgerFilePathPublic, loadLedger, saveLedger, withLock } from '../../../principle-tree-ledger.js';

const NOW = '2026-11-01T00:00:00.000Z';
const PRINCIPLE = '11111111-1111-4111-8111-111111111111';

describe('approved shadow revision uses one immutable-artifact budget (real SQLite)', () => {
  let handle: RuntimeStateHandle;
  let workspaceDir: string;
  let candidateId: string;
  let ids: Record<'scribe' | 'artificer' | 'evaluator' | 'rollout_reviewer', string>;
  let ledger: ApprovedRuleRevisionLedger;
  let identity: CandidatePrincipleIdentityResolution;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pd-approved-rule-revision-'));
    handle = await createRuntimeStateHandle({ workspaceDir });
    const manager = handle.stateManager;
    await manager.createTask({ taskId: 'diagnosis', taskKind: 'diagnostician', status: 'succeeded', attemptCount: 1, maxAttempts: 3 });
    const output = { schemaVersion: 'diagnostician-output-v2' as const, valid: true, diagnosisId: 'diagnosis', summary: 'Owner required approval.', rootCause: 'Skipped approved design.',
      violatedPrinciples: [], evidence: [{ sourceRef: 'owner://original', note: 'Original Owner material' }], confidence: 0.9,
      recommendations: [{ kind: 'rule' as const, description: 'Require approval before governed changes.', recommendationRef: 'rule-1',
        triggerPattern: 'governed change', action: 'Require approval before proceeding.',
        principleAssociation: { status: 'unresolved' as const, reason: 'insufficient_evidence' as const } }] };
    await manager.runStore.createRun({ runId: 'diagnosis-run', taskId: 'diagnosis', runtimeKind: 'test-double', startedAt: NOW,
      attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(output) });
    await new SqliteDiagnosticianCommitter(manager.connection).commit({ taskId: 'diagnosis', runId: 'diagnosis-run', output, idempotencyKey: 'commit' });
    const [candidate] = await manager.getCandidatesByTaskId('diagnosis');
    if (!candidate) throw new Error('fixture candidate missing');
    ({ candidateId } = candidate);
    ids = { scribe: `scribe-${candidateId}-code_tool_hook`, artificer: `artificer-${candidateId}-code_tool_hook`,
      evaluator: `evaluator-${candidateId}-code_tool_hook`, rollout_reviewer: `rollout_reviewer-${candidateId}-code_tool_hook` };
    const base = (deps: string[]) => ({ dependencyTaskIds: deps, channel: 'code_tool_hook' as const, timeoutMs: 1234,
      inputArtifactRefs: [], outputArtifactRefs: [], correlationId: candidateId });
    await manager.createTask({ taskId: 'dreamer', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ ...JSON.parse(createPITaskDiagnosticJson(base([]))), candidateId }) });
    await manager.createTask({ taskId: 'philosopher', taskKind: 'philosopher', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson(base(['dreamer'])) });
    for (const [kind, deps] of [
      ['scribe', ['philosopher']], ['artificer', [ids.scribe]], ['evaluator', [ids.artificer]], ['rollout_reviewer', [ids.evaluator]],
    ] as const) {
      await manager.createTask({ taskId: ids[kind], taskKind: kind, status: 'succeeded', attemptCount: 2, maxAttempts: 3,
        resultRef: `${kind}://old-run`, diagnosticJson: createPITaskDiagnosticJson({ ...base([...deps]), revisionCount: 4,
          sourceCorrectionCauseId: 'rule-source-correction:old:1', revisionCauseId: 'old-revision' }) });
    }
    identity = { status: 'resolved', candidateId, principleId: PRINCIPLE, basis: 'owner_rule_binding', bindingRevision: 1,
      decisionId: 'binding-decision', checkedAt: NOW };
    ledger = { resolveForCandidate: async () => identity, withLockedRuleCandidateIdentity: (_id, callback) => callback(identity) };
    await manager.piArtifactStore.createArtifact({ artifactId: 'approved-old', artifactKind: 'rule', sourceTaskId: ids.evaluator,
      sourcePrincipleId: PRINCIPLE, lineageArtifactIds: [], validationStatus: 'validated', createdAt: NOW, updatedAt: NOW,
      // Sized like a real approved artifact: the regenerable trace material
      // dominates (~130k in production) and must not gate or flood the revision.
      contentJson: JSON.stringify({ identityResolution: { candidateId, principleId: PRINCIPLE, basis: 'owner_rule_binding', bindingRevision: 1,
        decisionId: 'binding-decision' }, implementationCode: 'old-noncompliant-code',
        intentContract: { ownerIntent: 'Require approval before governed changes.' },
        goldenTrace: `// GENERATED-TRACE-MARKER\n${'x'.repeat(110_000)}` }) });
    const approvals = new SqliteApprovalQueueStore(manager.connection);
    const approval = await approvals.enqueue({ artifactId: 'approved-old', channel: 'code_tool_hook', riskLevel: 'high' }, NOW);
    expect((await approvals.approve(approval.approvalId, 'owner')).ok).toBe(true);
    await new SqliteActivationStateStore(manager.connection).recordActivation({ activationId: 'shadow', artifactId: 'approved-old',
      idempotencyKey: 'approved-old::code_tool_hook', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', targetRef: 'impl://old',
      activatedAt: NOW, deactivatedAt: null });
  });
  afterEach(async () => { vi.restoreAllMocks(); await handle.close(); rmSync(workspaceDir, { recursive: true, force: true }); });

  async function request(): Promise<ReviseApprovedRuleOnceArgs> {
    const preview = await previewApprovedRuleRevision({ stateManager: handle.stateManager, ledger, activationId: 'shadow' });
    if (preview.status !== 'ready') throw new Error(preview.reason);
    return { ...preview, stateManager: handle.stateManager, ledger, requestId: 'request', feedback: 'Recovery status was blocked under empty history and authoritative not_approved.',
      actor: { principal: { kind: 'configured_owner', ownerId: 'owner' }, authentication: { method: 'console_token', credentialId: 'credential' } } };
  }
  async function snapshot() {
    return { tasks: await handle.stateManager.listTasks(), artifacts: await handle.stateManager.piArtifactStore.listBySourceTaskId(ids.evaluator),
      approvals: await new SqliteApprovalQueueStore(handle.stateManager.connection).listAll(),
      activations: await new SqliteActivationStateStore(handle.stateManager.connection).listAllActivations() };
  }
  async function meta() {
    const task = await handle.stateManager.getTask(ids.artificer);
    if (!task) throw new Error('task missing');
    const pi = hydratePITaskRecord(task);
    if (!pi) throw new Error('metadata invalid');
    return pi;
  }

  /** A second approved shadow activation whose rule contract alone is unreasonably large. */
  async function activateOversizedArtifact() {
    const manager = handle.stateManager;
    // The revision-wave artifact path, so the row lands at the evaluator's
    // current epoch instead of colliding with the original artifact.
    await manager.piArtifactStore.upsertArtifact({ artifactId: 'approved-huge', artifactKind: 'rule', sourceTaskId: ids.evaluator,
      sourcePrincipleId: PRINCIPLE, lineageArtifactIds: [], validationStatus: 'validated', createdAt: NOW, updatedAt: NOW,
      contentJson: JSON.stringify({ identityResolution: { candidateId, principleId: PRINCIPLE, basis: 'owner_rule_binding', bindingRevision: 1,
        decisionId: 'binding-decision' }, implementationCode: 'y'.repeat(60_000) }) });
    const approvals = new SqliteApprovalQueueStore(manager.connection);
    const queued = await approvals.enqueue({ artifactId: 'approved-huge', channel: 'code_tool_hook', riskLevel: 'high' }, NOW);
    expect((await approvals.approve(queued.approvalId, 'owner')).ok).toBe(true);
    await new SqliteActivationStateStore(manager.connection).recordActivation({ activationId: 'shadow-huge', artifactId: 'approved-huge',
      idempotencyKey: 'approved-huge::code_tool_hook', channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate',
      targetRef: 'impl://huge', activatedAt: NOW, deactivatedAt: null });
  }

  it('refuses an oversized rule contract at preview, before the Owner writes feedback, with zero mutation', async () => {
    await activateOversizedArtifact();
    const before = await snapshot();
    expect(await previewApprovedRuleRevision({ stateManager: handle.stateManager, ledger, activationId: 'shadow-huge' }))
      .toMatchObject({ status: 'refused', reason: 'revision_source_exceeds_feedback_bound' });
    expect(await snapshot()).toEqual(before);
    expect((await meta()).approvedRuleRevisions).toBeUndefined();
  });

  it('a revision round supersedes the previous repair round instead of replaying its instructions', async () => {
    const task = await handle.stateManager.getTask(ids.artificer);
    const pi = task ? hydratePITaskRecord(task) : null;
    if (!pi) throw new Error('fixture artificer missing');
    // An approved artifact can come out of an evaluator repair round; its
    // payload would otherwise be rendered into the revision prompt and its
    // failed replay evidence re-resolved (the runner throws when that fails).
    await handle.stateManager.updateTask(ids.artificer, { diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
      adversarialFeedback: 'PRIOR ADVERSARIAL FAILURES: case-old-rejected — must not reach the revision prompt',
      repairPayload: { requiredChanges: ['previous repair instruction'], concerns: ['old concern'], previousScore: 0.4,
        repairIteration: 1, sourceArtificerArtifactId: 'old-artificer-artifact', sourceEvaluatorTaskId: ids.evaluator,
        diagnosticReplay: { ran: true, passed: false, failedCaseCount: 3 } } })) });
    expect(await reviseApprovedRuleOnce(await request())).toMatchObject({ status: 'started' });
    const after = await meta();
    // A rejected later adversarial round is stale work for this revision.
    expect(after.adversarialFeedback).toBeUndefined();
    const carried = after.repairPayload;
    if (!carried) throw new Error('repair payload dropped; the completion branch depends on it');
    expect(carried.requiredChanges.join(' ')).not.toContain('previous repair instruction');
    expect(carried.requiredChanges.join(' ')).toContain('owner_revision_feedback');
    expect(carried.concerns).toEqual([]);
    expect(carried.diagnosticReplay).toBeUndefined();
    // Structural identity survives: repair counting and stale-repair guards read it.
    expect(carried.repairIteration).toBe(1);
    expect(carried.sourceEvaluatorTaskId).toBe(ids.evaluator);
  });

  it('preview is read-only, and the consumed source correction does not prevent the separate approved-artifact revision', async () => {
    const before = await snapshot();
    const input = await request();
    expect(await snapshot()).toEqual(before);
    expect(await reviseApprovedRuleOnce(input)).toMatchObject({ status: 'started', taskRevisionEpoch: 5 });
    const after = await snapshot();
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.approvals).toEqual(before.approvals);
    expect(after.activations).toEqual(before.activations);
    expect(after.tasks.filter(task => task.taskId !== ids.artificer)).toEqual(before.tasks.filter(task => task.taskId !== ids.artificer));
    const pi = await meta();
    expect(pi.status).toBe('pending');
    expect(pi.attemptCount).toBe(0);
    expect(pi.maxAttempts).toBe(3);
    expect(pi.timeoutMs).toBe(1234);
    expect(pi.sourceCorrectionCauseId).toBe('rule-source-correction:old:1');
    const feedback = pi.revisionFeedback ?? '';
    expect(feedback).toContain('old-noncompliant-code');
    expect(feedback).toContain(input.feedback);
    // The previous rule's code contract travels; its generated trace does not.
    expect(feedback).toContain('Require approval before governed changes.');
    expect(feedback).not.toContain('GENERATED-TRACE-MARKER');
    expect(feedback.length).toBeLessThan(10_000);
    expect(pi.approvedRuleRevisions).toHaveLength(1);
  });

  it('two independent connections with different request IDs spend exactly one epoch and retain the same receipt after restart', async () => {
    const input = await request();
    const other = await createRuntimeStateHandle({ workspaceDir });
    try {
      const results = await Promise.all([reviseApprovedRuleOnce(input), reviseApprovedRuleOnce({ ...input, stateManager: other.stateManager, requestId: 'second' })]);
      expect(results.map(result => result.status).sort()).toEqual(['already_started', 'started']);
      expect((await meta()).revisionCount).toBe(5);
      expect(await reviseApprovedRuleOnce({ ...input, stateManager: other.stateManager, requestId: 'restart' })).toMatchObject({ status: 'already_started' });
      expect((await meta()).approvedRuleRevisions).toHaveLength(1);
    } finally { await other.close(); }
  });

  it.each(['digest', 'artifact', 'binding', 'control', 'epoch', 'feedback', 'actor'] as const)('refuses stale/invalid %s with zero mutation', async field => {    const input = await request();
    const before = await snapshot();
    const overrides = field === 'digest' ? { expectedArtifactDigest: 'sha256:' + '0'.repeat(64) }
      : field === 'artifact' ? { expectedArtifactId: 'unrelated' }
      : field === 'binding' ? { expectedBindingRevision: 99 }
      : field === 'control' ? { expectedControlVersion: 99 }
      : field === 'epoch' ? { expectedTaskRevisionEpoch: 99 }
      : field === 'feedback' ? { feedback: '' }
      : { actor: { principal: { kind: 'system_safety' as const, policyVersion: '1' }, authentication: { method: 'system' as const } } };
    expect(await reviseApprovedRuleOnce({ ...input, ...overrides })).toMatchObject({ status: 'refused' });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['scribe', 'artificer', 'evaluator', 'rollout_reviewer'] as const)('active %s lease prevents all writes', async kind => {
    const input = await request();
    await handle.stateManager.updateTask(ids[kind], { leaseOwner: 'worker', leaseExpiresAt: '2099-01-01T00:00:00Z' });
    const before = await snapshot();
    expect(await reviseApprovedRuleOnce(input)).toMatchObject({ status: 'refused', reason: `revision_chain_leased:${kind}` });
    expect(await snapshot()).toEqual(before);
  });

  it('binding mutation between preview and lock, and concurrent SQLite mutation, fail without spending the receipt', async () => {
    const input = await request();
    const before = await snapshot();
    const locked = ledger.withLockedRuleCandidateIdentity;
    ledger.withLockedRuleCandidateIdentity = (_id, operation) => operation({ status: 'unresolved', reason: 'binding_revoked', nextAction: 'review' });
    expect(await reviseApprovedRuleOnce(input)).toMatchObject({ status: 'refused' });
    expect(await snapshot()).toEqual(before);
    ledger.withLockedRuleCandidateIdentity = (id, operation) => {
      handle.stateManager.connection.getDb().prepare('UPDATE tasks SET max_attempts = 4 WHERE task_id = ?').run(ids.evaluator);
      return locked(id, operation);
    };
    expect(await reviseApprovedRuleOnce(input)).toMatchObject({ status: 'refused' });
    expect((await meta()).approvedRuleRevisions).toBeUndefined();
    expect((await meta()).status).toBe('succeeded');
  });

  it('SQLite abort at the only write rolls back both receipt and runnable state', async () => {
    const input = await request();
    const before = await snapshot();
    handle.stateManager.connection.getDb().exec("CREATE TRIGGER stop_revision BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'crash-simulation'); END");
    await expect(reviseApprovedRuleOnce(input)).rejects.toThrow('crash-simulation');
    expect(await snapshot()).toEqual(before);
    handle.stateManager.connection.getDb().exec('DROP TRIGGER stop_revision');
    expect(await reviseApprovedRuleOnce(input)).toMatchObject({ status: 'started' });
  });

  it('existing revision wave resumes the same Evaluator only after the new Artificer succeeds', async () => {
    await reviseApprovedRuleOnce(await request());
    await handle.stateManager.updateTask(ids.artificer, { status: 'succeeded', resultRef: 'artificer://new-run' });
    const orchestrator = new InternalizationOrchestrator({ stateManager: handle.stateManager }, { owner: 'test', runtimeKind: 'test-double' });
    expect(await orchestrator.commitNextTaskProposal(ids.artificer)).toMatchObject({ decision: 'successor_reopened', reopenedTaskId: ids.evaluator });
    expect((await handle.stateManager.getTask(ids.evaluator))?.status).toBe('pending');
    expect((await handle.stateManager.getTask(ids.rollout_reviewer))?.status).toBe('succeeded');
    expect(await orchestrator.commitNextTaskProposal(ids.artificer)).toMatchObject({ decision: 'successor_exists' });
    expect((await meta()).revisionFeedback).toContain('authoritative not_approved');
    const evaluator = await handle.stateManager.getTask(ids.evaluator);
    const evaluatorPi = evaluator && hydratePITaskRecord(evaluator);
    if (!evaluatorPi) throw new Error('fixture evaluator missing');
    await handle.stateManager.updateTask(ids.evaluator, { status: 'succeeded', resultRef: 'evaluator://new-evaluation',
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(evaluatorPi, { runnerDecision: 'approved' })) });
    expect(await orchestrator.commitNextTaskProposal(ids.evaluator)).toMatchObject({ decision: 'successor_reopened', reopenedTaskId: ids.rollout_reviewer });
    expect((await handle.stateManager.getTask(ids.rollout_reviewer))?.status).toBe('pending');
    const approvals = await new SqliteApprovalQueueStore(handle.stateManager.connection).listAll();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.artifactId).toBe('approved-old');
  });

  it('poisoned receipt fields cannot silently erase the spent budget during hydrate/merge', async () => {
    await reviseApprovedRuleOnce(await request());
    const pi = await meta();
    expect(hydratePITaskRecord({ ...pi, diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(pi, {})) })?.approvedRuleRevisions).toEqual(pi.approvedRuleRevisions);
    const raw: unknown = JSON.parse(createPITaskDiagnosticJson(pi));
    if (!raw || typeof raw !== 'object') throw new Error('fixture invalid');
    const metadata: unknown = Reflect.get(raw, 'pi_metadata');
    if (!metadata || typeof metadata !== 'object') throw new Error('fixture invalid');
    const receipts: unknown = Reflect.get(metadata, 'approvedRuleRevisions');
    if (!Array.isArray(receipts) || !receipts[0]) throw new Error('fixture invalid');
    Reflect.set(receipts[0], 'artifactDigest', ['sha256:' + '0'.repeat(64)]);
    expect(parsePITaskMetadata(JSON.stringify(raw))).toBeNull();
  });

  it('the production adapter holds the canonical cross-process ledger lock until the synchronous CAS callback finishes', () => {
    const stateDir = join(workspaceDir, '.state');
    mkdirSync(stateDir, { recursive: true });
    saveLedger(stateDir, loadLedger(stateDir));
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const filePath = getLedgerFilePathPublic(stateDir);
    expect(adapter.withLockedRuleCandidateIdentity(candidateId, current => {
      expect(current).toMatchObject({ status: 'unresolved', reason: 'missing' });
      expect(existsSync(filePath + '.lock')).toBe(true);
      expect(() => withLock(filePath, () => 'should not run', { maxRetries: 1 })).toThrow();
      return 'callback completed';
    })).toBe('callback completed');
    expect(existsSync(filePath + '.lock')).toBe(false);
    expect(() => adapter.withLockedRuleCandidateIdentity(candidateId, () => { throw new Error('CAS abort'); })).toThrow('CAS abort');
    expect(existsSync(filePath + '.lock')).toBe(false);
  });
});
