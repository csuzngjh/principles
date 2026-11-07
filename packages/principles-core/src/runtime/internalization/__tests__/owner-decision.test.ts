/**
 * PRI-629 / PRI-630 — Unified Owner Decision 核心契约测试。
 *
 * 覆盖 SPEC §33 验收矩阵的纯逻辑/服务层部分:
 *   A. metadata 序列化/hydration (humanReviewContext + ownerResolutions)
 *   B. human review 分类 (decision-capable vs recovery;legacy 推断;fail closed)
 *   C. capability 派生 (INV-01: allowedActions.length>0 ⇔ eligible)
 *   D. reviewKey stale 防护
 *   E. effective decision resolver (INV-03 机器判定保留)
 *   F. resolution service: 幂等 / 冲突 / stale / revise_once epoch 语义
 *   G. Recover guard (decision-capable 拒绝)
 *   H. epoch-aware repair causeId (P0)
 *   I. transition 仲裁使用 effective decision
 *   K. evaluator 收敛 schema 不变量 (SPEC §18.4)
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- legacy fixture assertions predate staged-file linting. */
import { describe, it, expect } from 'vitest';
import {
  serializePITaskMetadata,
  parsePITaskMetadata,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  type PITaskMetadata,
  type HumanReviewContext,
  type OwnerResolutionRecord,
  type RepairPayload,
} from '../pitask-metadata.js';
import {
  HUMAN_REVIEW_REASON,
  LEGACY_EVALUATOR_BUDGET_EXHAUSTED,
  buildOwnerReviewKey,
  collectOwnerDecisionFacts,
  deriveOwnerDecisionCapability,
  resolveEffectiveRunnerDecision,
  effectiveDecisionFor,
  planOwnerVerdictOverrideResume,
  detectHardGateFailureFromArtifact,
  type OwnerDecisionFactStore,
} from '../owner-review.js';
import {
  applyOwnerResolution,
  reviewStoreFromStateManager,
  sanitizeOwnerInstruction,
} from '../owner-resolution-service.js';
import { buildOwnerDecisionReview } from '../owner-decision-review.js';
import { buildRepairRevisionCauseId, reopenTaskForRevision, resolveRolloutRevisionTarget } from '../revision-reopen.js';
import { decideInternalizationTransition, transitionInputFromTask } from '../internalization-transition-decision.js';
import { ownerRetryNeedsHumanReviewTask } from '../owner-retry.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { deriveRequirementLedger } from '../evaluator-prompt-builder.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { MemoryTaskStore } from '../../store/task/memory-task-store.js';
import type { TaskRecord } from '../../task-status.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const EVAL_ID = 'evaluator-001';
const ARTIFER_ID = 'artificer-repair-evaluator-001-r2';
const SCRIBE_ID = 'scribe-001';
const RUN_ID = 'run-evaluator-001';
const ARTIFACT_ID = `pi-art-${EVAL_ID}-${RUN_ID}`;

function baseMeta(overrides: Partial<PITaskMetadata> = {}): PITaskMetadata {
  return {
    dependencyTaskIds: [ARTIFER_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  };
}

function budgetExhaustedRepairPayload(): RepairPayload {
  return {
    requiredChanges: ['fix timeout handling'],
    concerns: ['c1'],
    previousScore: 0.7,
    repairIteration: 2,
    sourceArtificerArtifactId: 'pi-art-artificer-old',
    sourceEvaluatorTaskId: 'evaluator-previous',
  };
}

function nhrContext(reasonCode: string = HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted): HumanReviewContext {
  return {
    reasonCode,
    sourceRunId: RUN_ID,
    sourceArtifactId: ARTIFACT_ID,
    sourceArtifactHash: 'a'.repeat(64),
    revisionEpoch: 0,
    createdAt: '2026-08-30T00:00:00.000Z',
  };
}

function evaluatorNhrTask(overrides: { meta?: Partial<PITaskMetadata>; status?: TaskRecord['status'] } = {}): TaskRecord {
  return {
    taskId: EVAL_ID,
    taskKind: 'evaluator',
    status: overrides.status ?? 'needs_human_review',
    attemptCount: 2,
    maxAttempts: 3,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(baseMeta({
      runnerDecision: 'needs_revision',
      completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
      humanReviewContext: nhrContext(),
      ...overrides.meta,
    })),
  };
}

function artificerTaskWithPayload(repairIteration: number): TaskRecord {
  return {
    taskId: ARTIFER_ID,
    taskKind: 'artificer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(baseMeta({
      dependencyTaskIds: [SCRIBE_ID],
      repairPayload: {
        requiredChanges: ['fix timeout handling'],
        concerns: ['c1'],
        previousScore: 0.7,
        repairIteration,
        sourceArtificerArtifactId: 'pi-art-artificer-old',
        sourceEvaluatorTaskId: 'evaluator-previous',
      },
    })),
  };
}

