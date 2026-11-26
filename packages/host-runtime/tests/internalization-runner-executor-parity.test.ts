/**
 * PRI-1293 Phase 2B — 六种 Peer Runner 装配等价性 (Parity) 测试。
 *
 * 方法: 对每种 kind, 以 **consumer cycle** 与 **run-once** 两个入口各自的
 * 真实输入形态 (与两处生产装配逐字段同形) 驱动唯一执行器
 * `executeSelectedInternalizationTask`, 用 prototype run 间碟捕获实际构造出的
 * Runner 实例, 断言其装配语义 — 不是对象同实例 (§2.5: Parity = 相同执行契约
 * + 正确的依赖映射), 并钉住六个有意保留的入口差异。
 *
 * Runner 真实 .run() 不执行 (返回 succeeded 由间碟短路) — 装配即被测对象;
 * 端到端行为由既有套件保证 (consumer-cycle-* / run-once-* 测试)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  ArtificerRunner,
  EvaluatorRunner,
  RolloutReviewerRunner,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  DefaultScribeValidator,
  DefaultArtificerValidator,
  DefaultEvaluatorValidator,
  DefaultRolloutReviewerValidator,
  StoreEventEmitter,
  createProductionGateDeps,
  buildArtificerHostSemanticContext,
  buildToolSemanticRegistry,
  RuntimeStateManager,
  createPITaskDiagnosticJson,
  InternalizationOrchestrator,
  type PDRuntimeAdapter,
  type EffectivePdConfig,
  type SeedArtificerRepairParams,
} from '@principles/core/runtime';
import { getDefaultPdConfig } from '@principles/core/runtime';
import {
  executeSelectedInternalizationTask,
  createEvaluatorRepairDeps,
  createRolloutGovernanceDeps,
  resolveWorkspaceHostToolSemantics,
  type ExecuteSelectedInternalizationTaskInput,
} from '../src/index.js';
import { WorkspaceTelemetryEmitter } from '../src/workspace-telemetry-emitter.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;

// 测试间碟: 捕获每个 kind 实际构造的 runner 实例 (this)。
type Captured = Record<string, unknown[]>;
const captured: Captured = {};
function spyRun(constructor: abstract new (...args: never[]) => unknown, key: string): void {
  vi.spyOn(constructor.prototype as { run: unknown }, 'run').mockImplementation(async function mockRun(this: { __parityKey?: string }) {
    (captured[key] ??= []).push(this);
    return { status: 'succeeded', taskId: 'x', attemptCount: 1 };
  });
}

const OWNER_CONSUMER = 'auto-consumer';
const OWNER_RUN_ONCE = 'pd-cli-internalization-run-once';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-parity-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  repairDeps = createEvaluatorRepairDeps(workspaceDir, stateManager, undefined);
  rolloutDeps = createRolloutGovernanceDeps(workspaceDir, fakeOrchestrator, {});
  spyRun(DreamerRunner, 'dreamer');
  spyRun(PhilosopherRunner, 'philosopher');
  spyRun(ScribeRunner, 'scribe');
  spyRun(ArtificerRunner, 'artificer');
  spyRun(EvaluatorRunner, 'evaluator');
  spyRun(RolloutReviewerRunner, 'rollout_reviewer');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

// ── 入口输入形态 ────────────────────────────────────────────────────────────

const adapter = {
  startRun: async () => ({ runId: 'r', runtimeKind: 'test-double', startedAt: 't' }),
  pollRun: async () => ({ status: 'succeeded' as const, runId: 'r' }),
  fetchOutput: async () => ({ runId: 'r', payload: {} }),
  cancelRun: async () => undefined,
  kind: () => 'pi-ai',
} as unknown as PDRuntimeAdapter;

/** consumer cycle 的 runnerOptions (internalization-consumer-cycle.ts:920-926 同形)。 */
function consumerOptions(effectiveConfig: EffectivePdConfig, timeoutMs = 240_000) {
  return {
    owner: OWNER_CONSUMER,
    runtimeKind: 'pi-ai',
    effectiveConfig,
    timeoutMs,
    outputLanguage: 'zh-CN' as const,
  };
}

/** run-once 的 runnerOptions (runtime-internalization-run-once.ts 同形)。 */
function runOnceOptions(effectiveConfig?: EffectivePdConfig) {
  return {
    owner: OWNER_RUN_ONCE,
    runtimeKind: 'pi-ai',
    pollIntervalMs: 100,
    timeoutMs: 300_000,
    effectiveConfig,
    outputLanguage: 'zh-CN' as const,
  };
}

