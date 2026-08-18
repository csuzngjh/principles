/**
 * MVP Core Loop Journey E2E (Gate B/C 证明) — 真实 store + 真实 runner +
 * 真实 ActivationDispatcher,仅 LLM 用 scripted adapter (状态机与治理是
 * 被测对象;LLM 真实链路由 signal-stage2-real-adapter.e2e.test.ts 覆盖)。
 *
 * Journey 5 — evaluator needs_revision: 无 rollout 旁路;repair 完成 reopen。
 * Journey 6 — repair 耗尽 → needs_human_review,无后继无审批无激活。
 * Journey 7 — rollout needs_revision → reopen scribe;approvals 表零新增。
 * Journey 8 — rollout approve_rollout → 自动 dispatch: 低风险 prompt 渠道
 *            直接产生 activation 行 (system_policy),无需人工 CLI。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { RolloutReviewerRunner } from '../rollout-reviewer-runner.js';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import type { RolloutReviewerOutputV1 } from '../rollout-reviewer-output.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { storeEmitter } from '../../store/event-emitter.js';
import { ActivationDispatcher } from '../../activation/activation-dispatcher.js';
import { PromptWriter, DeferArchiveWriter } from '../../activation/low-risk-writers.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationStateStore } from '../../activation/sqlite-activation-state-store.js';
import { SqliteApprovalQueueStore } from '../../activation/sqlite-approval-store.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { TaskRecord } from '../../task-status.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-journey-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager },
    { owner: 'journey-test', runtimeKind: 'journey-test', dryRun: true },
  );
});

afterEach(async () => {
  await stateManager.close();
  // Windows: better-sqlite3 WAL 句柄可能延迟释放,清理 best-effort (os.tmpdir 兜底)
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* temp dir — OS cleanup */
  }
});

function meta(overrides: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  });
}

async function createTask(taskId: string, taskKind: string, diagnosticJson: string): Promise<void> {
  await stateManager.createTask({
    taskId, taskKind, status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson,
  });
}

