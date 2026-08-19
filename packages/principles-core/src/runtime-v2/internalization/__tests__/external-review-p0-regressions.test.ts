/**
 * 外部复核 P0 回归测试 (P0-3 / P0-4 / P1-1)。
 *
 * P0-4 fault injection: repair seed 成功后模拟 evaluator completion crash,
 * 重放同一 commit — 断言 repair task 唯一 (确定性 id) 且 reopen 真幂等
 * (revisionCount 不递增)。
 * P0-3 orchestrator 传导: durable verdict 缺失时 runs.output_payload 的
 * 显式 verdict 是唯一 legacy 判据。
 * P1-1: artificer prompt 真实携带 rollout revisionFeedback。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { ArtificerRunner } from '../artificer-runner.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from '../pitask-metadata.js';
import { storeEmitter } from '../../store/event-emitter.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { TaskRecord } from '../../task-status.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-p0reg-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager },
    { owner: 'p0reg', runtimeKind: 'test-double', dryRun: true },
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

async function mkTask(taskId: string, taskKind: string, diagnosticJson: string, status = 'pending'): Promise<void> {
  await stateManager.createTask({
    taskId, taskKind, status: status as never, attemptCount: 0, maxAttempts: 3, diagnosticJson,
  });
}

async function succeed(taskId: string, runnerDecision?: string): Promise<void> {
  await stateManager.acquireLease({ taskId, owner: 'p0reg', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(taskId);
  if (runnerDecision) {
    const t = await stateManager.getTask(taskId);
    const pi = hydratePITaskRecord(t as TaskRecord);
    if (pi) {
      await stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(
        mergePITaskMetadata(pi, { runnerDecision: runnerDecision as never }),
      ));
    }
  }
}

// ── P0-4: deterministic repair identity + idempotent reopen ──────────────────

describe('P0-4 — repair/reopen 真幂等 (fault injection)', () => {
  it('repair 完成后 evaluator completion crash → 重放 commit: repair task 唯一,revisionCount 不递增', async () => {
    const EVAL_ID = 'evaluator-p04-prompt';
    const SCRIBE_ID = 'scribe-p04-prompt';
    const REPAIR_ID = 'artificer-repair-evaluator-p04-prompt-r1'; // 确定性 id

    await mkTask(SCRIBE_ID, 'scribe', meta({ correlationId: 'p04' }));
    await succeed(SCRIBE_ID);
    await mkTask('artificer-p04-prompt', 'artificer', meta({ dependencyTaskIds: [SCRIBE_ID], correlationId: 'p04' }));
    await succeed('artificer-p04-prompt');
    await mkTask(EVAL_ID, 'evaluator', meta({ dependencyTaskIds: ['artificer-p04-prompt'], correlationId: 'p04' }));
    await succeed(EVAL_ID, 'needs_revision');

    // evaluator runner 已 seed repair (生产由 seeder 创建; 此处按生产确定性 id)
    await mkTask(REPAIR_ID, 'artificer', meta({
      dependencyTaskIds: [SCRIBE_ID], correlationId: 'p04',
      repairPayload: { requiredChanges: ['x'], concerns: [], previousScore: 0.4, repairIteration: 1, sourceArtificerArtifactId: 'pi-art-a', sourceEvaluatorTaskId: EVAL_ID },
    }));

    // repair 完成 → commit → evaluator reopen (第一次)
    await succeed(REPAIR_ID);
    const r1 = await orchestrator.commitNextTaskProposal(REPAIR_ID);
    expect(r1.decision).toBe('revision_reopened');
    let evalTask = await stateManager.getTask(EVAL_ID);
    let evalPi = hydratePITaskRecord(evalTask as TaskRecord);
    expect(evalPi?.revisionCount).toBe(1);

    // ── fault injection: 模拟 evaluator 修订轮完成过程中 crash ──
    // (不推进 evaluator; consumer 下一周期重放同一 repair commit)
    const r2 = await orchestrator.commitNextTaskProposal(REPAIR_ID);
    expect(r2.decision).toBe('revision_reopened'); // 幂等成功

    // 关键断言: revisionCount 不递增 (同 causeId 重放 = no-op 语义)
    evalTask = await stateManager.getTask(EVAL_ID);
    evalPi = hydratePITaskRecord(evalTask as TaskRecord);
    expect(evalPi?.revisionCount).toBe(1);

    // repair task 唯一: 重放没有创建第二个 repair 任务
    const tasks = await stateManager.listTasks({});
    const repairTasks = tasks.filter((t) => t.taskKind === 'artificer' && t.taskId.startsWith('artificer-repair-'));
    expect(repairTasks.length).toBe(1);
    expect(repairTasks[0]?.taskId).toBe(REPAIR_ID);
  });
});

// ── P0-3: orchestrator legacy verdict 传导 ───────────────────────────────────

describe('P0-3 — durable verdict 缺失时的显式 legacy 解析', () => {
  it('runs.output_payload 携带 needs_revision → blocked_by_revision (不 ADVANCE,不 BLOCKED)', async () => {
    const EVAL_ID = 'evaluator-p03-prompt';
    await mkTask(EVAL_ID, 'evaluator', meta({ correlationId: 'p03' }));
    await succeed(EVAL_ID); // 无 runnerDecision (历史数据形状)

    // 历史 verdict 载体: 最近 succeeded run 的 output_payload
    const runs = await stateManager.getRunsByTask(EVAL_ID);
    expect(runs.length).toBeGreaterThan(0);
    const runId = runs[runs.length - 1]?.runId ?? '';
    await stateManager.updateRunOutput(runId, JSON.stringify({
      evaluation: { decision: 'needs_revision', summary: 'x', score: 0.4, strengths: [], concerns: [], requiredChanges: ['y'] },
    }));

    const r = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(r.decision).toBe('blocked_by_revision');
  });

  it('无 durable 且 runs 无可解析 verdict → blocked_missing_verdict (fail-closed)', async () => {
    const EVAL_ID = 'evaluator-p03b-prompt';
    await mkTask(EVAL_ID, 'evaluator', meta({ correlationId: 'p03b' }));
    await succeed(EVAL_ID);
    // runs 存在但 output_payload 为空/非 JSON
    const runs = await stateManager.getRunsByTask(EVAL_ID);
    const runId = runs[runs.length - 1]?.runId ?? '';

    const r1 = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(r1.decision).toBe('blocked_missing_verdict');

    await stateManager.updateRunOutput(runId, 'not-json');
    const r2 = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(r2.decision).toBe('blocked_missing_verdict');
  });
});

// ── P1-1: artificer prompt 携带 rollout revisionFeedback ─────────────────────

describe('P1-1 — artificer 真实消费 rollout requiredChanges', () => {
  it('revisionFeedback 存在时,发给 RuntimeAdapter 的 prompt 包含 requiredChanges 文本', async () => {
    const SCRIBE_ID = 'scribe-p11-prompt';
    const ARTIFICER_ID = 'artificer-p11-prompt';
    await mkTask(SCRIBE_ID, 'scribe', meta({ correlationId: 'p11' }));
    await succeed(SCRIBE_ID);

    const artifactStore = new MemoryPIArtifactStore();
    await artifactStore.upsertArtifact({
      artifactId: 'pi-art-scribe-p11', artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId: 'p11', text: '原则', principleDraft: { title: 'p11', statement: '原则' } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // artificer 任务带 rollout revisionFeedback (reopen 注入)
    await mkTask(ARTIFICER_ID, 'artificer', meta({
      dependencyTaskIds: [SCRIBE_ID], correlationId: 'p11',
      revisionFeedback: 'Rollout review 判定 needs_revision,请修订后重新走验证链:\n- 必须修改: 规则必须覆盖子目录场景\n- 风险: 未覆盖 nested path',
    }));

    const capturedPrompts: string[] = [];
    const adapter = {
      startRun: async (input: { inputPayload: unknown }): Promise<RunHandle> => {
        capturedPrompts.push(String(input.inputPayload));
        return { runId: 'run-p11', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
      },
      pollRun: async (): Promise<RunStatus> => ({ status: 'succeeded', runId: 'run-p11' }),
      fetchOutput: async () => ({ runId: 'run-p11', payload: null }),
      cancelRun: async () => undefined,
    } as unknown as PDRuntimeAdapter;

    const runner = new ArtificerRunner({
      stateManager, runtimeAdapter: adapter, eventEmitter: storeEmitter,
      artifactStore, validator: new DefaultArtificerValidator(), contentHashFn: undefined as never,
    }, { owner: 'p11', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });

    // fetchOutput 返回 null → runner 走失败路径;但 prompt 已捕获 — 断言 prompt 内容
    await runner.run(ARTIFICER_ID).catch(() => undefined);

    expect(capturedPrompts.length).toBeGreaterThan(0);
    const prompt = capturedPrompts.join('\n');
    expect(prompt).toContain('规则必须覆盖子目录场景');       // requiredChange 原文
    expect(prompt).toContain('rollout_revision_feedback');     // 注入信封标记
  });
});
