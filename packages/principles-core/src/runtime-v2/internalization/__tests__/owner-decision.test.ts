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
import { applyOwnerResolution, sanitizeOwnerInstruction } from '../owner-resolution-service.js';
import { buildRepairRevisionCauseId, resolveRolloutRevisionTarget } from '../revision-reopen.js';
import { decideInternalizationTransition, transitionInputFromTask } from '../internalization-transition-decision.js';
import { ownerRetryNeedsHumanReviewTask } from '../owner-retry.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
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
      sourceArtifactHash: 'h', revisionEpoch: 0, machineDecision: 'needs_revision',
    };
    const json = serializePITaskMetadata(baseMeta({ ownerResolutions: [bad] }));
    expect(parsePITaskMetadata(json)).toBeNull();
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
