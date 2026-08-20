/**
 * P0 (verdict drift) — durable completion intent 是 recovery authority。
 *
 * 外部复核反例 (第 5 轮): runner 在 side effect 已部分发生、task 未 terminal
 * 时 crash,retry/restart 重跑会重新调用 LLM;非确定性下新 verdict 覆盖旧
 * runnerDecision,与已发生副作用形成治理矛盾:
 *   T1 rollout revision drift — pending r1 不得被新 approve 漂移;
 *   T2 activation drift — 已 activated 后不得漂移为 reject;
 *   T3 evaluator repair drift — 已 seed repair 后不得漂移为 approved;
 *   T4 evaluator validation drift — 已 validate bearer 后不得漂移为 needs_revision;
 *   T5 new epoch — 真正 revision reopen 后允许不同 verdict (禁止过度封锁)。
 *
 * 每个 drift 测试的 adapter 均带调用计数: 断言 resume 路径根本未调用 LLM。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { RolloutReviewerRunner } from '../rollout-reviewer-runner.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import type { RolloutReviewerOutputV1 } from '../rollout-reviewer-output.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { storeEmitter } from '../../store/event-emitter.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from '../pitask-metadata.js';
import type { RolloutRevisionPayload } from '../pitask-metadata.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

const SCRIBE_ID = 'scribe-d1-prompt';
const ARTIFICER_ID = 'artificer-d1-prompt';
const EVAL_ID = 'evaluator-d1-prompt';
const ROLLOUT_ID = 'rollout_reviewer-d1-prompt';
const SCRIBE_ART = 'pi-art-scribe-d1';
const ARTIFICER_ART = 'pi-art-artificer-d1';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-drift-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'drift', runtimeKind: 'test-double', dryRun: true },
  );
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

async function mkTask(id: string, kind: string, deps: string[]): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ correlationId: 'd1', dependencyTaskIds: deps }) });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'drift', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

/** scribe(validated bearer) → artificer → evaluator(succeeded+approved) → rollout(pending) + 依赖 artifacts */
async function seedLineage(): Promise<SqlitePIArtifactStore> {
  await mkTask(SCRIBE_ID, 'scribe', []);
  await succeed(SCRIBE_ID);
  await mkTask(ARTIFICER_ID, 'artificer', [SCRIBE_ID]);
  await succeed(ARTIFICER_ID);
  await mkTask(EVAL_ID, 'evaluator', [ARTIFICER_ID]);
  await succeed(EVAL_ID);
  const evalRaw = await stateManager.getTask(EVAL_ID);
  if (!evalRaw) throw new Error('seed: evaluator missing');
  const evalPi = hydratePITaskRecord(evalRaw);
  if (!evalPi) throw new Error('seed: evaluator not hydratable');
  await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(evalPi, { runnerDecision: 'approved' })));
  await mkTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID]);

  const conn = new SqliteConnection(workspaceDir);
  const store = new SqlitePIArtifactStore(conn);
  await store.upsertArtifact({
    artifactId: 'pi-art-eval-d1', artifactKind: 'principle', sourceTaskId: EVAL_ID,
    lineageArtifactIds: [], validationStatus: 'pending',
    contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await store.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'd1-p', text: '原则', principleDraft: { title: 'd1-p', statement: '原则' } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  conn.close();
  return store;
}

function rolloutOutput(decision: 'needs_revision' | 'approve_rollout' | 'reject'): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID, sourceEvaluatorArtifactId: 'pi-art-eval-d1',
    review: { decision, summary: 'd1', confidence: 0.9, requiredChanges: decision === 'needs_revision' ? ['必须改 X'] : [], rolloutRisks: [], safetyChecks: [] },
    sourceTrace: { evaluatorArtifactId: 'pi-art-eval-d1' }, risks: [], generatedAt: new Date().toISOString(),
  };
}

