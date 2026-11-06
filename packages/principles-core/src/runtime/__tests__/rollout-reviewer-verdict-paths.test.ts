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
import type { PDRuntimeAdapter, RunHandle } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1 } from '../internalization/rollout-reviewer-output.js';
import { DefaultRolloutReviewerValidator } from '../internalization/rollout-reviewer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

const ROLLOUT_ID = 'rollout-reviewer-err';
const EVAL_ID = 'evaluator-err';
const SCRIBE_ID = 'scribe-err';
const ARTIFER_ID = 'artificer-err';

function makeTask(spec: { taskId: string; taskKind: string; deps?: string[]; status?: string }): TaskRecord {
  const { taskId, taskKind } = spec;
  const deps = spec.deps ?? [];
  const status = spec.status ?? 'succeeded';
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

type EmittedEvent = { eventType: string; payload: Record<string, unknown> };

function getEmitted(deps: RolloutReviewerRunnerDeps): EmittedEvent[] {
  const emitter = deps.eventEmitter as unknown as { emitTelemetry: { mock: { calls: EmittedEvent[][] } } };
  return emitter.emitTelemetry.mock.calls
    .map((c) => c[0])
    .filter((e): e is EmittedEvent => e !== undefined);
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

async function makeDeps(output: RolloutReviewerOutputV1, overrides: Partial<RolloutReviewerRunnerDeps> & {
  rolloutStatus?: string; rolloutMeta?: Record<string, unknown>;
} = {}): Promise<{ deps: RolloutReviewerRunnerDeps; stateManager: Record<string, unknown> }> {
  const rolloutTask = { ...makeTask({ taskId: ROLLOUT_ID, taskKind: 'rollout_reviewer', deps: [EVAL_ID], status: overrides.rolloutStatus ?? 'pending' }) };
  if (overrides.rolloutMeta) {
    rolloutTask.diagnosticJson = createPITaskDiagnosticJson({
      dependencyTaskIds: [EVAL_ID], channel: 'prompt', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
      ...overrides.rolloutMeta,
    } as never);
  }
  const tasks = new Map<string, TaskRecord>([
    [ROLLOUT_ID, rolloutTask],
    [EVAL_ID, makeTask({ taskId: EVAL_ID, taskKind: 'evaluator', deps: [ARTIFER_ID] })],
    [ARTIFER_ID, makeTask({ taskId: ARTIFER_ID, taskKind: 'artificer', deps: [SCRIBE_ID] })],
    [SCRIBE_ID, makeTask({ taskId: SCRIBE_ID, taskKind: 'scribe' })],
  ]);
  const artifactStoreEarly = new MemoryPIArtifactStore();
  // P0-1: 合法 activation 候选 = scribe 的 validated principle artifact
  await artifactStoreEarly.upsertArtifact({
    artifactId: 'pi-art-scribe-validated',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'err-path-p', text: 'x' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(rolloutTask),
    getTask: vi.fn().mockImplementation((id: string) => Promise.resolve(tasks.get(id) ?? null)),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-err', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-err', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: { status?: string }) => {
      // 忠实 store 语义 (ERR-025/PART A read-back): updateTask 成功 ⇒ 状态
      // 可被后续 getTask 读回 — markNeedsHumanReviewOrThrow 的 read-back
      // invariant 依赖这一点,bare vi.fn() 会让 needs_human_review 分支
      // 全部误报 storage_unavailable。
      const t = tasks.get(id);
      if (t && typeof patch.status === 'string') {
        (t as Record<string, unknown>).status = patch.status;
      }
      return undefined;
    }),
    updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as Record<string, unknown>;

  const runHandle: RunHandle = { runId: 'run-err', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-err' }),
    fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-err', payload: output }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const artifactStore = artifactStoreEarly;
  await artifactStore.upsertArtifact({
    artifactId: 'pi-art-eval-err',
    artifactKind: 'principle',
    sourceTaskId: EVAL_ID,
    lineageArtifactIds: [],
    // 真实形状: evaluator 名下 principle = 评审输出,恒 pending (P0-1)
    validationStatus: 'pending',
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


/**
 * PRI-629: markNeedsHumanReviewOrThrow 现在把 status 与 humanReviewContext
 * 写进同一次 updateTask (SPEC §4)。断言采用谓词匹配而非精确形状。
 */
function expectNeedsHumanReviewWrite(
  stateManager: Record<string, unknown>,
  expectedReasonCode: string,
): void {
  const calls = (stateManager.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, { status?: string; diagnosticJson?: string }][];
  const hit = calls.some(([id, patch]) => {
    if (id !== ROLLOUT_ID || patch?.status !== 'needs_human_review' || typeof patch.diagnosticJson !== 'string') return false;
    try {
      const parsed = JSON.parse(patch.diagnosticJson) as { pi_metadata?: { humanReviewContext?: { reasonCode?: string } } };
      return parsed.pi_metadata?.humanReviewContext?.reasonCode === expectedReasonCode;
    } catch {
      return false;
    }
  });
  if (!hit) {
    throw new Error(`expected needs_human_review write with reasonCode=${expectedReasonCode}`);
  }
}

describe('RolloutReviewerRunner verdict out-edge error paths', () => {
  it('approve_rollout + dispatch dep 未注入 → not_wired 事件 + needs_human_review (P0-2: 不伪装成功)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('approve_rollout'));
    const runner = makeRunner(deps);
    const result = await runner.run(ROLLOUT_ID);
    // runner 本轮执行成功 (verdict 有效),但 governance transition 未完成
    expect(result.status).toBe('succeeded');
    const emitted = getEmitted(deps);
    expect(emitted.some((e) => e.eventType === 'rollout_dispatch_not_wired')).toBe(true);
    expectNeedsHumanReviewWrite(stateManager, 'rollout_dispatch_not_wired');
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('approve_rollout + dispatch transient throw (db locked) → 不 markSucceeded,走重试路径 (P0-2)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('approve_rollout'), {
      dispatchActivation: vi.fn().mockRejectedValue(new Error('db locked')),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    // transient → 异常冒泡到 retryOrFail (mock 策略 shouldRetry=false → failed;
    // 生产策略为 retry_wait 自动重试,dispatcher 幂等保证重放安全)
    expect(result.status).not.toBe('succeeded');
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('needs_revision budget 耗尽 (已记录 iteration=2) → needs_human_review, 不再 reopen', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('needs_revision', ['改措辞']), {
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
    expectNeedsHumanReviewWrite(stateManager, 'rollout_revision_budget_exhausted');
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_reviewer_task_needs_human_review')).toBe(true);
  });

  it('needs_revision 路由目标缺失 (dep 链断) → needs_human_review (target_unresolved)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('needs_revision'));
    // 断链: evaluator 的 dep 指向不存在的 artificer;getTask 单独 override,
    // 状态用本地变量回写 (PART A read-back 依赖 getTask 能读到 updateTask 的效果)
    let rolloutStatus: TaskRecord['status'] = 'pending';
    (deps.stateManager.getTask as unknown as { mockImplementation: (fn: (id: string) => Promise<TaskRecord | null>) => void })
      .mockImplementation(async (id: string) => id === EVAL_ID
        ? { ...makeTask({ taskId: EVAL_ID, taskKind: 'evaluator', deps: ['missing-artificer'] }) }
        : id === ROLLOUT_ID ? { ...makeTask({ taskId: ROLLOUT_ID, taskKind: 'rollout_reviewer', deps: [EVAL_ID] }), status: rolloutStatus }
        : null);
    (stateManager.updateTask as { mockImplementation: (fn: (id: string, patch: { status?: TaskRecord['status'] }) => Promise<undefined>) => void })
      .mockImplementation(async (id: string, patch: { status?: TaskRecord['status'] }) => {
        if (id === ROLLOUT_ID && typeof patch.status === 'string') rolloutStatus = patch.status;
        return undefined;
      });
    const result = await makeRunner({ ...deps, reopenRevisionTarget: vi.fn() }).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expectNeedsHumanReviewWrite(stateManager, 'rollout_revision_target_unresolved');
  });

  it('needs_revision + reopen dep 未注入 → not_wired 事件 + needs_human_review', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('needs_revision', ['x']));
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    const emitted = getEmitted(deps);
    expect(emitted.some((e) => e.eventType === 'rollout_revision_not_wired')).toBe(true);
    expectNeedsHumanReviewWrite(stateManager, 'rollout_revision_routing_not_wired');
  });

  it('needs_revision + reopen 返回 ok=false → needs_human_review (reopen_failed reason)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('needs_revision', ['x']), {
      reopenRevisionTarget: vi.fn().mockResolvedValue({ ok: false, reason: 'task_in_flight_leased' }),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expectNeedsHumanReviewWrite(stateManager, 'rollout_revision_reopen_failed');
  });

  it('needs_revision + reopen throw → route_failed 事件 + transient 上抛 retry (P0: resume 而非 human_review)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('needs_revision', ['x']), {
      reopenRevisionTarget: vi.fn().mockRejectedValue(new Error('sqlite busy')),
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    // P0 verdict drift 语义变更: reopen 抛错 = transient (db locked) → 冒泡
    // retryOrFail (mock shouldRetry=false → failed;生产为 retry_wait → 下一轮
    // 入口门 resume 同一 completion intent,无 LLM 重问)。确定性拒绝
    // (ok=false) 才走 needs_human_review (见上一用例)。
    expect(result.status).not.toBe('succeeded');
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_revision_route_failed')).toBe(true);
    expect(stateManager.updateTask).not.toHaveBeenCalledWith(ROLLOUT_ID, { status: 'needs_human_review' });
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });

  it('completion intent 落库失败 → fail loud (retry),任务绝不无 verdict 地 succeeded (P0-3)', async () => {
    const { deps, stateManager } = await makeDeps(makeOutput('approve_rollout'));
    (deps.stateManager.updateTaskDiagnosticJson as unknown as { mockImplementation: (fn: () => Promise<never>) => void })
      .mockImplementation(() => Promise.reject(new Error('disk full')));
    const result = await makeRunner(deps).run(ROLLOUT_ID);
    expect(result.status).not.toBe('succeeded');
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
    expect(getEmitted(deps).some((e) => e.eventType === 'rollout_completion_record_failed')).toBe(true);
  });
});

