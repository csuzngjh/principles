/**
 * PRI-1301 — rollout revision 路由行为固化 (characterization) 测试。
 *
 * 目的: 在 runner 私有 `resolveRevisionTarget` 删除、统一改调共享
 * `resolveRolloutRevisionTarget` (revision-reopen.ts) 的去重收编**之前**,
 * 把两条修订路由的现有可观察行为钉死:
 *
 *   1. 自动 needs_revision 路由 (RolloutReviewerRunner.handleRevisionRouting):
 *      - prompt channel   → reopen scribe (走到底);
 *      - code_tool_hook   → reopen artificer;
 *      - 持久化 rolloutRevisionPayload 的 sourceArtifactId **恒等于 rollout
 *        taskId** — runner 私有返回类型的 `viaArtifactId?: string` 字段在
 *        全部 git 历史中从未被赋值 (引入提交 c41e91032 起即无任何
 *        `viaArtifactId:` 对象字面量赋值), `target.viaArtifactId ?? ctx.taskId`
 *        因此恒取 fallback。本测试在值层面钉住该事实, 任何未来改动若真的
 *        填充 viaArtifactId 必须显式修改本测试 (不得静默改变);
 *      - `rollout_revision_routed` 遥测载荷 (targetTaskId/targetKind/
 *        revisionIteration);
 *      - reopen 接线输入的 sourceArtifactId 同样恒为 rollout taskId。
 *   2. 目标不可解析 → needs_human_review,reasonCode 精确为
 *      `rollout_revision_target_unresolved`。
 *   3. Owner revise_once 路由 (owner-resolution-service → 共享实现) 与自动
 *      路由对同一血缘图解析出**同一目标** (两路由统一同源的行为证据)。
 *   4. 共享 resolveRolloutRevisionTarget 的返回对象不携带 viaArtifactId
 *      own-property (三种路由形状)。
 *
 * fixture 结构复用 crash-liveness-regressions.test.ts 的 sqlite 真实装配
 * (dreamer 根血缘门禁可证)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { RolloutReviewerRunner } from '../rollout-reviewer-runner.js';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import type { RolloutReviewerOutputV1 } from '../rollout-reviewer-output.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { storeEmitter } from '../../store/event-emitter.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from '../pitask-metadata.js';
import { resolveRolloutRevisionTarget } from '../revision-reopen.js';
import type { TaskRecord } from '../../task-status.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

const SCRIBE_ID = 'scribe-rrc-prompt';
const ARTIFICER_ID = 'artificer-rrc-prompt';
const EVAL_ID = 'evaluator-rrc-prompt';
const ROLLOUT_ID = 'rollout_reviewer-rrc-prompt';
const SCRIBE_ART = 'pi-art-scribe-rrc';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rrc-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'rrc', runtimeKind: 'test-double', dryRun: true },
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

async function mkTask(id: string, kind: string, deps: string[], channel = 'prompt'): Promise<void> {
  if (kind === 'scribe') {
    await stateManager.createTask({
      taskId: 'dreamer-rrc-src', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        pi_metadata: { dependencyTaskIds: [], channel, timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] },
        candidateId: 'c',
      }),
    });
  }
  const parentTaskId = kind === 'scribe' ? 'dreamer-rrc-src' : deps[0];
  await stateManager.createTask({
    taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: meta({ correlationId: 'c', dependencyTaskIds: deps, parentTaskId, channel }),
  });
}

async function succeed(id: string): Promise<void> {
  const lease = await stateManager.acquireLeaseDetailed({ taskId: id, owner: 'rrc', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id, undefined, { taskId: id, owner: 'rrc', leaseGeneration: lease.leaseGeneration }, lease.runId);
}

function makeOutput(decision: 'needs_revision' | 'approve_rollout'): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID, sourceEvaluatorArtifactId: 'pi-art-eval-rrc',
    review: { decision, summary: 'c', confidence: 0.9, requiredChanges: decision === 'needs_revision' ? ['必须改 X'] : [], rolloutRisks: [], safetyChecks: [] },
    sourceTrace: { evaluatorArtifactId: 'pi-art-eval-rrc' }, risks: [], generatedAt: new Date().toISOString(),
  };
}

function scriptedAdapter(output: RolloutReviewerOutputV1) {
  return {
    startRun: async () => ({ runId: 'run-rrc', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId: 'run-rrc' }),
    fetchOutput: async () => ({ runId: 'run-rrc', payload: output }),
    cancelRun: async () => undefined,
  } as never;
}

function captureEmitter(events: TelemetryEvent[]): { emitTelemetry: (event: TelemetryEvent) => boolean } {
  return {
    emitTelemetry: (event: TelemetryEvent) => {
      events.push(event);
      return true;
    },
  };
}

interface ReopenCall {
  targetTaskId: string;
  targetKind: string;
  revisionFeedback: string;
  revisionIteration: number;
  sourceRolloutTaskId: string;
  sourceArtifactId?: string;
}

function makeRunner(events: TelemetryEvent[], reopenCalls: ReopenCall[]): RolloutReviewerRunner {
  return new RolloutReviewerRunner({
    stateManager, runtimeAdapter: scriptedAdapter(makeOutput('needs_revision')),
    eventEmitter: captureEmitter(events), validator: new DefaultRolloutReviewerValidator(),
    artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
    reopenRevisionTarget: async (input) => {
      reopenCalls.push({ ...input });
      const r = await orchestrator.reopenTaskForRevision(input.targetTaskId, {
        revisionFeedback: input.revisionFeedback,
        revisionCauseId: `rollout-${input.sourceRolloutTaskId}-r${input.revisionIteration}`,
      });
      return r.ok ? { ok: true, reason: r.reason, reopenedTaskId: input.targetTaskId } : { ok: false, reason: r.reason };
    },
  }, { owner: 'rrc', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

/**
 * crash-liveness 同款血缘: scribe→artificer→evaluator→rollout (链挂 dreamer 根)。
 * channel 参数控制全链 pi_metadata.channel — 路由判决读 rollout 任务自身 channel。
 */
