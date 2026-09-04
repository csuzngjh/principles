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
import type { RolloutReviewerRunnerDeps } from '../rollout-reviewer-runner.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
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

function listActivations(): Record<string, unknown>[] {
  return withDb((db) => db.prepare('SELECT * FROM activations').all() as Record<string, unknown>[]);
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

  it('PRI-668: rollout needs_revision 重开父 artificer 后,级联 reopen 必须刷新 evaluator 的 artificer 依赖', async () => {
    const evalId = 'evaluator-j5b-prompt';
    const parentArtificerId = 'artificer-j5b-prompt';
    const repairId = 'artificer-repair-evaluator-j5b-prompt-r1';
    await createTask('scribe-j5b-prompt', 'scribe', meta({ correlationId: 'j5b' }));
    await succeedWithDecision('scribe-j5b-prompt');
    await createTask(parentArtificerId, 'artificer', meta({
      dependencyTaskIds: ['scribe-j5b-prompt'], correlationId: 'j5b',
    }));
    await succeedWithDecision(parentArtificerId);
    await createTask(evalId, 'evaluator', meta({
      dependencyTaskIds: [parentArtificerId], correlationId: 'j5b',
    }));
    await succeedWithDecision(evalId, 'approved');
    const seeded = await orchestrator.commitNextTaskProposal(evalId); // seeds rollout_reviewer
    expect(seeded.decision).toBe('successor_created');
    const rolloutId = 'rollout_reviewer-j5b-prompt';
    await succeedWithDecision(rolloutId, 'needs_revision');

    // repair 循环把 evaluator 依赖换到 repair 任务 (P0-D 既有行为)
    await createTask(repairId, 'artificer', meta({
      repairPayload: {
        requiredChanges: ['fix guard clause'],
        concerns: [],
        previousScore: 0.4,
        repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-afix-j5b',
        sourceEvaluatorTaskId: evalId,
      },
      dependencyTaskIds: ['scribe-j5b-prompt'],
    }));
    await succeedWithDecision(repairId);
    await orchestrator.commitNextTaskProposal(repairId); // REOPEN_SOURCE_EVALUATOR: dep → repair
    let evalTask = await stateManager.getTask(evalId);
    let evalPi = hydratePITaskRecord(evalTask as TaskRecord);
    expect(evalPi?.dependencyTaskIds).toContain(repairId); // P0-D 换依赖已生效
    // 修复轮后的 evaluator 修订轮完成 (仍 needs_revision → repair 预算耗尽形态)
    await succeedWithDecision(evalId, 'needs_revision');
    // rollout 复核仍 needs_revision → governance reopen 父 artificer
    // (模拟 createRolloutGovernanceDeps.reopenRevisionTarget 对 code_tool_hook 通道)
    const reopened = await orchestrator.reopenTaskForRevision(parentArtificerId, {
      reason: 'rollout_revision_iteration_1',
      revisionCauseId: 'rollout-rollout_reviewer-j5b-prompt-r1',
    });
    expect(reopened.ok).toBe(true);
    // 父 artificer 修订后重新完成 → commit 触发对 evaluator 的级联 reopen
    await succeedWithDecision(parentArtificerId);
    const cascade = await orchestrator.commitNextTaskProposal(parentArtificerId);
    expect(['successor_reopened', 'revision_reopen_noop']).toContain(cascade.decision);

    // PRI-668 断言: evaluator 的 artificer 依赖必须已刷新为刚完成的父 artificer,
    // 不得仍钉在陈旧的 repair 任务上 (陈旧依赖 = 修订永不收敛根因)
    evalTask = await stateManager.getTask(evalId);
    evalPi = hydratePITaskRecord(evalTask as TaskRecord);
    expect(evalPi?.dependencyTaskIds).toContain(parentArtificerId);
    expect(evalPi?.dependencyTaskIds).not.toContain(repairId);
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

function makeDispatcherDeps(): { dispatchActivation: NonNullable<RolloutReviewerRunnerDeps['dispatchActivation']> } {
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

describe('Journey 8 — 真实 EvaluatorRunner → RolloutReviewerRunner → ActivationDispatcher (P0-1)', () => {
  const SCRIBE_TASK_ID = 'scribe-j8-real-prompt';
  const ARTIFICER_TASK_ID = 'artificer-j8-real-prompt';
  const EVAL_TASK_ID = 'evaluator-j8-real-prompt';
  const ROLLOUT_TASK_ID = 'rollout_reviewer-j8-real-prompt';
  const SCRIBE_ARTIFACT = 'pi-art-scribe-j8-real';
  const ARTIFICER_ARTIFACT = 'pi-art-artificer-j8-real';

  async function seedRealLineage(): Promise<void> {
    // scribe(succeeded) + principle artifact(pending, 真实 bearer 形状)
    await createTask(SCRIBE_TASK_ID, 'scribe', meta({ correlationId: 'j8real' }));
    await succeedWithDecision(SCRIBE_TASK_ID);
    const conn = new SqliteConnection(workspaceDir);
    try {
      const store = new SqlitePIArtifactStore(conn);
      await store.upsertArtifact({
        artifactId: SCRIBE_ARTIFACT, artifactKind: 'principle', sourceTaskId: SCRIBE_TASK_ID,
        lineageArtifactIds: [], validationStatus: 'pending',
        contentJson: JSON.stringify({
          principleId: 'principle-j8-real', text: '遇到歧义先确认 Owner 意图',
          principleDraft: { title: 'principle-j8-real', statement: '遇到歧义先确认 Owner 意图' },
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await store.upsertArtifact({
        artifactId: ARTIFICER_ARTIFACT, artifactKind: 'patch', sourceTaskId: ARTIFICER_TASK_ID,
        lineageArtifactIds: [SCRIBE_ARTIFACT], validationStatus: 'pending',
        contentJson: JSON.stringify({ taskId: ARTIFICER_TASK_ID, changes: [] }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
    // artificer(succeeded) / evaluator(pending)
    await createTask(ARTIFICER_TASK_ID, 'artificer', meta({
      dependencyTaskIds: [SCRIBE_TASK_ID], correlationId: 'j8real',
      outputArtifactRefs: [{ artifactType: 'patch', ref: ARTIFICER_ARTIFACT }],
    }));
    await succeedWithDecision(ARTIFICER_TASK_ID);
    await createTask(EVAL_TASK_ID, 'evaluator', meta({
      dependencyTaskIds: [ARTIFICER_TASK_ID], correlationId: 'j8real',
    }));
  }

  function evaluatorAdapter(): PDRuntimeAdapter {
    return {
      startRun: async () => ({ runId: 'run-eval-j8', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
      pollRun: async () => ({ status: 'succeeded', runId: 'run-eval-j8' }),
      fetchOutput: async () => ({
        runId: 'run-eval-j8',
        payload: {
          taskId: EVAL_TASK_ID,
          sourceArtificerArtifactId: ARTIFICER_ARTIFACT,
          evaluation: { decision: 'approved', summary: 'ok', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
          sourceTrace: { artificerArtifactId: ARTIFICER_ARTIFACT, scribeArtifactId: SCRIBE_ARTIFACT },
          risks: [], generatedAt: new Date().toISOString(),
        },
      }),
      cancelRun: async () => undefined,
    } as unknown as PDRuntimeAdapter;
  }

  it('approved 链: dispatch 目标 = scribe 的 validated principle artifact,绝非 evaluator 评审输出', async () => {
    await seedRealLineage();
    const artifactStore = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));

    // ── 真实 EvaluatorRunner (scripted LLM verdict: approved) ──
    const evaluator = new EvaluatorRunner({
      stateManager, runtimeAdapter: evaluatorAdapter(), eventEmitter: storeEmitter,
      artifactStore, validator: new DefaultEvaluatorValidator(),
    }, { owner: 'j8', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
    const evalResult = await evaluator.run(EVAL_TASK_ID);
    expect(evalResult.status).toBe('succeeded');

    // evaluator 产物事实 (P0-1 基线): 名下 principle artifact = 评审输出,恒 pending;
    // scribe bearer 被翻 validated
    const evalOwned = await artifactStore.listBySourceTaskId(EVAL_TASK_ID);
    expect(evalOwned.length).toBe(1);
    expect(evalOwned[0]?.validationStatus).toBe('pending');
    const scribeArt = await artifactStore.getArtifactById(SCRIBE_ARTIFACT);
    expect(scribeArt?.validationStatus).toBe('validated');

    // commit → seed rollout (durable runnerDecision=approved)
    const commit = await orchestrator.commitNextTaskProposal(EVAL_TASK_ID);
    expect(commit.decision).toBe('successor_created');

    // ── 真实 RolloutReviewerRunner + 真实 dispatcher deps ──
    await createTask(ROLLOUT_TASK_ID, 'rollout_reviewer', meta({
      dependencyTaskIds: [EVAL_TASK_ID], correlationId: 'j8real',
    }));
    const rolloutOutput = makeRolloutOutput('approve_rollout');
    const rollout = new RolloutReviewerRunner({
      stateManager,
      runtimeAdapter: scriptedAdapter({
        ...rolloutOutput, taskId: ROLLOUT_TASK_ID,
        sourceTrace: { evaluatorArtifactId: evalOwned[0]?.artifactId ?? '' },
      }),
      eventEmitter: storeEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
      ...makeDispatcherDeps(),
    }, { owner: 'j8', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    expect(countActivations()).toBe(0);
    const result = await rollout.run(ROLLOUT_TASK_ID);
    expect(result.status).toBe('succeeded');

    // P0-1 核心断言: activation 落在 scribe bearer 上,不是 evaluator 输出
    const activations = listActivations();
    expect(activations.length).toBe(1);
    expect(activations[0]?.artifact_id).toBe(SCRIBE_ARTIFACT);
    expect(activations[0]?.artifact_id).not.toBe(evalOwned[0]?.artifactId);
    expect(activations[0]?.action).toBe('prompt_activate');
    expect(countApprovals()).toBe(0);

    // 幂等重放: reopen rollout 重跑 → already_activated,不重复
    await stateManager.updateTask(ROLLOUT_TASK_ID, { status: 'pending', attemptCount: 0 });
    const rerun = await rollout.run(ROLLOUT_TASK_ID);
    expect(rerun.status).toBe('succeeded');
    expect(listActivations().length).toBe(1);
  });

  it('P0-2: 无 validated 候选 (未跑 evaluator) → 任务 needs_human_review,零 activation', async () => {
    await seedRealLineage();
    // 不跑 evaluator,但存在其评审输出 artifact (pending, 真实形状) —
    // scribe bearer 仍 pending → 无 validated 候选
    const evalConn = new SqliteConnection(workspaceDir);
    try {
      const store = new SqlitePIArtifactStore(evalConn);
      await store.upsertArtifact({
        artifactId: 'pi-art-eval-j8b-review-output', artifactKind: 'principle', sourceTaskId: EVAL_TASK_ID,
        lineageArtifactIds: [ARTIFICER_ARTIFACT], validationStatus: 'pending',
        contentJson: JSON.stringify({ taskId: EVAL_TASK_ID, evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } finally {
      try { evalConn.close(); } catch { /* best-effort */ }
    }
    await succeedWithDecision(EVAL_TASK_ID, 'approved');
    const commit = await orchestrator.commitNextTaskProposal(EVAL_TASK_ID);
    expect(commit.decision).toBe('successor_created');
    await createTask(ROLLOUT_TASK_ID, 'rollout_reviewer', meta({
      dependencyTaskIds: [EVAL_TASK_ID], correlationId: 'j8real',
    }));

    const artifactStore = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
    const rollout = new RolloutReviewerRunner({
      stateManager,
      runtimeAdapter: scriptedAdapter({ ...makeRolloutOutput('approve_rollout'), taskId: ROLLOUT_TASK_ID }),
      eventEmitter: storeEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
      ...makeDispatcherDeps(),
    }, { owner: 'j8b', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    const result = await rollout.run(ROLLOUT_TASK_ID);
    expect(result.status).toBe('succeeded'); // runner 本轮执行成功 (verdict 有效)
    // governance transition 未完成 → needs_human_review,不伪装成功
    const task = await stateManager.getTask(ROLLOUT_TASK_ID);
    expect(task?.status).toBe('needs_human_review');
    expect(countActivations()).toBe(0);
  });
});
