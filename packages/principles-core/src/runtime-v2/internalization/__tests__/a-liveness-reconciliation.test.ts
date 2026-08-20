/**
 * A (最终复核) — succeeded-transition reconciliation 的
 * BOUNDED + FAIR + RESTART-DURABLE 验收 (orchestrator 级)。
 *
 * A1 starvation: orphan 不在最新 10 条内,跨轮推进仍恢复 (DESC top-10 会饿死)
 * A3 restart cursor: 部分 sweep 后重启,从持久游标继续而非回到第一页
 * A4 >500: 超过旧 LIMIT 500 的行数,任意位置 orphan 仍可恢复
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteReconciliationCursorStore, SUCCEEDED_TRANSITIONS_SCOPE } from '../../store/reconciliation-cursor-store.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from '../pitask-metadata.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;
let cursorConn: SqliteConnection;
let cursorStore: SqliteReconciliationCursorStore;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-aliv-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'aliv', runtimeKind: 'test-double', dryRun: true },
  );
  cursorConn = new SqliteConnection(workspaceDir);
  cursorStore = new SqliteReconciliationCursorStore(cursorConn);
});

afterEach(async () => {
  try { cursorConn.close(); } catch { /* best-effort */ }
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function meta(correlationId: string): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], correlationId,
  });
}

