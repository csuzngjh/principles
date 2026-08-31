/**
 * auto-consumer-governance-wiring 单元/集成测试 (codecov patch 响应)。
 *
 * 该模块是 P0-D/E/F 的 plugin I/O 接线(flag 探针 / repair seeder /
 * rollout dispatch / revision reopen),此前 0% patch coverage。
 * 全部走真实对象: 临时 workspace + 真实 SqliteConnection + 真实
 * ActivationDispatcher(低风险 prompt 渠道冒烟激活)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  SqliteConnection,
  SqlitePIArtifactStore,
} from '@principles/core/runtime-v2';
// PRI-624: the wiring moved to the shared host-runtime module (one
// implementation for OpenClaw auto-consumer + Companion workspace worker);
// these tests now exercise the shared seam directly.
import {
  createEvaluatorRepairDeps,
  createRolloutGovernanceDeps,
  dispatchRolloutActivation,
} from '@principles/host-runtime';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let workspaceDir: string;
let stateManager: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wiring-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function writeConfig(features: Record<string, unknown> = {}, agents: Record<string, unknown> = {}): void {
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  const lines = [
    'version: 1',
    'features:',
    ...(Object.keys(features).length === 0
      ? []  // 合法空段: loader 允许缺省 features
      : Object.entries(features).map(([k, v]) => `  ${k}: ${v}`)),
    'runtimeProfiles:',
    '  pd.default:',
    '    type: pi-ai',
    '    provider: ""',
    '    model: "test-model"',
    '    apiKeyEnv: TEST_KEY',
    'internalAgents:',
    '  defaultRuntime: pd.default',
    // 空 agents 段必须写 flow 空对象 — 裸 `agents:` 段解析为 null,
    // 校验器报 "must be an object, got object" (typeof null === 'object')
    '  agents: {}',
    ...(Object.keys(agents).length === 0
      ? []
      : Object.entries(agents).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)),
  ];
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), lines.join('\n'), 'utf-8');
}

describe('createEvaluatorRepairDeps', () => {
  it('flag 未配置 (config 合法) → registry 默认 (default ON) 生效', () => {
    // 写一个无关 flag 使 config 合法;repair loop 走 registry 默认
    writeConfig({ gfi: '{ category: quiet, enabled: false }' });
    const deps = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    expect(deps.isRepairLoopEnabled()).toBe(true);
  });

  it('config 显式 enabled:false → kill-switch 生效', () => {
    writeConfig({ 'evaluator_artificer_repair_loop': '{ category: quiet, enabled: false }' });
    const deps = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    expect(deps.isRepairLoopEnabled()).toBe(false);
  });

  it('seedArtificerRepairTask 创建 pending repair 任务并携带 payload', async () => {
    writeConfig();
    const deps = createEvaluatorRepairDeps(workspaceDir, stateManager, logger);
    const taskId = await deps.seedArtificerRepairTask({
      repairPayload: {
        requiredChanges: ['fix x'], concerns: [], previousScore: 0.4,
        repairIteration: 1, sourceArtificerArtifactId: 'pi-art-a', sourceEvaluatorTaskId: 'eval-1',
      },
      inheritedDependencyTaskIds: ['scribe-1'],
      inheritedChannel: 'prompt',
      inheritedTimeoutMs: 300_000,
      inheritedInputArtifactRefs: [],
    });
    expect(taskId.startsWith('artificer-repair-')).toBe(true);
    const task = await stateManager.getTask(taskId);
    expect(task?.taskKind).toBe('artificer');
    expect(task?.status).toBe('pending');
    const raw = task as unknown as { diagnosticJson?: string };
    const meta = JSON.parse(raw?.diagnosticJson ?? '{}').pi_metadata;
    expect(meta.repairPayload.repairIteration).toBe(1);
    expect(meta.dependencyTaskIds).toEqual(['scribe-1']);
  });
});

describe('dispatchRolloutActivation (真实 dispatcher 冒烟)', () => {
  it('validated principle artifact → 低风险 prompt 渠道自动激活', async () => {
    writeConfig();
    // 准备 validated artifact (dispatch 目标)
    const conn = new SqliteConnection(workspaceDir);
    try {
      const store = new SqlitePIArtifactStore(conn);
      await store.upsertArtifact({
        artifactId: 'pi-art-wire-1', artifactKind: 'principle', sourceTaskId: 'eval-wire',
        lineageArtifactIds: [], validationStatus: 'validated',
        contentJson: JSON.stringify({ principleId: 'wire-p1', text: 'wiring smoke principle' }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }

    const outcome = await dispatchRolloutActivation(workspaceDir, {
      artifactId: 'pi-art-wire-1', channel: 'prompt', confidence: 0.9, rolloutTaskId: 'rollout-wire',
    }, logger);

    expect(outcome.decision).toBe('activated');
    expect(outcome.activationId).toBeTruthy();

    // 幂等重放 → already_activated
    const replay = await dispatchRolloutActivation(workspaceDir, {
      artifactId: 'pi-art-wire-1', channel: 'prompt', confidence: 0.9, rolloutTaskId: 'rollout-wire',
    }, logger);
    expect(replay.decision).toBe('already_activated');
  });

  it('artifact 不存在 → invalid_artifact 带 reason,不抛', async () => {
    writeConfig({ gfi: '{ category: quiet, enabled: false }' });
    const outcome = await dispatchRolloutActivation(workspaceDir, {
      artifactId: 'pi-art-missing', channel: 'prompt', rolloutTaskId: 'r',
    }, logger);
    expect(outcome.decision).toBe('invalid_artifact');
    expect(String(outcome.reason)).toBeTruthy();
  });
});

describe('createRolloutGovernanceDeps', () => {
  it('reopenRevisionTarget 经 orchestrator reopen succeeded 任务', async () => {
    writeConfig();
    await stateManager.createTask({
      taskId: 'scribe-wire', taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [] } }),
    });
    await stateManager.acquireLease({ taskId: 'scribe-wire', owner: 't', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded('scribe-wire');

    const orchestrator = new InternalizationOrchestrator(
      { stateManager }, { owner: 'wire-test', runtimeKind: 'test-double', dryRun: true },
    );
    const deps = createRolloutGovernanceDeps(workspaceDir, orchestrator, logger);
    const result = await deps.reopenRevisionTarget({
      targetTaskId: 'scribe-wire', targetKind: 'scribe',
      revisionFeedback: '措辞修订', revisionIteration: 1,
      sourceRolloutTaskId: 'rollout-wire', sourceArtifactId: 'pi-art-wire-1',
    });
    expect(result.ok).toBe(true);
    expect((await stateManager.getTask('scribe-wire'))?.status).toBe('pending');
  });
});
