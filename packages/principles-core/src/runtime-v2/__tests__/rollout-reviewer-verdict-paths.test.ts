/**
 * RolloutReviewerRunner verdict-outedge 错误路径测试 (PR review Phase 3)。
 *
 * 覆盖 codecov 指出的未覆盖分支: handleAutoDispatch / handleRevisionRouting
 * 的降级与失败路径 (not-wired / target-unresolved / budget 耗尽 / throw),
 * 以及 recordRunnerDecision 的 store 失败分支。复用 vslice 测试的 mock 模式。
 */
import { describe, it, expect, vi } from 'vitest';
import { RolloutReviewerRunner } from '../internalization/rollout-reviewer-runner.js';
import type { RolloutReviewerRunnerDeps } from '../internalization/rollout-reviewer-runner.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1 } from '../internalization/rollout-reviewer-output.js';
import { DefaultRolloutReviewerValidator } from '../internalization/rollout-reviewer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

const ROLLOUT_ID = 'rollout-reviewer-err';
const EVAL_ID = 'evaluator-err';
const SCRIBE_ID = 'scribe-err';
const ARTIFER_ID = 'artificer-err';

function makeTask(taskId: string, taskKind: string, deps: string[], status = 'succeeded'): TaskRecord {
  return {
    taskId, taskKind, status: status as TaskRecord['status'],
    attemptCount: 0, maxAttempts: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    }),
  };
}