function evaluatorOutput(decision: 'approved' | 'needs_revision'): unknown {
  return {
    taskId: EVAL_ID, sourceArtificerArtifactId: ARTIFICER_ART,
    evaluation: { decision, summary: 'd1', score: 0.9, strengths: [], concerns: [], requiredChanges: decision === 'needs_revision' ? ['必须改 X'] : [] },
    sourceTrace: { artificerArtifactId: ARTIFICER_ART, scribeArtifactId: SCRIBE_ART },
    risks: [], generatedAt: new Date().toISOString(),
  };
}

/** 带 LLM 调用计数的 scripted adapter — drift 场景的"第二次"回答 */
function driftAdapter(payload: unknown, spy: { llmCalls: number }): PDRuntimeAdapter {
  return {
    startRun: async () => { spy.llmCalls += 1; return { runId: 'run-drift-2', runtimeKind: 'test-double', startedAt: new Date().toISOString() }; },
    pollRun: async () => ({ status: 'succeeded', runId: 'run-drift-2' }),
    fetchOutput: async () => ({ runId: 'run-drift-2', payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

/**
 * 手工构造真实 crash 态 (与生产原子写等价):
 * run 行携带原 output → metadata 落 runnerDecision + pending completionIntent
 * → 任务回到 pending (模拟 lease 过期回收)。
 */
async function craftRolloutCrashState(decision: 'needs_revision' | 'approve_rollout', options?: {
  revisionIteration?: number;
  rolloutRevisionPayload?: RolloutRevisionPayload;
  effect?: 'needs_human_review';
}): Promise<string> {
  await stateManager.acquireLease({ taskId: ROLLOUT_ID, owner: 'drift', runtimeKind: 'test-double' });
  const runs = await stateManager.getRunsByTask(ROLLOUT_ID);
  const runId = runs[runs.length - 1]?.runId;
  if (!runId) throw new Error('craft: no run row after lease');
  await stateManager.updateRunOutput(runId, JSON.stringify(rolloutOutput(decision)));
  const raw = await stateManager.getTask(ROLLOUT_ID);
  if (!raw) throw new Error('craft: rollout missing');
  const pi = hydratePITaskRecord(raw);
  if (!pi) throw new Error('craft: rollout not hydratable');
  await stateManager.updateTaskDiagnosticJson(ROLLOUT_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
    runnerDecision: decision,
    completionIntent: {
      decision, sourceRunId: runId, revisionEpoch: pi.revisionCount ?? 0, status: 'pending',
      ...(options?.revisionIteration !== undefined ? { revisionIteration: options.revisionIteration } : {}),
      ...(options?.effect ? { effect: options.effect } : {}),
    },
    ...(options?.rolloutRevisionPayload ? { rolloutRevisionPayload: options.rolloutRevisionPayload } : {}),
  })));
  await stateManager.updateTask(ROLLOUT_ID, { status: 'pending', attemptCount: 0 });
  return runId;
}

async function craftEvaluatorCrashState(decision: 'approved' | 'needs_revision', outputOverride?: unknown): Promise<string> {
  // seedLineage 后 evaluator 是 succeeded;crash 叙事里它当时 leased — 先回 pending
  await stateManager.updateTask(EVAL_ID, { status: 'pending', attemptCount: 0 });
  await stateManager.acquireLease({ taskId: EVAL_ID, owner: 'drift', runtimeKind: 'test-double' });
  const runs = await stateManager.getRunsByTask(EVAL_ID);
  const runId = runs[runs.length - 1]?.runId;
  if (!runId) throw new Error('craft: no run row after lease');
  await stateManager.updateRunOutput(runId, JSON.stringify(outputOverride ?? evaluatorOutput(decision)));
  const raw = await stateManager.getTask(EVAL_ID);
  if (!raw) throw new Error('craft: evaluator missing');
  const pi = hydratePITaskRecord(raw);
  if (!pi) throw new Error('craft: evaluator not hydratable');
  await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
    runnerDecision: decision,
    completionIntent: { decision, sourceRunId: runId, revisionEpoch: pi.revisionCount ?? 0, status: 'pending' },
  })));
  await stateManager.updateTask(EVAL_ID, { status: 'pending', attemptCount: 0 });
  return runId;
}

