/**
 * T-OWNER-RETRY-1..5 — Owner retry 必须是原子的 completion authority reset。
 *
 * 背景 (PR #1358 final audit follow-up): Owner retry 此前只清 runnerDecision、
 * 保留 completionIntent —— needs_human_review → retry → pending 后,runner
 * 入口门 resume/finalize 旧 intent,LLM 永不运行,Owner retry 实际失效
 * (违反 MVP_CORE_LOOP_CONTRACT INV-03: retry = 重新入队/新一轮机器处理)。
 *
 * 本文件用真实 RuntimeStateManager + 真实 SQLite 临时 workspace 测生产路径
 * (EP-02): 不 mock store,断言真实 DB 行。runner 侧语义(新 LLM verdict 成为
 * authority)在 principles-core verdict-drift-regressions 的 owner-retry
 * describe 中用真实 Runner 验证。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  RolloutReviewerRunner,
  DefaultRolloutReviewerValidator,
  storeEmitter,
} from '@principles/core/runtime-v2';
import type {
  PITaskMetadata,
  RolloutRevisionPayload,
  PDRuntimeAdapter,
  RolloutReviewerOutputV1,
} from '@principles/core/runtime-v2';
import { handleRuntimeInternalizationRetry } from '../../src/commands/runtime-internalization-retry.js';

/** barrel 未导出 RunnerCompletionIntent — 从 metadata 字段派生 (避免为测试改 core) */
type RunnerCompletionIntent = NonNullable<PITaskMetadata['completionIntent']>;

const TASK_ID = 'rollout_reviewer-owner-retry';
const SCRIBE_ID = 'scribe-owner-retry';
const ARTIFICER_ID = 'artificer-owner-retry';
const EVAL_ID = 'evaluator-owner-retry';
const EVAL_ART = 'pi-art-eval-owner-retry';
const SCRIBE_ART = 'pi-art-scribe-owner-retry';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

function intent(status: 'pending' | 'applied'): RunnerCompletionIntent {
  return {
    decision: 'needs_revision',
    sourceRunId: 'run-owner-1',
    revisionEpoch: 1,
    status,
    effect: 'needs_human_review',
  };
}

function revisionPayload(): RolloutRevisionPayload {
  return {
    requiredChanges: ['必须改 X'],
    revisionIteration: 2,
    sourceRolloutTaskId: TASK_ID,
    sourceArtifactId: 'pi-art-eval-1',
    targetTaskKind: 'scribe',
    status: 'applied',
  };
}

/** 构造 needs_human_review 的 rollout 任务(带指定 authority/budget metadata) */
async function seedNeedsHumanReview(meta: Partial<PITaskMetadata>, diagnosticJson?: string): Promise<void> {
  await stateManager.createTask({
    taskId: TASK_ID,
    taskKind: 'rollout_reviewer',
    status: 'needs_human_review',
    attemptCount: 2,
    maxAttempts: 3,
    diagnosticJson: diagnosticJson ?? createPITaskDiagnosticJson({
      dependencyTaskIds: ['evaluator-1'],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      correlationId: 'owner-retry',
      revisionCount: 1,
      ...meta,
    }),
  });
}

async function readTask() {
  return stateManager.getTask(TASK_ID);
}

async function readMeta() {
  const raw = await readTask();
  return raw ? hydratePITaskRecord(raw) : null;
}