function makeArtifactStoreWithDecisionArtifact(content: unknown = {
  taskId: EVAL_ID,
  sourceArtificerArtifactId: 'pi-art-artificer-old',
  evaluation: {
    decision: 'needs_revision', summary: 's', score: 0.7,
    strengths: [], concerns: ['c'], requiredChanges: ['fix timeout handling'],
  },
  sourceTrace: { artificerArtifactId: 'pi-art-artificer-old' },
  risks: [], generatedAt: '2026-08-30T00:00:00.000Z',
}): MemoryPIArtifactStore {
  const store = new MemoryPIArtifactStore();
  void store.upsertArtifact({
    artifactId: ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: EVAL_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify(content),
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
  return store;
}

function makeFactStore(tasks: TaskRecord[], artifacts: MemoryPIArtifactStore): OwnerDecisionFactStore {
  return {
    getTask: async (id) => tasks.find((t) => t.taskId === id) ?? null,
    listArtifactsBySourceTask: async (id) => artifacts.listBySourceTaskId(id).then((list) => list.map((a) => ({
      artifactId: a.artifactId, artifactKind: a.artifactKind, validationStatus: a.validationStatus, contentJson: a.contentJson,
    }))),
  };
}

// ── N-3 fixtures: candidate-unresolved rollout 任务（跨 describe 共享）──

const ROLLOUT_ID = 'rollout-reviewer-001';

function rolloutCandidateUnresolvedTask(overrides: { meta?: Partial<PITaskMetadata> } = {}): TaskRecord {
  return {
    taskId: ROLLOUT_ID,
    taskKind: 'rollout_reviewer',
    status: 'needs_human_review',
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(baseMeta({
      channel: 'code_tool_hook',
      dependencyTaskIds: [EVAL_ID],
      runnerDecision: 'approve_rollout',
      completionIntent: { decision: 'approve_rollout', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
      humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.rolloutActivationCandidateUnresolved),
      ...overrides.meta,
    })),
  };
}

function makeRolloutArtifactStore(): MemoryPIArtifactStore {
  const store = new MemoryPIArtifactStore();
  void store.upsertArtifact({
    artifactId: ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: ROLLOUT_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      review: { decision: 'approve_rollout', summary: 's', confidence: 0.9, requiredChanges: [], rolloutRisks: [] },
      risks: [], generatedAt: 't', sourceEvaluatorArtifactId: 'pi-art-eval-1',
    }),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return store;
}

/** in-memory stateManager 满足 owner-resolution-service / owner-retry 需要的面 */
function makeInMemoryStateManager(tasks: TaskRecord[], artifacts: MemoryPIArtifactStore) {
  const store = new MemoryTaskStore();
  for (const t of tasks) void store.createTask({ ...t });
  const runs = new Map<string, { runId: string; taskId: string; outputPayload?: string }>([
    [RUN_ID, { runId: RUN_ID, taskId: EVAL_ID, outputPayload: JSON.stringify({
      taskId: EVAL_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-old',
      evaluation: {
        decision: 'needs_revision', summary: 's', score: 0.7,
        strengths: [], concerns: ['c'], requiredChanges: ['fix timeout handling'],
      },
      sourceTrace: { artificerArtifactId: 'pi-art-artificer-old', scribeArtifactId: 'pi-art-scribe' },
      risks: [], generatedAt: '2026-08-30T00:00:00.000Z',
    }) }],
  ]);
  const sm = {
    _store: store,
    piArtifactStore: artifacts,
    async getTask(id: string) { return store.getTask(id); },
    async getRunsByTask(id: string) { return [...runs.values()].filter((r) => r.taskId === id); },
    async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
    async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
    async updateTaskIfDiagnosticJsonUnchanged(id: string, expected: string | null, patch: Parameters<MemoryTaskStore['updateTask']>[1]) {
      return store.updateTaskIfDiagnosticJsonUnchanged(id, expected, patch);
    },
    async updateTaskIfDiagnosticJsonAndArtifactsUnchanged(input: {
      taskId: string;
      expectedDiagnosticJson: string | null;
      artifacts: readonly {
        artifactId: string;
        sourceTaskId: string;
        lineageArtifactIdsJson: string;
        contentJson: string;
      }[],
      patch: Parameters<MemoryTaskStore['updateTask']>[1];
    }) {
      for (const bound of input.artifacts) {
        const current = await artifacts.getArtifactById(bound.artifactId);
        if (!current
          || current.sourceTaskId !== bound.sourceTaskId
          || JSON.stringify(current.lineageArtifactIds) !== bound.lineageArtifactIdsJson
          || current.contentJson !== bound.contentJson) return null;
      }
      return store.updateTaskIfDiagnosticJsonUnchanged(input.taskId, input.expectedDiagnosticJson, input.patch);
    },
    async markTaskSucceeded(id: string, resultRef: string) { await store.updateTask(id, { status: 'succeeded', resultRef }); },
  };
  return sm;
}

// ── A. metadata contract ──────────────────────────────────────────────────────

describe('PRI-629 metadata: humanReviewContext + ownerResolutions round-trip', () => {
  it('serializes and re-parses humanReviewContext + ownerResolutions (legacy rows without them still hydrate)', () => {
    const resolution: OwnerResolutionRecord = {
      resolutionId: 'ores_abc', reviewKey: 'odk_k', action: 'accept_current', status: 'applied',
      ownerId: 'owner-1', decidedAt: '2026-08-30T01:00:00.000Z', appliedAt: '2026-08-30T01:00:05.000Z',
      sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID, sourceArtifactHash: 'h'.repeat(64),
      revisionEpoch: 0, machineDecision: 'needs_revision', effectiveDecision: 'approved',
    };
    const json = serializePITaskMetadata(baseMeta({
      humanReviewContext: nhrContext(),
      ownerResolutions: [resolution],
    }));
    const parsed = parsePITaskMetadata(json);
    expect(parsed?.humanReviewContext?.reasonCode).toBe('evaluator_repair_budget_exhausted');
    expect(parsed?.ownerResolutions?.[0]?.effectiveDecision).toBe('approved');
    const hydrated = hydratePITaskRecord({ ...evaluatorNhrTask(), diagnosticJson: json });
    expect(hydrated?.ownerResolutions?.length).toBe(1);
    // legacy: 无新字段的旧行照常 hydrate
    const legacy = parsePITaskMetadata(serializePITaskMetadata(baseMeta()));
    expect(legacy?.humanReviewContext).toBeUndefined();
    expect(legacy?.ownerResolutions).toBeUndefined();
  });

  it('fails closed on malformed resolution records (rc-1/rc-3)', () => {
    const bad: OwnerResolutionRecord = {
      resolutionId: '', reviewKey: 'odk_k', action: 'accept_current', status: 'pending',
      ownerId: 'o', decidedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision' as const,
    };
    const json = serializePITaskMetadata(baseMeta({ ownerResolutions: [bad] }));
    expect(parsePITaskMetadata(json)).toBeNull();
  });

  it('PRI-634: humanReviewContext.detail round-trips through serialize → parse (legacy 无 detail 照常 hydrate)', () => {
    const json = serializePITaskMetadata(baseMeta({
      humanReviewContext: { ...nhrContext(), detail: '1 rule/validated artifact(s) rejected: pi-art-x (missing: goldenTrace)' },
    }));
    const parsed = parsePITaskMetadata(json);
    expect(parsed?.humanReviewContext?.detail)
      .toBe('1 rule/validated artifact(s) rejected: pi-art-x (missing: goldenTrace)');
    // legacy: 无 detail 的 context 照常 hydrate,字段为 undefined 而非空串
    const legacy = parsePITaskMetadata(serializePITaskMetadata(baseMeta({ humanReviewContext: nhrContext() })));
    expect(legacy?.humanReviewContext?.detail).toBeUndefined();
  });

  it('PRI-634: malformed humanReviewContext.detail fails closed (rc-1/rc-2 trust boundary)', () => {
    // detail 一旦存在必须是 non-empty string;object/array/number/空串一律
    // 整条 metadata fail closed,禁止静默 hydrate 成类型谎言 (detail?: string)。
    for (const badDetail of [{}, [], 123, ''] as unknown[]) {
      const json = serializePITaskMetadata(baseMeta({
        humanReviewContext: { ...nhrContext(), detail: badDetail as string },
      }));
      expect(parsePITaskMetadata(json)).toBeNull();
    }
  });

  it('rejects duplicate reviewKey within ownerResolutions (authority corruption fails closed)', () => {
    const rec = (id: string): OwnerResolutionRecord => ({
      resolutionId: id, reviewKey: 'odk_same', action: 'reject_current', status: 'applied',
      ownerId: 'o', decidedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision',
    });
    const json = serializePITaskMetadata(baseMeta({ ownerResolutions: [rec('ores_1'), rec('ores_2')] }));
    expect(parsePITaskMetadata(json)).toBeNull();
  });
});

// ── B/C. classification & capability ─────────────────────────────────────────

describe('PRI-629 classification + capability (INV-01/INV-02/§22)', () => {
  it('decision-capable context + durable artifact → eligible with accept/revise/reject', async () => {
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([evaluatorNhrTask(), artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(true);
    expect(cap.allowedActions).toEqual(['accept_current', 'revise_once', 'reject_current']);
    expect(cap.reviewKey).toMatch(/^odk_[0-9a-f]{64}$/);
  });

  it('unknown reasonCode → recovery (fail closed, §22)', async () => {
    const task = evaluatorNhrTask({ meta: { humanReviewContext: nhrContext('something_new_unknown') } });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(false);
    expect(cap.attention).toBe('recovery');
  });

  it('recovery reasons (dispatch not wired / seed failed) never eligible', async () => {
    for (const reason of [HUMAN_REVIEW_REASON.rolloutDispatchNotWired, HUMAN_REVIEW_REASON.evaluatorRepairSeedFailed]) {
      const task = evaluatorNhrTask({ meta: { humanReviewContext: nhrContext(reason) } });
      const facts = await collectOwnerDecisionFacts(
        makeFactStore([task, artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
      expect(deriveOwnerDecisionCapability(facts!).eligible).toBe(false);
    }
  });

  it('legacy evaluator: needs_revision + dep repairIteration>=2 + epoch-matched intent → decision-capable (§23)', async () => {
    const meta = baseMeta({
      runnerDecision: 'needs_revision',
      humanReviewContext: undefined,
      completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
    });
    const task = evaluatorNhrTask({ meta });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(true);
    expect(cap.reasonCode).toBe(LEGACY_EVALUATOR_BUDGET_EXHAUSTED);
    expect(cap.legacy).toBe(true);
  });

  it('legacy ambiguous (no repairPayload on dep / intent epoch stale) → recovery, not guessed', async () => {
    const artificerFirstRound = {
      ...artificerTaskWithPayload(2),
      diagnosticJson: createPITaskDiagnosticJson(baseMeta({ dependencyTaskIds: [SCRIBE_ID] })),
    };
    const task = evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision',
      humanReviewContext: undefined,
      completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
    }) });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, artificerFirstRound], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    expect(deriveOwnerDecisionCapability(facts!).eligible).toBe(false);
  });

  it('missing decision artifact → not eligible (no reviewKey without durable facts)', async () => {
    const emptyStore = new MemoryPIArtifactStore();
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([evaluatorNhrTask(), artificerTaskWithPayload(2)], emptyStore), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(false);
    expect(cap.blockers).toContain('decision_artifact_missing');
  });

  it('existing resolution for current epoch removes the item from the inbox', async () => {
    const task = evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision',
      completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
      humanReviewContext: nhrContext(),
      ownerResolutions: [{
        resolutionId: 'ores_x', reviewKey: 'odk_prev', action: 'revise_once', status: 'applied',
        ownerId: 'o', decidedAt: 't', appliedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
        sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision',
      }],
    }) });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    expect(deriveOwnerDecisionCapability(facts!).blockers).toContain('resolution_already_recorded_for_current_epoch');
  });

  it('hard gate failure (adversarialResult.passed=false) blocks accept_current but keeps revise/reject (§9.1/§20)', async () => {
    const store = makeArtifactStoreWithDecisionArtifact({
      taskId: EVAL_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-old',
      evaluation: {
        decision: 'needs_revision', summary: 's', score: 0.7,
        strengths: [], concerns: ['c'], requiredChanges: ['fix'],
      },
      sourceTrace: { artificerArtifactId: 'pi-art-artificer-old' },
      risks: [], generatedAt: 't',
      adversarialResult: { passed: false, failedCases: [] },
    });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([evaluatorNhrTask(), artificerTaskWithPayload(2)], store), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.allowedActions).toEqual(['revise_once', 'reject_current']);
    expect(cap.blockers).toContain('deterministic_hard_gate_failed');
    expect(detectHardGateFailureFromArtifact('{"adversarialResult":{"passed":false}}')).toBe(true);
    expect(detectHardGateFailureFromArtifact('{"adversarialResult":{"passed":true}}')).toBe(false);
  });

  // ── N-3 (pipeline-verification 2026-09-05): rollout_activation_candidate_unresolved ──
  // 生产者 (rollout-reviewer-runner) 语义: 机器 approve_rollout 但激活候选缺失,
  // rejectionDetail 透传给 Owner 判断。修复前该原因不在 decision-capable 集合 →
  // 收件箱静默丢弃 (live 2 条挂 5 天不可见)。
  // fixtures (rolloutCandidateUnresolvedTask / makeRolloutArtifactStore / ROLLOUT_ID)
  // 定义在模块顶层,与 resolution describe 共享。

  it('N-3: rollout_activation_candidate_unresolved is decision-capable with revise/reject (no accept — no candidate to approve)', async () => {
    const task = rolloutCandidateUnresolvedTask();
    const evaluator = evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({
      channel: 'code_tool_hook',
      runnerDecision: 'approved',
      humanReviewContext: undefined,
      dependencyTaskIds: [ARTIFER_ID],
    }) });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, evaluator], makeRolloutArtifactStore()), 'rollout-reviewer-001');
    expect(facts).not.toBeNull();
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(true);
    expect(cap.attention).toBe('owner_decision');
    expect(cap.reasonCode).toBe('rollout_activation_candidate_unresolved');
    // 机器决策 approve_rollout 不再触发 runner_decision_not_needs_revision 阻断
    expect(cap.blockers).not.toContain('runner_decision_not_needs_revision:approve_rollout');
    // 无可批准候选 → accept_current 不可用;revise_once (重开生成链) / reject_current (归档) 可用
    expect(cap.allowedActions).toEqual(['revise_once', 'reject_current']);
    expect(cap.reviewKey).toMatch(/^odk_[0-9a-f]{64}$/);
  });

  it('N-3: revise_once target resolves through evaluator dep chain (reopen artificer on code_tool_hook)', async () => {
    // live 同构链: rollout → evaluator → artificer。revise_once 的目标解析必须
    // 在 candidate-unresolved 任务上成功,否则裁决权形同虚设。
    const task = rolloutCandidateUnresolvedTask();
    const evaluator = evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({
      channel: 'code_tool_hook',
      runnerDecision: 'approved',
      humanReviewContext: undefined,
      dependencyTaskIds: [ARTIFER_ID],
    }) });
    const artificer = artificerTaskWithPayload(0);
    const byId = new Map<string, TaskRecord>([
      [task.taskId, task],
      [evaluator.taskId, evaluator],
      [artificer.taskId, artificer],
    ]);
    const target = await resolveRolloutRevisionTarget(
      async (id) => byId.get(id) ?? null,
      task.taskId,
      'code_tool_hook',
    );
    expect(target).not.toBeNull();
    expect(target?.taskId).toBe(ARTIFER_ID);
  });

  it('N-3: legacy budget-exhausted semantics unchanged (needs_revision still required outside no-accept reasons)', async () => {
    // 守卫: 门放宽只作用于 NO_ACCEPT 集合内的原因,其余 decision-capable 原因
    // 仍要求 runnerDecision=needs_revision。
    const task = evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'approved',
      humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted),
    }) });
    const facts = await collectOwnerDecisionFacts(
      makeFactStore([task, artificerTaskWithPayload(2)], makeArtifactStoreWithDecisionArtifact()), EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(false);
    expect(cap.blockers).toContain('runner_decision_not_needs_revision:approved');
  });

  it('not_run + code-bearing artificer → accept_current forbidden (deterministic gate never ran, PRI-634 R4 P1)', async () => {
    // Evaluator artifact 不包含 adversarialResult → deterministicStatus = not_run。
    // code-bearing 时 accept_current 被移除（owner-decision-review.ts:348-350）。
    const store = makeArtifactStoreWithDecisionArtifact(); // 默认无 adversarialResult
    const task = evaluatorNhrTask();
    const sm = makeInMemoryStateManager([task, artificerTaskWithPayload(2)], store);
    // 添加 code-bearing 的 artificer artifact（implementationCode 字段）
    await store.upsertArtifact({
      artifactId: 'pi-art-artificer-code-bearing',
      artifactKind: 'principle',
      sourceTaskId: ARTIFER_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate(i, h) { return { decision: "allow", matched: false, reason: "ok" }; }',
        goldenTraceCases: [{ caseId: 'c-pos', kind: 'positive', toolName: 'write_file', params: { path: '/safe' }, expectedDecision: 'allow' }],
        affectedTools: ['write_file'],
      }),
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    // 更新决策 artifact 的 lineage 指向 code-bearing artificer
    const decision = await store.getArtifactById(ARTIFACT_ID);
    expect(decision).not.toBeNull();
    await store.upsertArtifact({ ...decision!, lineageArtifactIds: ['pi-art-artificer-code-bearing'] });

    const rendered = await buildOwnerDecisionReview({
      getTask: (id) => sm.getTask(id),
      getArtifactById: (id) => store.getArtifactById(id).then((a) => a ?? null),
      listArtifactsBySourceTask: async (id) => (await store.listBySourceTaskId(id)).map((a) => ({
        artifactId: a.artifactId, artifactKind: a.artifactKind, validationStatus: a.validationStatus, contentJson: a.contentJson,
      })),
    }, EVAL_ID);

    expect(rendered).not.toBeNull();
    if (!rendered) return;
    // deterministicStatus = not_run（adversarialResult 缺失）
    expect(rendered.evidence.deterministicChecks[0]?.status).toBe('not_run');
    // code-bearing + not_run → accept_current forbidden（无论具体 reasonCode 是
    // adversarial_hard_gate_not_passed 还是 review_evidence_insufficient）
    expect(rendered.capability.finalOfferedActions).not.toContain('accept_current');
  });
});

