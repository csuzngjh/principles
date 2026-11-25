/**
 * PRI-1293 Phase 3 — host-runtime Evaluator Repair Seeder 血缘集成 (§5.2)。
 *
 * 生产路径: consumer cycle 经 createEvaluatorRepairDeps 把 seedArtificerRepairTask
 * 注入 EvaluatorRunner; evaluator needs_revision 时调用该 seeder 创建 repair
 * 任务。本文件验证收口后的 seeder 契约:
 *   1. 来源 evaluator 链可证明 → repair 任务创建且携带验证的 correlationId +
 *      parentTaskId=sourceEvaluatorTaskId (28 字段 metadata 机制内, 不新增列);
 *   2. 来源链不可证明 (孤儿 evaluator) → 结构化拒绝 (抛
 *      evaluator_repair_seed_lineage_refused), 流入 evaluator 的
 *      repair_task_seed_failed → seed_failed 路径, 零任务创建;
 *   3. 下一轮 evaluator 经 REOPEN_SOURCE_EVALUATOR reopen 后继承同一 id。
 * 确定性 task id / 在途复用 / 终态禁复用等既有 repair 生命周期语义不变。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRuntimeStateHandle,
  hydratePITaskRecord,
  artificerRepairTaskId,
  InternalizationOrchestrator,
  type SeedArtificerRepairParams,
  type RuntimeStateManager,
} from '@principles/core/runtime';
import { createEvaluatorRepairDeps } from '../src/internalization-consumer-governance.js';

const CAND_A = 'cand-repair-lineage-a';

let workspaceDir: string;
let handle: Awaited<ReturnType<typeof createRuntimeStateHandle>> | null = null;
let stateManager: RuntimeStateManager;

const logger = { info: () => undefined, warn: () => undefined };

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-repair-lineage-'));
  handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  stateManager = handle.stateManager;
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  handle = null;
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function repairParams(sourceEvaluatorTaskId: string): SeedArtificerRepairParams {
  return {
    repairPayload: {
      requiredChanges: ['fix the rule'],
      concerns: [],
      previousScore: 0.5,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-src',
      sourceEvaluatorTaskId,
      sourceEvaluatorRunId: 'run-eval-1',
    },
    inheritedDependencyTaskIds: ['scribe-x'],
    inheritedChannel: 'prompt',
    inheritedTimeoutMs: 300_000,
    inheritedInputArtifactRefs: [],
  };
}

/** dreamer(仅 seed candidateId) → artificer → evaluator 历史链, 全程无 id。 */
async function seedProvableChain(): Promise<string> {
  const mk = async (taskId: string, kind: string, parentTaskId?: string): Promise<void> => {
    await stateManager.createTask({
      taskId, taskKind: kind, status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          ...(parentTaskId !== undefined ? { parentTaskId } : {}),
        },
        ...(kind === 'dreamer' ? { candidateId: CAND_A } : {}),
      }),
    });
  };
  await mk('dreamer-lineage-prompt', 'dreamer');
  await mk('artificer-lineage-1', 'artificer', 'dreamer-lineage-prompt');
  await mk('evaluator-lineage-1', 'evaluator', 'artificer-lineage-1');
  return 'evaluator-lineage-1';
}

describe('createEvaluatorRepairDeps.seedArtificerRepairTask — PRI-1293 Phase 3 血缘收口', () => {
  it('来源链可证明: repair 创建并写入验证的 correlationId + parentTaskId (test 6 前半)', async () => {
    const sourceEvaluator = await seedProvableChain();
    const seeder = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    const repairTaskId = await seeder.seedArtificerRepairTask(repairParams(sourceEvaluator));
    expect(repairTaskId).toBe(artificerRepairTaskId(sourceEvaluator, 1));
    const repair = await stateManager.getTask(repairTaskId);
    expect(repair?.taskKind).toBe('artificer');
    const pi = hydratePITaskRecord(repair!);
    // 恢复自根 dreamer seed 的权威 id 写入 repair metadata。
    expect(pi?.correlationId).toBe(CAND_A);
    // D3: parentTaskId=sourceEvaluatorTaskId — repair 链从此可回溯根 dreamer。
    expect(pi?.parentTaskId).toBe(sourceEvaluator);
  });

  it('来源链不可证明: 结构化拒绝, 零任务创建', async () => {
    // 孤儿 evaluator: 无 parentTaskId、无 id — 无法回溯根 dreamer。
    await stateManager.createTask({
      taskId: 'evaluator-orphan-lineage', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] },
      }),
    });
    const seeder = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    const before = (await stateManager.listTasks()).length;
    await expect(seeder.seedArtificerRepairTask(repairParams('evaluator-orphan-lineage')))
      .rejects.toThrow(/evaluator_repair_seed_lineage_refused:missing_correlation_id_lineage/);
    expect((await stateManager.listTasks()).length).toBe(before);
  });

  it('来源 evaluator 任务缺失: 结构化拒绝', async () => {
    const seeder = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    await expect(seeder.seedArtificerRepairTask(repairParams('evaluator-never-existed')))
      .rejects.toThrow(/evaluator_repair_seed_lineage_refused: source evaluator task evaluator-never-existed not found/);
  });

  it('在途复用语义保持: 同 id repair 已存在 (in-flight) → reuse, 不重复校验不重建', async () => {
    const sourceEvaluator = await seedProvableChain();
    const seeder = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    const first = await seeder.seedArtificerRepairTask(repairParams(sourceEvaluator));
    // 重放同一 params — 幂等 reuse (repair 生命周期语义不变)。
    const second = await seeder.seedArtificerRepairTask(repairParams(sourceEvaluator));
    expect(second).toBe(first);
  });

  it('repair 完成后来源 evaluator reopen 继承同一 id (test 6 后半)', async () => {
    const sourceEvaluator = await seedProvableChain();
    const seeder = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    const repairTaskId = await seeder.seedArtificerRepairTask(repairParams(sourceEvaluator));
    // repair 成功完成 (真实 store 翻转)。
    await stateManager.updateTask(repairTaskId, { status: 'succeeded', attemptCount: 1 });
    // evaluator 带 needs_revision verdict → commit 走 REOPEN_SOURCE_EVALUATOR。
    const evalRaw = await stateManager.getTask(sourceEvaluator);
    const evalPi = hydratePITaskRecord(evalRaw!);
    await stateManager.updateTask(sourceEvaluator, {
      diagnosticJson: JSON.stringify({
        pi_metadata: {
          ...evalPi,
          runnerDecision: 'needs_revision',
          correlationId: evalPi?.correlationId,
        },
      }),
      status: 'succeeded',
    });
    const orchestrator = new InternalizationOrchestrator(
      { stateManager }, { owner: 'repair-lineage', runtimeKind: 'test-double', dryRun: true },
    );
    const commit = await orchestrator.commitNextTaskProposal(repairTaskId);
    expect(commit.decision).toBe('revision_reopened');
    if (commit.decision !== 'revision_reopened') return;
    expect(commit.reopenedTaskId).toBe(sourceEvaluator);
    const reopened = hydratePITaskRecord((await stateManager.getTask(sourceEvaluator))!);
    // 继承 + §5.3.7 补链: 来源 evaluator 历史上无 id, reopen 把根侧恢复的
    // 权威 id 安全补入 — 下一轮 evaluator 与 repair 任务、整条链同源。
    expect(reopened?.correlationId).toBe(CAND_A);
    expect(reopened?.status).toBe('pending');
  });
});
