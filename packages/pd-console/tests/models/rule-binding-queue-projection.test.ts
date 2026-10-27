import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createRuntimeStateHandle, PrincipleTreeLedgerAdapter, SqliteDiagnosticianCommitter, reviseRuleBindingOnce,
  createPITaskDiagnosticJson, type RuntimeStateHandle, type DiagnosticianOutputV1,
} from '@principles/core/runtime-v2';
import { addPrincipleToLedger } from '@principles/core/principle-tree-ledger';
import { RuleCandidateBindingConsoleModel } from '../../src/server/models/RuleCandidateBindingConsoleModel.js';

const NOW = '2026-10-26T00:00:00.000Z';
const TARGET_PRINCIPLE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * PRI-1048 U02/U03 model-level projection: the queue card must answer
 * 「这是哪次反馈？现在卡在哪？我要做什么？」 from real authorities only —
 * pain_events (trajectory.db), the ledger binding, and the internalization
 * chain (dreamer→…→artificer) — without any new persisted state.
 */
const boundDiagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'projection-bound-diagnosis',
  summary: 'The design change shipped unconfirmed.',
  rootCause: 'Design: direction approval was treated as design confirmation.',
  violatedPrinciples: [],
  evidence: [],
  confidence: 0.9,
  recommendations: [
    { kind: 'principle', description: 'Non-trivial behavior changes need a confirmed design first.' },
    { kind: 'rule', description: 'Require a confirmed design before non-trivial behavior changes.' },
  ],
};

type Fixture = {
  workspaceDir: string;
  handle: RuntimeStateHandle;
  ruleCandidateId: string;
  twinCandidateId: string;
};