// ── D. reviewKey ──────────────────────────────────────────────────────────────

describe('PRI-629 reviewKey (SPEC §6 stale protection)', () => {
  const base = {
    taskId: EVAL_ID, revisionEpoch: 0, sourceRunId: RUN_ID,
    sourceArtifactId: ARTIFACT_ID, sourceArtifactHash: 'a'.repeat(64),
    machineDecision: 'needs_revision', humanReviewReason: 'evaluator_repair_budget_exhausted',
  };
  it('changes when any bound fact changes', () => {
    const k1 = buildOwnerReviewKey(base);
    expect(buildOwnerReviewKey({ ...base, sourceRunId: 'run-other' })).not.toBe(k1);
    expect(buildOwnerReviewKey({ ...base, sourceArtifactHash: 'b'.repeat(64) })).not.toBe(k1);
    expect(buildOwnerReviewKey({ ...base, revisionEpoch: 1 })).not.toBe(k1);
    expect(buildOwnerReviewKey({ ...base, machineDecision: 'rejected' })).not.toBe(k1);
    expect(buildOwnerReviewKey(base)).toBe(k1);
  });
});

// ── E. effective decision resolver (INV-03) ──────────────────────────────────

describe('PRI-629 resolveEffectiveRunnerDecision (single resolution point, §8)', () => {
  const resolution = (status: 'pending' | 'applied', epoch = 0): OwnerResolutionRecord => ({
    resolutionId: 'ores_x', reviewKey: 'odk_k', action: 'accept_current', status,
    ownerId: 'o', decidedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
    sourceArtifactHash: 'h', revisionEpoch: epoch, machineDecision: 'needs_revision',
    effectiveDecision: 'approved',
  });

  it('applied override in current epoch wins; machine runnerDecision never mutated', () => {
    const pi = hydratePITaskRecord(evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision', humanReviewContext: nhrContext(), ownerResolutions: [resolution('applied')],
    }) }))!;
    expect(resolveEffectiveRunnerDecision(pi)).toBe('approved');
    expect(pi.runnerDecision).toBe('needs_revision');
  });

  it('pending override does NOT change effective decision until applied', () => {
    const pi = hydratePITaskRecord(evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision', ownerResolutions: [resolution('pending')],
    }) }))!;
    expect(resolveEffectiveRunnerDecision(pi)).toBe('needs_revision');
  });

  it('stale-epoch override is ignored (new epoch → machine verdict)', () => {
    const pi = hydratePITaskRecord(evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: undefined, revisionCount: 1, ownerResolutions: [resolution('applied', 0)],
    }) }))!;
    expect(resolveEffectiveRunnerDecision(pi)).toBeUndefined();
  });

  it('effectiveDecisionFor maps rollout accept to approve_rollout, never approved (INV-08)', () => {
    expect(effectiveDecisionFor('rollout_reviewer', 'accept_current')).toBe('approve_rollout');
    expect(effectiveDecisionFor('evaluator', 'accept_current')).toBe('approved');
    expect(effectiveDecisionFor('rollout_reviewer', 'reject_current')).toBe('reject');
    expect(effectiveDecisionFor('evaluator', 'reject_current')).toBe('rejected');
    expect(effectiveDecisionFor('evaluator', 'revise_once')).toBeUndefined();
  });
});

