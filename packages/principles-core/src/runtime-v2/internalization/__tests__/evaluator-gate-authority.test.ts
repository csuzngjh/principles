/**
 * PRI-634 R1/R2 — evaluator deterministic gate authority 集成回归。
 *
 * 事故复现（链 48371236）：生产装配缺 gateDeps（A1）且 evaluator 输出合法
 * V1 shape 时（A2），`isEvaluatorOutputV2()` 使 adversarial replay 结构性
 * 跳过 → 产出 succeeded + adversarialResult=null → 链上永远没有合法
 * pi-rule-* 产物。
 *
 * R1（authority regression 守卫）：code-bearing Artificer artifact + 合法
 * V1-shaped evaluator output（approved）→ **必须**进入 deterministic gate
 * （evaluateInSandbox 被调用），adversarialResult.passed=true 写回产物。
 *
 * R2（wiring regression 守卫）：code-bearing + approved 但 gateDeps 未注入
 * → **不得** succeeded + adversarialResult=null；必须 fail-loud
 * （capability_missing，permanent error）。
 *
 * 另覆盖 A3 可观测性：静默退化路径现在发 adversarial_replay_skipped 事件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import type { RefinerRuleHostGateDeps } from '../refiner-rulehost-gate.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let emitted: { eventType: string; payload: Record<string, unknown> }[];
const ARTIFICER_ID = 'artificer-gate-auth';
const EVAL_ID = 'evaluator-gate-auth';
const ARTIFICER_ART = 'pi-art-artificer-gate-auth';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-auth-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  emitter = new StoreEventEmitter();
  emitted = [];
  // 所有 telemetry 事件都会 emit('telemetry', event)（event-emitter.ts）；
  // 具体 eventType 事件用 onEventType 监听。这里收集全量便于断言。
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
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
  await stateManager.createTask({ taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ correlationId: 'gate-auth', dependencyTaskIds: deps }) });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'gate-auth', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

function codeBearingArtificerContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false }; }',
    goldenTraceCases: [
      { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/project/src/safe.ts' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['edit_file'],
    ...overrides,
  });
}

/** 纯 V1 shape：只有评估字段，没有任何 V2 字段（adversarialCases/codeReview/…） */
function v1EvaluatorOutput(decision: 'approved' | 'needs_revision'): unknown {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: ARTIFICER_ART,
    evaluation: {
      decision,
      summary: 'gate-auth',
      score: 0.9,
      strengths: [],
      concerns: [],
      requiredChanges: decision === 'needs_revision' ? ['必须改 X'] : [],
    },
    sourceTrace: { artificerArtifactId: ARTIFICER_ART },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function scriptedAdapter(payload: unknown): PDRuntimeAdapter {
  return {
    startRun: async () => ({ runId: 'run-gate-auth', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId: 'run-gate-auth' }),
    fetchOutput: async () => ({ runId: 'run-gate-auth', payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

function makeGateDepsStub(calls: { count: number }): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: (_code, _trace) => {
      calls.count += 1;
      return { success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] };
    },
  };
}

async function seedLineage(artificerContent: string): Promise<SqlitePIArtifactStore> {
  await mkTask(ARTIFICER_ID, 'artificer', []);
  await succeed(ARTIFICER_ID);
  await mkTask(EVAL_ID, 'evaluator', [ARTIFICER_ID]);
  const store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
  await store.upsertArtifact({
    artifactId: ARTIFICER_ART, artifactKind: 'principle', sourceTaskId: ARTIFICER_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: artificerContent,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return store;
}

function makeRunner(store: SqlitePIArtifactStore, options: { gateDeps?: RefinerRuleHostGateDeps }): EvaluatorRunner {
  return new EvaluatorRunner(
    {
      stateManager, runtimeAdapter: scriptedAdapter(v1EvaluatorOutput('approved')),
      eventEmitter: emitter, artifactStore: store, validator: new DefaultEvaluatorValidator(),
    },
    { owner: 'gate-auth', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, ...options },
  );
}

describe('PRI-634 R1: code-bearing + V1-shaped approved output must run the deterministic gate', () => {
  it('evaluateInSandbox 被调用，adversarialResult.passed=true 写回产物，task succeeded', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const calls = { count: 0 };
    const runner = makeRunner(store, { gateDeps: makeGateDepsStub(calls) });

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('succeeded');
    expect(calls.count).toBeGreaterThan(0); // R1: gate 必须真正运行

    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as { adversarialResult?: { passed?: boolean } };
    expect(parsed.adversarialResult?.passed).toBe(true);
    expect((await stateManager.getTask(EVAL_ID))?.status).toBe('succeeded');
  });
});

describe('PRI-634 R2: code-bearing without gateDeps must fail loud, never succeed un-gated', () => {
  it('run 返回 failed（capability_missing），task 落 failed，不产出 succeeded', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const runner = makeRunner(store, {}); // 故意不注入 gateDeps

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('failed');
    const task = await stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('failed');
    expect(task?.lastError).toBe('capability_missing');

    // 可观测性：缺 gateDeps 的 skip 事件必须发出（A3）
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'gate_deps_not_injected')).toBe(true);
  });
});

describe('PRI-634 legacy path: non-code-bearing Artificer keeps V1 behavior', () => {
  it('非 code-bearing（无 implementationCode）+ V1 approved + 无 gateDeps → 走 legacy succeeded（不 fail）', async () => {
    const store = await seedLineage(JSON.stringify({
      analysis: '非 code-bearing artificer 产物（纯分析）',
      goldenTraceCases: [
        { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/project/src/safe.ts' }, expectedDecision: 'allow' },
      ],
    }));
    const runner = makeRunner(store, {});

    const result = await runner.run(EVAL_ID);

    // authority 迁移后 legacy 语义不变：非 code-bearing 不要求 gate，无 gateDeps 也 succeed
    expect(result.status).toBe('succeeded');
    const task = await stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('succeeded');
  });

  it('code-bearing + approved + gateDeps + affectedTools 缺失且 positive case 无 path → 合并 cases 为空时 degrade 不 crash（A3 静默洞）', async () => {
    // positive case 保持结构合法（params 允许空对象），但无 path → v2 cases
    // 生成失败（no_path_param_for_v2_adversarial_cases）+ V1 无 LLM cases →
    // merged 为空 → no_adversarial_cases_after_merge（PRI-634 A3 静默洞 #3）
    const store = await seedLineage(codeBearingArtificerContent({
      affectedTools: undefined,
      goldenTraceCases: [
        { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: {}, expectedDecision: 'allow' },
      ],
    }));
    const calls = { count: 0 };
    const runner = makeRunner(store, { gateDeps: makeGateDepsStub(calls) });

    const result = await runner.run(EVAL_ID);

    // 合并后无 adversarial cases → skip 事件 + updatedOutput=null → 不 crash、
    // 不阻塞 succeeded（与 PRI-426 non-fatal 语义一致）
    expect(result.status).toBe('succeeded');
    expect(calls.count).toBe(0);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'no_adversarial_cases_after_merge')).toBe(true);
  });
});