async function seedLineage(channel: 'prompt' | 'code_tool_hook'): Promise<void> {
  await mkTask(SCRIBE_ID, 'scribe', [], channel);
  await succeed(SCRIBE_ID);
  await mkTask(ARTIFICER_ID, 'artificer', [SCRIBE_ID], channel);
  await succeed(ARTIFICER_ID);
  await mkTask(EVAL_ID, 'evaluator', [ARTIFICER_ID], channel);
  await succeed(EVAL_ID);
  const evalRaw = await stateManager.getTask(EVAL_ID);
  if (!evalRaw) throw new Error('seed: evaluator missing');
  const evalPi = hydratePITaskRecord(evalRaw);
  if (!evalPi) throw new Error('seed: evaluator not hydratable');
  await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(evalPi, { runnerDecision: 'approved' })));
  await mkTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID], channel);

  const conn = new SqliteConnection(workspaceDir);
  const store = new SqlitePIArtifactStore(conn);
  await store.upsertArtifact({
    artifactId: 'pi-art-eval-rrc', artifactKind: 'principle', sourceTaskId: EVAL_ID,
    lineageArtifactIds: [], validationStatus: 'pending',
    contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await store.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'c-p', text: '原则', principleDraft: { title: 'c-p', statement: '原则' } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  conn.close();
}

async function readRolloutPayload(): Promise<{ sourceArtifactId?: string; targetTaskKind?: string; revisionIteration?: number; status?: string }> {
  const pi = hydratePITaskRecord((await stateManager.getTask(ROLLOUT_ID)) as TaskRecord);
  return {
    sourceArtifactId: pi?.rolloutRevisionPayload?.sourceArtifactId,
    targetTaskKind: pi?.rolloutRevisionPayload?.targetTaskKind,
    revisionIteration: pi?.rolloutRevisionPayload?.revisionIteration,
    status: pi?.rolloutRevisionPayload?.status,
  };
}

describe('PRI-1301 固化 — 自动 needs_revision 路由 (runner 端可观察行为)', () => {
  it('prompt channel: reopen scribe; payload.sourceArtifactId 恒为 rollout taskId; rollout_revision_routed 遥测载荷精确', async () => {
    await seedLineage('prompt');
    const events: TelemetryEvent[] = [];
    const reopenCalls: ReopenCall[] = [];
    const result = await makeRunner(events, reopenCalls).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // 路由目标: scribe 被 reopen 恰一次
    expect(reopenCalls.length).toBe(1);
    expect(reopenCalls[0]?.targetTaskId).toBe(SCRIBE_ID);
    expect(reopenCalls[0]?.targetKind).toBe('scribe');
    expect(reopenCalls[0]?.revisionIteration).toBe(1);
    // viaArtifactId 从未赋值的既有事实: reopen 接线的 sourceArtifactId = rollout taskId
    expect(reopenCalls[0]?.sourceArtifactId).toBe(ROLLOUT_ID);
    const scribePi = hydratePITaskRecord((await stateManager.getTask(SCRIBE_ID)) as TaskRecord);
    expect(scribePi?.revisionCount).toBe(1);
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('pending');

    // 持久化载荷: sourceArtifactId 恒为 rollout taskId (fallback 现实)
    const payload = await readRolloutPayload();
    expect(payload.sourceArtifactId).toBe(ROLLOUT_ID);
    expect(payload.targetTaskKind).toBe('scribe');
    expect(payload.revisionIteration).toBe(1);
    expect(payload.status).toBe('applied');

    // 遥测: rollout_revision_routed 精确载荷
    const routed = events.filter((e) => e.eventType === 'rollout_revision_routed');
    expect(routed.length).toBe(1);
    expect(routed[0]?.payload).toMatchObject({
      targetTaskId: SCRIBE_ID,
      targetKind: 'scribe',
      revisionIteration: 1,
    });
  });

  it('code_tool_hook channel: reopen artificer; payload.sourceArtifactId 恒为 rollout taskId; 遥测 targetKind=artificer', async () => {
    await seedLineage('code_tool_hook');
    const events: TelemetryEvent[] = [];
    const reopenCalls: ReopenCall[] = [];
    const result = await makeRunner(events, reopenCalls).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    expect(reopenCalls.length).toBe(1);
    expect(reopenCalls[0]?.targetTaskId).toBe(ARTIFICER_ID);
    expect(reopenCalls[0]?.targetKind).toBe('artificer');
    expect(reopenCalls[0]?.sourceArtifactId).toBe(ROLLOUT_ID);
    const artPi = hydratePITaskRecord((await stateManager.getTask(ARTIFICER_ID)) as TaskRecord);
    expect(artPi?.revisionCount).toBe(1);
    expect((await stateManager.getTask(ARTIFICER_ID))?.status).toBe('pending');
    // prompt 链的 scribe 不被波及
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('succeeded');

    const payload = await readRolloutPayload();
    expect(payload.sourceArtifactId).toBe(ROLLOUT_ID);
    expect(payload.targetTaskKind).toBe('artificer');

    const routed = events.filter((e) => e.eventType === 'rollout_revision_routed');
    expect(routed.length).toBe(1);
    expect(routed[0]?.payload).toMatchObject({
      targetTaskId: ARTIFICER_ID,
      targetKind: 'artificer',
      revisionIteration: 1,
    });
  });

  it('目标不可解析 (evaluator 无 artificer 依赖且无直接 scribe 依赖): NHR reasonCode 精确为 rollout_revision_target_unresolved', async () => {
    // 链存在但 evaluator 不依赖 artificer — 解析第一跳失败;rollout 只挂
    // evaluator,直接 scribe fallback 也不命中 → null → NHR。
    await mkTask(SCRIBE_ID, 'scribe', []);
    await succeed(SCRIBE_ID);
    await mkTask(ARTIFICER_ID, 'artificer', [SCRIBE_ID]);
    await succeed(ARTIFICER_ID);
    await mkTask(EVAL_ID, 'evaluator', []); // 无 artificer 依赖 — 解析断链
    await succeed(EVAL_ID);
    const evalRaw = await stateManager.getTask(EVAL_ID);
    const evalPi = hydratePITaskRecord(evalRaw as TaskRecord);
    if (!evalPi) throw new Error('seed: evaluator not hydratable');
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(evalPi, { runnerDecision: 'approved' })));
    await mkTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID]);
    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    await store.upsertArtifact({
      artifactId: 'pi-art-eval-rrc', artifactKind: 'principle', sourceTaskId: EVAL_ID,
      lineageArtifactIds: [], validationStatus: 'pending',
      contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    conn.close();

    const events: TelemetryEvent[] = [];
    const reopenCalls: ReopenCall[] = [];
    const result = await makeRunner(events, reopenCalls).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded'); // runner 完成,但转入 NHR
    expect(reopenCalls.length).toBe(0); // 无 reopen 发生

    const rolloutRaw = await stateManager.getTask(ROLLOUT_ID);
    expect(rolloutRaw?.status).toBe('needs_human_review');
    const rolloutPi = hydratePITaskRecord(rolloutRaw as TaskRecord);
    expect(rolloutPi?.humanReviewContext?.reasonCode).toBe('rollout_revision_target_unresolved');

    const nhrEvents = events.filter((e) => e.eventType === 'rollout_reviewer_task_needs_human_review');
    expect(nhrEvents.length).toBeGreaterThan(0);
    expect(nhrEvents[0]?.payload).toMatchObject({ reason: 'rollout_revision_target_unresolved' });
    // 无 routed 遥测
    expect(events.filter((e) => e.eventType === 'rollout_revision_routed').length).toBe(0);
  });
});