// ── F. resolution service ─────────────────────────────────────────────────────

describe('PRI-629 applyOwnerResolution (SPEC §7/§10/§11)', () => {
  async function setup() {
    const artifacts = makeArtifactStoreWithDecisionArtifact();
    const task = evaluatorNhrTask();
    const sm = makeInMemoryStateManager([task, artificerTaskWithPayload(2)], artifacts);
    const factStore: OwnerDecisionFactStore = {
      getTask: (id) => sm.getTask(id),
      listArtifactsBySourceTask: async (id) => (await artifacts.listBySourceTaskId(id)).map((a) => ({
        artifactId: a.artifactId, artifactKind: a.artifactKind, validationStatus: a.validationStatus, contentJson: a.contentJson,
      })),
    };
    const facts = await collectOwnerDecisionFacts(factStore, EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    const hash = facts!.decisionArtifact!.contentHash;
    const req = (action: 'accept_current' | 'revise_once' | 'reject_current', extra: Record<string, unknown> = {}) => ({
      action,
      reviewKey: cap.reviewKey!,
      expectedRevisionEpoch: 0,
      expectedSourceRunId: RUN_ID,
      expectedSourceArtifactId: ARTIFACT_ID,
      expectedSourceArtifactHash: hash,
      ...extra,
    });
    return { sm, req, deps: { stateManager: sm as never, now: () => '2026-08-30T02:00:00.000Z' } };
  }
  const identity = { ownerId: 'owner-1' };

  it('accept_current: pending resolution + atomic flip to pending (runnerWillApply)', async () => {
    const { sm, deps, req } = await setup();
    const outcome = await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('accept_current'), identity });
    expect(outcome.status).toBe('resolved');
    if (outcome.status === 'resolved') {
      expect(outcome.action).toBe('accept_current');
      expect(outcome.effectiveDecision).toBe('approved');
      expect(outcome.runnerWillApply).toBe(true);
    }
    const updated = await sm.getTask(EVAL_ID);
    expect(updated?.status).toBe('pending');
    const pi = hydratePITaskRecord(updated!);
    expect(pi?.runnerDecision).toBe('needs_revision'); // INV-03: machine verdict preserved
    expect(pi?.ownerResolutions?.[0]?.status).toBe('pending');
    expect(pi?.completionIntent?.decision).toBe('needs_revision'); // intent 保留 — runner 恢复门用
  });

  it('same reviewKey + same action → idempotent success (double click safe)', async () => {
    const { sm, deps, req } = await setup();
    const first = await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('reject_current'), identity });
    const second = await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('reject_current'), identity });
    expect(first.status).toBe('resolved');
    expect(second.status).toBe('resolved');
    const pi = hydratePITaskRecord((await sm.getTask(EVAL_ID))!);
    expect(pi?.ownerResolutions?.length).toBe(1); // 无第二条记录
  });

  // ── N-3 端到端: candidate-unresolved rollout 任务的新裁决路径 ──
  // Phase 3 自查补充: 既有 resolution 测试只覆盖 budget-exhausted 场景;
  // 新 eligible 场景 (approve_rollout + candidate-unresolved) 的
  // applyOwnerResolution 全链行为必须同样被锁定。

  async function setupRolloutCandidateUnresolved() {
    const artifacts = makeRolloutArtifactStore();
    const task = rolloutCandidateUnresolvedTask();
    const evaluator = evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({
      channel: 'code_tool_hook',
      runnerDecision: 'approved',
      humanReviewContext: undefined,
      dependencyTaskIds: [ARTIFER_ID],
    }) });
    const sm = makeInMemoryStateManager([task, evaluator, artificerTaskWithPayload(0)], artifacts);
    const factStore: OwnerDecisionFactStore = {
      getTask: (id) => sm.getTask(id),
      listArtifactsBySourceTask: async (id) => (await artifacts.listBySourceTaskId(id)).map((a) => ({
        artifactId: a.artifactId, artifactKind: a.artifactKind, validationStatus: a.validationStatus, contentJson: a.contentJson,
      })),
    };
    const facts = await collectOwnerDecisionFacts(factStore, ROLLOUT_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.eligible).toBe(true); // 前置: 新场景确实 eligible
    const hash = facts!.decisionArtifact!.contentHash;
    const req = (action: 'accept_current' | 'revise_once' | 'reject_current') => ({
      action,
      reviewKey: cap.reviewKey!,
      expectedRevisionEpoch: 0,
      expectedSourceRunId: RUN_ID,
      expectedSourceArtifactId: ARTIFACT_ID,
      expectedSourceArtifactHash: hash,
    });
    return { sm, req, deps: { stateManager: sm as never, now: () => '2026-09-05T10:00:00.000Z' } };
  }

  it('N-3 e2e: reject_current on candidate-unresolved rollout → resolved with effectiveDecision=reject, task requeued', async () => {
    const { sm, deps, req } = await setupRolloutCandidateUnresolved();
    const outcome = await applyOwnerResolution(deps, { taskId: ROLLOUT_ID, request: req('reject_current'), identity });
    expect(outcome.status).toBe('resolved');
    if (outcome.status === 'resolved') {
      expect(outcome.effectiveDecision).toBe('reject'); // rollout 映射 (INV-08)
      expect(outcome.runnerWillApply).toBe(true);
    }
    const updated = await sm.getTask(ROLLOUT_ID);
    expect(updated?.status).toBe('pending'); // 翻回 pending 等 runner resume 门应用
    const pi = hydratePITaskRecord(updated!);
    expect(pi?.runnerDecision).toBe('approve_rollout'); // INV-03: 机器 verdict 不改写
    expect(pi?.ownerResolutions?.[0]?.status).toBe('pending');
  });

  it('N-3 e2e: accept_current on candidate-unresolved rollout is refused by the server (action_not_permitted)', async () => {
    const { deps, req } = await setupRolloutCandidateUnresolved();
    const outcome = await applyOwnerResolution(deps, { taskId: ROLLOUT_ID, request: req('accept_current'), identity });
    expect(outcome.status).toBe('not_decision_capable');
    if (outcome.status === 'not_decision_capable') {
      expect(outcome.blockers).toContain('action_not_permitted:accept_current');
    }
  });

  it('same reviewKey/action with changed lineage evidence digest is not an idempotent replay', async () => {
    const { sm, deps, req } = await setup();
    const decision = await sm.piArtifactStore.getArtifactById(ARTIFACT_ID);
    expect(decision).not.toBeNull();
    await sm.piArtifactStore.upsertArtifact({
      ...decision!,
      lineageArtifactIds: ['pi-art-artificer-old'],
    });
    await sm.piArtifactStore.upsertArtifact({
      artifactId: 'pi-art-artificer-old',
      artifactKind: 'principle',
      sourceTaskId: ARTIFER_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({
        implementationSummary: 'Implementation A',
        affectedTools: ['write_file'],
        risks: [],
      }),
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const firstReview = await buildOwnerDecisionReview(
      reviewStoreFromStateManager(sm as never),
      EVAL_ID,
    );
    expect(firstReview).not.toBeNull();
    const artificer = await sm.piArtifactStore.getArtifactById('pi-art-artificer-old');
    await sm.piArtifactStore.upsertArtifact({
      ...artificer!,
      contentJson: JSON.stringify({
        implementationSummary: 'Implementation B',
        affectedTools: ['write_file'],
        risks: [],
      }),
      updatedAt: '2026-08-30T00:01:00.000Z',
    });
    const secondReview = await buildOwnerDecisionReview(
      reviewStoreFromStateManager(sm as never),
      EVAL_ID,
    );
    expect(secondReview?.reviewKey).toBe(firstReview?.reviewKey);
    expect(secondReview?.evidence.digest).not.toBe(firstReview?.evidence.digest);
    await sm.piArtifactStore.upsertArtifact(artificer!);

    const firstRequest = req('reject_current', {
      expectedEvidenceDigest: firstReview!.evidence.digest,
    });
    const first = await applyOwnerResolution(deps, {
      taskId: EVAL_ID,
      request: firstRequest,
      identity,
    });
    expect(first.status).toBe('resolved');

    await sm.piArtifactStore.upsertArtifact({
      ...artificer!,
      contentJson: JSON.stringify({
        implementationSummary: 'Implementation B',
        affectedTools: ['write_file'],
        risks: [],
      }),
      updatedAt: '2026-08-30T00:01:00.000Z',
    });

    const replay = await applyOwnerResolution(deps, {
      taskId: EVAL_ID,
      request: req('reject_current', {
        expectedEvidenceDigest: secondReview!.evidence.digest,
      }),
      identity,
    });
    expect(replay.status).toBe('stale_owner_decision');
  });

  it('revalidates independently persisted evidence after the CAS read and refuses a raced digest', async () => {
    const { sm, deps, req } = await setup();
    const decision = await sm.piArtifactStore.getArtifactById(ARTIFACT_ID);
    await sm.piArtifactStore.upsertArtifact({
      ...decision!,
      lineageArtifactIds: ['pi-art-artificer-old'],
    });
    await sm.piArtifactStore.upsertArtifact({
      artifactId: 'pi-art-artificer-old',
      artifactKind: 'principle',
      sourceTaskId: ARTIFER_ID,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson: JSON.stringify({ implementationSummary: 'Evidence A', affectedTools: ['write_file'] }),
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const rendered = await buildOwnerDecisionReview(reviewStoreFromStateManager(sm as never), EVAL_ID);
    expect(rendered).not.toBeNull();

    const originalGetTask = sm.getTask.bind(sm);
    let evaluatorReads = 0;
    sm.getTask = async (id: string) => {
      const task = await originalGetTask(id);
      if (id === EVAL_ID && ++evaluatorReads === 3) {
        const artifact = await sm.piArtifactStore.getArtifactById('pi-art-artificer-old');
        await sm.piArtifactStore.upsertArtifact({
          ...artifact!,
          contentJson: JSON.stringify({ implementationSummary: 'Evidence B', affectedTools: ['write_file'] }),
          updatedAt: '2026-08-30T00:01:00.000Z',
        });
      }
      return task;
    };

    const outcome = await applyOwnerResolution(deps, {
      taskId: EVAL_ID,
      request: req('reject_current', { expectedEvidenceDigest: rendered!.evidence.digest }),
      identity,
    });
    expect(outcome.status).toBe('stale_owner_decision');
    const unchanged = hydratePITaskRecord((await originalGetTask(EVAL_ID))!);
    expect(unchanged?.status).toBe('needs_human_review');
    expect(unchanged?.ownerResolutions).toBeUndefined();
  });

  it('does not persist when evidence changes after the final review rebuild but before the task mutation', async () => {
    const { sm, deps, req } = await setup();
    const rendered = await buildOwnerDecisionReview(reviewStoreFromStateManager(sm as never), EVAL_ID);
    expect(rendered).not.toBeNull();

    const originalAtomicUpdate = sm.updateTaskIfDiagnosticJsonAndArtifactsUnchanged.bind(sm);
    let intercepted = false;
    sm.updateTaskIfDiagnosticJsonAndArtifactsUnchanged = async (...args) => {
      if (!intercepted) {
        intercepted = true;
        const decision = await sm.piArtifactStore.getArtifactById(ARTIFACT_ID);
        await sm.piArtifactStore.upsertArtifact({
          ...decision!,
          contentJson: JSON.stringify({ changedAfterFinalReview: true }),
          updatedAt: '2026-08-30T00:02:00.000Z',
        });
      }
      return originalAtomicUpdate(...args);
    };

    const outcome = await applyOwnerResolution(deps, {
      taskId: EVAL_ID,
      request: req('reject_current', { expectedEvidenceDigest: rendered!.evidence.digest }),
      identity,
    });

    expect(intercepted).toBe(true);
    expect(outcome.status).toBe('stale_owner_decision');
    const unchanged = hydratePITaskRecord((await sm.getTask(EVAL_ID))!);
    expect(unchanged?.status).toBe('needs_human_review');
    expect(unchanged?.ownerResolutions).toBeUndefined();
  });

  it('same reviewKey + different action → already_resolved (conflict)', async () => {
    const { deps, req } = await setup();
    await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('accept_current'), identity });
    const conflict = await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('reject_current'), identity });
    expect(conflict).toEqual({ status: 'already_resolved', existingAction: 'accept_current' });
  });

  it('stale reviewKey (artifact changed) → stale_owner_decision', async () => {
    const { deps, req } = await setup();
    const outcome = await applyOwnerResolution(deps, {
      taskId: EVAL_ID,
      // 浏览器持有旧 hash
      request: req('accept_current', { expectedSourceArtifactHash: 'deadbeef'.repeat(8) }),
      identity,
    });
    expect(outcome.status).toBe('stale_owner_decision');
  });

  it('revise_once: reopens the latest repair artificer with owner-res causeId; repairIteration stays 2 (§11)', async () => {
    const { sm, deps, req } = await setup();
    const outcome = await applyOwnerResolution(deps, { taskId: EVAL_ID, request: req('revise_once', { ownerInstruction: '不要增加新要求，只处理上一轮未解决问题。' }), identity });
    expect(outcome.status).toBe('resolved');
    if (outcome.status === 'resolved') {
      expect(outcome.applied).toBe(true);
      expect(outcome.targetTaskId).toBe(ARTIFER_ID);
    }
    // 目标 artificer 被 reopen: revisionCount+1、causeId、反馈注入
    const artPi = hydratePITaskRecord((await sm.getTask(ARTIFER_ID))!);
    expect(artPi?.revisionCount).toBe(1);
    expect(artPi?.revisionCauseId).toMatch(/^owner-res-ores_/);
    expect(artPi?.revisionFeedback).toContain('不要增加新要求');
    // repairPayload.repairIteration 保持 2 — 自动预算永不增加 (INV-07)
    expect(artPi?.repairPayload?.repairIteration).toBe(2);
    // evaluator 任务留在 NHR,resolution applied → 不再出现在 inbox
    const evalPi = hydratePITaskRecord((await sm.getTask(EVAL_ID))!);
    expect(evalPi?.status).toBe('needs_human_review');
    expect(evalPi?.ownerResolutions?.[0]?.status).toBe('applied');
  });

  it('P1 review: action outside allowedActions → not_decision_capable (server-side enforcement)', async () => {
    // hard gate 失败 → capability 只允许 revise_once/reject_current
    const gateStore = makeArtifactStoreWithDecisionArtifact({
      taskId: EVAL_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-old',
      evaluation: {
        decision: 'needs_revision', summary: 's', score: 0.7,
        strengths: [], concerns: ['c'], requiredChanges: ['fix'],
      },
      sourceTrace: { artificerArtifactId: 'pi-art-artificer-old' },
      risks: [], generatedAt: 't',
      adversarialResult: { passed: false, failedCases: [] },
    });
    const task = evaluatorNhrTask();
    const sm = makeInMemoryStateManager([task, artificerTaskWithPayload(2)], gateStore);
    const factStore: OwnerDecisionFactStore = {
      getTask: (id) => sm.getTask(id),
      listArtifactsBySourceTask: async (id) => (await gateStore.listBySourceTaskId(id)).map((a) => ({
        artifactId: a.artifactId, artifactKind: a.artifactKind, validationStatus: a.validationStatus, contentJson: a.contentJson,
      })),
    };
    const facts = await collectOwnerDecisionFacts(factStore, EVAL_ID);
    const cap = deriveOwnerDecisionCapability(facts!);
    expect(cap.allowedActions).not.toContain('accept_current');
    const hash = facts!.decisionArtifact!.contentHash;
    const outcome = await applyOwnerResolution(
      { stateManager: sm as never, now: () => '2026-08-30T02:00:00.000Z' },
      {
        taskId: EVAL_ID,
        request: {
          action: 'accept_current', reviewKey: cap.reviewKey!,
          expectedRevisionEpoch: 0, expectedSourceRunId: RUN_ID,
          expectedSourceArtifactId: ARTIFACT_ID, expectedSourceArtifactHash: hash,
        },
        identity,
      },
    );
    expect(outcome.status).toBe('not_decision_capable');
    if (outcome.status === 'not_decision_capable') {
      expect(outcome.blockers.some((b) => b.startsWith('action_not_permitted:'))).toBe(true);
    }
    // 任务未被重启
    expect((await sm.getTask(EVAL_ID))?.status).toBe('needs_human_review');
  });

  it('sanitizeOwnerInstruction bounds and strips control characters (§13)', () => {
    expect(sanitizeOwnerInstruction(undefined)).toBeUndefined();
    expect(sanitizeOwnerInstruction('   ')).toBeUndefined();
    expect(sanitizeOwnerInstruction(42)).toBeUndefined();
    expect(sanitizeOwnerInstruction('a\u0000b')).toBe('a b');
    expect(sanitizeOwnerInstruction('x'.repeat(900))!.length).toBe(500);
  });
});

