import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata } from '../pitask-metadata.js';
import { reviseRuleSourceOnce, SOURCE_CORRECTION_STOP_REASON_CODES } from '../rule-source-correction.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { createRuntimeStateHandle, type RuntimeStateHandle } from '../../runtime-state-handle.js';
import { SqliteDiagnosticianCommitter } from '../../store/commit/diagnostician-committer.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { CandidatePrincipleIdentityResolution } from '../../adapter/principle-tree-ledger-adapter.js';

/**
 * SPEC-PRI-1047 R03: real SQLite + the formal authenticated entry
 * (reviseRuleSourceOnce) + the production consumer (commitNextTaskProposal):
 * the full recovery circuit "binding revision consumed + scribe
 * revisionCount=3 + artificer NHR → one source-correction authorization →
 * new epoch → new artifact → ORIGINAL artificer CAS-reopened on the new
 * artifact → evaluator cascade" plus every negative control.
 */
const NOW = '2026-10-26T00:00:00.000Z';
const BINDING_REVISION = 1;
const MAX_ATTEMPTS = 3;

const OWNER_SENTENCE = '非简单行为变更先调查现状，交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码；方向认可和操作权限不得替代设计确认。';

const diagnosis: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'pri1047-source-correction-diagnosis',
  summary: 'Implementation proceeded without the Owner design approval.',
  rootCause: 'Design: code was written before the Owner reviewed the SPEC.',
  violatedPrinciples: [],
  evidence: [{ sourceRef: 'trajectory://owner/turn-4', note: 'Owner原文引用：' + OWNER_SENTENCE }],
  confidence: 0.9,
  recommendations: [{ kind: 'rule', description: 'Gate non-trivial changes on design approval.' }],
};

function sha256Of(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function scribeArtifactJson(taskId: string, textualBasis: string): string {
  return JSON.stringify({
    taskId,
    sourcePhilosopherArtifactId: 'pi-art-philosopher-run-2',
    principleDraft: {
      title: '设计确认门禁', statement: '高成本非简单变更必须先获Owner设计批准后才编码。',
      rationale: 'r', applicability: ['a'], antiPatterns: ['b'], confidence: 0.9,
    },
    intentContract: {
      ownerIntent: 'Owner要求先批准再编码。', targetBehavior: 't', forbiddenBehavior: 'f',
      evidenceSource: 'e', validationExpectation: 'v',
    },
    sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-run-2' },
    risks: [],
    generatedAt: NOW,
    executionConditions: { version: 1, requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis }] },
  });
}