function base(taskId: string) {
  return { taskId, stateManager, runtimeAdapter: adapter, eventEmitter: new StoreEventEmitter(), artifactStore: stateManager.piArtifactStore, workspaceDir };
}

const config = getDefaultPdConfig() as unknown as EffectivePdConfig;
const registryResult = buildToolSemanticRegistry([{ rawToolName: 'Write', canonicalKind: 'write' }]);
if (!registryResult.ok) throw new Error('fixture registry build failed');
const registry = registryResult.registry;
const hostSemantics = buildArtificerHostSemanticContext(registry, ['openclaw']);
// 依赖 workspaceDir/stateManager 的接线在 beforeEach 内构造 (模块期尚未初始化)。
let repairDeps: ReturnType<typeof createEvaluatorRepairDeps>;
const fakeOrchestrator = { } as unknown as InternalizationOrchestrator;
let rolloutDeps: ReturnType<typeof createRolloutGovernanceDeps>;

function consumerInput(kind: ExecuteSelectedInternalizationTaskInput['taskKind'], taskId: string): ExecuteSelectedInternalizationTaskInput {
  const common = { ...base(taskId), runnerOptions: consumerOptions(config) };
  switch (kind) {
    case 'dreamer': return { taskKind: kind, ...common };
    case 'philosopher': return { taskKind: kind, ...common };
    case 'scribe': return { taskKind: kind, ...common };
    case 'artificer':
      return {
        taskKind: kind, ...common,
        behaviorExamplePack: { version: 2 } as never,
        trustedFacts: { resolveFact: async () => ({ found: true as const, value: 'v' }) } as never,
        hostSemanticContext: hostSemantics,
      };
    case 'evaluator':
      return {
        taskKind: kind, ...common,
        eventEmitter: new WorkspaceTelemetryEmitter(storeEmitterProbe(), workspaceDir, () => undefined),
        repairDeps,
        gateDeps: createProductionGateDeps({ toolSemantics: registry, projectDir: workspaceDir }),
        hostToolCatalog: { readOnlyTools: ['Read'], writeTools: ['Write'] },
        hostSemanticContext: hostSemantics,
      };
    case 'rollout_reviewer':
      return { taskKind: kind, ...common, governanceDeps: rolloutDeps };
  }
}

function runOnceInput(kind: ExecuteSelectedInternalizationTaskInput['taskKind'], taskId: string): ExecuteSelectedInternalizationTaskInput {
  const common = { ...base(taskId), runnerOptions: runOnceOptions(config) };
  switch (kind) {
    case 'dreamer': return { taskKind: kind, ...common };
    case 'philosopher': return { taskKind: kind, ...common };
    case 'scribe': return { taskKind: kind, ...common };
    case 'artificer': {
      // run-once 的宿主语义投影来自 workspace 持久化声明 — 未声明时缺省。
      const resolved = resolveWorkspaceHostToolSemantics(workspaceDir);
      return {
        taskKind: kind, ...common,
        ...(resolved.ok ? { hostSemanticContext: buildArtificerHostSemanticContext(resolved.registry, resolved.hostKinds) } : {}),
      };
    }
    case 'evaluator':
      return { taskKind: kind, ...common, repairDeps, gateDeps: createProductionGateDeps({ projectDir: workspaceDir }) };
    case 'rollout_reviewer':
      return {
        taskKind: kind, ...common,
        runnerOptions: { owner: OWNER_RUN_ONCE, runtimeKind: 'pi-ai', pollIntervalMs: 100, timeoutMs: 300_000, outputLanguage: 'zh-CN' as const },
        governanceDeps: rolloutDeps,
      };
  }
}

function storeEmitterProbe(): StoreEventEmitter {
  return new StoreEventEmitter();
}

async function runExecutor(input: ExecuteSelectedInternalizationTaskInput): Promise<void> {
  await executeSelectedInternalizationTask(input);
}

function capturedAt(kind: string, index: 0 | 1): Record<string, unknown> {
  const list = captured[kind];
  if (!list || list[index] === undefined) throw new Error(`no captured runner ${kind}[${index}]`);
  return list[index] as Record<string, unknown>;
}

// ── Parity ──────────────────────────────────────────────────────────────────