// ── G. Recover guard ──────────────────────────────────────────────────────────

describe('PRI-629 Recover guard (SPEC §17/INV-06)', () => {
  it('decision-capable NHR → rejected with owner_decision_required + nextAction', async () => {
    const artifacts = makeArtifactStoreWithDecisionArtifact();
    const sm = makeInMemoryStateManager([evaluatorNhrTask(), artificerTaskWithPayload(2)], artifacts);
    const outcome = await ownerRetryNeedsHumanReviewTask(sm as never, EVAL_ID);
    expect(outcome).toEqual({
      status: 'rejected', taskKind: 'evaluator', previousStatus: 'needs_human_review',
      reason: 'owner_decision_required', nextAction: 'open_governance_focus',
    });
    // 任务未被改动
    expect((await sm.getTask(EVAL_ID))?.status).toBe('needs_human_review');
  });

  it('P0 review: applied-only resolution + recovery NHR → Recover allowed (technical retry)', async () => {
    const artifacts = makeArtifactStoreWithDecisionArtifact();
    const appliedRes = {
      resolutionId: 'ores_applied', reviewKey: 'odk_prev', action: 'accept_current' as const, status: 'applied' as const,
      ownerId: 'o', decidedAt: 't', appliedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision' as const,
    };
    const task = evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision',
      humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.rolloutDispatchNotWired),
      ownerResolutions: [appliedRes],
    }) });
    const sm = makeInMemoryStateManager([task, artificerTaskWithPayload(2)], artifacts);
    const outcome = await ownerRetryNeedsHumanReviewTask(sm as never, EVAL_ID);
    expect(outcome.status).toBe('requeued');
  });

  it('P0 review: pending resolution + recovery NHR → Recover still refused (runner will apply)', async () => {
    const artifacts = makeArtifactStoreWithDecisionArtifact();
    const pendingRes = {
      resolutionId: 'ores_pending', reviewKey: 'odk_prev', action: 'accept_current' as const, status: 'pending' as const,
      ownerId: 'o', decidedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision' as const,
    };
    const task = evaluatorNhrTask({ meta: baseMeta({
      runnerDecision: 'needs_revision',
      humanReviewContext: nhrContext(HUMAN_REVIEW_REASON.rolloutDispatchNotWired),
      ownerResolutions: [pendingRes],
    }) });
    const sm = makeInMemoryStateManager([task, artificerTaskWithPayload(2)], artifacts);
    const outcome = await ownerRetryNeedsHumanReviewTask(sm as never, EVAL_ID);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toBe('owner_decision_required');
    }
  });

  it('ambiguous legacy (no decision facts) → recover remains allowed', async () => {
    const artifacts = makeArtifactStoreWithDecisionArtifact();
    // 无 repairPayload 的首轮 artificer + 无 context → 不可判定 → 不阻断
    const artificerFirstRound = {
      ...artificerTaskWithPayload(2),
      diagnosticJson: createPITaskDiagnosticJson(baseMeta({ dependencyTaskIds: [SCRIBE_ID] })),
    };
    const task = evaluatorNhrTask({ meta: baseMeta({ runnerDecision: 'needs_revision', humanReviewContext: undefined }) });
    const sm = makeInMemoryStateManager([task, artificerFirstRound], artifacts);
    const outcome = await ownerRetryNeedsHumanReviewTask(sm as never, EVAL_ID);
    expect(outcome.status).toBe('requeued');
  });
});

