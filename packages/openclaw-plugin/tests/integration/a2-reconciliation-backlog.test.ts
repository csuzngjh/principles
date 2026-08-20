/**
 * A2 (最终复核) — continuous backlog 下 reconciliation 不被饿死。
 *
 * 真实调用 production runConsumerCycle (packages/openclaw-plugin):
 * - 持续存在 ready dreamer 任务 (每 cycle 消费一个,LLM endpoint 不可达 →
 *   retry_wait,backlog 由预先播种的 N 个任务维持);
 * - orphan evaluator (succeeded+approved, commit 从未执行) 位于 ASC 第 9 位;
 * - 断言: 即使从未进入 idle (每 cycle 都有 ready 任务), orphan 仍在
 *   bounded cycles 内被恢复 — 证明 finally 每周期预算的公平性。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
} from '@principles/core/runtime-v2';
import { runConsumerCycle } from '../../src/service/internalization-auto-consumer-service.js';
import type { TaskRecord } from '@principles/core/runtime-v2';

process.env.PD_TEST_BACKLOG_KEY = 'dummy';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-a2-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), [
    'version: 1',
    'features:',
    '  internalization_auto_consumer: { category: quiet, enabled: true }',
    'runtimeProfiles:',
    '  pd.default:',
    '    type: pi-ai',
    '    provider: openai',
    '    model: test-model',
    '    apiKeyEnv: PD_TEST_BACKLOG_KEY',
    '    baseUrl: http://127.0.0.1:9/v1',
    'internalAgents:',
    '  defaultRuntime: pd.default',
    '  agents: {}',
  ].join('\n'), 'utf-8');
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function meta(correlationId: string): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 5_000,
    inputArtifactRefs: [], outputArtifactRefs: [], correlationId,
  });
}

async function seedMaterializedRollout(id: string): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(id) });
  await stateManager.acquireLease({ taskId: id, owner: 'a2', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
  const pi = hydratePITaskRecord(await stateManager.getTask(id) as TaskRecord);
  await stateManager.updateTaskDiagnosticJson(id, createPITaskDiagnosticJson(mergePITaskMetadata(pi!, { runnerDecision: 'approve_rollout' })));
}

async function seedOrphanEvaluator(id: string): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(id) });
  await stateManager.acquireLease({ taskId: id, owner: 'a2', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
  const pi = hydratePITaskRecord(await stateManager.getTask(id) as TaskRecord);
  await stateManager.updateTaskDiagnosticJson(id, createPITaskDiagnosticJson(mergePITaskMetadata(pi!, { runnerDecision: 'approved' })));
}

async function seedBacklogDreamer(id: string): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(id) });
}

describe('A2 — real runConsumerCycle: backlog does not starve reconciliation', () => {
  it('持续 ready 任务下 orphan 在 bounded cycles 内恢复', { timeout: 180_000 }, async () => {
    // 8 materialized 背景 + orphan (ASC 第 9) + 6 个 backlog dreamer
    for (let i = 0; i < 8; i++) await seedMaterializedRollout(`mat-a2-${i}`);
    await seedOrphanEvaluator('evaluator-orphan-a2');
    for (let i = 0; i < 6; i++) await seedBacklogDreamer(`dreamer-backlog-${i}`);

    const successorId = 'rollout_reviewer-evaluator-orphan-a2-prompt';
    expect(await stateManager.getTask(successorId)).toBeNull();

    // 连续运行真实 production cycles — backlog 保证每 cycle 都有 ready 任务
    let recoveredCycle = -1;
    for (let cycle = 1; cycle <= 5 && recoveredCycle < 0; cycle++) {
      await runConsumerCycle(workspaceDir, logger as never);
      if (await stateManager.getTask(successorId)) recoveredCycle = cycle;
    }

    // 每周期预算 5: cycle1 扫 mat-0..4, cycle2 扫 5..9 (含 orphan)
    expect(recoveredCycle).toBeGreaterThan(0);
    expect(recoveredCycle).toBeLessThanOrEqual(3);

    // backlog 真实存在: dreamer 被消费 (进入 retry_wait — LLM 不可达)
    const dreamer = await stateManager.getTask('dreamer-backlog-0');
    expect(['retry_wait', 'pending', 'leased']).toContain(dreamer?.status ?? '');
  });

  it('A2-idle: 队列全空 (readyTaskCount=0) 时 orphan 仍经真实 runConsumerCycle 恢复', { timeout: 120_000 }, async () => {
    // 纯 orphan 场景: succeeded 后 crash, 无任何 pending 任务 → 快照
    // readyTaskCount=0 → shouldConsume=false 早退。reconciliation budget
    // (finally) 必须仍然执行, 否则经典 crash-orphan 永远无法恢复。
    for (let i = 0; i < 8; i++) await seedMaterializedRollout(`mat-a2i-${i}`);
    await seedOrphanEvaluator('evaluator-orphan-a2i');

    const successorId = 'rollout_reviewer-evaluator-orphan-a2i-prompt';
    expect(await stateManager.getTask(successorId)).toBeNull();

    let recoveredCycle = -1;
    for (let cycle = 1; cycle <= 4 && recoveredCycle < 0; cycle++) {
      await runConsumerCycle(workspaceDir, logger as never);
      if (await stateManager.getTask(successorId)) recoveredCycle = cycle;
    }

    // 每周期预算 5: cycle1 扫 mat-0..4, cycle2 扫 5..8 (含 orphan)
    expect(recoveredCycle).toBeGreaterThan(0);
    expect(recoveredCycle).toBeLessThanOrEqual(3);
  });
});