/** 拿 handler 的 JSON 输出(emit 的第一行 console.log = 单 JSON 对象, cli-1) */
function jsonOutput(): Record<string, unknown> {
  expect(consoleLogSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  return JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-retry-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  consoleLogSpy.mockRestore();
  vi.restoreAllMocks();
  process.exitCode = 0;
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('T-OWNER-RETRY — pd runtime internalization retry --confirm = atomic authority reset', () => {
  it('T-OWNER-RETRY-1: applied intent 被 reset — status/attemptCount/runnerDecision/completionIntent 全部到位', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('applied'),
    });

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    expect(jsonOutput().status).toBe('requeued');

    const task = await readTask();
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);

    const meta = await readMeta();
    expect(meta).not.toBeNull();
    expect(meta?.runnerDecision).toBeUndefined();
    expect(meta?.completionIntent).toBeUndefined();
    // lineage 保留
    expect(meta?.dependencyTaskIds).toEqual(['evaluator-1']);
    expect(meta?.channel).toBe('prompt');
  });

  it('T-OWNER-RETRY-2: pending intent 同样被 reset — 不得留下可 resume 的旧 effect', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('pending'),
    });

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    expect(jsonOutput().status).toBe('requeued');
    const task = await readTask();
    expect(task?.status).toBe('pending');
    const meta = await readMeta();
    expect(meta?.completionIntent).toBeUndefined();
    expect(meta?.runnerDecision).toBeUndefined();
  });

  it('T-OWNER-RETRY-3: revision budget 证据不动 — rolloutRevisionPayload iteration / revisionCount 保留', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('applied'),
      revisionCount: 1,
      revisionCauseId: `rollout-${TASK_ID}-r2`,
      rolloutRevisionPayload: revisionPayload(),
    });

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    const meta = await readMeta();
    // authority 被 reset
    expect(meta?.completionIntent).toBeUndefined();
    expect(meta?.runnerDecision).toBeUndefined();
    // machine revision budget 原样保留 — Owner retry 只 reset authority
    expect(meta?.revisionCount).toBe(1);
    expect(meta?.revisionCauseId).toBe(`rollout-${TASK_ID}-r2`);
    expect(meta?.rolloutRevisionPayload?.revisionIteration).toBe(2);
    expect(meta?.rolloutRevisionPayload?.status).toBe('applied');
  });

  it('T-OWNER-RETRY-4: dry-run(无 --confirm)完全不落库', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('applied'),
      rolloutRevisionPayload: revisionPayload(),
    });

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, json: true });

    const out = jsonOutput();
    expect(out.status).toBe('dry_run');
    expect(process.exitCode).toBe(0);

    const task = await readTask();
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(2);
    const meta = await readMeta();
    expect(meta?.runnerDecision).toBe('needs_revision');
    expect(meta?.completionIntent).toEqual(intent('applied'));
    expect(meta?.rolloutRevisionPayload?.revisionIteration).toBe(2);
  });

  it('T-OWNER-RETRY-5: confirm 恰一次 updateTask、同 patch 含全部 reset 字段,且不经过 updateTaskDiagnosticJson', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('applied'),
    });

    const updateTaskSpy = vi.spyOn(RuntimeStateManager.prototype, 'updateTask');
    const diagSpy = vi.spyOn(RuntimeStateManager.prototype, 'updateTaskDiagnosticJson');

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    // 恰一次 confirm mutation,且不经过独立的 diagnostic 写
    expect(updateTaskSpy).toHaveBeenCalledTimes(1);
    expect(diagSpy).not.toHaveBeenCalled();

    const patch = updateTaskSpy.mock.calls[0][1];
    expect(patch.status).toBe('pending');
    expect(patch.attemptCount).toBe(0);
    // 同一 diagnosticJson 内 authority 已清空
    const envelope = JSON.parse(patch.diagnosticJson as string) as { pi_metadata: Record<string, unknown> };
    expect(Object.hasOwn(envelope.pi_metadata, 'runnerDecision')).toBe(false);
    expect(Object.hasOwn(envelope.pi_metadata, 'completionIntent')).toBe(false);
  });

  it('T-OWNER-RETRY-5b: 单一 updateTask 抛错 → DB 行保持原样,无 partial reset', async () => {
    await seedNeedsHumanReview({
      runnerDecision: 'needs_revision',
      completionIntent: intent('applied'),
    });

    const updateTaskSpy = vi.spyOn(RuntimeStateManager.prototype, 'updateTask')
      .mockRejectedValueOnce(new Error('injected update failure'));

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    expect(updateTaskSpy).toHaveBeenCalledTimes(1);
    const out = jsonOutput();
    expect(out.status).toBe('failed');
    expect(process.exitCode).toBe(1);

    // 原行完整保留: 仍 needs_human_review + 原 runnerDecision + 原 completionIntent
    const task = await readTask();
    expect(task?.status).toBe('needs_human_review');
    const meta = await readMeta();
    expect(meta?.runnerDecision).toBe('needs_revision');
    expect(meta?.completionIntent).toEqual(intent('applied'));
  });

  it('fail-closed: metadata 不可 hydrate → metadata_invalid,不得只改 status 产生 partial retry', async () => {
    // diagnosticJson 不是合法 pi_metadata(损坏/缺字段)
    await seedNeedsHumanReview({}, JSON.stringify({ note: 'not pi metadata' }));

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });

    const out = jsonOutput();
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('metadata_invalid');
    expect(process.exitCode).toBe(1);

    // 行未被动过 — 没有 "status 翻了但 authority 记录留在损坏 metadata 里" 的窗口
    const task = await readTask();
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(2);
  });
});

