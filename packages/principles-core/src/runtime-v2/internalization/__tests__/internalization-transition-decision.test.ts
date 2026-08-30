/**
 * P0-D/E 回归测试: needs_revision 的单一迁移决策
 * (MVP_CORE_LOOP_CONTRACT INV-02 / Gate B)。
 *
 * 审计背景 (ISSUE-005): 修复前 evaluator needs_revision → task succeeded →
 * auto-consumer 无差别 commitNextTaskProposal → 错误并行 seed rollout_reviewer;
 * 即使打开 repair flag, repair_seeded 仍 fall through 到 succeeded → 双播种。
 * 修复后 commitNextTaskProposal 以 InternalizationTransitionDecision 仲裁。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import { decideInternalizationTransition, transitionInputFromTask } from '../internalization-transition-decision.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson } from '../pitask-metadata.js';
import type { PITaskMetadata, RepairPayload } from '../pitask-metadata.js';

// ── 纯决策单元 ───────────────────────────────────────────────────────────────

describe('decideInternalizationTransition (pure)', () => {
  it('evaluator approved → ADVANCE', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', runnerDecision: 'approved', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'ADVANCE' });
  });

  it('evaluator needs_revision → REVISION_REQUIRED (绝不 ADVANCE)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', runnerDecision: 'needs_revision', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'REVISION_REQUIRED' });
  });

  it('evaluator rejected → TERMINAL_REJECT', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', runnerDecision: 'rejected', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'TERMINAL_REJECT' });
  });

  it('rollout approve_rollout → ADVANCE (dispatch 语义)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'rollout_reviewer', taskStatus: 'succeeded', runnerDecision: 'approve_rollout', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'ADVANCE' });
  });

  it('rollout needs_revision → REVISION_REQUIRED (绝不进 approval)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'rollout_reviewer', taskStatus: 'succeeded', runnerDecision: 'needs_revision', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'REVISION_REQUIRED' });
  });

  it('rollout reject → TERMINAL_REJECT (无 activation)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'rollout_reviewer', taskStatus: 'succeeded', runnerDecision: 'reject', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'TERMINAL_REJECT' });
  });

  it('artificer repair 任务完成 → REOPEN_SOURCE_EVALUATOR', () => {
    expect(decideInternalizationTransition({
      taskKind: 'artificer', taskStatus: 'succeeded', isRepairTask: true, revisionCount: 0,
    })).toMatchObject({ kind: 'REOPEN_SOURCE_EVALUATOR' });
  });

  it('needs_human_review → HUMAN_REVIEW_REQUIRED (有 Owner 出边, 不 seed 后继)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'needs_human_review', isRepairTask: false, revisionCount: 2,
    })).toMatchObject({ kind: 'HUMAN_REVIEW_REQUIRED' });
  });

  it('非决策型 runner (dreamer/scribe/artificer 常规) → ADVANCE', () => {
    for (const kind of ['dreamer', 'philosopher', 'scribe', 'artificer']) {
      expect(decideInternalizationTransition({
        taskKind: kind, taskStatus: 'succeeded', isRepairTask: false, revisionCount: 0,
      })).toMatchObject({ kind: 'ADVANCE' });
    }
  });

  it('P0-3: 无 durable verdict 且无 legacy verdict → BLOCKED_MISSING_VERDICT (fail-closed)', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'BLOCKED_MISSING_VERDICT' });
    expect(decideInternalizationTransition({
      taskKind: 'rollout_reviewer', taskStatus: 'succeeded', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'BLOCKED_MISSING_VERDICT' });
  });

  it('P0-3: 显式 legacy verdict (runs.output_payload) 是唯一回退判据', () => {
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', legacyRunnerDecision: 'needs_revision', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'REVISION_REQUIRED' });
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', legacyRunnerDecision: 'approved', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'ADVANCE' });
    // 非法 legacy 值不作为判据 → 阻断
    expect(decideInternalizationTransition({
      taskKind: 'evaluator', taskStatus: 'succeeded', legacyRunnerDecision: 'yolo', isRepairTask: false, revisionCount: 0,
    })).toMatchObject({ kind: 'BLOCKED_MISSING_VERDICT' });
  });
});

// ── Orchestrator commit 门 (Journey 5/6/7 断言基础) ─────────────────────────

function makeMeta(overrides: Partial<PITaskMetadata> = {}): PITaskMetadata {
  return {
    dependencyTaskIds: [],
    channel: 'prompt',
    timeoutMs: 60_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  };
}

function makeTask(overrides: {
  taskId: string; taskKind: string; status: string; meta?: PITaskMetadata;
}): TaskRecord {
  return {
    taskId: overrides.taskId,
    taskKind: overrides.taskKind,
    status: overrides.status as TaskRecord['status'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson(overrides.meta ?? makeMeta()),
  };
}

function makeRepairPayload(iteration: number, evaluatorTaskId: string): RepairPayload {
  return {
    requiredChanges: ['fix the guard clause'],
    concerns: [],
    previousScore: 0.4,
    repairIteration: iteration,
    sourceArtificerArtifactId: 'pi-art-src-1',
    sourceEvaluatorTaskId: evaluatorTaskId,
  };
}

describe('InternalizationOrchestrator.commitNextTaskProposal — transition gate', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockStateManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let OrchestratorClass: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStateManager = {
      listTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue(null),
      acquireLease: vi.fn(),
      createTask: vi.fn().mockImplementation(async (input: { taskId: string; taskKind: string; status?: string; diagnosticJson?: string }) => makeTask({
        taskId: input.taskId, taskKind: input.taskKind, status: 'pending',
      })),
      updateTask: vi.fn().mockResolvedValue(undefined),
      updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined),
    };
    const mod = await import('../internalization-orchestrator.js');
    OrchestratorClass = mod.InternalizationOrchestrator;
  });

  function makeOrchestrator(): InstanceType<typeof OrchestratorClass> {
    return new OrchestratorClass(
      { stateManager: mockStateManager },
      { owner: 'test', runtimeKind: 'test', dryRun: true },
    );
  }

  it('Journey-5 核心断言: evaluator needs_revision → blocked_by_revision, 绝不 seed rollout_reviewer', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-1-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'needs_revision', dependencyTaskIds: ['artificer-cand-1-prompt'] }),
    });
    mockStateManager.getTask.mockResolvedValue(evaluatorTask);

    const result = await makeOrchestrator().commitNextTaskProposal('evaluator-cand-1-prompt');

    expect(result.decision).toBe('blocked_by_revision');
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('evaluator approved → 正常 seed rollout_reviewer', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-2-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'approved', correlationId: 'cand-2' }),
    });
    mockStateManager.getTask.mockResolvedValue(evaluatorTask);
    mockStateManager.listTasks.mockResolvedValue([]);

    const result = await makeOrchestrator().commitNextTaskProposal('evaluator-cand-2-prompt');

    expect(result.decision).toBe('successor_created');
    expect(mockStateManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskKind: 'rollout_reviewer', status: 'pending' }),
    );
  });

  it('evaluator rejected → blocked_by_rejection, 无后继', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-3-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'rejected' }),
    });
    mockStateManager.getTask.mockResolvedValue(evaluatorTask);

    const result = await makeOrchestrator().commitNextTaskProposal('evaluator-cand-3-prompt');

    expect(result.decision).toBe('blocked_by_rejection');
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('artificer repair 完成 → revision_reopened: 来源 evaluator 被重开且 dep 指向 repair 任务', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-4-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ dependencyTaskIds: ['artificer-cand-4-prompt', 'scribe-cand-4-prompt'] }),
    });
    const originalArtificer = makeTask({
      taskId: 'artificer-cand-4-prompt', taskKind: 'artificer', status: 'succeeded',
      meta: makeMeta({ dependencyTaskIds: ['scribe-cand-4-prompt'] }),
    });
    const repairTask = makeTask({
      taskId: 'artificer-repair-xyz', taskKind: 'artificer', status: 'succeeded',
      meta: makeMeta({ repairPayload: makeRepairPayload(1, 'evaluator-cand-4-prompt') }),
    });
    mockStateManager.getTask.mockImplementation(async (id: string) => {
      if (id === 'artificer-repair-xyz') return repairTask;
      if (id === 'evaluator-cand-4-prompt') return evaluatorTask;
      if (id === 'artificer-cand-4-prompt') return originalArtificer;
      return null;
    });

    const result = await makeOrchestrator().commitNextTaskProposal('artificer-repair-xyz');

    expect(result.decision).toBe('revision_reopened');
    expect(result.reopenedTaskId).toBe('evaluator-cand-4-prompt');
    // evaluator 被单次 task-row mutation 更新: pending + attemptCount 重置 + metadata
    // (P1 评审修复: 单行原子写,消除 metadata/status 两写 crash 窗口)
    const reopenCall1 = (mockStateManager.updateTask.mock.calls as Array<[string, { status?: string; attemptCount?: number; diagnosticJson?: string }]>).find(
      (c) => c[0] === 'evaluator-cand-4-prompt',
    )?.[1];
    expect(reopenCall1?.status).toBe('pending');
    expect(reopenCall1?.attemptCount).toBe(0);
    // dep 替换: 原 artificer dep 移除, repair 任务成为唯一 artificer dep
    const writtenJson = reopenCall1?.diagnosticJson as string;
    const parsed = JSON.parse(writtenJson) as { pi_metadata: { dependencyTaskIds: string[]; revisionCount?: number } };
    expect(parsed.pi_metadata.dependencyTaskIds).toContain('artificer-repair-xyz');
    expect(parsed.pi_metadata.dependencyTaskIds).not.toContain('artificer-cand-4-prompt');
    expect(parsed.pi_metadata.dependencyTaskIds).toContain('scribe-cand-4-prompt'); // scribe 依赖保留
    expect(parsed.pi_metadata.revisionCount).toBe(1);
    // 没有创建任何正常 successor (evaluator 已在同 lineage)
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('revision wave 级联: evaluator(revisionCount>0) re-succeed → 已 succeeded 的 rollout 被 reopen', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-5-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'approved', correlationId: 'cand-5', revisionCount: 1 }),
    });
    const rolloutTask = makeTask({
      taskId: 'rollout_reviewer-cand-5-prompt', taskKind: 'rollout_reviewer', status: 'succeeded',
      meta: makeMeta({ dependencyTaskIds: ['evaluator-cand-5-prompt'] }),
    });
    mockStateManager.getTask.mockImplementation(async (id: string) => {
      if (id === 'evaluator-cand-5-prompt') return evaluatorTask;
      if (id === 'rollout_reviewer-cand-5-prompt') return rolloutTask;
      return null;
    });

    const result = await makeOrchestrator().commitNextTaskProposal('evaluator-cand-5-prompt');

    expect(result.decision).toBe('successor_reopened');
    expect(result.reopenedTaskId).toBe('rollout_reviewer-cand-5-prompt');
    const reopenCall2 = (mockStateManager.updateTask.mock.calls as Array<[string, { status?: string; attemptCount?: number; diagnosticJson?: string }]>).find(
      (c) => c[0] === 'rollout_reviewer-cand-5-prompt',
    )?.[1];
    expect(reopenCall2?.status).toBe('pending');
    expect(reopenCall2?.attemptCount).toBe(0);
    expect(typeof reopenCall2?.diagnosticJson).toBe('string');
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
  });

  it('无 revision 的幂等重扫: succeeded 后继存在 → successor_exists (不级联, 保持旧行为)', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-6-prompt', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'approved', correlationId: 'cand-6' }),
    });
    const rolloutTask = makeTask({
      taskId: 'rollout_reviewer-cand-6-prompt', taskKind: 'rollout_reviewer', status: 'succeeded',
      meta: makeMeta({ dependencyTaskIds: ['evaluator-cand-6-prompt'] }),
    });
    mockStateManager.getTask.mockImplementation(async (id: string) => {
      if (id === 'evaluator-cand-6-prompt') return evaluatorTask;
      if (id === 'rollout_reviewer-cand-6-prompt') return rolloutTask;
      return null;
    });
    // 真实 store 的 UNIQUE 约束: 同 id 任务已存在 → createTask 抛错
    mockStateManager.createTask.mockImplementation(async (input: { taskId: string; taskKind: string }) => {
      if (input.taskId === 'rollout_reviewer-cand-6-prompt') {
        throw new Error('UNIQUE constraint failed: tasks.task_id');
      }
      return makeTask({ taskId: input.taskId, taskKind: input.taskKind, status: 'pending', meta: makeMeta() });
    });

    const result = await makeOrchestrator().commitNextTaskProposal('evaluator-cand-6-prompt');

    expect(result.decision).toBe('successor_exists');
    expect(mockStateManager.updateTask).not.toHaveBeenCalled();
  });

  it('reopenTaskForRevision 幂等: 目标已 pending → ok 且不重复递增', async () => {
    const evaluatorTask = makeTask({
      taskId: 'evaluator-cand-7-prompt', taskKind: 'evaluator', status: 'pending',
      meta: makeMeta({ revisionCount: 1 }),
    });
    mockStateManager.getTask.mockResolvedValue(evaluatorTask);

    const orchestrator = makeOrchestrator();
    const r1 = await orchestrator.reopenTaskForRevision('evaluator-cand-7-prompt', { reason: 'idempotent-check' });
    expect(r1.ok).toBe(true);
    // 单写契约: metadata + status + attemptCount 一个 UPDATE (P1 评审修复)
    const call3 = (mockStateManager.updateTask.mock.calls as Array<[string, { status?: string; attemptCount?: number; diagnosticJson?: string }]>).find(
      (c) => c[0] === 'evaluator-cand-7-prompt',
    )?.[1];
    const parsed = JSON.parse(call3?.diagnosticJson ?? '') as { pi_metadata: { revisionCount?: number } };
    expect(parsed.pi_metadata.revisionCount).toBe(2);
    expect(call3?.status).toBe('pending');
    expect(call3?.attemptCount).toBe(0);
  });
});

// ── 元数据 round-trip (新字段) ────────────────────────────────────────────────

describe('PITaskMetadata new fields round-trip', () => {
  it('runnerDecision / revisionCount / revisionFeedback / rolloutRevisionPayload 持久化往返', () => {
    const meta = makeMeta({
      runnerDecision: 'needs_revision',
      revisionCount: 2,
      revisionFeedback: '修正原则措辞',
      rolloutRevisionPayload: {
        requiredChanges: ['tighten wording'],
        revisionIteration: 1,
        sourceRolloutTaskId: 'rollout-1',
        sourceArtifactId: 'pi-art-1',
        targetTaskKind: 'scribe',
      },
    });
    const json = createPITaskDiagnosticJson(meta);
    const task = makeTask({ taskId: 't', taskKind: 'rollout_reviewer', status: 'succeeded', meta });
    void json;
    const hydrated = hydratePITaskRecord(task);
    expect(hydrated?.runnerDecision).toBe('needs_revision');
    expect(hydrated?.revisionCount).toBe(2);
    expect(hydrated?.revisionFeedback).toBe('修正原则措辞');
    expect(hydrated?.rolloutRevisionPayload).toMatchObject({
      revisionIteration: 1, targetTaskKind: 'scribe',
    });
  });

  it('非法 runnerDecision 值 → hydrate fail-closed (null)', () => {
    const bad = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [], channel: 'prompt', timeoutMs: 1000,
        inputArtifactRefs: [], outputArtifactRefs: [],
        runnerDecision: 'yolo',
      },
    });
    const task = {
      taskId: 't', taskKind: 'evaluator', status: 'succeeded',
      createdAt: '', updatedAt: '', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: bad,
    } as TaskRecord;
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('transitionInputFromTask 投影一致', () => {
    const task = makeTask({
      taskId: 't2', taskKind: 'evaluator', status: 'succeeded',
      meta: makeMeta({ runnerDecision: 'needs_revision', revisionCount: 1 }),
    });
    const piTask = hydratePITaskRecord(task);
    expect(piTask).not.toBeNull();
    if (piTask) {
      const input = transitionInputFromTask(piTask);
      expect(input).toMatchObject({
        taskKind: 'evaluator', taskStatus: 'succeeded',
        runnerDecision: 'needs_revision', isRepairTask: false, revisionCount: 1,
      });
    }
  });
});
