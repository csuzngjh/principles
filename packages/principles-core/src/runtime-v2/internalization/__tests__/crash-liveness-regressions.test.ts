/**
 * C (crash/restart liveness 轮): rollout revision budget persistence fail-closed。
 *
 * 顺序契约 (record-first): routing intent (iteration/cause) 持久化成功是
 * reopen 的前置 — 禁止 "reopen 成功 + budget metadata 丢失 + rollout 正常完成"。
 *
 * 故障注入: 真实 store 上包装 stateManager,令 rollout 任务元数据写入在
 * 第一次携带 rolloutRevisionPayload 时失败;随后恢复并重放 revision flow。
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
import type { TaskRecord } from '../../task-status.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

const SCRIBE_ID = 'scribe-c-prompt';
const ARTIFICER_ID = 'artificer-c-prompt';
const EVAL_ID = 'evaluator-c-prompt';
const ROLLOUT_ID = 'rollout_reviewer-c-prompt';
const SCRIBE_ART = 'pi-art-scribe-c';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-clv-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'clv', runtimeKind: 'test-double', dryRun: true },
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
  await stateManager.createTask({ taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ correlationId: 'c', dependencyTaskIds: deps }) });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'clv', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

function makeOutput(decision: 'needs_revision' | 'approve_rollout'): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID, sourceEvaluatorArtifactId: 'pi-art-eval-c',
    review: { decision, summary: 'c', confidence: 0.9, requiredChanges: decision === 'needs_revision' ? ['必须改 X'] : [], rolloutRisks: [], safetyChecks: [] },
    sourceTrace: { evaluatorArtifactId: 'pi-art-eval-c' }, risks: [], generatedAt: new Date().toISOString(),
  };
}

function scriptedAdapter(output: RolloutReviewerOutputV1) {
  return {
    startRun: async () => ({ runId: 'run-c', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId: 'run-c' }),
    fetchOutput: async () => ({ runId: 'run-c', payload: output }),
    cancelRun: async () => undefined,
  } as never;
}

/** 包装 stateManager: 对 ROLLOUT_ID 的 rolloutRevisionPayload 元数据写入前 failN 次失败 */
function wrapRoutingWriteFailure(failures: { count: number }): typeof stateManager {
  const inner = stateManager as unknown as Record<string, unknown>;
  const orig = inner.updateTaskDiagnosticJson as (taskId: string, json: string) => Promise<void>;
  inner.updateTaskDiagnosticJson = async (taskId: string, json: string): Promise<void> => {
    if (taskId === ROLLOUT_ID && json.includes('"rolloutRevisionPayload"') && failures.count > 0) {
      failures.count -= 1;
      throw new Error('injected routing metadata write failure (disk)');
    }
    return orig.call(stateManager, taskId, json);
  };
  return stateManager;
}

async function resetRolloutForRerun(): Promise<void> {
  const t = await stateManager.getTask(ROLLOUT_ID);
  const pi = hydratePITaskRecord(t as TaskRecord);
  if (pi) {
    await stateManager.updateTaskDiagnosticJson(ROLLOUT_ID, createPITaskDiagnosticJson(
      mergePITaskMetadata(pi, { runnerDecision: undefined }),
    ));
  }
  await stateManager.updateTask(ROLLOUT_ID, { status: 'pending', attemptCount: 0 });
}