// ── H. epoch-aware repair causeId (P0, SPEC §12) ─────────────────────────────

describe('PRI-629 buildRepairRevisionCauseId (P0)', () => {
  it('rc0 keeps legacy format; owner revision epochs get -rcN suffix', () => {
    const t0 = hydratePITaskRecord(artificerTaskWithPayload(2))!;
    expect(buildRepairRevisionCauseId(t0)).toBe(`repair-${ARTIFER_ID}`);
    const t1 = hydratePITaskRecord({ ...artificerTaskWithPayload(2), diagnosticJson: createPITaskDiagnosticJson(baseMeta({
      dependencyTaskIds: [SCRIBE_ID], revisionCount: 1,
      repairPayload: budgetExhaustedRepairPayload(),
    })) })!;
    expect(buildRepairRevisionCauseId(t1)).toBe(`repair-${ARTIFER_ID}-rc1`);
  });
});

// ── I. transition arbitration uses effective decision ─────────────────────────

describe('PRI-629 transition arbitration consumes effective decision (§8)', () => {
  it('accept_current applied → evaluator ADVANCE; machine needs_revision would have been REVISION_REQUIRED', () => {
    const withOverride = hydratePITaskRecord(evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({
      runnerDecision: 'needs_revision',
      ownerResolutions: [{
        resolutionId: 'ores_x', reviewKey: 'odk_k', action: 'accept_current', status: 'applied',
        ownerId: 'o', decidedAt: 't', appliedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
        sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision', effectiveDecision: 'approved',
      }],
    }) }))!;
    const transition = decideInternalizationTransition(transitionInputFromTask(withOverride));
    expect(transition.kind).toBe('ADVANCE');

    const withoutOverride = hydratePITaskRecord(evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({
      runnerDecision: 'needs_revision',
    }) }))!;
    expect(decideInternalizationTransition(transitionInputFromTask(withoutOverride)).kind).toBe('REVISION_REQUIRED');
  });

  it('rollout reject_current applied → TERMINAL_REJECT; accept_current → ADVANCE (dispatch side)', () => {
    const res = (action: 'accept_current' | 'reject_current', eff: string): OwnerResolutionRecord => ({
      resolutionId: 'ores_x', reviewKey: 'odk_k', action, status: 'applied',
      ownerId: 'o', decidedAt: 't', appliedAt: 't', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID,
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision',
      effectiveDecision: eff as OwnerResolutionRecord['effectiveDecision'],
    });
    const mk = (r: OwnerResolutionRecord) => hydratePITaskRecord({
      taskId: 'rollout-1', taskKind: 'rollout_reviewer', status: 'succeeded',
      attemptCount: 1, maxAttempts: 3, createdAt: 't', updatedAt: 't',
      diagnosticJson: createPITaskDiagnosticJson(baseMeta({
        dependencyTaskIds: [EVAL_ID], runnerDecision: 'needs_revision', ownerResolutions: [r],
      })),
    })!;
    expect(decideInternalizationTransition(transitionInputFromTask(mk(res('accept_current', 'approve_rollout')))).kind).toBe('ADVANCE');
    expect(decideInternalizationTransition(transitionInputFromTask(mk(res('reject_current', 'reject')))).kind).toBe('TERMINAL_REJECT');
  });

  it('planOwnerVerdictOverrideResume picks latest epoch-matched override; revise_once ignored', () => {
    const pi = hydratePITaskRecord(evaluatorNhrTask({ meta: baseMeta({
      ownerResolutions: [
        { resolutionId: 'a', reviewKey: 'k1', action: 'revise_once', status: 'applied', ownerId: 'o', decidedAt: '2026-01-01T00:00:00Z', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID, sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision' },
        { resolutionId: 'b', reviewKey: 'k2', action: 'accept_current', status: 'pending', ownerId: 'o', decidedAt: '2026-01-02T00:00:00Z', sourceRunId: RUN_ID, sourceArtifactId: ARTIFACT_ID, sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision', effectiveDecision: 'approved' },
      ],
    }) }))!;
    const plan = planOwnerVerdictOverrideResume(pi);
    expect(plan?.resolution.resolutionId).toBe('b');
    expect(plan?.overrideDecision).toBe('approved');
  });
});

