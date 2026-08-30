/**
 * PRI-629 — Owner verdict override 的 runner 级集成测试（SPEC §10/§14/§30）。
 *
 * 验收矩阵对应:
 *   - Evaluator Accept: 不重新调用 LLM (runtimeAdapter.startRun 未被调用)
 *   - Evaluator Accept: machine verdict 仍是 needs_revision (INV-03)
 *   - Evaluator Accept: effective decision = approved → 任务 succeeded,
 *     principle bearer 被 validated (复用既有 approved side effects)
 *   - Evaluator Reject: 无 side effects、terminal
 *   - Rollout Accept low-risk: 经注入的 dispatchActivation 正常 activation
 *   - Rollout Accept high-risk (dispatcher 返回 queued_for_approval): completed
 *   - Rollout Reject: dispatch 未被调用
 *   - crash 窗口: applied-but-not-terminal 的 resolution 重放收敛 (无 LLM)
 *   - P0: orchestrator 的 repair reopen 使用 epoch-aware causeId
 */
import { describe, it, expect, vi } from 'vitest';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { RolloutReviewerRunner } from '../rollout-reviewer-runner.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { MemoryTaskStore } from '../../store/task/memory-task-store.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, type PITaskMetadata, type OwnerResolutionRecord, type HumanReviewContext } from '../pitask-metadata.js';
import { HUMAN_REVIEW_REASON } from '../owner-review.js';
import type { TaskRecord } from '../../task-status.js';

const EVAL_ID = 'evaluator-001';
const ARTIFER_ID = 'artificer-repair-evaluator-001-r2';
const SCRIBE_ID = 'scribe-001';
const ROLLOUT_ID = 'rollout-reviewer-001';
const RUN_ID = 'run-evaluator-001';
const EVAL_ARTIFACT_ID = `pi-art-${EVAL_ID}-${RUN_ID}`;
const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-001';

function meta(overrides: Partial<PITaskMetadata> = {}): PITaskMetadata {
  return {
    dependencyTaskIds: [ARTIFER_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  };
}

function task(taskId: string, taskKind: string, status: TaskRecord['status'], m: PITaskMetadata): TaskRecord {
  return {
    taskId, taskKind, status, attemptCount: 0, maxAttempts: 3,
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(m),
  };
}

function nhrContext(reasonCode: string): HumanReviewContext {
  return {
    reasonCode, sourceRunId: RUN_ID, sourceArtifactId: EVAL_ARTIFACT_ID,
    sourceArtifactHash: 'a'.repeat(64), revisionEpoch: 0, createdAt: '2026-08-30T00:00:00.000Z',
  };
}

function resolution(action: 'accept_current' | 'reject_current', effectiveDecision: string, status: 'pending' | 'applied'): OwnerResolutionRecord {
  return {
    resolutionId: 'ores_test1', reviewKey: 'odk_test', action, status,
    ownerId: 'owner-1', decidedAt: '2026-08-30T01:00:00.000Z',
    ...(status === 'applied' ? { appliedAt: '2026-08-30T01:00:05.000Z' } : {}),
    sourceRunId: RUN_ID, sourceArtifactId: EVAL_ARTIFACT_ID, sourceArtifactHash: 'a'.repeat(64),
    revisionEpoch: 0, machineDecision: 'needs_revision',
    effectiveDecision: effectiveDecision as OwnerResolutionRecord['effectiveDecision'],
  };
}

const evaluatorOutput = {
  taskId: EVAL_ID,
  sourceArtificerArtifactId: 'pi-art-artificer-old',
  evaluation: {
    decision: 'needs_revision', summary: 'gaps remain', score: 0.72,
    strengths: ['clear structure'], concerns: ['c1'], requiredChanges: ['fix timeout'],
  },
  sourceTrace: { artificerArtifactId: 'pi-art-artificer-old', scribeArtifactId: SCRIBE_ARTIFACT_ID },
  risks: [], generatedAt: '2026-08-30T00:00:00.000Z',
};

function makeArtifacts(): MemoryPIArtifactStore {
  const store = new MemoryPIArtifactStore();
  void store.upsertArtifact({
    artifactId: SCRIBE_ARTIFACT_ID, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'pending',
    contentJson: JSON.stringify({ principleDraft: { title: 't', statement: 's' }, generatedAt: 'x' }),
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
  });
  void store.upsertArtifact({
    artifactId: EVAL_ARTIFACT_ID, artifactKind: 'principle', sourceTaskId: EVAL_ID,
    lineageArtifactIds: [], validationStatus: 'pending',
    contentJson: JSON.stringify(evaluatorOutput),
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
  });
  return store;
}

/** MemoryTaskStore 支撑的忠实 in-memory stateManager(读写语义与 SQLite 一致) */
function makeHarness(tasks: TaskRecord[], artifacts: MemoryPIArtifactStore) {
  const store = new MemoryTaskStore();
  for (const t of tasks) void store.createTask({ ...t });
  const runs = new Map([
    [RUN_ID, { runId: RUN_ID, taskId: EVAL_ID, runtimeKind: 'evaluator', outputPayload: JSON.stringify(evaluatorOutput) }],
  ]);
  const startRun = vi.fn();
  const stateManager = {
    piArtifactStore: artifacts,
    async acquireLease() { return store.getTask(tasks[0]!.taskId); },
    async getTask(id: string) { return store.getTask(id); },
    async listTasks() { return [] as TaskRecord[]; },
    async getRunsByTask(id: string) { return [...runs.values()].filter((r) => r.taskId === id); },
    async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
    async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
    async markTaskSucceeded(id: string, resultRef: string) { await store.updateTask(id, { status: 'succeeded', resultRef }); },
    async markTaskFailed(id: string, lastError: TaskRecord['lastError']) { await store.updateTask(id, { status: 'failed' as const, lastError }); },
    getRetryPolicy: () => ({ shouldRetry: () => false }),
  };
  const runtimeAdapter = {
    startRun,
    pollRun: vi.fn(),
    fetchOutput: vi.fn(),
    cancelRun: vi.fn(),
  };
  const eventEmitter = { emitTelemetry: vi.fn() };
  return { stateManager, runtimeAdapter, eventEmitter, store, startRun };
}

function flippedEvaluatorTask(res: OwnerResolutionRecord): TaskRecord {
  return task(EVAL_ID, 'evaluator', 'pending', meta({
    runnerDecision: 'needs_revision',
    completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
    humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted),
    ownerResolutions: [res],
  }));
}