function makeRolloutRunner(adapter: PDRuntimeAdapter, deps: {
  dispatch?: (input: { artifactId: string }) => Promise<{ decision: string; reason?: string; activationId?: string }>;
  reopen?: (input: { targetTaskId: string; revisionIteration: number }) => Promise<{ ok: boolean; reason: string }>;
}): RolloutReviewerRunner {
  return new RolloutReviewerRunner({
    stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter,
    artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
    validator: new DefaultRolloutReviewerValidator(),
    ...(deps.dispatch ? { dispatchActivation: deps.dispatch } : {}),
    ...(deps.reopen ? { reopenRevisionTarget: deps.reopen } : {}),
  }, { owner: 'drift', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

async function readMeta(id: string): Promise<ReturnType<typeof hydratePITaskRecord>> {
  const raw = await stateManager.getTask(id);
  return raw ? hydratePITaskRecord(raw) : null;
}

describe('P0 verdict drift — completion intent 是 recovery authority', () => {
  it('T1 rollout revision drift: pending r1 之后 LLM 返回 approve 也不得成为 authority', async () => {
    await seedLineage();
    await craftRolloutCrashState('needs_revision', { revisionIteration: 1 });

    const spy = { llmCalls: 0 };
    const dispatchCalls: string[] = [];
    const runner = makeRolloutRunner(driftAdapter(rolloutOutput('approve_rollout'), spy), {
      dispatch: async (input) => { dispatchCalls.push(input.artifactId); return { decision: 'activated' }; },
      reopen: async (input) => {
        const r = await orchestrator.reopenTaskForRevision(input.targetTaskId, {
          revisionCauseId: `rollout-${ROLLOUT_ID}-r${input.revisionIteration}`,
          revisionFeedback: 'feedback',
        });
        return r.ok ? { ok: true, reason: r.reason } : { ok: false, reason: r.reason };
      },
    });

    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // LLM 根本未被调用 — 第二个 adapter 不是 authority
    expect(spy.llmCalls).toBe(0);
    // r1 被继续 materialize: scribe 被 reopen 一次
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('pending');
    const scribePi = await readMeta(SCRIBE_ID);
    expect(scribePi?.revisionCauseId).toBe(`rollout-${ROLLOUT_ID}-r1`);
    // activation = 0
    expect(dispatchCalls).toEqual([]);
    // 终态与 intent 一致
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).toBe('succeeded');
    const rolloutPi = await readMeta(ROLLOUT_ID);
    expect(rolloutPi?.runnerDecision).toBe('needs_revision');
    expect(rolloutPi?.rolloutRevisionPayload?.status).toBe('applied');
    expect(rolloutPi?.rolloutRevisionPayload?.revisionIteration).toBe(1);
    expect(rolloutPi?.completionIntent?.status).toBe('applied');
  });

  it('T2 activation drift: activated 后 crash,LLM 返回 reject 也不得漂移 (无 reject+active)', async () => {
    await seedLineage();
    await craftRolloutCrashState('approve_rollout');

    const spy = { llmCalls: 0 };
    const dispatchCalls: number[] = [];
    const runner = makeRolloutRunner(driftAdapter(rolloutOutput('reject'), spy), {
      // run-1 已 activated 的 durable 效果 → 重放 dispatch = already_activated
      dispatch: async () => { dispatchCalls.push(1); return { decision: 'already_activated', reason: 'idempotent_redispatch' }; },
      reopen: async () => { throw new Error('T2: reopen must not be called'); },
    });

    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    expect(spy.llmCalls).toBe(0);                       // LLM 未被调用
    expect(dispatchCalls.length).toBe(1);               // activation 恰好一条 (幂等重放)
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).toBe('succeeded');
    const pi = await readMeta(ROLLOUT_ID);
    expect(pi?.runnerDecision).toBe('approve_rollout'); // final verdict 与 activation 一致
    expect(pi?.completionIntent?.status).toBe('applied');
  });

  it('T3 evaluator repair drift: repair 已 seed 后 LLM 返回 approved 也不得绕过 repair', async () => {
    await seedLineage();
    const conn = new SqliteConnection(workspaceDir);
    const artifactStore = new SqlitePIArtifactStore(conn);
    // artificer 依赖产物 (repair seed lineage 用)
    await artifactStore.upsertArtifact({
      artifactId: ARTIFICER_ART, artifactKind: 'principle', sourceTaskId: ARTIFICER_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ plan: 'p' }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    conn.close();
    await craftEvaluatorCrashState('needs_revision');

    // run-1 的 durable 副作用: 确定性 ID 的 repair 任务已 seed (crash 前发生)
    const repairTaskId = `artificer-repair-${EVAL_ID}-r1`;
    await stateManager.createTask({
      taskId: repairTaskId, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({
        correlationId: 'd1', dependencyTaskIds: [SCRIBE_ID],
        repairPayload: {
          requiredChanges: ['必须改 X'], concerns: [], previousScore: 0.9,
          repairIteration: 1, sourceArtificerArtifactId: ARTIFICER_ART, sourceEvaluatorTaskId: EVAL_ID,
        },
      }),
    });

    const spy = { llmCalls: 0 };
    const seedCalls: number[] = [];
    const evaluator = new EvaluatorRunner({
      stateManager, runtimeAdapter: driftAdapter(evaluatorOutput('approved'), spy),
      eventEmitter: storeEmitter, artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
      validator: new DefaultEvaluatorValidator(),
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (params) => {
        seedCalls.push(1);
        // 生产接线语义: 确定性 ID 已存在 → 复用
        const existing = await stateManager.getTask(repairTaskId);
        if (existing) return repairTaskId;
        await stateManager.createTask({
          taskId: repairTaskId, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
          diagnosticJson: meta({ correlationId: 'd1', dependencyTaskIds: [SCRIBE_ID], repairPayload: params.repairPayload }),
        });
        return repairTaskId;
      },
    }, { owner: 'drift', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    const result = await evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    expect(spy.llmCalls).toBe(0);                        // LLM 未被调用
    expect((await stateManager.getTask(EVAL_ID))?.status).toBe('succeeded');
    const pi = await readMeta(EVAL_ID);
    expect(pi?.runnerDecision).toBe('needs_revision');   // 原 intent 被恢复
    expect(pi?.completionIntent?.status).toBe('applied');
    // repair 恰好一个 (确定性 ID 复用)
    expect(await stateManager.getTask(repairTaskId)).not.toBeNull();
    expect(seedCalls.length).toBe(1);
    // approved 不得正常推进: commit 门 fail-closed (无 rollout 后继)
    const commit = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(commit.decision).toBe('blocked_by_revision');
  });

  it('T4 evaluator validation drift: bearer 已 validated 后 LLM 返回 needs_revision 也不得漂移', async () => {
    await seedLineage();
    await craftEvaluatorCrashState('approved');

    const spy = { llmCalls: 0 };
    const seedCalls: number[] = [];
    const evaluator = new EvaluatorRunner({
      stateManager, runtimeAdapter: driftAdapter(evaluatorOutput('needs_revision'), spy),
      eventEmitter: storeEmitter, artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
      validator: new DefaultEvaluatorValidator(),
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async () => { seedCalls.push(1); throw new Error('T4: seed must not be called'); },
    }, { owner: 'drift', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    const result = await evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    expect(spy.llmCalls).toBe(0);
    expect((await stateManager.getTask(EVAL_ID))?.status).toBe('succeeded');
    const pi = await readMeta(EVAL_ID);
    expect(pi?.runnerDecision).toBe('approved');         // 原 intent 恢复
    expect(pi?.completionIntent?.status).toBe('applied');
    // 无 "validated + needs_revision" 矛盾: bearer 维持 validated,无 repair
    expect(seedCalls).toEqual([]);
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    const bearer = await store.getArtifactById(SCRIBE_ART);
    conn.close();
    expect(bearer?.validationStatus).toBe('validated');
    // approved 正常推进 (lineage 已预建 rollout 任务 → successor_exists 同为 ADVANCE)
    const commit = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(commit.decision).not.toBe('blocked_by_revision');
    expect(['successor_created', 'successor_exists']).toContain(commit.decision);
  });

  it('T5 new epoch: 真正 revision reopen 后允许不同 verdict (LLM 被调用)', async () => {
    await seedLineage();
    // 构造 r1 已 applied 且 rollout 被 reopen (revisionCount=1,intent/decision 已清空)
    const raw = await stateManager.getTask(ROLLOUT_ID);
    if (!raw) throw new Error('T5: rollout missing');
    const pi = hydratePITaskRecord(raw);
    if (!pi) throw new Error('T5: rollout not hydratable');
    const payload: RolloutRevisionPayload = {
      requiredChanges: ['x'], revisionIteration: 1, sourceRolloutTaskId: ROLLOUT_ID,
      sourceArtifactId: SCRIBE_ART, targetTaskKind: 'scribe', status: 'applied',
    };
    await stateManager.updateTaskDiagnosticJson(ROLLOUT_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
      runnerDecision: undefined,
      completionIntent: undefined,
      revisionCount: 1,
      rolloutRevisionPayload: payload,
    })));

    const spy = { llmCalls: 0 };
    const dispatchCalls: number[] = [];
    const runner = makeRolloutRunner(driftAdapter(rolloutOutput('approve_rollout'), spy), {
      dispatch: async () => { dispatchCalls.push(1); return { decision: 'activated', activationId: 'act-t5' }; },
      reopen: async () => { throw new Error('T5: reopen must not be called'); },
    });

    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // 新 epoch 允许新 verdict: LLM 被调用,与上一轮 needs_revision 不同
    expect(spy.llmCalls).toBe(1);
    expect(dispatchCalls.length).toBe(1);
    const finalPi = await readMeta(ROLLOUT_ID);
    expect(finalPi?.runnerDecision).toBe('approve_rollout');
    expect(finalPi?.completionIntent?.status).toBe('applied');
    expect(finalPi?.completionIntent?.revisionEpoch).toBe(1);
  });

  it('T6 budget exhausted resume: crash before needs_human_review 写入,LLM 返回 approve 也不得漂移', async () => {
    await seedLineage();
    // 前置: r1/r2 已 materialized (applied iteration=2) — 新 verdict 需 budget
    await craftRolloutCrashState('needs_revision', {
      effect: 'needs_human_review',
      rolloutRevisionPayload: {
        requiredChanges: ['前两轮'], revisionIteration: 2, sourceRolloutTaskId: ROLLOUT_ID,
        sourceArtifactId: SCRIBE_ART, targetTaskKind: 'scribe', status: 'applied',
      },
    });

    const spy = { llmCalls: 0 };
    const runner = makeRolloutRunner(driftAdapter(rolloutOutput('approve_rollout'), spy), {
      dispatch: async () => { throw new Error('T6: dispatch must not be called'); },
      reopen: async () => { throw new Error('T6: reopen must not be called'); },
    });

    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // 同 epoch retry: resume needs_human_review 效果,LLM/activation/路由全禁
    expect(spy.llmCalls).toBe(0);
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).toBe('needs_human_review');
    const pi = await readMeta(ROLLOUT_ID);
    expect(pi?.runnerDecision).toBe('needs_revision');
    // budget 仍为 2 (未产生新修订轮)
    expect(pi?.rolloutRevisionPayload?.revisionIteration).toBe(2);
    expect(pi?.rolloutRevisionPayload?.status).toBe('applied');
    expect(pi?.completionIntent?.status).toBe('applied');
    expect(pi?.completionIntent?.effect).toBe('needs_human_review');
  });
});

describe('P0-B verdict drift — rule assembly 纳入 completion effect', () => {
  /** V2 (code-bearing) + adversarial passed 的 evaluator output */
  function evaluatorV2Output(): unknown {
    return {
      taskId: EVAL_ID, sourceArtificerArtifactId: ARTIFICER_ART,
      evaluation: { decision: 'approved', summary: 'v2', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
      sourceTrace: { artificerArtifactId: ARTIFICER_ART, scribeArtifactId: SCRIBE_ART },
      risks: [], generatedAt: new Date().toISOString(),
      codeReview: {
        intentConsistency: { aligned: true, explanation: 'ok' },
        scopePrecision: { verdict: 'precise', explanation: 'ok' },
        traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' },
      },
      adversarialCases: [{ caseId: 'adv-1', attackType: 'boundary', toolName: 'write_file', params: { path: '/x' }, expectedDecision: 'block', rationale: 'r' }],
      adversarialResult: { passed: true, failedCases: [] },
    };
  }

  /** artificer 的 V2 产物 (implementationCode + ≥1 正例 + ≥1 负例 golden trace) */
  async function seedArtificerV2Artifact(): Promise<void> {
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    await store.upsertArtifact({
      artifactId: ARTIFICER_ART, artifactKind: 'principle', sourceTaskId: ARTIFICER_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({
        taskId: ARTIFICER_ID, sourceScribeArtifactId: SCRIBE_ART,
        implementationCode: 'function evaluate(input) { return { decision: "allow", matched: true, reason: "ok" }; }',
        goldenTraceCases: [
          { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/safe.txt' }, expectedDecision: 'allow' },
          { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        ],
        affectedTools: ['write_file'],
        sourceTrace: { scribeArtifactId: SCRIBE_ART },
        risks: [], generatedAt: new Date().toISOString(),
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    conn.close();
  }

  async function listRules(): Promise<{ artifactId: string; validationStatus: string }[]> {
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    const all = await store.listBySourceTaskId(EVAL_ID);
    conn.close();
    return all.filter((a) => a.artifactKind === 'rule')
      .map((a) => ({ artifactId: a.artifactId, validationStatus: a.validationStatus }));
  }

  function makeV2Evaluator(spy: { llmCalls: number }, payload: unknown, seedRepair?: () => Promise<string>): EvaluatorRunner {
    return new EvaluatorRunner({
      stateManager, runtimeAdapter: driftAdapter(payload, spy),
      eventEmitter: storeEmitter, artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
      validator: new DefaultEvaluatorValidator(),
      isRepairLoopEnabled: () => true,
      ...(seedRepair ? { seedArtificerRepairTask: seedRepair } : {}),
    }, { owner: 'drift', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
  }

  it('T7 assembly 完成后 crash before terminal: LLM 返回 needs_revision 也不得漂移,rule 恰一个', async () => {
    await seedLineage();
    await seedArtificerV2Artifact();
    const runId = await craftEvaluatorCrashState('approved', evaluatorV2Output());

    // run-1 的 durable 副作用: rule 已 assembled + validated,crash before terminal
    const expectedRuleId = `pi-rule-${EVAL_ID}-${runId}`;
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    await store.upsertArtifact({
      artifactId: expectedRuleId, artifactKind: 'rule', sourceTaskId: EVAL_ID,
      sourcePrincipleId: 'd1-p', sourceRuleId: `rule-${EVAL_ID}`,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ implementationCode: 'x', goldenTrace: { cases: [] }, goldenTraceCases: [], affectedTools: [], ruleHostGateDecision: 'accepted_shadow' }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    conn.close();

    const spy = { llmCalls: 0 };
    const seedCalls: number[] = [];
    const result = await makeV2Evaluator(spy, evaluatorV2Output(), async () => { seedCalls.push(1); throw new Error('T7: repair must not be seeded'); }).run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    expect(spy.llmCalls).toBe(0);                          // LLM 未被调用
    const pi = await readMeta(EVAL_ID);
    expect(pi?.runnerDecision).toBe('approved');           // final verdict 不漂移
    expect(pi?.completionIntent?.status).toBe('applied');
    expect(seedCalls).toEqual([]);                         // 无 repair
    // validated rule 恰好一个,id 与 fresh run 相同 (deterministic)
    const rules = await listRules();
    expect(rules.length).toBe(1);
    expect(rules[0]?.artifactId).toBe(expectedRuleId);
    expect(rules[0]?.validationStatus).toBe('validated');
  });

  it('T8 intent 持久化后、rule validated 前 crash: resume 自动恢复 assembly', async () => {
    await seedLineage();
    await seedArtificerV2Artifact();
    const runId = await craftEvaluatorCrashState('approved', evaluatorV2Output());
    // crash between intent and rule assembly — 无 rule 产物
    expect((await listRules()).length).toBe(0);

    const spy = { llmCalls: 0 };
    const result = await makeV2Evaluator(spy, evaluatorV2Output()).run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    expect(spy.llmCalls).toBe(0);                          // 不调用 LLM
    // rule assembly 自动恢复: 最终 validated,evaluator succeeded
    const rules = await listRules();
    expect(rules.length).toBe(1);
    expect(rules[0]?.artifactId).toBe(`pi-rule-${EVAL_ID}-${runId}`);
    expect(rules[0]?.validationStatus).toBe('validated');
    expect((await stateManager.getTask(EVAL_ID))?.status).toBe('succeeded');
    const pi = await readMeta(EVAL_ID);
    expect(pi?.runnerDecision).toBe('approved');
    expect(pi?.completionIntent?.status).toBe('applied');
  });

  it('T8-reverse (approved V2 真实 fixture) intent 持久化前 crash: 无任何治理副作用落库', async () => {
    await seedLineage();
    await seedArtificerV2Artifact();
    await stateManager.updateTask(EVAL_ID, { status: 'pending', attemptCount: 0 });
    // seedLineage 为 rollout 链预置了 runnerDecision='approved' — 清空以证明
    // "失败写不留痕" (assert 的 undefined 只能来自本次 abandoned attempt)
    const preRaw = await stateManager.getTask(EVAL_ID);
    if (!preRaw) throw new Error('T8-reverse: evaluator missing');
    const prePi = hydratePITaskRecord(preRaw);
    if (!prePi) throw new Error('T8-reverse: evaluator not hydratable');
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(
      mergePITaskMetadata(prePi, { runnerDecision: undefined, completionIntent: undefined }),
    ));
    // bearer 起始 pending: 若 approved effects 在 intent 前执行过,会被翻 validated
    const conn0 = new SqliteConnection(workspaceDir);
    const store0 = new SqlitePIArtifactStore(conn0);
    await store0.updateValidationStatus(SCRIBE_ART, 'pending');
    conn0.close();

    // 注入: completion intent 的 metadata 写失败 (crash-before-intent 等价)。
    // fixture 是真实的 approved V2 + adversarial passed (PART B 修复: 此前
    // 误用 needs_revision V1,从未证明 approved V2 ordering)。
    const inner = stateManager as unknown as Record<string, unknown>;
    const orig = inner.updateTaskDiagnosticJson as (taskId: string, json: string) => Promise<void>;
    inner.updateTaskDiagnosticJson = async (taskId: string, json: string): Promise<void> => {
      if (taskId === EVAL_ID && json.includes('"completionIntent"')) {
        throw new Error('injected completion intent write failure');
      }
      return orig.call(stateManager, taskId, json);
    };

    const spy = { llmCalls: 0 };
    const seedCalls: number[] = [];
    const result = await makeV2Evaluator(spy, evaluatorV2Output(), async () => {
      seedCalls.push(1);
      throw new Error('T8-reverse: repair must not be seeded');
    }).run(EVAL_ID);

    // evaluator 不得 succeeded
    expect(result.status).not.toBe('succeeded');
    const pi = await readMeta(EVAL_ID);
    // 原子写失败 ⇒ decision + intent 均未落库,无 durable completion
    expect(pi?.completionIntent).toBeUndefined();
    expect(pi?.runnerDecision).toBeUndefined();
    // validated rule 数量 = 0 (rule assembly 在 intent 后,intent 未落则绝不执行)
    expect((await listRules()).filter((r) => r.validationStatus === 'validated')).toEqual([]);
    // scribe bearer 不得因本次 abandoned completion 获得治理状态变化
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    const bearer = await store.getArtifactById(SCRIBE_ART);
    conn.close();
    expect(bearer?.validationStatus).toBe('pending');
    // repair task = 0
    expect(seedCalls).toEqual([]);
  });

  it('T6b needs_human_review materialization 失败: intent 不 applied,恢复后 resume 同一 effect (零 LLM)', async () => {
    await seedLineage();
    await craftRolloutCrashState('needs_revision', {
      effect: 'needs_human_review',
      rolloutRevisionPayload: {
        requiredChanges: ['前两轮'], revisionIteration: 2, sourceRolloutTaskId: ROLLOUT_ID,
        sourceArtifactId: SCRIBE_ART, targetTaskKind: 'scribe', status: 'applied',
      },
    });

    // 注入: updateTask(status=needs_human_review) 一次性失败
    const inner = stateManager as unknown as Record<string, unknown>;
    const origUpdate = inner.updateTask as (taskId: string, patch: Record<string, unknown>) => Promise<unknown>;
    let failuresLeft = 1;
    inner.updateTask = async (taskId: string, patch: Record<string, unknown>): Promise<unknown> => {
      if (taskId === ROLLOUT_ID && (patch as { status?: string }).status === 'needs_human_review' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('injected needs_human_review write failure');
      }
      return origUpdate.call(stateManager, taskId, patch);
    };

    const spy = { llmCalls: 0 };
    const runner1 = makeRolloutRunner(driftAdapter(rolloutOutput('approve_rollout'), spy), {
      dispatch: async () => { throw new Error('T6b: dispatch must not be called'); },
      reopen: async () => { throw new Error('T6b: reopen must not be called'); },
    });

    // 第一次 resume: materialize 失败 → 不正常完成
    const r1 = await runner1.run(ROLLOUT_ID);
    expect(r1.status).not.toBe('succeeded');
    // intent 仍 pending (INV-2: effect 未 durable 不得 applied)
    const pi1 = await readMeta(ROLLOUT_ID);
    expect(pi1?.completionIntent?.status).toBe('pending');
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).not.toBe('needs_human_review');
    expect(spy.llmCalls).toBe(0);

    // 第二次 run: DB 恢复 → resume 同一 effect,LLM 总数仍 0
    const runner2 = makeRolloutRunner(driftAdapter(rolloutOutput('approve_rollout'), spy), {
      dispatch: async () => { throw new Error('T6b: dispatch must not be called'); },
      reopen: async () => { throw new Error('T6b: reopen must not be called'); },
    });
    const r2 = await runner2.run(ROLLOUT_ID);
    expect(r2.status).toBe('succeeded');
    expect(spy.llmCalls).toBe(0);
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).toBe('needs_human_review');
    const pi2 = await readMeta(ROLLOUT_ID);
    expect(pi2?.runnerDecision).toBe('needs_revision');
    expect(pi2?.completionIntent?.status).toBe('applied');
    // revision budget 保持不变
    expect(pi2?.rolloutRevisionPayload?.revisionIteration).toBe(2);
  });
});