describe('PRI-629 P1 review: reopen crash-window idempotency (same cause, terminal residue)', () => {
  it('same revisionCauseId on a terminal task → true no-op (revisionCount unchanged)', async () => {
    // 模拟双写中断残留: metadata 已写 causeId/revisionCount,但 status 仍是 terminal
    const crashed = {
      ...artificerTaskWithPayload(2),
      status: 'succeeded' as const,
      diagnosticJson: createPITaskDiagnosticJson(baseMeta({
        dependencyTaskIds: [SCRIBE_ID],
        revisionCount: 1,
        revisionCauseId: 'owner-res-ores_x',
        repairPayload: budgetExhaustedRepairPayload(),
      })),
    };
    const store = new MemoryTaskStore();
    void store.createTask({ ...crashed });
    const sm = {
      async getTask(id: string) { return store.getTask(id); },
      async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
      async updateTask(id: string, patch: Record<string, unknown>) { return store.updateTask(id, patch); },
    };
    const outcome = await reopenTaskForRevision(sm as never, ARTIFER_ID, {
      revisionCauseId: 'owner-res-ores_x',
      reason: 'owner_revise_once',
    });
    expect(outcome.ok).toBe(true);
    const after = hydratePITaskRecord((await store.getTask(ARTIFER_ID))!);
    expect(after?.revisionCount).toBe(1); // 不再 +1
    expect(after?.revisionCauseId).toBe('owner-res-ores_x');
  });

  it('reopen is a SINGLE task-row mutation (status+attemptCount+metadata together)', async () => {
    const store = new MemoryTaskStore();
    void store.createTask({ ...artificerTaskWithPayload(2) });
    const writes: Record<string, unknown>[] = [];
    const sm = {
      async getTask(id: string) { return store.getTask(id); },
      async updateTaskDiagnosticJson(id: string, json: string) {
        writes.push({ op: 'diagnostic_only' });
        await store.updateTask(id, { diagnosticJson: json });
      },
      async updateTask(id: string, patch: Record<string, unknown>) {
        writes.push(patch);
        return store.updateTask(id, patch);
      },
    };
    await reopenTaskForRevision(sm as never, ARTIFER_ID, {
      revisionCauseId: 'owner-res-ores_y',
      reason: 'owner_revise_once',
    });
    // 不允许"只写 metadata"的中间态 mutation
    expect(writes.some((w) => 'op' in w)).toBe(false);
    const mutating = writes.filter((w) => !('op' in w));
    expect(mutating).toHaveLength(1);
    const single = mutating[0]!;
    expect(single.status).toBe('pending');
    expect(single.attemptCount).toBe(0);
    expect(typeof single.diagnosticJson).toBe('string');
    const after = hydratePITaskRecord((await store.getTask(ARTIFER_ID))!);
    expect(after?.status).toBe('pending');
    expect(after?.revisionCount).toBe(1);
  });
});

// ── N. rollout revision target routing (shared implementation) ────────────────