// ── 真实 Runner 后半段 (T-OWNER-RETRY-1/2 spec): retry 后新一轮 LLM verdict
// 成为 authority — 不得 resume/finalize 旧 intent。镜像 principles-core
// verdict-drift-regressions 的 proven 搭建 (真实 RolloutReviewerRunner + 真实 store)。

function rolloutOutput(decision: 'approve_rollout' | 'needs_revision'): RolloutReviewerOutputV1 {
  return {
    taskId: TASK_ID, sourceEvaluatorArtifactId: EVAL_ART,
    review: { decision, summary: 'owner-retry', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
    sourceTrace: { evaluatorArtifactId: EVAL_ART }, risks: [], generatedAt: new Date().toISOString(),
  };
}

/** 带 LLM 调用计数的 scripted adapter */
function scriptedAdapter(payload: unknown, spy: { llmCalls: number }, runId: string): PDRuntimeAdapter {
  return {
    startRun: async () => { spy.llmCalls += 1; return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() }; },
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

async function seedRunnerLineage(): Promise<void> {
  // 依赖链 scribe ← artificer ← evaluator: dispatch 候选解析沿此 BFS
  const chain: readonly [string, string, string[]][] = [
    [SCRIBE_ID, 'scribe', []],
    [ARTIFICER_ID, 'artificer', [SCRIBE_ID]],
    [EVAL_ID, 'evaluator', [ARTIFICER_ID]],
  ];
  for (const [id, kind, deps] of chain) {
    await stateManager.createTask({
      taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'owner-retry',
      }),
    });
    await stateManager.acquireLease({ taskId: id, owner: 'owner-retry', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(id);
  }
  // evaluator 的 principle artifact — rollout buildContext 经 dependency 解析
  await stateManager.piArtifactStore.upsertArtifact({
    artifactId: EVAL_ART, artifactKind: 'principle', sourceTaskId: EVAL_ID,
    lineageArtifactIds: [], validationStatus: 'pending',
    contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  // scribe 的 validated principle — prompt 渠道唯一合法 activation 候选
  await stateManager.piArtifactStore.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'owner-retry-p', text: '原则', principleDraft: { title: 'owner-retry-p', statement: '原则' } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

/**
 * 构造 budget-exhausted 终态: rollout needs_human_review + applied/pending
 * intent (effect=needs_human_review) + revision budget 证据 (iteration 2)。
 * applied = 正常完成后的 Owner 审核态;pending = needs_human_review 已写、
 * intent applied 写失败前的 crash 窗口 (T6b 中段)。
 */
async function craftOwnerReviewState(intentStatus: 'applied' | 'pending'): Promise<void> {
  await seedRunnerLineage();
  await stateManager.createTask({
    taskId: TASK_ID, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [EVAL_ID], channel: 'prompt', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'owner-retry',
    }),
  });
  await stateManager.acquireLease({ taskId: TASK_ID, owner: 'owner-retry', runtimeKind: 'test-double' });
  const runs = await stateManager.getRunsByTask(TASK_ID);
  const runId = runs[runs.length - 1]?.runId;
  if (!runId) throw new Error('craft: no run row');
  await stateManager.updateRunOutput(runId, JSON.stringify(rolloutOutput('needs_revision')));
  const raw = await readTask();
  const pi = raw ? hydratePITaskRecord(raw) : null;
  if (!pi) throw new Error('craft: not hydratable');
  const payload: RolloutRevisionPayload = {
    requiredChanges: ['前两轮'], revisionIteration: 2, sourceRolloutTaskId: TASK_ID,
    sourceArtifactId: EVAL_ART, targetTaskKind: 'scribe', status: 'applied',
  };
  await stateManager.updateTaskDiagnosticJson(TASK_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
    runnerDecision: 'needs_revision',
    revisionCount: 1,
    rolloutRevisionPayload: payload,
    completionIntent: {
      decision: 'needs_revision', sourceRunId: runId, revisionEpoch: 1,
      status: intentStatus, effect: 'needs_human_review',
    },
  })));
  await stateManager.updateTask(TASK_ID, { status: 'needs_human_review', attemptCount: 2 });
}