describe('PRI-1301 固化 — 两条路由同一目标的同源证据', () => {
  it.each(['prompt', 'code_tool_hook'] as const)('同一血缘图: 共享 resolveRolloutRevisionTarget (Owner revise_once 路由) 与 runner 自动路由命中同一目标 (%s)', async (channel) => {
    await seedLineage(channel);
    // Owner 路由的解析方式 (owner-resolution-service.resolveReviseTarget):
    // 绑定 stateManager.getTask 调共享实现,channel 缺省 'prompt'。
    const ownerRouteTarget = await resolveRolloutRevisionTarget(
      (id) => stateManager.getTask(id),
      ROLLOUT_ID,
      channel,
    );
    // runner 自动路由实际 reopen 的目标
    const events: TelemetryEvent[] = [];
    const reopenCalls: ReopenCall[] = [];
    const result = await makeRunner(events, reopenCalls).run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    expect(reopenCalls.length).toBe(1);

    expect(ownerRouteTarget).not.toBeNull();
    expect(ownerRouteTarget?.taskId).toBe(reopenCalls[0]?.targetTaskId);
    expect(ownerRouteTarget?.kind).toBe(reopenCalls[0]?.targetKind);
  });
});

describe('PRI-1301 固化 — viaArtifactId 从未产生值的回归钉', () => {
  function resolutionStore(shape: 'code_chain' | 'direct_scribe'): (id: string) => Promise<TaskRecord | null> {
    const m = (deps: string[]): string => createPITaskDiagnosticJson({
      dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [],
    });
    const rec = (taskId: string, taskKind: string, deps: string[]): TaskRecord => ({
      taskId, taskKind, status: 'succeeded', attemptCount: 0, maxAttempts: 3,
      createdAt: 't', updatedAt: 't', diagnosticJson: m(deps),
    });
    const rows = shape === 'code_chain'
      ? [
          rec('rollout-1', 'rollout_reviewer', ['eval-1']),
          rec('eval-1', 'evaluator', ['art-1']),
          rec('art-1', 'artificer', ['scribe-1']),
          rec('scribe-1', 'scribe', []),
        ]
      : [
          rec('rollout-1', 'rollout_reviewer', ['scribe-1']),
          rec('scribe-1', 'scribe', []),
        ];
    return async (id) => rows.find((r) => r.taskId === id) ?? null;
  }

  it('code 链两种 channel 与直接 scribe 链: 解析结果均不携带 viaArtifactId own-property', async () => {
    const codeHook = await resolveRolloutRevisionTarget(resolutionStore('code_chain'), 'rollout-1', 'code_tool_hook');
    const codePrompt = await resolveRolloutRevisionTarget(resolutionStore('code_chain'), 'rollout-1', 'prompt');
    const directScribe = await resolveRolloutRevisionTarget(resolutionStore('direct_scribe'), 'rollout-1', 'prompt');
    expect(codeHook).toMatchObject({ taskId: 'art-1', kind: 'artificer' });
    expect(codePrompt).toMatchObject({ taskId: 'scribe-1', kind: 'scribe' });
    expect(directScribe).toMatchObject({ taskId: 'scribe-1', kind: 'scribe' });
    // 核心钉: 全 git 历史中 viaArtifactId 从未被赋值 — 解析结果对象上不存在
    // 该 own-property。若未来实现真的填充它, 本测试必须显式更新 (不得静默)。
    for (const target of [codeHook, codePrompt, directScribe]) {
      expect(target).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(target, 'viaArtifactId')).toBe(false);
    }
  });
});