describe('PRI-1293 Phase 2B — 六种 Peer Runner 装配等价性 (双入口 × 共享执行器)', () => {
  it('DreamerRunner: 两入口的 owner/runtimeKind/effectiveConfig/timeout/outputLanguage/validator 装配一致', async () => {
    await runExecutor(consumerInput('dreamer', 'task-d1'));
    await runExecutor(runOnceInput('dreamer', 'task-d2'));
    const consumer = capturedAt('dreamer', 0);
    const runOnce = capturedAt('dreamer', 1);
    for (const runner of [consumer, runOnce]) {
      expect(runner.validator).toBeInstanceOf(DefaultDreamerValidator);
    }
    const consumerOpts = consumer.resolvedOptions as Record<string, unknown>;
    const runOnceOpts = runOnce.resolvedOptions as Record<string, unknown>;
    expect(consumerOpts.owner).toBe(OWNER_CONSUMER);
    expect(runOnceOpts.owner).toBe(OWNER_RUN_ONCE);
    expect(consumerOpts.runtimeKind).toBe('pi-ai');
    expect(runOnceOpts.runtimeKind).toBe('pi-ai');
    expect(consumerOpts.timeoutMs).toBe(240_000);
    expect(runOnceOpts.timeoutMs).toBe(300_000);
    expect(consumerOpts.outputLanguage).toBe('zh-CN');
    expect(runOnceOpts.outputLanguage).toBe('zh-CN');
    // effectiveConfig 存于 BasePeerRunner 的 PeerRunnerConfig (非 resolvedOptions)。
    const configOf = (runner: Record<string, unknown>): Record<string, unknown> =>
      runner.config as Record<string, unknown>;
    expect(configOf(consumer).effectiveConfig).toBe(config);
    expect(configOf(runOnce).effectiveConfig).toBe(config);
    // 共享 deps: stateManager / runtimeAdapter 原样注入 (不复制不包装)。
    expect(consumer.stateManager).toBe(stateManager);
    expect(consumer.runtimeAdapter).toBe(adapter);
  });

  it('PhilosopherRunner: 与周期执行相同的配置语义 (validator + options 透传)', async () => {
    await runExecutor(consumerInput('philosopher', 'task-p1'));
    await runExecutor(runOnceInput('philosopher', 'task-p2'));
    const consumer = capturedAt('philosopher', 0);
    const runOnce = capturedAt('philosopher', 1);
    expect(consumer.validator).toBeInstanceOf(DefaultPhilosopherValidator);
    expect(runOnce.validator).toBeInstanceOf(DefaultPhilosopherValidator);
    for (const runner of [consumer, runOnce]) {
      const opts = runner.resolvedOptions as Record<string, unknown>;
      expect(opts.runtimeKind).toBe('pi-ai');
      expect(opts.outputLanguage).toBe('zh-CN');
    }
  });

  it('ScribeRunner: 完整 ledgerIdentity 三元组可调用 — 身份缺失/账本不可用不得静默变有效', async () => {
    await runExecutor(consumerInput('scribe', 'task-s1'));
    await runExecutor(runOnceInput('scribe', 'task-s2'));
    for (const runner of [capturedAt('scribe', 0), capturedAt('scribe', 1)]) {
      expect(runner.validator).toBeInstanceOf(DefaultScribeValidator);
      const identity = runner.ledgerIdentity as Record<string, unknown> | undefined;
      expect(identity).toBeDefined();
      // 三元组全部存在且真实工作 (对空 workspace: isAvailable=false, 不可用
      // 账本不得读作已解析链 — PRI-915)。
      expect(typeof identity?.resolveForCandidate).toBe('function');
      expect(typeof identity?.isAvailable).toBe('function');
      expect(typeof identity?.listForCandidate).toBe('function');
      expect(typeof (identity?.isAvailable as () => boolean)()).toBe('boolean');
      expect((identity?.listForCandidate as (id: string) => unknown[])('nope')).toEqual([]);
    }
  });

  it('ArtificerRunner: consumer 注入 evidence pack + trustedFacts; run-once 无装配端口则缺省 (§2.5 差异保持)', async () => {
    await runExecutor(consumerInput('artificer', 'task-a1'));
    await runExecutor(runOnceInput('artificer', 'task-a2'));
    const consumer = capturedAt('artificer', 0);
    const runOnce = capturedAt('artificer', 1);
    // consumer: preflight 通过后的 evidence pack 与同一 trusted-facts 端口进 runner。
    expect(consumer.behaviorExamplePack).toBeDefined();
    expect(consumer.trustedFacts).toBeDefined();
    // run-once: 本 CLI 无 evidence 装配端口 — runner 绝不被无据构造出 pack。
    expect(runOnce.behaviorExamplePack).toBeUndefined();
    expect(runOnce.trustedFacts).toBeUndefined();
    // 两入口的 validator / ledgerIdentity.resolveForCandidate 同契约。
    expect(consumer.validator).toBeInstanceOf(DefaultArtificerValidator);
    expect(runOnce.validator).toBeInstanceOf(DefaultArtificerValidator);
    expect(typeof (consumer.ledgerIdentity as Record<string, unknown>)?.resolveForCandidate).toBe('function');
    expect(typeof (runOnce.ledgerIdentity as Record<string, unknown>)?.resolveForCandidate).toBe('function');
  });

  it('EvaluatorRunner: gateDeps 必在、repair 接线必在、ledgerIdentity 含 hasPrinciple、host 目录/语义透传', async () => {
    await runExecutor(consumerInput('evaluator', 'task-e1'));
    await runExecutor(runOnceInput('evaluator', 'task-e2'));
    const consumer = capturedAt('evaluator', 0);
    const runOnce = capturedAt('evaluator', 1);
    for (const runner of [consumer, runOnce]) {
      // gateDeps 属于 evaluator production semantics — 缺失即装配错误。
      expect(runner.gateDeps).toBeDefined();
      expect(runner.repairTaskSeeder).toBeTypeOf('function');
      expect(runner.repairLoopEnabledResolver).toBeTypeOf('function');
      expect(runner.validator).toBeInstanceOf(DefaultEvaluatorValidator);
      const identity = runner.ledgerIdentity as Record<string, unknown> | undefined;
      expect(typeof identity?.isAvailable).toBe('function');
      // PRI-911A writer boundary: hasPrinciple 把 "UUID 形状" 变成 "账本实际铸造"。
      expect(typeof identity?.hasPrinciple).toBe('function');
    }
    // hostToolCatalog (consumer 有宿主声明端口; run-once 输入形态无目录)。
    expect(consumer.hostToolCatalog).toBeDefined();
    // 事件口差异 (§2.5.6): consumer evaluator 用 workspace-scoped emitter。
    expect(consumer.eventEmitter).toBeInstanceOf(WorkspaceTelemetryEmitter);
    expect(runOnce.eventEmitter).toBeInstanceOf(StoreEventEmitter);
  });

  it('RolloutReviewerRunner: dispatchActivation/reopenRevisionTarget 治理接线必在 — Owner 审批不可绕过', async () => {
    await runExecutor(consumerInput('rollout_reviewer', 'task-r1'));
    await runExecutor(runOnceInput('rollout_reviewer', 'task-r2'));
    for (const runner of [capturedAt('rollout_reviewer', 0), capturedAt('rollout_reviewer', 1)]) {
      expect(runner.validator).toBeInstanceOf(DefaultRolloutReviewerValidator);
      expect(runner.dispatchActivation).toBeTypeOf('function');
      expect(runner.reopenRevisionTarget).toBeTypeOf('function');
    }
    // 有意差异 (§2.5): run-once 的 rollout options 不带 effectiveConfig (历史语义)。
    const runOnceOpts = captured.rollout_reviewer?.[1] as unknown as Record<string, unknown> | undefined;
    expect((runOnceOpts?.resolvedOptions as Record<string, unknown>).effectiveConfig).toBeUndefined();
  });

  it('repair 接线语义: 两个入口的 seedArtificerRepairTask 都经唯一血缘收口 (SeedArtificerRepairParams 契约不变)', async () => {
    const params: SeedArtificerRepairParams = {
      repairPayload: {
        requiredChanges: ['x'], concerns: [], previousScore: 0.5, repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-a', sourceEvaluatorTaskId: 'evaluator-missing',
        sourceEvaluatorRunId: 'run',
      },
      inheritedDependencyTaskIds: [], inheritedChannel: 'prompt', inheritedTimeoutMs: 300_000,
      inheritedInputArtifactRefs: [],
    };
    // 来源不可考 → 两个入口的 seeder 一致拒绝 (唯一血缘权威)。
    await expect(repairDeps.seedArtificerRepairTask(params)).rejects.toThrow(/evaluator_repair_seed_lineage_refused/);
  });
});