async function createFixture(): Promise<Fixture> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-binding-queue-projection-'));
  const handle = await createRuntimeStateHandle({ workspaceDir });

  // Parent diagnosis + router sub-task commit; the rule candidate lives on
  // the router (split provenance), the principle candidate on the parent.
  await handle.stateManager.createTask({ taskId: 'diagnosis-parent', taskKind: 'diagnostician', status: 'succeeded', inputRef: 'pain-design-gate', attemptCount: 1, maxAttempts: 3 });
  await handle.stateManager.runStore.createRun({ runId: 'run-parent', taskId: 'diagnosis-parent', runtimeKind: 'test-double', startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(boundDiagnosis) });
  await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({ taskId: 'diagnosis-parent', runId: 'run-parent', output: boundDiagnosis, idempotencyKey: 'projection-parent-commit' });

  await handle.stateManager.createTask({ taskId: 'diag_router-diagnosis-parent', taskKind: 'diag_router', status: 'succeeded', inputRef: 'diagnosis-parent', attemptCount: 1, maxAttempts: 3 });
  await handle.stateManager.runStore.createRun({ runId: 'run-router', taskId: 'diag_router-diagnosis-parent', runtimeKind: 'test-double', startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(boundDiagnosis) });
  await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({ taskId: 'diag_router-diagnosis-parent', runId: 'run-router', output: boundDiagnosis, idempotencyKey: 'projection-router-commit' });

  const parentCandidates = await handle.stateManager.getCandidatesByTaskId('diagnosis-parent');
  const principleCandidate = parentCandidates.find(c => c.taskId === 'diagnosis-parent' && c.rawRecommendationKind === 'principle');
  const ruleCandidate = parentCandidates.find(c => c.rawRecommendationKind === 'rule');
  if (!principleCandidate || !ruleCandidate) throw new Error('Real committer did not produce both candidates.');

  // A second, unlinked rule candidate on its own pain (direct provenance).
  const twinOutput: DiagnosticianOutputV1 = {
    ...boundDiagnosis, diagnosisId: 'projection-twin-diagnosis',
    recommendations: [{ kind: 'rule', description: 'Front-load the conclusion in every owner-facing reply.' }],
  };
  await handle.stateManager.createTask({ taskId: 'diagnosis-twin', taskKind: 'diagnostician', status: 'succeeded', inputRef: 'pain-unlinked', attemptCount: 1, maxAttempts: 3 });
  await handle.stateManager.runStore.createRun({ runId: 'run-twin', taskId: 'diagnosis-twin', runtimeKind: 'test-double', startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded', outputPayload: JSON.stringify(twinOutput) });
  await new SqliteDiagnosticianCommitter(handle.stateManager.connection).commit({ taskId: 'diagnosis-twin', runId: 'run-twin', output: twinOutput, idempotencyKey: 'projection-twin-commit' });
  const twinCandidate = (await handle.stateManager.getCandidatesByTaskId('diagnosis-twin')).find(c => c.rawRecommendationKind === 'rule');
  if (!twinCandidate) throw new Error('Twin rule candidate missing.');

  // Eligible target principle in the ledger (real binding authority path).
  addPrincipleToLedger(join(workspaceDir, '.state'), {
    id: TARGET_PRINCIPLE_ID, version: 1, text: '设计确认门禁：非简单行为变更先交付SPEC并获批准后编码。',
    triggerPattern: 'design', action: 'require_spec', status: 'candidate', priority: 'P1',
    scope: 'general', evaluability: 'deterministic', valueScore: 0, adherenceRate: 0,
    painPreventedCount: 0, derivedFromPainIds: [principleCandidate.candidateId], ruleIds: [], conflictsWithPrincipleIds: [],
    createdAt: NOW, updatedAt: NOW,
  });

  // Pain events behind both signals (trajectory store, same DDL as the e2e seed).
  const stateDir = join(workspaceDir, '.state');
  const traj = new Database(join(stateDir, 'trajectory.db'));
  traj.exec(`CREATE TABLE IF NOT EXISTS pain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0, reason TEXT, severity TEXT, origin TEXT, confidence REAL,
    text TEXT, created_at TEXT NOT NULL, canonical_pain_id TEXT, runtime_task_id TEXT);`);
  traj.prepare(`INSERT INTO pain_events (session_id, source, text, created_at, canonical_pain_id)
    VALUES (?, ?, ?, ?, ?)`).run('s1', 'manual', 'Owner指出：新增LLM意图提示词层时未先提交SPEC就完成了实现。', NOW, 'pain-design-gate');
  traj.prepare(`INSERT INTO pain_events (session_id, source, text, created_at, canonical_pain_id)
    VALUES (?, ?, ?, ?, ?)`).run('s2', 'manual', '你发过来的分析我看不懂，结论不在最前面。', NOW, 'pain-unlinked');
  traj.close();

  return { workspaceDir, handle, ruleCandidateId: ruleCandidate.candidateId, twinCandidateId: twinCandidate.candidateId };
}

function ledgerAdapter(fixture: Fixture): PrincipleTreeLedgerAdapter {
  return new PrincipleTreeLedgerAdapter({
    stateDir: join(fixture.workspaceDir, '.state'),
    reviewSources: {
      loadCandidateMaterial: async candidateId => {
        const candidate = await fixture.handle.stateManager.getCandidate(candidateId);
        if (!candidate) return null;
        const [task, run, artifact] = await Promise.all([
          fixture.handle.stateManager.getTask(candidate.taskId),
          fixture.handle.stateManager.getRun(candidate.sourceRunId),
          fixture.handle.stateManager.getArtifact(candidate.artifactId),
        ]);
        const parentTask = task?.taskKind === 'diag_router' && task.inputRef ? await fixture.handle.stateManager.getTask(task.inputRef) : null;
        return task && run && artifact ? { candidate, task, run, artifact, parentTask } : null;
      },
    },
  });
}

async function bindCandidate(fixture: Fixture): Promise<void> {
  const adapter = ledgerAdapter(fixture);
  const review = await adapter.createRuleCandidateBindingReview(fixture.ruleCandidateId);
  if (!review.ok) throw new Error(`Cannot establish binding fixture: ${review.reason}`);
  const target = review.eligibleTargets.find(entry => entry.principle.id === TARGET_PRINCIPLE_ID);
  if (!target) throw new Error('Target principle not eligible.');
  const result = await adapter.mutateRuleCandidateBinding({
    candidateId: fixture.ruleCandidateId,
    owner: { actorId: 'owner-test', source: 'authenticated_console' },
    request: {
      action: 'bind', principleId: TARGET_PRINCIPLE_ID, expectedRevision: 0,
      expectedCandidateDigest: review.reviewedCandidateDigest,
      expectedPrincipleDigest: target.reviewedPrincipleDigest,
      reason: 'Bind the design-gate rule to the reviewed principle.', requestId: 'projection-bind', resumeOnce: true,
    },
  });
  if (!result.ok) throw new Error(`Binding fixture refused: ${result.reason}`);
}

type ChainStep = { taskId: string; taskKind: string; deps: string[]; status: string; seed?: string; budgetCause?: boolean; blocked?: { reasonCode: string; detail: string } };

async function seedChain(handle: RuntimeStateHandle, steps: ChainStep[]): Promise<void> {
  for (const step of steps) {
    const metadata = createPITaskDiagnosticJson({
      dependencyTaskIds: step.deps, channel: 'code_tool_hook', timeoutMs: 1000,
      inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard',
      ...(step.budgetCause ? { revisionCount: 1, ruleBindingRevisionCauseId: `rule-binding:test:1` } : {}),
      ...(step.blocked ? {
        humanReviewContext: {
          reasonCode: step.blocked.reasonCode, sourceRunId: 'run-x', revisionEpoch: 0,
          detail: step.blocked.detail, createdAt: NOW,
        },
      } : {}),
    });
    const diagnosticJson = step.seed
      ? JSON.stringify({ ...JSON.parse(metadata), candidateId: step.seed })
      : metadata;
    await handle.stateManager.createTask({
      taskId: step.taskId, taskKind: step.taskKind, status: step.status as never,
      attemptCount: 1, maxAttempts: 3, diagnosticJson,
    });
  }
}

describe('rule binding queue projection (PRI-1048)', () => {
  let fixture: Fixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => {
    await fixture.handle.close();
    rmSync(fixture.workspaceDir, { recursive: true, force: true });
  });

  it('a bound candidate blocked before the model call projects the real 52d-like facts', async () => {
    await bindCandidate(fixture);
    await seedChain(fixture.handle, [
      { taskId: 'dreamer-1', taskKind: 'dreamer', deps: ['diag_router-diagnosis-parent'], status: 'succeeded', seed: fixture.ruleCandidateId },
      { taskId: 'philosopher-1', taskKind: 'philosopher', deps: ['dreamer-1'], status: 'succeeded' },
      { taskId: 'scribe-1', taskKind: 'scribe', deps: ['philosopher-1'], status: 'succeeded', budgetCause: true },
      { taskId: 'artificer-1', taskKind: 'artificer', deps: ['scribe-1'], status: 'needs_human_review', blocked: { reasonCode: 'textual_basis_unanchored', detail: "required fact 'design_approval' textualBasis cannot be anchored" } },
    ]);
    // The bounded source-correction preview anchors to the CURRENT scribe artifact.
    await fixture.handle.stateManager.piArtifactStore.upsertArtifact({
      artifactId: 'pi-art-scribe-1-run-1', artifactKind: 'principle', sourceTaskId: 'scribe-1',
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ taskId: 'scribe-1', principleDraft: { statement: '设计确认门禁。' } }),
      createdAt: NOW, updatedAt: NOW,
    });

    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    if (!item) throw new Error('Bound candidate missing from queue.');
    expect(item.pain).toMatchObject({ painId: 'pain-design-gate', text: expect.stringContaining('Owner指出'), source: 'manual' });
    expect(item.diagnosisStatus).toBe('succeeded');
    expect(item.binding).toMatchObject({
      status: 'bound',
      principle: {
        principleId: TARGET_PRINCIPLE_ID, status: 'candidate', version: 1, revision: 1,
        text: expect.stringContaining('设计确认门禁'),
      },
    });
    if (item.binding.status !== 'bound') throw new Error('unreachable');
    expect(item.binding.principle.decidedAt).not.toBe('');
    expect(item.generation).toMatchObject({ stage: 'blocked', stageKind: 'artificer', reasonCode: 'textual_basis_unanchored' });
    expect(item.resume).toEqual({ status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: 'scribe-1', taskRevisionEpoch: 1 });
    // PRI-1048 R6 #4: with the binding budget spent but the source-material stop
    // in scope, the bounded source-correction entry is READY with the full CAS set.
    expect(item.sourceCorrection).toMatchObject({
      status: 'ready', reason: null, scribeTaskId: 'scribe-1', artificerTaskId: 'artificer-1', expectedBindingRevision: 1,
    });
    expect(item.sourceCorrection?.scribeArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const twin = queue.items.find(entry => entry.candidateId === fixture.twinCandidateId);
    expect(twin?.binding).toEqual({ status: 'unlinked' });
    expect(twin?.generation).toBeNull();
    expect(twin?.resume).toBeNull();
    expect(twin?.sourceCorrection).toBeNull();
    expect(twin?.pain).toMatchObject({ painId: 'pain-unlinked' });

    // The split diagnosis contributes TWO distinct rule candidates (the
    // parent commit's own + the router's), the twin pain one more — dedup
    // collapses provenance traversal, never distinct candidates.
    expect(queue.summary).toEqual({ painGroups: 2, candidates: 3, bound: 1, unlinked: 2, blocked: 1 });
    expect(queue.truncated).toBe(false);
  });

  it('a bound candidate with an unbudgeted completed chain projects a ready resume (real resolver)', async () => {
    await bindCandidate(fixture);
    await seedChain(fixture.handle, [
      { taskId: 'dreamer-2', taskKind: 'dreamer', deps: ['diag_router-diagnosis-parent'], status: 'succeeded', seed: fixture.ruleCandidateId },
      { taskId: 'philosopher-2', taskKind: 'philosopher', deps: ['dreamer-2'], status: 'succeeded' },
      { taskId: 'scribe-2', taskKind: 'scribe', deps: ['philosopher-2'], status: 'succeeded' },
    ]);
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.resume).toEqual({ status: 'ready', reason: null, scribeTaskId: 'scribe-2', taskRevisionEpoch: 0 });
    expect(item?.generation).toMatchObject({ stage: 'advanced', stageKind: 'scribe' });
  });

  it('an in-flight scribe revision projects in_progress, not blocked', async () => {
    await bindCandidate(fixture);
    await seedChain(fixture.handle, [
      { taskId: 'dreamer-3', taskKind: 'dreamer', deps: ['diag_router-diagnosis-parent'], status: 'succeeded', seed: fixture.ruleCandidateId },
      { taskId: 'philosopher-3', taskKind: 'philosopher', deps: ['dreamer-3'], status: 'succeeded' },
      { taskId: 'scribe-3', taskKind: 'scribe', deps: ['philosopher-3'], status: 'pending', budgetCause: true },
    ]);
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.generation).toMatchObject({ stage: 'in_progress', stageKind: 'scribe' });
  });

  it('a bound candidate without any internalization chain projects not_built', async () => {
    await bindCandidate(fixture);
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.generation).toEqual({ stage: 'not_built', stageKind: null, reasonCode: null, detail: null });
  });

  it('an unreadable ledger surfaces as attention, never as unlinked', async () => {
    await bindCandidate(fixture);
    writeFileSync(join(fixture.workspaceDir, '.state', 'principle_training_state.json'), '{truncated', 'utf8');
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.binding).toEqual({ status: 'attention', reason: 'ledger_unavailable' });
  });

  it('a revoked binding projects binding_revoked and stays visible', async () => {
    await bindCandidate(fixture);
    const adapter = ledgerAdapter(fixture);
    const revoked = await adapter.mutateRuleCandidateBinding({
      candidateId: fixture.ruleCandidateId,
      owner: { actorId: 'owner-test', source: 'authenticated_console' },
      request: { action: 'revoke', expectedRevision: 1, reason: 'Withdraw.', requestId: 'projection-revoke', resumeOnce: false },
    });
    if (!revoked.ok) throw new Error(`Revoke refused: ${revoked.reason}`);
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.binding).toEqual({ status: 'binding_revoked' });
    expect(queue.summary.bound).toBe(0);
  });

  it('a missing pain record shows unrecorded text, not a fabricated quote', async () => {
    rmSync(join(fixture.workspaceDir, '.state', 'trajectory.db'));
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.pain).toEqual({ painId: 'pain-design-gate', text: null, source: 'unknown', createdAt: null });
  });

  it('an unreadable trajectory store is labeled unreadable, never misattributed as unrecorded (rc-9)', async () => {
    rmSync(join(fixture.workspaceDir, '.state', 'trajectory.db'));
    writeFileSync(join(fixture.workspaceDir, '.state', 'trajectory.db'), 'not a sqlite database', 'utf8');
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const item = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId);
    expect(item?.pain).toEqual({ painId: 'pain-design-gate', text: null, source: 'unreadable', createdAt: null });
  });

  /** P4 drift pin: the read-only preview must agree with the click-time authority. */
  it('the projected resume verdict matches what reviseRuleBindingOnce would actually do', async () => {
    await bindCandidate(fixture);
    await seedChain(fixture.handle, [
      { taskId: 'dreamer-1', taskKind: 'dreamer', deps: ['diag_router-diagnosis-parent'], status: 'succeeded', seed: fixture.ruleCandidateId },
      { taskId: 'philosopher-1', taskKind: 'philosopher', deps: ['dreamer-1'], status: 'succeeded' },
      { taskId: 'scribe-1', taskKind: 'scribe', deps: ['philosopher-1'], status: 'succeeded', budgetCause: true },
      { taskId: 'artificer-1', taskKind: 'artificer', deps: ['scribe-1'], status: 'needs_human_review', blocked: { reasonCode: 'textual_basis_unanchored', detail: 'anchor missing' } },
    ]);
    const queue = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).list();
    const preview = queue.items.find(entry => entry.candidateId === fixture.ruleCandidateId)?.resume;
    expect(preview).toMatchObject({ status: 'refused', reason: 'revision_budget_exhausted' });
    const adapter = ledgerAdapter(fixture);
    const actual = await reviseRuleBindingOnce({
      stateManager: fixture.handle.stateManager,
      ledger: { resolveForCandidate: async id => adapter.resolveCandidatePrincipleIdentity(id, 'rule') },
      candidateId: fixture.ruleCandidateId,
      expectedBindingRevision: 1,
    });
    // The click-time authority refuses for the SAME reason the preview showed.
    expect(actual).toMatchObject({ status: 'refused', reason: 'revision_budget_exhausted' });
  });

  it('review() enriches the decision view with pain text, bound principle, generation and resume', async () => {
    await bindCandidate(fixture);
    await seedChain(fixture.handle, [
      { taskId: 'dreamer-1', taskKind: 'dreamer', deps: ['diag_router-diagnosis-parent'], status: 'succeeded', seed: fixture.ruleCandidateId },
      { taskId: 'philosopher-1', taskKind: 'philosopher', deps: ['dreamer-1'], status: 'succeeded' },
      { taskId: 'scribe-1', taskKind: 'scribe', deps: ['philosopher-1'], status: 'succeeded', budgetCause: true },
      { taskId: 'artificer-1', taskKind: 'artificer', deps: ['scribe-1'], status: 'needs_human_review', blocked: { reasonCode: 'textual_basis_unanchored', detail: 'anchor missing' } },
    ]);
    const result = await new RuleCandidateBindingConsoleModel(fixture.workspaceDir).review(fixture.ruleCandidateId, '');
    if (!result.ok) throw new Error(`Review refused: ${result.reason}`);
    expect(result.review.sourcePain).toMatchObject({ painId: 'pain-design-gate', text: expect.stringContaining('Owner指出') });
    expect(result.review.boundPrinciple).toMatchObject({ principleId: TARGET_PRINCIPLE_ID, version: 1, revision: 1 });
    expect(result.review.generation).toMatchObject({ stage: 'blocked', stageKind: 'artificer', reasonCode: 'textual_basis_unanchored' });
    expect(result.review.resume).toEqual({ status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: 'scribe-1', taskRevisionEpoch: 1 });
  });
});