function makeOutput(decision: 'needs_revision' | 'approve_rollout', requiredChanges: string[] = []): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID,
    sourceEvaluatorArtifactId: 'pi-art-eval-err',
    review: {
      decision, summary: 'err-path', confidence: 0.9,
      requiredChanges, rolloutRisks: [], safetyChecks: [],
    },
    sourceTrace: { evaluatorArtifactId: 'pi-art-eval-err' },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function makeDeps(output: RolloutReviewerOutputV1, overrides: Partial<RolloutReviewerRunnerDeps> & {
  rolloutStatus?: string; rolloutMeta?: Record<string, unknown>;
} = {}): { deps: RolloutReviewerRunnerDeps; stateManager: Record<string, unknown> } {
  const rolloutTask = { ...makeTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID], overrides.rolloutStatus ?? 'pending') };
  if (overrides.rolloutMeta) {
    rolloutTask.diagnosticJson = createPITaskDiagnosticJson({
      dependencyTaskIds: [EVAL_ID], channel: 'prompt', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
      ...overrides.rolloutMeta,
    } as never);
  }
  const tasks = new Map<string, TaskRecord>([
    [ROLLOUT_ID, rolloutTask],
    [EVAL_ID, makeTask(EVAL_ID, 'evaluator', [ARTIFER_ID])],
    [ARTIFER_ID, makeTask(ARTIFER_ID, 'artificer', [SCRIBE_ID])],
    [SCRIBE_ID, makeTask(SCRIBE_ID, 'scribe', [])],
  ]);

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(rolloutTask),
    getTask: vi.fn().mockImplementation((id: string) => Promise.resolve(tasks.get(id) ?? null)),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-err', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-err', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as Record<string, unknown>;

  const runHandle: RunHandle = { runId: 'run-err', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-err' } as RunStatus),
    fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-err', payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const artifactStore = new MemoryPIArtifactStore();
  void artifactStore.upsertArtifact({
    artifactId: 'pi-art-eval-err',
    artifactKind: 'principle',
    sourceTaskId: EVAL_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: 'err-principle',
      text: '错误路径测试原则',
      evaluation: { decision: 'approved', score: 0.9, requiredChanges: [], concerns: [] },
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const deps: RolloutReviewerRunnerDeps = {
    stateManager: stateManager as unknown as RuntimeStateManager,
    runtimeAdapter,
    eventEmitter: { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter,
    validator: new DefaultRolloutReviewerValidator(),
    artifactStore,
    ...overrides,
  };
  return { deps, stateManager };
}

function makeRunner(deps: RolloutReviewerRunnerDeps): RolloutReviewerRunner {
  return new RolloutReviewerRunner(deps, { owner: 'err-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

describe('RolloutReviewerRunner verdict out-edge error paths', () => {
  it('approve_rollout + dispatch dep 未注入 → rollout_dispatch_not_wired 事件, 不 throw', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('approve_rollout'));
    const runner = makeRunner(deps);
    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    const emitted = getEmitted(deps);
    expect(emitted.some((e) => e.eventType === 'rollout_dispatch_not_wired')).toBe(true);
    expect(stateManager.updateTask).not.toHaveBeenCalledWith(ROLLOUT_ID, expect.objectContaining({ status: 'needs_human_review' }));
  });

  it('approve_rollout + dispatch throw → rollout_activation_dispatch_failed 事件, 任务仍 succeeded (降级不卡链)', async () => {
    const { deps } = makeDeps(makeOutput('approve_rollout'), {
      dispatchActivation: vi.fn().mockRejectedValue(new Error('db locked')),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_activation_dispatch_failed')).toBe(true);
  });

  it('needs_revision budget 耗尽 (已记录 iteration=2) → needs_human_review, 不再 reopen', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('needs_revision', ['改措辞']), {
      rolloutMeta: {
        rolloutRevisionPayload: {
          requiredChanges: ['前一轮'], revisionIteration: 2,
          sourceRolloutTaskId: ROLLOUT_ID, sourceArtifactId: 'pi-art-x', targetTaskKind: 'scribe',
        },
      },
    });
    const reopen = vi.fn();
    const result = await makeRunner({ ...deps, reopenRevisionTarget: reopen }).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(reopen).not.toHaveBeenCalled();
    expect(stateManager.updateTask).toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_reviewer_task_needs_human_review')).toBe(true);
  });

  it('needs_revision 路由目标缺失 (dep 链断) → needs_human_review (target_unresolved)', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('needs_revision'));
    // 断链: evaluator 的 dep 指向不存在的 artificer
    (deps.stateManager.getTask as unknown as { mockImplementation: (fn: (id: string) => Promise<TaskRecord | null>) => void })
      .mockImplementation(async (id: string) => id === EVAL_ID
        ? { ...makeTask(EVAL_ID, 'evaluator', ['missing-artificer']) }
        : id === ROLLOUT_ID ? { ...makeTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID], 'pending') }
        : null);
    const result = await makeRunner({ ...deps, reopenRevisionTarget: vi.fn() }).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(stateManager.updateTask).toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
  });

  it('needs_revision + reopen dep 未注入 → not_wired 事件 + needs_human_review', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('needs_revision', ['x']));
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    const emitted = getEmitted(deps);
    expect(emitted.some((e) => e.eventType === 'rollout_revision_not_wired')).toBe(true);
    expect(stateManager.updateTask).toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
  });

  it('needs_revision + reopen 返回 ok=false → needs_human_review (reopen_failed reason)', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('needs_revision', ['x']), {
      reopenRevisionTarget: vi.fn().mockResolvedValue({ ok: false, reason: 'task_in_flight_leased' }),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(stateManager.updateTask).toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
  });

  it('needs_revision + reopen throw → route_failed 事件 + needs_human_review', async () => {
    const { deps, stateManager } = makeDeps(makeOutput('needs_revision', ['x']), {
      reopenRevisionTarget: vi.fn().mockRejectedValue(new Error('sqlite busy')),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_revision_route_failed')).toBe(true);
    expect(stateManager.updateTask).toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
  });

  it('recordRunnerDecision store 失败 → decision_record_failed 事件, 不 throw (verdict 已在 events/runs 可观测)', async () => {
    const { deps } = makeDeps(makeOutput('approve_rollout'));
    (deps.stateManager.updateTaskDiagnosticJson as unknown as { mockImplementation: (fn: () => Promise<never>) => void })
      .mockImplementation(() => Promise.reject(new Error('disk full')));
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_decision_record_failed')).toBe(true);
  });
});

type EmittedEvent = { eventType: string; payload: Record<string, unknown> };

function getEmitted(deps: RolloutReviewerRunnerDeps): EmittedEvent[] {
  const emitter = deps.eventEmitter as unknown as { emitTelemetry: { mock: { calls: Array<Array<EmittedEvent | undefined>> } } };
  return emitter.emitTelemetry.mock.calls
    .map((c) => c[0])
    .filter((e): e is EmittedEvent => e !== undefined);
}