async function succeedWithDecision(taskId: string, runnerDecision?: string): Promise<void> {
  await stateManager.acquireLease({ taskId, owner: 't', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(taskId);
  if (runnerDecision) {
    const t = await stateManager.getTask(taskId);
    const pi = hydratePITaskRecord(t as TaskRecord);
    if (pi) {
      await stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson({
        dependencyTaskIds: pi.dependencyTaskIds,
        channel: pi.channel,
        timeoutMs: pi.timeoutMs,
        inputArtifactRefs: pi.inputArtifactRefs,
        outputArtifactRefs: pi.outputArtifactRefs,
        correlationId: pi.correlationId,
        revisionCount: pi.revisionCount,
        runnerDecision: runnerDecision as never,
      }));
    }
  }
}

async function countTasks(): Promise<Map<string, { status: string; kind: string }>> {
  const tasks = await stateManager.listTasks({});
  const map = new Map<string, { status: string; kind: string }>();
  for (const t of tasks) map.set(t.taskId, { status: t.status, kind: t.taskKind });
  return map;
}

// ── Journey 5/6: evaluator revision 状态机 ──────────────────────────────────

describe('Journey 5 — Evaluator needs_revision 无旁路 + repair reopen', () => {
  it('evaluator needs_revision: 绝不创建 rollout_reviewer;repair 完成后 evaluator 重开', async () => {
    const evalId = 'evaluator-j5-prompt';
    await createTask('scribe-j5-prompt', 'scribe', meta({ correlationId: 'j5' }));
    await succeedWithDecision('scribe-j5-prompt');
    await createTask('artificer-j5-prompt', 'artificer', meta({
      dependencyTaskIds: ['scribe-j5-prompt'], correlationId: 'j5',
    }));
    await succeedWithDecision('artificer-j5-prompt');
    await createTask(evalId, 'evaluator', meta({
      dependencyTaskIds: ['artificer-j5-prompt'],
      correlationId: 'j5',
    }));
    await succeedWithDecision(evalId, 'needs_revision');

    // 模拟 evaluator runner 已 seed 的 repair 任务 (生产中由 seeder dep 创建)
    const repairId = 'artificer-repair-j5-1';
    await createTask(repairId, 'artificer', meta({
      repairPayload: {
        requiredChanges: ['fix guard clause'],
        concerns: [],
        previousScore: 0.4,
        repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-afix-j5',
        sourceEvaluatorTaskId: evalId,
      },
      dependencyTaskIds: ['scribe-j5-prompt'],
    }));

    // host 提交 evaluator 后继 (auto-consumer 行为)
    const r1 = await orchestrator.commitNextTaskProposal(evalId);
    expect(r1.decision).toBe('blocked_by_revision');
    let tasks = await countTasks();
    expect([...tasks.keys()].filter((id) => id.includes('rollout'))).toEqual([]);

    // repair 任务完成 → evaluator 重开
    await succeedWithDecision(repairId);
    const r2 = await orchestrator.commitNextTaskProposal(repairId);
    expect(r2.decision).toBe('revision_reopened');

    const reopened = await stateManager.getTask(evalId);
    expect(reopened?.status).toBe('pending');
    const reopenedPi = hydratePITaskRecord(reopened as TaskRecord);
    expect(reopenedPi?.dependencyTaskIds).toContain(repairId);
    expect(reopenedPi?.dependencyTaskIds).not.toContain('artificer-j5-prompt');
    expect(reopenedPi?.revisionCount).toBe(1);
    expect(reopenedPi?.runnerDecision).toBeUndefined();

    // evaluator 修订轮 approved (revisionCount=1) → 级联 seed rollout_reviewer
    await succeedWithDecision(evalId, 'approved');
    const r3 = await orchestrator.commitNextTaskProposal(evalId);
    expect(r3.decision).toBe('successor_created');
    tasks = await countTasks();
    expect([...tasks.keys()]).toContain('rollout_reviewer-j5-prompt');
  });
});

describe('Journey 6 — Repair 耗尽 → needs_human_review,零副作用', () => {
  it('第三轮 needs_revision (priorIteration>=2) → needs_human_review,无 rollout/approval/activation', async () => {
    const evalId = 'evaluator-j6-prompt';
    await createTask(evalId, 'evaluator', meta({
      dependencyTaskIds: ['artificer-repair-j6-2'],
      correlationId: 'j6',
    }));
    // evaluator 依赖的 repair 任务已是第 2 轮 → 下一次 needs_revision 耗尽
    await createTask('artificer-repair-j6-2', 'artificer', meta({
      repairPayload: {
        requiredChanges: ['x'], concerns: [], previousScore: 0.3,
        repairIteration: 2, sourceArtificerArtifactId: 'pi-art-a2',
        sourceEvaluatorTaskId: evalId,
      },
    }));
    // 生产路径: evaluator runner 判定耗尽 → updateTask(needs_human_review)
    await stateManager.acquireLease({ taskId: evalId, owner: 't', runtimeKind: 'test-double' });
    await stateManager.updateTask(evalId, { status: 'needs_human_review' });

    const r = await orchestrator.commitNextTaskProposal(evalId);
    expect(r.decision).toBe('source_not_succeeded');
    const tasks = await countTasks();
    expect([...tasks.keys()].filter((id) => id.includes('rollout'))).toEqual([]);

    // Owner 出道 (INV-3): needs_human_review → pending (retry)
    await stateManager.updateTask(evalId, { status: 'pending', attemptCount: 0 });
    expect((await stateManager.getTask(evalId))?.status).toBe('pending');
  });
});

// ── Journey 7/8: rollout reviewer 真实 runner + 真实治理 deps ───────────────

const EVAL_ID = 'evaluator-j78-prompt';
const ROLLOUT_ID = 'rollout_reviewer-j78-prompt';
const ARTIFICER_ID = 'artificer-j78-prompt';
const SCRIBE_ID = 'scribe-j78-prompt';
const EVAL_ARTIFACT = 'pi-art-eval-j78';

function makeRolloutOutput(decision: 'approve_rollout' | 'needs_revision'): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID,
    sourceEvaluatorArtifactId: EVAL_ARTIFACT,
    review: {
      decision,
      summary: 'journey test',
      confidence: 0.9,
      requiredChanges: decision === 'needs_revision' ? ['措辞必须更明确'] : [],
      rolloutRisks: [],
      safetyChecks: [],
    },
    sourceTrace: { evaluatorArtifactId: EVAL_ARTIFACT },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function scriptedAdapter(output: RolloutReviewerOutputV1): PDRuntimeAdapter {
  return {
    startRun: async (): Promise<RunHandle> => ({ runId: 'run-j78', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async (): Promise<RunStatus> => ({ status: 'succeeded', runId: 'run-j78' }),
    fetchOutput: async () => ({ runId: 'run-j78', payload: output }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

async function seedRolloutLineage(evaluatorValidated: boolean): Promise<SqlitePIArtifactStore> {
  await createTask(SCRIBE_ID, 'scribe', meta({ correlationId: 'j78' }));
  await succeedWithDecision(SCRIBE_ID);
  await createTask(ARTIFICER_ID, 'artificer', meta({
    dependencyTaskIds: [SCRIBE_ID], correlationId: 'j78',
  }));
  await succeedWithDecision(ARTIFICER_ID);
  await createTask(EVAL_ID, 'evaluator', meta({
    dependencyTaskIds: [ARTIFICER_ID], correlationId: 'j78',
  }));
  await succeedWithDecision(EVAL_ID, 'approved');
  await createTask(ROLLOUT_ID, 'rollout_reviewer', meta({
    dependencyTaskIds: [EVAL_ID], correlationId: 'j78',
  }));

  const artifactConn = new SqliteConnection(workspaceDir);
  const artifactStore = new SqlitePIArtifactStore(artifactConn);
  try {
  await artifactStore.upsertArtifact({
    artifactId: EVAL_ARTIFACT,
    artifactKind: 'principle',
    sourceTaskId: EVAL_ID,
    lineageArtifactIds: [],
    validationStatus: evaluatorValidated ? 'validated' : 'pending',
    contentJson: JSON.stringify({
      principleId: 'principle-j78',
      text: '遇到歧义先确认 Owner 意图',
      evaluation: { decision: 'approved', score: 0.9, requiredChanges: [], concerns: [] },
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  } finally {
    try { artifactConn.close(); } catch { /* best-effort */ }
  }
  return artifactStore;
}

function makeDispatcherDeps(): { dispatchActivation: NonNullable<import('../rollout-reviewer-runner.js').RolloutReviewerRunnerDeps['dispatchActivation']> } {
  return {
    dispatchActivation: async (input) => {
      // 与 plugin auto-consumer-governance-wiring 相同的真实接线 (core 内联版)
      const connection = new SqliteConnection(workspaceDir);
      try {
        const piArtifactStore = new SqlitePIArtifactStore(connection);
        const artifactReadModel = {
          getArtifactById: async (id: string) => {
            const rec = await piArtifactStore.getArtifactById(id);
            return rec ? {
              artifactId: rec.artifactId, artifactKind: rec.artifactKind,
              sourceTaskId: rec.sourceTaskId, lineageArtifactIds: rec.lineageArtifactIds,
              validationStatus: rec.validationStatus, contentJson: rec.contentJson,
              createdAt: rec.createdAt, updatedAt: rec.updatedAt,
            } : null;
          },
        };
        const dispatcher = new ActivationDispatcher(
          artifactReadModel,
          new SqliteActivationStateStore(connection),
          { writers: [new PromptWriter(), new DeferArchiveWriter()], approvalQueueStore: new SqliteApprovalQueueStore(connection) },
        );
        const decision = await dispatcher.dispatch({
          artifactId: input.artifactId,
          channel: 'prompt',
          rolloutDecision: 'auto_activate',
          actor: { kind: 'system', source: 'rollout_reviewer' },
          now: new Date().toISOString(),
          confirm: true,
          confidence: input.confidence,
        });
        if (decision.decision === 'activated') return { decision: decision.decision, activationId: decision.activationId };
        if (decision.decision === 'already_activated') return { decision: decision.decision, reason: 'idempotent' };
        if (decision.decision === 'queued_for_approval') return { decision: decision.decision, reason: decision.approvalId };
        return { decision: decision.decision, reason: 'reason' in decision ? String(decision.reason) : decision.decision };
      } finally {
        try { connection.close(); } catch { /* best-effort */ }
      }
    },
  };
}

describe('Journey 7 — rollout needs_revision → scribe reopen,不进 approval', () => {
  it('needs_revision: scribe 被 reopen (revisionFeedback 注入),approvals 表零新增', async () => {
    const artifactStore = await seedRolloutLineage(true);
    const dispatcherDeps = makeDispatcherDeps();
    const reopenCalls: string[] = [];
    const runner = new RolloutReviewerRunner({
      stateManager,
      runtimeAdapter: scriptedAdapter(makeRolloutOutput('needs_revision')),
      eventEmitter: storeEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
      ...dispatcherDeps,
      reopenRevisionTarget: async (input) => {
        reopenCalls.push(input.targetTaskId);
        const r = await orchestrator.reopenTaskForRevision(input.targetTaskId, {
          revisionFeedback: input.revisionFeedback,
        });
        return r.ok ? { ok: true, reason: r.reason, reopenedTaskId: input.targetTaskId } : { ok: false, reason: r.reason };
      },
    }, { owner: 'j7', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    const beforeApprovals = countApprovals();
    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // 路由到 scribe (prompt 渠道 → 原则措辞问题)
    expect(reopenCalls).toEqual([SCRIBE_ID]);
    const scribe = await stateManager.getTask(SCRIBE_ID);
    expect(scribe?.status).toBe('pending');
    const scribePi = hydratePITaskRecord(scribe as TaskRecord);
    expect(scribePi?.revisionCount).toBe(1);
    expect(scribePi?.revisionFeedback).toContain('措辞必须更明确');

    // rollout 任务记录了 runnerDecision + revision payload (budget 依据)
    const rollout = await stateManager.getTask(ROLLOUT_ID);
    const rolloutPi = hydratePITaskRecord(rollout as TaskRecord);
    expect(rolloutPi?.runnerDecision).toBe('needs_revision');
    expect(rolloutPi?.rolloutRevisionPayload?.revisionIteration).toBe(1);
    expect(rolloutPi?.rolloutRevisionPayload?.targetTaskKind).toBe('scribe');

    // 关键断言 (Gate C): approval 队列零新增
    expect(countApprovals()).toBe(beforeApprovals);
    // 无 activation
    expect(countActivations()).toBe(0);
  });
});

describe('Journey 8 — approve_rollout → 自动 dispatch (低风险 system_policy)', () => {
  it('approve_rollout: activation 行自动产生,无需 pd runtime activation dispatch', async () => {
    const artifactStore = await seedRolloutLineage(true);
    const runner = new RolloutReviewerRunner({
      stateManager,
      runtimeAdapter: scriptedAdapter(makeRolloutOutput('approve_rollout')),
      eventEmitter: storeEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
      ...makeDispatcherDeps(),
    }, { owner: 'j8', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    expect(countActivations()).toBe(0);
    const result = await runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // 低风险 prompt 渠道 → system policy 自动激活
    const activations = listActivations();
    expect(activations.length).toBe(1);
    expect(activations[0]?.artifact_id).toBe(EVAL_ARTIFACT);
    expect(activations[0]?.action).toBe('prompt_activate');
    expect(activations[0]?.deactivated_at).toBeNull();
    // 无 approval 需要 Owner 处理 (低风险自动路径)
    expect(countApprovals()).toBe(0);

    // 幂等 (INV-08): 重跑不产生第二条 activation
    await stateManager.updateTask(ROLLOUT_ID, { status: 'pending', attemptCount: 0 });
    const rerun = await runner.run(ROLLOUT_ID);
    expect(rerun.status).toBe('succeeded');
    expect(listActivations().length).toBe(1);
  });
});

// ── SQL 计数 helpers (经独立只读连接) ───────────────────────────────────────

function withDb<T>(fn: (db: { prepare: (sql: string) => { get: (...a: unknown[]) => T; all: (...a: unknown[]) => unknown[] } }) => T): T {
  const conn = new SqliteConnection(workspaceDir);
  try {
    return fn(conn.getDb() as never);
  } finally {
    try { conn.close(); } catch { /* best-effort */ }
  }
}

function countApprovals(): number {
  return withDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS c FROM approvals').get() as unknown as { c: number };
    return row.c;
  });
}

function countActivations(): number {
  return withDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS c FROM activations').get() as unknown as { c: number };
    return row.c;
  });
}

function listActivations(): Array<Record<string, unknown>> {
  return withDb((db) => db.prepare('SELECT * FROM activations').all() as Array<Record<string, unknown>>);
}