describe('SPEC-PRI-1047 R03 — one bounded source-correction recovery through the formal entry (real SQLite)', () => {
  let workspaceDir: string;
  let handle: RuntimeStateHandle;
  let candidateId: string;
  let run4ArtifactId: string;
  // Chain ids derive from the committed candidate (mechanism is candidate-agnostic — no hardcoded production UUID).
  let SCRIBE_TASK_ID: string;
  let ARTIFICER_TASK_ID: string;
  let EVALUATOR_TASK_ID: string;
  let CAUSE_ID: string;

  function requireTask<T extends { taskId: string }>(task: T | null | undefined): T {
    if (task === null || task === undefined) throw new Error('fixture: task missing');
    return task;
  }

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pd-pri1047-r03-'));
    handle = await createRuntimeStateHandle({ workspaceDir });
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: 'diagnosis', taskKind: 'diagnostician', status: 'succeeded',
      inputRef: 'original-evidence', attemptCount: 1, maxAttempts: 3,
    });
    await stateManager.runStore.createRun({
      runId: 'diagnosis-run', taskId: 'diagnosis', runtimeKind: 'test-double',
      startedAt: NOW, attemptNumber: 1, executionStatus: 'succeeded',
      outputPayload: JSON.stringify(diagnosis),
    });
    await new SqliteDiagnosticianCommitter(stateManager.connection).commit({
      taskId: 'diagnosis', runId: 'diagnosis-run', output: diagnosis, idempotencyKey: 'pri1047-commit',
    });
    const ruleCandidate = (await stateManager.getCandidatesByTaskId('diagnosis'))
      .find((c) => c.rawRecommendationKind === 'rule');
    if (!ruleCandidate) throw new Error('fixture: rule candidate missing');
    ({ candidateId } = ruleCandidate);
    SCRIBE_TASK_ID = `scribe-${candidateId}-code_tool_hook`;
    ARTIFICER_TASK_ID = `artificer-${candidateId}-code_tool_hook`;
    EVALUATOR_TASK_ID = `evaluator-${candidateId}-code_tool_hook`;
    CAUSE_ID = `rule-source-correction:${candidateId}:${BINDING_REVISION}`;

    const baseMeta = (dependencyTaskIds: string[]) => createPITaskDiagnosticJson({
      dependencyTaskIds, channel: 'code_tool_hook', timeoutMs: 1_000,
      inputArtifactRefs: [], outputArtifactRefs: [], pipelineMode: 'standard',
      correlationId: candidateId,
    });
    // dreamer/philosopher succeeded (upstream of the scribe).
    await stateManager.createTask({
      taskId: 'dreamer-1', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: MAX_ATTEMPTS,
      diagnosticJson: JSON.stringify({ ...JSON.parse(baseMeta([])), candidateId, sourcePainId: 'pain_001' }),
    });
    await stateManager.createTask({
      taskId: 'philosopher-1', taskKind: 'philosopher', status: 'succeeded', attemptCount: 2, maxAttempts: MAX_ATTEMPTS,
      resultRef: 'philosopher://run-2', diagnosticJson: baseMeta(['dreamer-1']),
    });
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: 'pi-art-philosopher-run-2', artifactKind: 'principle', sourceTaskId: 'philosopher-1',
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ taskId: 'philosopher-1', analysis: 'Owner原文引用：' + OWNER_SENTENCE, thesis: '', risks: [] }),
      createdAt: NOW, updatedAt: NOW,
    });
    // scribe: epoch 0 artifact first (revisionCount still 0), then the post-run4
    // metadata (revisionCount=3, binding cause consumed), then the epoch-3 artifact.
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID, taskKind: 'scribe', status: 'succeeded', attemptCount: 4, maxAttempts: MAX_ATTEMPTS,
      resultRef: 'scribe://run-3', diagnosticJson: baseMeta(['philosopher-1']),
    });
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: `pi-art-${SCRIBE_TASK_ID}-run-3`, artifactKind: 'principle', sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: scribeArtifactJson(SCRIBE_TASK_ID, 'Owner原文：' + OWNER_SENTENCE), // epoch-0 bad citation (historical)
      createdAt: NOW, updatedAt: NOW,
    });
    const scribeTask = await stateManager.getTask(SCRIBE_TASK_ID);
    const scribePi = hydratePITaskRecord(requireTask(scribeTask));
    await stateManager.updateTask(SCRIBE_TASK_ID, {
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(requireTask(scribePi), {
        revisionCount: 3,
        revisionCauseId: `rule-binding:${candidateId}:1`,
        ruleBindingRevisionCauseId: `rule-binding:${candidateId}:1`,
        revisionFeedback: 'Owner bound this rule candidate to a formal principle.',
      })),
      resultRef: 'scribe://run-4',
    });
    run4ArtifactId = `pi-art-${SCRIBE_TASK_ID}-run-scribe-52d-4`;
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: run4ArtifactId, artifactKind: 'principle', sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [], validationStatus: 'pending',
      contentJson: scribeArtifactJson(SCRIBE_TASK_ID, 'Owner原文：\u2018非简单行为变更先调查现状，交付SPEC和技术方案……经Owner确认后再编码\u2019'),
      createdAt: NOW, updatedAt: NOW,
    });
    // artificer: stopped at the source-material NHR (production 2026-10-26 shape).
    await stateManager.createTask({
      taskId: ARTIFICER_TASK_ID, taskKind: 'artificer', status: 'needs_human_review',
      attemptCount: 0, maxAttempts: 6, diagnosticJson: (() => {
        const meta = JSON.parse(baseMeta([SCRIBE_TASK_ID])) as { pi_metadata: Record<string, unknown> };
        meta.pi_metadata.revisionCount = 2;
        meta.pi_metadata.revisionCauseId = `cascade-${SCRIBE_TASK_ID}-rc3-${ARTIFICER_TASK_ID}`;
        meta.pi_metadata.humanReviewContext = {
          reasonCode: 'textual_basis_unanchored', sourceRunId: 'intent-preflight',
          revisionEpoch: 2, detail: 'required fact textualBasis cannot be anchored', createdAt: NOW,
        };
        return JSON.stringify(meta);
      })(),
    });
    // evaluator: old-epoch success (the revision wave must cascade onto it later).
    await stateManager.createTask({
      taskId: EVALUATOR_TASK_ID, taskKind: 'evaluator', status: 'succeeded',
      attemptCount: 2, maxAttempts: MAX_ATTEMPTS, resultRef: 'evaluator://run-2',
      diagnosticJson: baseMeta([ARTIFICER_TASK_ID]),
    });
  });

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function ledger(): { resolveForCandidate: (id: string) => Promise<CandidatePrincipleIdentityResolution> } {
    return {
      resolveForCandidate: async (id) => ({
        status: 'resolved', candidateId: id, principleId: 'ce2b7885-a9ea-4f6e-94da-b0e6c9b85110',
        basis: 'owner_rule_binding', bindingRevision: BINDING_REVISION,
        decisionId: '7814f382-6bd4-49dd-b7df-62fa98c3f8f2', checkedAt: NOW,
      }),
    };
  }

  function authorize(overrides: Partial<Parameters<typeof reviseRuleSourceOnce>[0]> = {}) {
    return reviseRuleSourceOnce({
      stateManager: handle.stateManager,
      ledger: ledger(),
      candidateId,
      expectedBindingRevision: BINDING_REVISION,
      expectedScribeTaskId: SCRIBE_TASK_ID,
      expectedArtificerTaskId: ARTIFICER_TASK_ID,
      reason: 'Owner authorized one source-correction for the run4 unanchored citation.',
      actor: 'owner-console:pd',
      requestId: 'req-pri1047-001',
      ...overrides,
    });
  }

  function orchestrator(): InternalizationOrchestrator {
    return new InternalizationOrchestrator(
      { stateManager: handle.stateManager },
      { owner: 'pri1047-test', runtimeKind: 'test-double' },
    );
  }

  async function currentScribeArtifactJson(): Promise<string> {
    const [artifact] = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
    if (!artifact) throw new Error('fixture: current scribe artifact missing');
    return artifact.contentJson;
  }

  /** Simulate the reopened scribe actually succeeding in the new epoch (R03 is the deterministic chain; the real model run is R04). */
  async function simulateScribeEpochSuccess(): Promise<void> {
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'succeeded', resultRef: 'scribe://run-5' });
    await handle.stateManager.piArtifactStore.upsertArtifact({
      artifactId: `pi-art-${SCRIBE_TASK_ID}-run-5`, artifactKind: 'principle', sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [], validationStatus: 'pending',
      contentJson: scribeArtifactJson(SCRIBE_TASK_ID, OWNER_SENTENCE), // corrected continuous original sentence
      createdAt: NOW, updatedAt: NOW,
    });
  }

  it('full happy path: authorization consumes exactly once, reopens the scribe in a new epoch, CAS-reopens the ORIGINAL artificer on the new artifact, then cascades to the evaluator', async () => {
    const result = await authorize();
    expect(result.status).toBe('revision_started');
    if (result.status !== 'revision_started') return;
    expect(result.causeId).toBe(CAUSE_ID);

    const scribe = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    expect(scribe?.status).toBe('pending');
    expect(scribe?.attemptCount).toBe(0);
    expect(scribe?.maxAttempts).toBe(MAX_ATTEMPTS);          // original cap untouched
    const scribePi = hydratePITaskRecord(requireTask(scribe));
    expect(scribePi?.revisionCount).toBe(4);                 // new epoch = old 3 + 1
    expect(scribePi?.sourceCorrectionCauseId).toBe(CAUSE_ID);
    expect(scribePi?.sourceCorrectionReceipt?.status).toBe('consumed');
    expect(scribePi?.sourceCorrectionReceipt?.actor).toBe('owner-console:pd');
    expect(scribePi?.sourceCorrectionReceipt?.artificerTaskId).toBe(ARTIFICER_TASK_ID);
    expect(scribePi?.sourceCorrectionReceipt?.sourceArtifactId).toBe(run4ArtifactId);
    expect(scribePi?.revisionFeedback).toContain('CONTINUOUS original sentence');
    expect(scribePi?.ruleBindingRevisionCauseId).toBe(`rule-binding:${candidateId}:1`); // history preserved

    // New scribe epoch succeeds → the ORIGINAL artificer is CAS-reopened.
    await simulateScribeEpochSuccess();
    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_correction_reopened');
    if (commit.decision === 'source_correction_reopened') {
      expect(commit.reopenedTaskId).toBe(ARTIFICER_TASK_ID);
    }
    const artificer = await handle.stateManager.getTask(ARTIFICER_TASK_ID);
    expect(artificer?.status).toBe('pending');
    expect(artificer?.attemptCount).toBe(0);
    expect(artificer?.maxAttempts).toBe(6);
    const artificerPi = hydratePITaskRecord(requireTask(artificer));
    expect(artificerPi?.dependencyTaskIds).toEqual([SCRIBE_TASK_ID]); // same task, same dependencies
    expect(artificerPi?.revisionCauseId).toBe(CAUSE_ID);
    expect(artificerPi?.revisionCount).toBe(3);
    // receipt outcome recorded; exactly ONE artificer task exists (no duplicate/new branch).
    const scribeAfter = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    expect(scribeAfter?.sourceCorrectionReceipt?.reopenOutcome?.kind).toBe('reopened');
    const allTasks = await handle.stateManager.listTasks();
    expect(allTasks.filter((t) => t.taskKind === 'artificer')).toHaveLength(1);
    // The reopened artificer resolves the NEW epoch artifact (MAX view) — no fallback.
    const resolved = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
    expect(resolved.map((a) => a.artifactId)).toEqual([`pi-art-${SCRIBE_TASK_ID}-run-5`]);
    expect((await currentScribeArtifactJson())).toContain(OWNER_SENTENCE);

    // Artificer rerun succeeds → the EXISTING cascade reopens the evaluator (reused successor machinery).
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, { status: 'succeeded', resultRef: 'artificer://run-2' });
    const evalCommit = await orchestrator().commitNextTaskProposal(ARTIFICER_TASK_ID);
    expect(['successor_reopened', 'revision_reopened', 'source_correction_reopened']).toContain(evalCommit.decision);
    const evaluator = await handle.stateManager.getTask(EVALUATOR_TASK_ID);
    expect(evaluator?.status).toBe('pending');               // Evaluator advanced, same taskId
    expect((await handle.stateManager.listTasks()).filter((t) => t.taskKind === 'evaluator')).toHaveLength(1);
    // History & spend preserved: old artifacts still readable by id, epochs intact.
    const epoch0 = await handle.stateManager.piArtifactStore.getArtifactById(`pi-art-${SCRIBE_TASK_ID}-run-3`);
    const run4 = await handle.stateManager.piArtifactStore.getArtifactById(run4ArtifactId);
    expect(epoch0?.artifactId).toBe(`pi-art-${SCRIBE_TASK_ID}-run-3`);
    expect(run4?.artifactId).toBe(run4ArtifactId);
  });

  it('idempotent replay: double-click / crash-restart / a different requestId with the SAME cause never yields a second budget', async () => {
    const first = await authorize();
    expect(first.status).toBe('revision_started');
    const second = await authorize({ requestId: 'req-pri1047-OTHER' });
    expect(second.status).toBe('revision_already_started');  // same cause → replay, no new budget
    const third = await authorize({ requestId: 'req-pri1047-THIRD' });
    expect(third.status).toBe('revision_already_started');
    const scribePi = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    expect(scribePi?.revisionCount).toBe(4);                 // exactly one increment
  });

  it('one-consumption cap: same-cause replay after completion stays idempotent; a rebind attempt is refused as budget exhausted', async () => {
    // Simulate the new epoch having run and the task completed again (any terminal state).
    await authorize();
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'succeeded' });
    const sameCause = await authorize({ requestId: 'req-after-epoch' });
    expect(sameCause.status).toBe('revision_already_started'); // idempotent, never a second budget
    // A rebind (binding revision 2) computes a DIFFERENT cause — the candidate's
    // one source-correction budget is already consumed, so it must be refused.
    const rebound = await reviseRuleSourceOnce({
      stateManager: handle.stateManager,
      ledger: {
        resolveForCandidate: async (id) => ({
          status: 'resolved', candidateId: id, principleId: 'ce2b7885-a9ea-4f6e-94da-b0e6c9b85110',
          basis: 'owner_rule_binding', bindingRevision: BINDING_REVISION + 1,
          decisionId: 'd2', checkedAt: NOW,
        }),
      },
      candidateId, expectedBindingRevision: BINDING_REVISION + 1,
      reason: 'rebind attempt', actor: 'owner-console:pd', requestId: 'req-rebind',
    });
    expect(rebound.status).toBe('refused');
    if (rebound.status === 'refused') expect(rebound.reason).toBe('source_correction_budget_exhausted');
  });

  it('live lease on the scribe refuses with ZERO consumption', async () => {
    const scribe = await handle.stateManager.getTask(SCRIBE_TASK_ID);
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, {
      leaseOwner: 'companion-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await authorize();
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toBe('task_lease_present');
    const scribePi = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    expect(scribePi?.sourceCorrectionCauseId).toBeUndefined(); // zero consumption
    expect(scribePi?.revisionCount).toBe(3);
    expect(scribe?.status).toBe('succeeded');
  });

  it('stale scribe artifact digest refuses (material changed → no idle model spend)', async () => {
    const result = await authorize({ expectedScribeArtifactDigest: 'sha256:' + '0'.repeat(64) });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toBe('scribe_artifact_changed');
  });

  it('current-digest authorization binds the receipt to the exact material', async () => {
    const digest = sha256Of(await currentScribeArtifactJson());
    const result = await authorize({ expectedScribeArtifactDigest: digest });
    expect(result.status).toBe('revision_started');
  });

  it('binding mismatches refuse: wrong revision / non-owner basis', async () => {
    const stale = await authorize({ expectedBindingRevision: BINDING_REVISION + 1 });
    expect(stale.status).toBe('refused');
    if (stale.status === 'refused') expect(stale.reason).toBe('binding_revision_stale');
    const unbound = await reviseRuleSourceOnce({
      stateManager: handle.stateManager,
      ledger: {
        resolveForCandidate: async (id) => ({
          status: 'resolved', candidateId: id, principleId: 'p1',
          basis: 'derived_candidate' as const,
          bindingRevision: BINDING_REVISION, checkedAt: NOW,
        }),
      },
      candidateId, expectedBindingRevision: BINDING_REVISION,
      reason: 'r', actor: 'a', requestId: 'req-unbound',
    });
    expect(unbound.status).toBe('refused');
    if (unbound.status === 'refused') expect(unbound.reason).toBe('binding_revision_stale');
  });

  it('arbitrary task combinations refuse: mismatched artificer id / artificer not in review / stop reason not source material', async () => {
    const mismatch = await authorize({ expectedArtificerTaskId: 'artificer-someone-else' });
    expect(mismatch.status).toBe('refused');
    if (mismatch.status === 'refused') expect(mismatch.reason).toBe('artificer_target_mismatch');

    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, { status: 'pending' });
    const notInReview = await authorize();
    expect(notInReview.status).toBe('refused');
    if (notInReview.status === 'refused') expect(notInReview.reason).toBe('artificer_not_in_review_pending');

    // Back to NHR but with a NON source-material stop reason (identity gate stop).
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, { status: 'needs_human_review' });
    const artificer = requireTask(await handle.stateManager.getTask(ARTIFICER_TASK_ID));
    const meta = JSON.parse(artificer.diagnosticJson ?? '{}') as { pi_metadata: Record<string, unknown> };
    (meta.pi_metadata.humanReviewContext as Record<string, unknown>).reasonCode = 'identity_changed_during_generation';
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, { diagnosticJson: JSON.stringify(meta) });
    const wrongStop = await authorize();
    expect(wrongStop.status).toBe('refused');
    if (wrongStop.status === 'refused') expect(wrongStop.reason).toContain('stop_reason_not_source_material');
    expect(SOURCE_CORRECTION_STOP_REASON_CODES).toContain('textual_basis_unanchored');
  });

  it('scribe failure after authorization reopens NOTHING downstream (artificer stays NHR)', async () => {
    await authorize();
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'failed' });
    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_not_succeeded');
    expect((await handle.stateManager.getTask(ARTIFICER_TASK_ID))?.status).toBe('needs_human_review');
  });

  it('scribe parking in needs_human_review after authorization also reopens nothing', async () => {
    await authorize();
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'needs_human_review' });
    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_not_succeeded');
    expect((await handle.stateManager.getTask(ARTIFICER_TASK_ID))?.status).toBe('needs_human_review');
  });

  it('reopen conflict is observable and recoverable: drifted stop reason does not silently consume the artificer', async () => {
    await authorize();
    await simulateScribeEpochSuccess();
    const artificer = requireTask(await handle.stateManager.getTask(ARTIFICER_TASK_ID));
    const meta = JSON.parse(artificer.diagnosticJson ?? '{}') as { pi_metadata: Record<string, unknown> };
    (meta.pi_metadata.humanReviewContext as Record<string, unknown>).reasonCode = 'approval_dependency_undeclared_is_not_it'; // drifted
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, { diagnosticJson: JSON.stringify(meta) });

    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_correction_reopen_conflict');
    expect((await handle.stateManager.getTask(ARTIFICER_TASK_ID))?.status).toBe('needs_human_review'); // untouched
    const scribePi = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    expect(scribePi?.sourceCorrectionReceipt?.reopenOutcome?.kind).toBe('conflict');
    // Reconciliation replay must stay TERMINAL: the recorded conflict outcome
    // suppresses the generic cascade too — the artificer the conflict decision
    // refused to touch is NOT reopened behind our back (review P2 #3).
    const replay = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(replay.decision).toBe('source_correction_reopen_noop');
    if (replay.decision === 'source_correction_reopen_noop') expect(replay.reason).toContain('outcome_recorded:conflict');
    expect((await handle.stateManager.getTask(ARTIFICER_TASK_ID))?.status).toBe('needs_human_review');
    const artificersAfterReplay = (await handle.stateManager.listTasks()).filter((t) => t.taskKind === 'artificer');
    expect(artificersAfterReplay).toHaveLength(1); // no NEW artificer seeded by the generic path
  });

  it('crash-window replay: artificer reopened but receipt outcome missing → same-cause no-op, then outcome recorded', async () => {
    await authorize();
    await simulateScribeEpochSuccess();
    // Simulate a crash between the CAS reopen and the outcome write: reopen manually.
    const artificer = await handle.stateManager.getTask(ARTIFICER_TASK_ID);
    const artificerPi = hydratePITaskRecord(requireTask(artificer));
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, {
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(requireTask(artificerPi), {
        revisionCount: (artificerPi?.revisionCount ?? 0) + 1, revisionCauseId: CAUSE_ID,
      })),
      status: 'pending', attemptCount: 0,
    });
    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_correction_reopen_noop');
    const scribePi = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    expect(scribePi?.sourceCorrectionReceipt?.reopenOutcome?.kind).toBe('reopened_earlier');
  });

  it('the old findExistingSuccessor gap stays covered: an NHR artificer is never treated as an in-flight successor, and the targeted branch precedes it', async () => {
    // Without a receipt (plain revision wave), the NHR artificer is invisible to
    // findExistingSuccessor — the generic cascade handles it via existingById.
    await authorize();
    await simulateScribeEpochSuccess();
    const commit = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(commit.decision).toBe('source_correction_reopened'); // receipt branch took precedence
    // And the negative shape: a NON-receipt scribe completion cascades generically.
    const scribePi = hydratePITaskRecord(requireTask(await handle.stateManager.getTask(SCRIBE_TASK_ID)));
    if (scribePi === null) throw new Error('fixture: scribe metadata missing');
    const { sourceCorrectionReceipt: _a, sourceCorrectionCauseId: _b, ...plainMeta } = scribePi;
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, {
      diagnosticJson: createPITaskDiagnosticJson(plainMeta),
      status: 'needs_human_review',
    });
    // artificer back to NHR (as it would be after another material stop)
    const artificer = await handle.stateManager.getTask(ARTIFICER_TASK_ID);
    const artificerPi = hydratePITaskRecord(requireTask(artificer));
    await handle.stateManager.updateTask(ARTIFICER_TASK_ID, {
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(requireTask(artificerPi), { revisionCauseId: undefined })),
      status: 'needs_human_review',
    });
    await handle.stateManager.updateTask(SCRIBE_TASK_ID, { status: 'succeeded' });
    const generic = await orchestrator().commitNextTaskProposal(SCRIBE_TASK_ID);
    expect(['successor_reopened', 'revision_reopen_noop']).toContain(generic.decision);
  });
});