const artificerR2 = task(ARTIFER_ID, 'artificer', 'succeeded', meta({
  dependencyTaskIds: [SCRIBE_ID],
  repairPayload: {
    requiredChanges: ['fix timeout'], concerns: ['c1'], previousScore: 0.7,
    repairIteration: 2, sourceArtificerArtifactId: 'pi-art-artificer-old', sourceEvaluatorTaskId: EVAL_ID,
  },
}));

const scribeTask = task(SCRIBE_ID, 'scribe', 'succeeded', meta({ dependencyTaskIds: [] }));

// ── Evaluator ─────────────────────────────────────────────────────────────────

describe('PRI-629 evaluator owner override resume (no LLM, INV-03)', () => {
  it('accept_current: resumes durable output, approves via override, never calls the LLM', async () => {
    const artifacts = makeArtifacts();
    const h = makeHarness([flippedEvaluatorTask(resolution('accept_current', 'approved', 'pending')), artificerR2, scribeTask], artifacts);
    const runner = new EvaluatorRunner(
      { stateManager: h.stateManager as never, runtimeAdapter: h.runtimeAdapter as never, eventEmitter: h.eventEmitter as never, artifactStore: artifacts, validator: new DefaultEvaluatorValidator() },
      { owner: 'test', runtimeKind: 'evaluator' },
    );
    const result = await runner.run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    // SPEC §33: 不重新调用 LLM
    expect(h.startRun).not.toHaveBeenCalled();
    const after = hydratePITaskRecord((await h.stateManager.getTask(EVAL_ID))!);
    // INV-03: 机器判定永久保留
    expect(after?.runnerDecision).toBe('needs_revision');
    expect(after?.status).toBe('succeeded');
    expect(after?.ownerResolutions?.[0]?.status).toBe('applied');
    expect(after?.completionIntent?.status).toBe('applied');
    // approved side effect: principle bearer 被 validated (复用既有 effects)
    expect((await artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('validated');
  });

  it('applied-but-not-terminal crash window replays the same resolution (still no LLM)', async () => {
    const artifacts = makeArtifacts();
    const h = makeHarness([flippedEvaluatorTask(resolution('accept_current', 'approved', 'applied')), artificerR2, scribeTask], artifacts);
    const runner = new EvaluatorRunner(
      { stateManager: h.stateManager as never, runtimeAdapter: h.runtimeAdapter as never, eventEmitter: h.eventEmitter as never, artifactStore: artifacts, validator: new DefaultEvaluatorValidator() },
      { owner: 'test', runtimeKind: 'evaluator' },
    );
    const result = await runner.run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    expect((await h.stateManager.getTask(EVAL_ID))?.status).toBe('succeeded');
  });

  it('reject_current: terminal without side effects and without LLM', async () => {
    const artifacts = makeArtifacts();
    const h = makeHarness([flippedEvaluatorTask(resolution('reject_current', 'rejected', 'pending')), artificerR2, scribeTask], artifacts);
    const runner = new EvaluatorRunner(
      { stateManager: h.stateManager as never, runtimeAdapter: h.runtimeAdapter as never, eventEmitter: h.eventEmitter as never, artifactStore: artifacts, validator: new DefaultEvaluatorValidator() },
      { owner: 'test', runtimeKind: 'evaluator' },
    );
    const result = await runner.run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    expect((await artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('pending');
    const after = hydratePITaskRecord((await h.stateManager.getTask(EVAL_ID))!);
    expect(after?.ownerResolutions?.[0]?.effectiveDecision).toBe('rejected');
    expect(after?.runnerDecision).toBe('needs_revision');
  });
});

// ── Rollout ───────────────────────────────────────────────────────────────────

const rolloutOutput = {
  taskId: ROLLOUT_ID,
  sourceEvaluatorArtifactId: EVAL_ARTIFACT_ID,
  review: {
    decision: 'needs_revision', confidence: 0.8, summary: 'rollout gaps',
    requiredChanges: ['improve wording'], rolloutRisks: ['r'], safetyChecks: ['s'],
  },
  sourceTrace: { evaluatorArtifactId: EVAL_ARTIFACT_ID },
  risks: [],
  generatedAt: '2026-08-30T00:00:00.000Z',
};

function rolloutHarness(res: OwnerResolutionRecord, dispatchDecision: string | null, scribeValidated = true) {
  const artifacts = makeArtifacts();
  if (scribeValidated) {
    void artifacts.updateValidationStatus(SCRIBE_ARTIFACT_ID, 'validated');
  }
  const rolloutTask = task(ROLLOUT_ID, 'rollout_reviewer', 'pending', meta({
    dependencyTaskIds: [EVAL_ID],
    runnerDecision: 'needs_revision',
    completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'applied', effect: 'needs_human_review' },
    humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.rolloutRevisionBudgetExhausted),
    ownerResolutions: [res],
  }));
  // evaluator 依赖存在 (lineage 可解析)
  const evalSucceeded = task(EVAL_ID, 'evaluator', 'succeeded', meta({
    dependencyTaskIds: [ARTIFER_ID], runnerDecision: 'approved',
  }));
  const store = new MemoryTaskStore();
  for (const t of [rolloutTask, evalSucceeded, artificerR2, scribeTask]) void store.createTask({ ...t });
  const runs = new Map([
    [RUN_ID, { runId: RUN_ID, taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', outputPayload: JSON.stringify(rolloutOutput) }],
  ]);
  const startRun = vi.fn();
  const dispatchActivation = vi.fn().mockResolvedValue({
    decision: dispatchDecision, activationId: 'act-1', reason: null,
  });
  const stateManager = {
    piArtifactStore: artifacts,
    async acquireLease() { return store.getTask(ROLLOUT_ID); },
    async getTask(id: string) { return store.getTask(id); },
    async listTasks() { return [] as TaskRecord[]; },
    async getRunsByTask(id: string) { return [...runs.values()].filter((r) => r.taskId === id); },
    async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
    async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
    async markTaskSucceeded(id: string, resultRef: string) { await store.updateTask(id, { status: 'succeeded', resultRef }); },
    getRetryPolicy: () => ({ shouldRetry: () => false }),
  };
  const runner = new RolloutReviewerRunner(
    {
      stateManager: stateManager as never,
      runtimeAdapter: { startRun, pollRun: vi.fn(), fetchOutput: vi.fn(), cancelRun: vi.fn() } as never,
      eventEmitter: { emitTelemetry: vi.fn() } as never,
      artifactStore: artifacts,
      validator: new DefaultRolloutReviewerValidator(),
      ...(dispatchDecision !== null ? { dispatchActivation } : {}),
    },
    { owner: 'test', runtimeKind: 'rollout_reviewer' },
  );
  return { runner, startRun, dispatchActivation, stateManager, artifacts };
}

describe('PRI-629 rollout owner override resume (INV-08)', () => {
  it('accept_current low-risk: dispatches through the injected dispatcher (activated)', async () => {
    const h = rolloutHarness(resolution('accept_current', 'approve_rollout', 'pending'), 'activated');
    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.dispatchActivation).toHaveBeenCalledTimes(1);
    expect((await h.stateManager.getTask(ROLLOUT_ID))?.status).toBe('succeeded');
    const after = hydratePITaskRecord((await h.stateManager.getTask(ROLLOUT_ID))!);
    expect(after?.runnerDecision).toBe('needs_revision');
    expect(after?.ownerResolutions?.[0]?.status).toBe('applied');
  });

  it('accept_current high-risk (dispatcher queues approval): completed, no direct activation', async () => {
    const h = rolloutHarness(resolution('accept_current', 'approve_rollout', 'pending'), 'queued_for_approval');
    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.dispatchActivation).toHaveBeenCalledTimes(1);
    // 高风险路径: dispatcher 决定 queued — approval 仍是独立门 (INV-08)
    expect((await h.stateManager.getTask(ROLLOUT_ID))?.status).toBe('succeeded');
  });

  it('P0 review: accept downstream dispatch refusal → recovery NHR but resolution APPLIED (no dead-end)', async () => {
    const h = rolloutHarness(resolution('accept_current', 'approve_rollout', 'pending'), 'refused');
    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    // 任务进入 recovery 类 NHR (dispatch 拒绝是技术故障)
    const after = hydratePITaskRecord((await h.stateManager.getTask(ROLLOUT_ID))!);
    expect(after?.status).toBe('needs_human_review');
    expect(after?.humanReviewContext?.reasonCode).toContain('rollout_dispatch');
    // P0 核心: Owner 裁决已被执行 — resolution 必须标 applied,不得停留 pending
    expect(after?.ownerResolutions?.[0]?.status).toBe('applied');
  });

  it('reject_current: no dispatch, terminal, machine verdict preserved', async () => {
    const h = rolloutHarness(resolution('reject_current', 'reject', 'pending'), 'activated');
    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.dispatchActivation).not.toHaveBeenCalled();
    const after = hydratePITaskRecord((await h.stateManager.getTask(ROLLOUT_ID))!);
    expect(after?.ownerResolutions?.[0]?.effectiveDecision).toBe('reject');
    expect(after?.runnerDecision).toBe('needs_revision');
  });
});

// ── P0: orchestrator repair reopen uses epoch-aware causeId ──────────────────

describe('PRI-629 P0: epoch-aware repair reopen (SPEC §12)', () => {
  function orchestratorHarness(evaluatorCauseId: string | undefined, artificerRevisionCount?: number) {
    const evalTask = task(EVAL_ID, 'evaluator', 'needs_human_review', meta({
      runnerDecision: 'needs_revision',
      revisionCount: 1,
      ...(evaluatorCauseId !== undefined ? { revisionCauseId: evaluatorCauseId } : {}),
    }));
    const repair = task(ARTIFER_ID, 'artificer', 'succeeded', meta({
      dependencyTaskIds: [SCRIBE_ID],
      revisionCount: artificerRevisionCount,
      repairPayload: {
        requiredChanges: ['fix'], concerns: [], previousScore: 0.7, repairIteration: 2,
        sourceArtificerArtifactId: 'pi-art-old', sourceEvaluatorTaskId: EVAL_ID,
      },
    }));
    const store = new MemoryTaskStore();
    for (const t of [evalTask, repair, scribeTask]) void store.createTask({ ...t });
    const stateManager = {
      async getTask(id: string) { return store.getTask(id); },
      async listTasks() { return [] as TaskRecord[]; },
      async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
      async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
      async getRunsByTask() { return []; },
    };
    return { orchestrator: new InternalizationOrchestrator({ stateManager: stateManager as never }, { owner: 'test', runtimeKind: 'test' }), store };
  }

  it('rc0 completion with evaluator already carrying `repair-<id>` → no-op replay', async () => {
    const { orchestrator, store } = orchestratorHarness(`repair-${ARTIFER_ID}`);
    const result = await orchestrator.commitNextTaskProposal(ARTIFER_ID);
    expect(result.decision).toBe('revision_reopen_noop');
    expect(hydratePITaskRecord((await store.getTask(EVAL_ID))!)?.revisionCount).toBe(1);
  });

  it('owner revision epoch (rc1) completion → NEW causeId → real reopen (revisionCount +1)', async () => {
    const { orchestrator, store } = orchestratorHarness(`repair-${ARTIFER_ID}`, 1);
    const result = await orchestrator.commitNextTaskProposal(ARTIFER_ID);
    expect(result.decision).toBe('revision_reopened');
    const after = hydratePITaskRecord((await store.getTask(EVAL_ID))!);
    expect(after?.revisionCount).toBe(2);
    expect(after?.revisionCauseId).toBe(`repair-${ARTIFER_ID}-rc1`);
    // 新 epoch: 旧 verdict/intent 被清空 — evaluator 将重新评估
    expect(after?.runnerDecision).toBeUndefined();
    expect(after?.completionIntent).toBeUndefined();
  });
});