describe('PRI-629 resolveRolloutRevisionTarget (§18 routing)', () => {
  it('code_tool_hook routes to artificer; other channels route to scribe', async () => {
    const scribe: TaskRecord = { taskId: SCRIBE_ID, taskKind: 'scribe', status: 'succeeded', attemptCount: 0, maxAttempts: 3, createdAt: 't', updatedAt: 't', diagnosticJson: createPITaskDiagnosticJson(baseMeta({ dependencyTaskIds: [] })) };
    const artificer = artificerTaskWithPayload(2);
    const evaluator = evaluatorNhrTask({ status: 'succeeded', meta: baseMeta({ dependencyTaskIds: [ARTIFER_ID] }) });
    const rollout: TaskRecord = {
      taskId: 'rollout-1', taskKind: 'rollout_reviewer', status: 'needs_human_review',
      attemptCount: 1, maxAttempts: 3, createdAt: 't', updatedAt: 't',
      diagnosticJson: createPITaskDiagnosticJson(baseMeta({ dependencyTaskIds: [EVAL_ID], channel: 'code_tool_hook' })),
    };
    const allTasks: TaskRecord[] = [scribe, artificer, evaluator, rollout];
    const getTask = async (id: string): Promise<TaskRecord | null> => allTasks.find((t) => t.taskId === id) ?? null;
    expect(await resolveRolloutRevisionTarget(getTask, 'rollout-1', 'code_tool_hook')).toEqual({ taskId: ARTIFER_ID, kind: 'artificer' });
    expect(await resolveRolloutRevisionTarget(getTask, 'rollout-1', 'prompt')).toEqual({ taskId: SCRIBE_ID, kind: 'scribe' });
  });
});

describe('PRI-630 P1 review: deriveRequirementLedger (stable requirement identity across rounds)', () => {
  it('round with echoed ledger: open items keep ids; non-exact restatement becomes new entry', () => {
    const ledger = deriveRequirementLedger(
      [
        { id: 'req-1', statement: 'A', status: 'resolved' },
        { id: 'req-2', statement: 'B', status: 'still_open' },
      ],
      ['B (reworded)', 'new blocker C'],
    );
    // 核心: req-2 保留原 id 与原 statement (身份不漂移);非精确改述作为
    // 新条目 (可预测 — 文本模糊匹配在 LLM 改述上不可靠)
    expect(ledger).toEqual([
      { id: 'req-2', statement: 'B', status: 'still_open' },
      { id: 'req-3', statement: 'B (reworded)', status: 'new' },
      { id: 'req-4', statement: 'new blocker C', status: 'new' },
    ]);
  });

  it('regressed items keep ids too; exact-duplicate restatements are not re-added', () => {
    const ledger = deriveRequirementLedger(
      [
        { id: 'req-2', statement: 'fix timeout', status: 'regressed' },
        { id: 'req-5', statement: 'add retry', status: 'still_open' },
      ],
      ['fix timeout', 'add retry backoff'],
    );
    expect(ledger.map((e) => e.id)).toEqual(['req-2', 'req-5', 'req-6']);
    expect(ledger[2]).toEqual({ id: 'req-6', statement: 'add retry backoff', status: 'new' });
    // 'fix timeout' 精确重复 carried → 不再作为新条目
    expect(ledger.some((e) => e.statement === 'fix timeout' && e.status === 'new')).toBe(false);
  });

  it('no ledger (first repair round): sequential numbering from requiredChanges', () => {
    expect(deriveRequirementLedger(undefined, ['X', 'Y'])).toEqual([
      { id: 'req-1', statement: 'X', status: 'new' },
      { id: 'req-2', statement: 'Y', status: 'new' },
    ]);
  });
});

// ── K. evaluator convergence schema invariant (SPEC §18.4) ────────────────────

describe('PRI-630 evaluator convergence invariants', () => {
  const validator = new DefaultEvaluatorValidator();
  const baseOutput = (decision: string, requiredChanges: string[]) => ({
    taskId: EVAL_ID,
    sourceArtificerArtifactId: 'pi-art-artificer-old',
    evaluation: {
      decision, summary: 's', score: 0.7, strengths: [], concerns: ['c'], requiredChanges,
    },
    sourceTrace: { artificerArtifactId: 'pi-art-artificer-old' },
    risks: [], generatedAt: 't',
  });

  it('needs_revision with empty requiredChanges → validator rejects (裁决与依据脱节)', async () => {
    const result = await validator.validate(baseOutput('needs_revision', []), EVAL_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('PRI-630');
  });

  it('approved/rejected with empty requiredChanges remain valid; valid statuses array accepted', async () => {
    expect((await validator.validate(baseOutput('approved', []), EVAL_ID)).valid).toBe(true);
    const withStatuses = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: [{ id: 'req-1', status: 'still_open' as const }],
      },
    };
    const result = await validator.validate(withStatuses, EVAL_ID);
    expect(result.valid).toBe(true);
  });

  // ── 评审轮 2 P1: requirementLedger 收紧为 validator-enforced contract ──
  // convergence context 携带 authoritative expected {id, statement};
  // repair round 必须同时输出 statuses + ledger,且二者互洽。
  const EXPECTED = [
    { id: 'req-1', statement: 'fix timeout handling' },
    { id: 'req-2', statement: 'add retry backoff' },
  ];
  const okStatuses = [
    { id: 'req-1', status: 'resolved' as const },
    { id: 'req-2', status: 'still_open' as const },
  ];
  const okLedger = [
    { id: 'req-1', statement: 'fix timeout handling', status: 'resolved' as const },
    { id: 'req-2', statement: 'add retry backoff', status: 'still_open' as const },
  ];

  it('R2: repair round missing priorRequirementStatuses → rejected', async () => {
    const result = await validator.validate(baseOutput('needs_revision', ['fix']), EVAL_ID, undefined, {
      expectedRequirements: EXPECTED,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('priorRequirementStatuses');
  });

  it('R2: repair round missing requirementLedger entirely → rejected (no longer prompt-only)', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: okStatuses,
        // requirementLedger 缺失 — LLM 忘了输出也必须被机器拒绝
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('requirementLedger');
  });

  it('R2: statuses partial coverage → rejected with the missing id named', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: [okStatuses[0]!],
        requirementLedger: okLedger,
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('req-2');
  });

  it('R2: statuses duplicate id → rejected (each expected id exactly once)', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: [okStatuses[0]!, okStatuses[0]!, okStatuses[1]!],
        requirementLedger: okLedger,
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('req-1');
  });

  it('R2: ledger renumbered (req-2 renamed to req-9) → rejected as missing + unexpected id', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: okStatuses,
        requirementLedger: [
          okLedger[0]!,
          { id: 'req-9', statement: 'add retry backoff', status: 'still_open' },
        ],
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    const errs = result.errors.join('; ');
    expect(errs).toContain('req-2'); // 缺失
    expect(errs).toContain('req-9'); // 幻觉/重编号 id 不允许
  });

  it('R2: ledger statement drift → rejected (must match authoritative context verbatim)', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: okStatuses,
        requirementLedger: [
          okLedger[0]!,
          { id: 'req-2', statement: 'add retry backoff (paraphrased)', status: 'still_open' },
        ],
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('req-2');
    expect(result.errors.join('; ')).toContain('statement');
  });

  it('R2: ledger status inconsistent with priorRequirementStatuses → rejected', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: okStatuses,
        requirementLedger: [
          okLedger[0]!,
          { id: 'req-2', statement: 'add retry backoff', status: 'resolved' }, // statuses 说 still_open
        ],
      },
    };
    const result = await validator.validate(out, EVAL_ID, undefined, { expectedRequirements: EXPECTED });
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('req-2');
    expect(result.errors.join('; ')).toContain('status');
  });

  it('R2: fully compliant statuses + ledger → valid; first round (no convergence) unaffected', async () => {
    const out = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: okStatuses,
        requirementLedger: okLedger,
      },
    };
    expect((await validator.validate(out, EVAL_ID, undefined, {
      expectedRequirements: EXPECTED,
    })).valid).toBe(true);
    // 第一轮: 未提供 convergence 上下文 → 两者皆省略仍合法
    expect((await validator.validate(baseOutput('needs_revision', ['fix']), EVAL_ID)).valid).toBe(true);
  });

  it('malformed priorRequirementStatuses rejected (rc-1/rc-4)', async () => {
    const bad = {
      ...baseOutput('needs_revision', ['fix']),
      evaluation: {
        ...baseOutput('needs_revision', ['fix']).evaluation,
        priorRequirementStatuses: [{ id: 'req-1', status: 'done' }],
      },
    };
    const result = await validator.validate(bad, EVAL_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('priorRequirementStatuses');
  });
});