function makeRunner(injected: typeof stateManager): RolloutReviewerRunner {
  return new RolloutReviewerRunner({
    stateManager: injected, runtimeAdapter: scriptedAdapter(makeOutput('needs_revision')),
    eventEmitter: storeEmitter, validator: new DefaultRolloutReviewerValidator(),
    artifactStore: new SqlitePIArtifactStore(new SqliteConnection(workspaceDir)),
    reopenRevisionTarget: async (input) => {
      const r = await orchestrator.reopenTaskForRevision(input.targetTaskId, {
        revisionFeedback: input.revisionFeedback,
        revisionCauseId: `rollout-${input.sourceRolloutTaskId}-r${input.revisionIteration}`,
      });
      return r.ok ? { ok: true, reason: r.reason, reopenedTaskId: input.targetTaskId } : { ok: false, reason: r.reason };
    },
  }, { owner: 'clv', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

async function readRolloutRouting(): Promise<{ iteration?: number; causeId?: string; runnerDecision?: string }> {
  const t = await stateManager.getTask(ROLLOUT_ID);
  const pi = hydratePITaskRecord(t as TaskRecord);
  return {
    iteration: pi?.rolloutRevisionPayload?.revisionIteration,
    causeId: pi?.revisionCauseId,
    runnerDecision: pi?.runnerDecision,
  };
}

describe('C — rollout revision budget persistence fail-closed (record-first)', () => {
  it('routing 元数据写失败 → 不 reopen + 任务不 succeeded;恢复后重放恰一次;iteration 不回退;2-round bound 保持', async () => {
    // lineage: scribe(validated bearer) → artificer → evaluator(succeeded+approved) → rollout
    await mkTask(SCRIBE_ID, 'scribe', []);
    await succeed(SCRIBE_ID);
    await mkTask(ARTIFICER_ID, 'artificer', [SCRIBE_ID]);
    await succeed(ARTIFICER_ID);
    await mkTask(EVAL_ID, 'evaluator', [ARTIFICER_ID]);
    await succeed(EVAL_ID);
    const evalPi = hydratePITaskRecord(await stateManager.getTask(EVAL_ID) as TaskRecord);
    await stateManager.updateTaskDiagnosticJson(EVAL_ID, createPITaskDiagnosticJson(mergePITaskMetadata(evalPi!, { runnerDecision: 'approved' })));
    await mkTask(ROLLOUT_ID, 'rollout_reviewer', [EVAL_ID]);

    const conn = new SqliteConnection(workspaceDir);
    const store = new SqlitePIArtifactStore(conn);
    await store.upsertArtifact({
      artifactId: 'pi-art-eval-c', artifactKind: 'principle', sourceTaskId: EVAL_ID,
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

    // ── 1) 注入: 第一次 routing 元数据写失败 ──
    const failures = { count: 1 };
    const injected = wrapRoutingWriteFailure(failures);
    const r1 = await makeRunner(injected).run(ROLLOUT_ID);

    // fail-closed: 任务未 succeeded (retry 路径),scribe 未被 reopen
    expect(r1.status).not.toBe('succeeded');
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('succeeded');
    expect((await readRolloutRouting()).iteration).toBeUndefined(); // budget 未落

    // ── 2) 恢复 + 重放 (模拟重启后的 revision flow) ──
    await resetRolloutForRerun();
    const r2 = await makeRunner(stateManager).run(ROLLOUT_ID);
    expect(r2.status).toBe('succeeded');
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('pending'); // reopen 恰发生一次
    const after1 = await readRolloutRouting();
    expect(after1.iteration).toBe(1); // 不回退、不重复

    // ── 3) 第二轮 revision (target 完成后再次 needs_revision) ──
    await succeed(SCRIBE_ID); // target 修订完成
    await resetRolloutForRerun();
    const r3 = await makeRunner(stateManager).run(ROLLOUT_ID);
    expect(r3.status).toBe('succeeded');
    const after2 = await readRolloutRouting();
    expect(after2.iteration).toBe(2); // 递进, 未重置

    // ── 4) 第三轮 → budget exhausted → needs_human_review (2-round bound) ──
    await succeed(SCRIBE_ID);
    await resetRolloutForRerun();
    const r4 = await makeRunner(stateManager).run(ROLLOUT_ID);
    expect(r4.status).toBe('succeeded'); // runner 完成
    expect((await stateManager.getTask(ROLLOUT_ID))?.status).toBe('needs_human_review');
    expect((await stateManager.getTask(SCRIBE_ID))?.status).toBe('succeeded'); // 未产生额外 revision
  });
});
