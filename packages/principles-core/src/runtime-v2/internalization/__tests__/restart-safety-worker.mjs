/**
 * Journey 11 (Restart Safety) 的 Worker stage 脚本。
 *
 * 由 restart-safety.e2e.test.ts 以 new Worker() 逐 stage 加载——每个 Worker
 * 拥有独立模块图与事件循环,进程内单例(SqliteConnection/RuntimeStateManager/
 * storeEmitter)与内存缓存全部不共享,worker 退出即消失;下一 stage 新 Worker
 * 从 SQLite 重读状态。语义等价于 OpenClaw 重启(auto-consumer 每周期新连接)。
 *
 * workerData: { workspaceDir: string, stage: string }
 * postMessage: { tasks, approvals, activations, commit?, runStatus? }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Windows ESM: 动态 import 需要 file:// URL 而非盘符绝对路径
const dist = (rel) => pathToFileURL(join(here, '..', '..', '..', '..', 'dist', 'runtime-v2', rel)).href;

const { workspaceDir, stage } = workerData;
if (typeof workspaceDir !== 'string' || typeof stage !== 'string') {
  throw new Error('workerData requires {workspaceDir, stage}');
}

const { RuntimeStateManager } = await import(dist('store/runtime-state-manager.js'));
const { InternalizationOrchestrator } = await import(dist('internalization/internalization-orchestrator.js'));
const { RolloutReviewerRunner } = await import(dist('internalization/rollout-reviewer-runner.js'));
const { DefaultRolloutReviewerValidator } = await import(dist('internalization/rollout-reviewer-output.js'));
const { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata } = await import(dist('internalization/pitask-metadata.js'));
const { ActivationDispatcher } = await import(dist('activation/activation-dispatcher.js'));
const { PromptWriter, DeferArchiveWriter } = await import(dist('activation/low-risk-writers.js'));
const { SqliteConnection } = await import(dist('store/sqlite-connection.js'));
const { SqliteActivationStateStore } = await import(dist('activation/sqlite-activation-state-store.js'));
const { SqliteApprovalQueueStore } = await import(dist('activation/sqlite-approval-store.js'));
const { SqlitePIArtifactStore } = await import(dist('store/artifact/sqlite-pi-artifact-store.js'));
const { storeEmitter } = await import(dist('store/event-emitter.js'));

const EVAL_ID = 'evaluator-j11-prompt';
const REPAIR_ID = 'artificer-repair-j11-1';
const ROLLOUT_ID = 'rollout_reviewer-j11-prompt';
const SCRIBE_ID = 'scribe-j11-prompt';
const ORIGINAL_ARTIFICER_ID = 'artificer-j11-prompt';
const EVAL_ARTIFACT = 'pi-art-eval-j11';

function meta(o = {}) {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

async function main() {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  const orchestrator = new InternalizationOrchestrator(
    { stateManager },
    { owner: 'j11-worker', runtimeKind: 'test-double', dryRun: true },
  );

  const summarize = async (extra = {}) => {
    const tasks = await stateManager.listTasks({});
    const byId = {};
    for (const t of tasks) byId[t.taskId] = t.status;
    const conn = new SqliteConnection(workspaceDir);
    let approvals = 0;
    let activations = [];
    try {
      const db = conn.getDb();
      approvals = db.prepare('SELECT COUNT(*) c FROM approvals').get().c;
      activations = db.prepare('SELECT activation_id, action FROM activations').all();
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
    return { tasks: byId, approvals, activations, ...extra };
  };

  if (stage === 'seed') {
    await stateManager.createTask({ taskId: SCRIBE_ID, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ correlationId: 'j11' }) });
    await stateManager.acquireLease({ taskId: SCRIBE_ID, owner: 'p', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(SCRIBE_ID);
    await stateManager.createTask({ taskId: ORIGINAL_ARTIFICER_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ dependencyTaskIds: [SCRIBE_ID], correlationId: 'j11' }) });
    await stateManager.acquireLease({ taskId: ORIGINAL_ARTIFICER_ID, owner: 'p', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ORIGINAL_ARTIFICER_ID);
    await stateManager.createTask({ taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ dependencyTaskIds: [ORIGINAL_ARTIFICER_ID], correlationId: 'j11' }) });
    await stateManager.acquireLease({ taskId: EVAL_ID, owner: 'p', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(EVAL_ID);
    const t = await stateManager.getTask(EVAL_ID);
    const pi = hydratePITaskRecord(t);
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, { runnerDecision: 'needs_revision' })));
    await stateManager.createTask({
      taskId: REPAIR_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({
        dependencyTaskIds: [SCRIBE_ID], correlationId: 'j11',
        repairPayload: { requiredChanges: ['fix guard'], concerns: [], previousScore: 0.4, repairIteration: 1, sourceArtificerArtifactId: 'pi-art-a-j11', sourceEvaluatorTaskId: EVAL_ID },
      }),
    });
    return await summarize({ stage });
  }

  if (stage === 'repair-complete') {
    // 幂等: 重启后的 consumer 只处理 pending;已 succeeded(上轮已完成)直接重放 commit
    const existing = await stateManager.getTask(REPAIR_ID);
    if (existing?.status !== 'succeeded') {
      await stateManager.acquireLease({ taskId: REPAIR_ID, owner: 'p', runtimeKind: 'test-double' });
      await stateManager.markTaskSucceeded(REPAIR_ID);
    }
    const r = await orchestrator.commitNextTaskProposal(REPAIR_ID);
    return await summarize({ stage, commit: r.decision });
  }

  if (stage === 'evaluator-approved') {
    // 修订轮重跑完成: reopen 后 evaluator 为 pending,先 lease+succeed(等价 runner 执行),
    // 再由 runner 写入新 verdict(此处直接写元数据,与 recordRunnerDecision 同构)
    const current = await stateManager.getTask(EVAL_ID);
    if (current?.status !== 'succeeded') {
      await stateManager.acquireLease({ taskId: EVAL_ID, owner: 'p', runtimeKind: 'test-double' });
      await stateManager.markTaskSucceeded(EVAL_ID);
    }
    const t = await stateManager.getTask(EVAL_ID);
    const pi = hydratePITaskRecord(t);
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, { runnerDecision: 'approved' })));
    const r = await orchestrator.commitNextTaskProposal(EVAL_ID);
    return await summarize({ stage, commit: r.decision });
  }

  if (stage === 'rollout-approve') {
    // 幂等: 重放时任务已存在(上轮已 succeeded)则跳过创建;runner 对非 pending
    // 任务 lease 失败 → fail-soft 返回,activation 不会被重复触发
    const existingRollout = await stateManager.getTask(ROLLOUT_ID);
    if (!existingRollout) {
      await stateManager.createTask({
        taskId: ROLLOUT_ID, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 0, maxAttempts: 3,
        diagnosticJson: meta({ dependencyTaskIds: [EVAL_ID], correlationId: 'j11' }),
      });
    }
    // artifacts 先落 SQLite(幂等),真实形状 (P0-1):
    //   - evaluator 名下 principle = 评审输出,恒 pending
    //   - scribe 名下 principle = bearer,validated (evaluator approved 翻过)
    const seedConn = new SqliteConnection(workspaceDir);
    try {
      const seedStore = new SqlitePIArtifactStore(seedConn);
      await seedStore.upsertArtifact({
        artifactId: EVAL_ARTIFACT, artifactKind: 'principle', sourceTaskId: EVAL_ID,
        lineageArtifactIds: [], validationStatus: 'pending',
        contentJson: JSON.stringify({ taskId: EVAL_ID, evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await seedStore.upsertArtifact({
        artifactId: 'pi-art-scribe-j11', artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
        lineageArtifactIds: [], validationStatus: 'validated',
        contentJson: JSON.stringify({ principleId: 'j11-principle', text: '重启安全测试', principleDraft: { title: 'j11-principle', statement: '重启安全测试' } }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } finally {
      try { seedConn.close(); } catch { /* best-effort */ }
    }
    const artifactConn2 = new SqliteConnection(workspaceDir);
    const artifactStore = new SqlitePIArtifactStore(artifactConn2);

    const runner = new RolloutReviewerRunner({
      stateManager,
      runtimeAdapter: {
        startRun: async () => ({ runId: 'run-j11', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
        pollRun: async () => ({ status: 'succeeded', runId: 'run-j11' }),
        fetchOutput: async () => ({
          runId: 'run-j11',
          payload: {
            taskId: ROLLOUT_ID, sourceEvaluatorArtifactId: EVAL_ARTIFACT,
            review: { decision: 'approve_rollout', summary: 'restart', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
            sourceTrace: { evaluatorArtifactId: EVAL_ARTIFACT }, risks: [], generatedAt: new Date().toISOString(),
          },
        }),
        cancelRun: async () => undefined,
      },
      eventEmitter: storeEmitter,
      validator: new DefaultRolloutReviewerValidator(),
      artifactStore,
      dispatchActivation: async (input) => {
        const connection = new SqliteConnection(workspaceDir);
        try {
          const store = new SqlitePIArtifactStore(connection);
          const dispatcher = new ActivationDispatcher(
            {
              getArtifactById: async (id) => {
                const rec = await store.getArtifactById(id);
                return rec ? { artifactId: rec.artifactId, artifactKind: rec.artifactKind, sourceTaskId: rec.sourceTaskId, lineageArtifactIds: rec.lineageArtifactIds, validationStatus: rec.validationStatus, contentJson: rec.contentJson, createdAt: rec.createdAt, updatedAt: rec.updatedAt } : null;
              },
            },
            new SqliteActivationStateStore(connection),
            { writers: [new PromptWriter(), new DeferArchiveWriter()], approvalQueueStore: new SqliteApprovalQueueStore(connection) },
          );
          const decision = await dispatcher.dispatch({
            artifactId: input.artifactId, channel: 'prompt', rolloutDecision: 'auto_activate',
            actor: { kind: 'system', source: 'rollout_reviewer' },
            now: new Date().toISOString(), confirm: true, confidence: input.confidence,
          });
          return decision.decision === 'activated'
            ? { decision: decision.decision, activationId: decision.activationId }
            : { decision: decision.decision, reason: 'reason' in decision ? String(decision.reason) : decision.decision };
        } finally {
          try { connection.close(); } catch { /* best-effort */ }
        }
      },
    }, { owner: 'j11', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    let result;
    try {
      result = await runner.run(ROLLOUT_ID);
    } finally {
      try { artifactConn2.close(); } catch { /* best-effort */ }
    }
    return await summarize({ stage, runStatus: result.status });
  }

  if (stage === 'eval-approved-nocommit') {
    // A (crash window): evaluator 修订轮 approved, markSucceeded 已持久化,
    // 但进程在 consumer 调用 commit 之前死亡 — 不执行任何 commit。
    const current = await stateManager.getTask(EVAL_ID);
    if (current?.status !== 'succeeded') {
      await stateManager.acquireLease({ taskId: EVAL_ID, owner: 'p', runtimeKind: 'test-double' });
      await stateManager.markTaskSucceeded(EVAL_ID);
    }
    const t = await stateManager.getTask(EVAL_ID);
    const pi = hydratePITaskRecord(t);
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(pi, { runnerDecision: 'approved' })));
    return await summarize({ stage });
  }

  if (stage === 'rollout-succeed') {
    // B: 使 cascade 有 succeeded 下游 — lease+succeed rollout (不跑 runner)
    const existing = await stateManager.getTask(ROLLOUT_ID);
    if (existing && existing.status !== 'succeeded') {
      await stateManager.acquireLease({ taskId: ROLLOUT_ID, owner: 'p', runtimeKind: 'test-double' });
      await stateManager.markTaskSucceeded(ROLLOUT_ID);
    }
    return await summarize({ stage });
  }

  if (stage === 'reconcile') {
    // A: 模拟重启后的 auto-consumer idle 周期 — 只调 bounded reconciliation,
    // 不执行任何手动 CLI / 直接 commit。
    const recon = await orchestrator.reconcileSucceededTransitions({ limit: 10 });
    return await summarize({ stage, reconcile: { scanned: recon.scanned, recovered: recon.recovered, alreadyMaterialized: recon.alreadyMaterialized, blocked: recon.blocked, outcomes: recon.outcomes } });
  }

  throw new Error(`unknown stage: ${stage}`);
}

const summary = await main();
parentPort.postMessage(summary);