/** 建一个 succeeded evaluator (durable verdict=approved)。orphan = commit 未跑。 */
async function seedSucceededEvaluator(id: string): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(id) });
  await stateManager.acquireLease({ taskId: id, owner: 'aliv', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
  const raw = await stateManager.getTask(id);
  if (!raw) throw new Error(`seed: task ${id} missing`);
  const pi = hydratePITaskRecord(raw);
  if (!pi) throw new Error(`seed: task ${id} not hydratable`);
  await stateManager.updateTaskDiagnosticJson(id, createPITaskDiagnosticJson(
    mergePITaskMetadata(pi, { runnerDecision: 'approved' }),
  ));
}

/** 建一个已 materialized 的 succeeded 任务: rollout_reviewer (终节点, commit=no_successor)。 */
async function seedMaterializedSucceeded(id: string, index: number): Promise<void> {
  const corr = `mat-${index}`;
  await stateManager.createTask({ taskId: id, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(corr) });
  await stateManager.acquireLease({ taskId: id, owner: 'aliv', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
  const raw = await stateManager.getTask(id);
  if (!raw) throw new Error(`seed: task ${id} missing`);
  const pi = hydratePITaskRecord(raw);
  if (!pi) throw new Error(`seed: task ${id} not hydratable`);
  await stateManager.updateTaskDiagnosticJson(id, createPITaskDiagnosticJson(
    mergePITaskMetadata(pi, { runnerDecision: 'approve_rollout' }),
  ));
}

/** 模拟 production 每周期: orchestrator sweep + cursor 持久化 (wrap → clear)。 */
async function runCycle(budget: number): Promise<{ recovered: number; outcomes: { taskId: string; decision: string }[] }> {
  const stored = cursorStore.get(SUCCEEDED_TRANSITIONS_SCOPE);
  const r = await orchestrator.reconcileSucceededTransitions({
    limit: budget,
    cursor: stored ? { updatedAt: stored.lastUpdatedAt, taskId: stored.lastTaskId } : undefined,
  });
  if (r.wrappedAround) cursorStore.clear(SUCCEEDED_TRANSITIONS_SCOPE);
  else cursorStore.set(SUCCEEDED_TRANSITIONS_SCOPE, r.nextCursor);
  return { recovered: r.recovered, outcomes: r.outcomes };
}

async function successorExists(taskId: string): Promise<boolean> {
  return (await stateManager.getTask(taskId)) !== null;
}

describe('A — reconciliation bounded/fair/restart-durable', () => {
  it('A1 starvation: orphan 在最新 10 条之外,连续 bounded cycle 后仍恢复', { timeout: 120_000 }, async () => {
    // 14 个 materialized succeeded 先建 (更老), orphan 第 15, 再建 5 个更新的
    for (let i = 0; i < 14; i++) await seedMaterializedSucceeded(`mat-a1-${i}`, i);
    await seedSucceededEvaluator('evaluator-orphan-a1'); // orphan: 无 successor
    for (let i = 14; i < 19; i++) await seedMaterializedSucceeded(`mat-a1-${i}`, i);

    expect(await successorExists('rollout_reviewer-evaluator-orphan-a1-prompt')).toBe(false);
    // budget 5: 轮1 扫 mat-0..4, 轮2 扫 5..9, 轮3 扫 10..14, 轮4 应达 orphan
    let recovered = 0;
    for (let cycle = 0; cycle < 6 && recovered === 0; cycle++) {
      const r = await runCycle(5);
      ({ recovered } = r);
    }
    expect(recovered).toBe(1);
    expect(await successorExists('rollout_reviewer-evaluator-orphan-a1-prompt')).toBe(true);
  });

  it('A3 restart cursor: 部分 sweep 后新实例从持久游标继续,不回到第一页', { timeout: 120_000 }, async () => {
    for (let i = 0; i < 9; i++) await seedMaterializedSucceeded(`mat-a3-${i}`, i);
    await seedSucceededEvaluator('evaluator-orphan-a3');
    await seedMaterializedSucceeded('mat-a3-newer', 99);

    // 第一个实例: 一轮 budget 5 (扫 mat-0..4)
    const r1 = await runCycle(5);
    expect(r1.recovered).toBe(0);
    const firstBatch = r1.outcomes.map((o) => o.taskId);
    expect(firstBatch).toContain('mat-a3-0');
    expect(firstBatch).not.toContain('mat-a3-5');

    // restart: 全新 stateManager + orchestrator (进程等价), 游标来自持久存储
    await stateManager.close();
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    orchestrator = new InternalizationOrchestrator(
      { stateManager }, { owner: 'aliv-restarted', runtimeKind: 'test-double', dryRun: true },
    );

    const r2 = await runCycle(5);
    const secondBatch = r2.outcomes.map((o) => o.taskId);
    // 继续而非重置: 首条是 mat-a3-5,第一页 (mat-a3-0..4) 未重复出现
    expect(secondBatch).not.toContain('mat-a3-0');
    expect(secondBatch).toContain('mat-a3-5');
    // 本轮覆盖 5..9 (含 orphan at index 9) → 恢复发生
    expect(r2.recovered).toBe(1);
    expect(await successorExists('rollout_reviewer-evaluator-orphan-a3-prompt')).toBe(true);
  });

  it('A4 >500 rows: 旧 LIMIT 500 无法可靠覆盖位置的 orphan 仍恢复', { timeout: 300_000 }, async () => {
    // 540 个 materialized succeeded, orphan 插在 ASC 序列第 ~530 位 (远超旧 500 窗)
    for (let i = 0; i < 529; i++) {
      await seedMaterializedSucceeded(`mat-a4-${String(i).padStart(4, '0')}`, i);
    }
    await seedSucceededEvaluator('evaluator-orphan-a4');
    for (let i = 529; i < 540; i++) {
      await seedMaterializedSucceeded(`mat-a4-${String(i).padStart(4, '0')}`, i);
    }

    expect(await successorExists('rollout_reviewer-evaluator-orphan-a4-prompt')).toBe(false);
    let recoveredTotal = 0;
    let cycles = 0;
    while (recoveredTotal === 0 && cycles < 200) {
      const r = await runCycle(50);
      recoveredTotal += r.recovered;
      cycles += 1;
    }
    expect(recoveredTotal).toBe(1);
    expect(await successorExists('rollout_reviewer-evaluator-orphan-a4-prompt')).toBe(true);
    // bounded: 每周期 ≤50 条,恢复需要的周期数远小于全量
    expect(cycles).toBeLessThanOrEqual(12);
  });
});