function makeRolloutRunner(adapter: PDRuntimeAdapter, dispatch: (input: { artifactId: string }) => Promise<{ decision: string; activationId?: string }>): RolloutReviewerRunner {
  return new RolloutReviewerRunner({
    stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter,
    artifactStore: stateManager.piArtifactStore,
    validator: new DefaultRolloutReviewerValidator(),
    dispatchActivation: dispatch,
    reopenRevisionTarget: async () => { throw new Error('owner-retry: reopen must not be called'); },
  }, { owner: 'owner-retry', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

describe('T-OWNER-RETRY — retry 后真实 Runner: 新 LLM verdict 成为 authority', () => {
  it('T-OWNER-RETRY-1(runner): applied intent 被 Owner retry 清除后,LLM calls=1、新 verdict=approve_rollout 生效,不得 finalize 旧 intent', async () => {
    await craftOwnerReviewState('applied');

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });
    expect(jsonOutput().status).toBe('requeued');

    const spy = { llmCalls: 0 };
    const dispatchCalls: string[] = [];
    const runner = makeRolloutRunner(
      scriptedAdapter(rolloutOutput('approve_rollout'), spy, 'run-owner-retry-2'),
      async (input) => { dispatchCalls.push(input.artifactId); return { decision: 'activated', activationId: 'act-owner-retry' }; },
    );

    const result = await runner.run(TASK_ID);
    expect(result.status).toBe('succeeded');

    // 新一轮 LLM 真的运行了 (若旧 intent 被 finalize/resume,这里必须是 0)
    expect(spy.llmCalls).toBe(1);
    // 新 verdict 成为 authority
    expect((await readTask())?.status).toBe('succeeded');
    const meta = await readMeta();
    expect(meta?.runnerDecision).toBe('approve_rollout');
    expect(meta?.completionIntent?.decision).toBe('approve_rollout');
    expect(meta?.completionIntent?.status).toBe('applied');
    // approve_rollout 被 dispatch (finalizeAppliedIntentTerminal(oldIntent) 只会
    // 重写 needs_human_review 且零 dispatch)
    expect(dispatchCalls).toEqual([SCRIBE_ART]);
    // revision budget 未被偷偷 reset
    expect(meta?.rolloutRevisionPayload?.revisionIteration).toBe(2);
    expect(meta?.revisionCount).toBe(1);
  });

  it('T-OWNER-RETRY-2(runner): pending intent 被 Owner retry 清除后,下一次 run 不得 resume 旧 effect (LLM calls=1)', async () => {
    await craftOwnerReviewState('pending');

    await handleRuntimeInternalizationRetry({ workspace: workspaceDir, taskId: TASK_ID, confirm: true, json: true });
    expect(jsonOutput().status).toBe('requeued');

    const spy = { llmCalls: 0 };
    const dispatchCalls: string[] = [];
    const runner = makeRolloutRunner(
      scriptedAdapter(rolloutOutput('approve_rollout'), spy, 'run-owner-retry-3'),
      async (input) => { dispatchCalls.push(input.artifactId); return { decision: 'activated', activationId: 'act-owner-retry-2' }; },
    );

    const result = await runner.run(TASK_ID);
    expect(result.status).toBe('succeeded');

    // pending intent 若残留,入口门会零 LLM resume 旧 needs_revision effect
    expect(spy.llmCalls).toBe(1);
    const meta = await readMeta();
    expect(meta?.runnerDecision).toBe('approve_rollout');
    expect(dispatchCalls).toEqual([SCRIBE_ART]);
  });
});
