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
 * R3（终态不变量守卫）：code-bearing + approved 且 gateDeps 已注入时，
 * runAdversarialReplay **必须**产出 adversarialResult；无论何种成因导致
 * gate 没跑成（merged cases 为空 / 无 positive case / 产物不可解析 /
 * conversion drift …），都不得以 succeeded 结束 → fail-loud
 * （input_invalid，permanent）。R1 管「要不要跑」，R3 管「跑了有没有结果」，
 * 二者合一才封死终态；R2 只是 wiring 缺失这一个成因的特例。
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
import type { EvaluatorRunnerDeps } from '../evaluator-runner.js';

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
function v1EvaluatorOutput(decision: 'approved' | 'needs_revision' | 'rejected'): unknown {
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

function makeRunner(
  store: SqlitePIArtifactStore,
  options: { gateDeps?: RefinerRuleHostGateDeps; payload?: unknown } = {},
  deps: Partial<Pick<EvaluatorRunnerDeps, 'isRepairLoopEnabled' | 'seedArtificerRepairTask'>> = {},
): EvaluatorRunner {
  return new EvaluatorRunner(
    {
      stateManager, runtimeAdapter: scriptedAdapter(options.payload ?? v1EvaluatorOutput('approved')),
      eventEmitter: emitter, artifactStore: store, validator: new DefaultEvaluatorValidator(),
      ...deps,
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

});

// ── PRI-634 R3（终态不变量）──
// R1 只保证「code-bearing + approved 会去调 gate」；R3 补上另一半：
// 「调了但没产出 adversarialResult」同样不允许以 succeeded 结束。二者合一
// 才真正封死链 48371236 的终态（approved + gate 未执行 +
// adversarialResult=null + 永无 pi-rule-*）。R2 只覆盖 wiring 缺失这一因，
// R3 覆盖其余所有成因（cases 为空 / 无 positive case / 产物不可解析 /
// conversion drift …）—— 封的是终态，不是某个具体成因。
describe('PRI-634 R3: code-bearing + approved 若 gate 未产出 adversarialResult 必须 fail-loud', () => {
  it('affectedTools 缺失 + positive case 无 path → merged cases 为空 → failed(input_invalid)，不得 succeeded', async () => {
    // positive case 保持结构合法（params 允许空对象），但无 path → v2 cases
    // 生成失败（no_path_param_for_v2_adversarial_cases）+ V1 无 LLM cases →
    // merged 为空 → no_adversarial_cases_after_merge。
    //
    // 这正是 Owner 复核指出的逃逸路径：旧断言 succeeded 与文件顶部 R1 契约
    // （「必须进入 deterministic gate」）自相矛盾，等于给洞发通行证。
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

    // 终态守卫：gate 没跑成 → 必须 fail-loud，而不是 succeeded + null
    expect(result.status).toBe('failed');
    expect(calls.count).toBe(0);
    // permanent（input_invalid 已在 permanentErrorCategories），不重试烧 LLM budget；
    // 与 R2 的 capability_missing 区分：gate 已正确装配，是上游产物派生不出 gate 输入
    const task = await stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('failed');
    expect(task?.lastError).toBe('input_invalid');
    // A3 可观测性保留：skip 事件仍要发
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'no_adversarial_cases_after_merge')).toBe(true);
  });

  it('反向对照：非 code-bearing（无 implementationCode）+ V2 output → 同样 skip，但走 legacy succeeded（R3 不误伤）', async () => {
    // A2 明确保留的 legacy 语义：V2-shaped output over a non-code-bearing
    // artifact 仍尝试 replay，失败则带 telemetry 降级，不升级为失败。
    // 若此例也 failed，说明 R3 的作用域收窄错了。
    const store = await seedLineage(JSON.stringify({
      analysis: '非 code-bearing artificer 产物（纯分析）',
      goldenTraceCases: [
        { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/project/src/safe.ts' }, expectedDecision: 'allow' },
      ],
    }));
    const calls = { count: 0 };
    // V2-shaped output：带合法 codeReview，无 adversarialCases →
    // outputWantsGate=true 会进入 replay，但因缺 implementationCode 而 skip
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub(calls),
      payload: {
        ...(v1EvaluatorOutput('approved') as Record<string, unknown>),
        codeReview: {
          intentConsistency: { aligned: true, explanation: '与原则意图一致' },
          scopePrecision: { verdict: 'precise', explanation: '范围精确' },
          traceCoverage: { sufficient: true, gaps: [], explanation: '覆盖充分' },
          summary: 'code review passed',
        },
      },
    });

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('succeeded');
    expect(calls.count).toBe(0);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'artificer_artifact_has_no_implementation_code')).toBe(true);
  });
});

// ── PRI-634 R4（needs_revision 诊断重放）──
// 评审（2026-08-31）确认三条 P1：拆分 executeDeterministicReplay（P1-1）、
// RepairPayload 增 diagnosticReplay 通道（P1-2）、canonical envelope 持久化（P1-3）。
// R4 覆盖完整契约：
//   - code-bearing + needs_revision + gateDeps → evaluateInSandbox MUST be called
//   - adversarialResult MUST be persisted（canonical envelope）
//   - machine verdict MUST remain needs_revision（不覆盖）
//   - repairPayload MUST carry diagnosticReplay evidence（P1-2）
//   - 本轮不组装 pi-rule-*（verdict 不是 approved）
describe('PRI-634 R4: code-bearing + needs_revision → diagnostic replay 执行、verdict 不变、evidence 进 repairPayload', () => {
  it('evaluateInSandbox 被调用；adversarialResult 持久化（canonical envelope）；machine verdict 仍为 needs_revision；repairPayload 携带 diagnosticReplay；不组装 pi-rule-*', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const calls = { count: 0 };
    let seededRepairPayload: { diagnosticReplay?: unknown } | null = null;
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub(calls),
      payload: v1EvaluatorOutput('needs_revision'),
    }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (params) => {
        seededRepairPayload = params.repairPayload;
        return 'repair-task-r4';
      },
    });

    const result = await runner.run(EVAL_ID);

    // R4（P1-1）：诊断重放必须真正执行（executeDeterministicReplay 无 verdict guard）
    expect(calls.count).toBeGreaterThan(0);

    // machine verdict 仍为 needs_revision（不覆盖）
    expect(result.status).toBe('succeeded');
    const task = await stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('succeeded');

    // R4（P1-1 + P1-3）：adversarialResult 持久化到 artifact，canonical envelope 保留
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as {
      evaluation?: { decision?: string };
      adversarialResult?: { passed?: boolean };
    };
    // verdict 不变（not overridden to approved）
    expect(parsed.evaluation?.decision).toBe('needs_revision');
    // adversarialResult 存在（diagnostic replay 已执行）
    expect(parsed.adversarialResult?.passed).toBe(true);
    // 使用 canonical envelope → contentJson 包含 summary 或 predecessorSummary
    // 当 artifact-summary flag 开启时；没有 flag 时 contentJson 是 JSON.stringify(output)
    // 但无论如何 lineageArtifactIds 应非空（包含 artificer artifact）
    expect(principle.lineageArtifactIds.length).toBeGreaterThanOrEqual(1);
    expect(principle.validationStatus).toBe('pending');

    // R4（P1-2）：repairPayload 携带 diagnosticReplay evidence
    expect(seededRepairPayload).not.toBeNull();
    expect((seededRepairPayload as unknown as { diagnosticReplay?: unknown })?.diagnosticReplay).toEqual({ ran: true, passed: true, failedCaseCount: 0 });

    // 本轮不组装 pi-rule-*（verdict 不是 approved）
    const rules = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(rules).toHaveLength(0);
  });

  it('反向对照：needs_revision 但 gateDeps 未装配 → 不 fail-loud，仅 skip（诊断证据缺失不改变 verdict 路径）', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const runner = makeRunner(store, {
      payload: v1EvaluatorOutput('needs_revision'),
    }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (_params) => 'repair-task-r4b',
    });

    const result = await runner.run(EVAL_ID);

    // needs_revision 不是 rule-assembly 终态：缺 gateDeps 只损失诊断证据，不 fail-loud
    expect(result.status).toBe('succeeded');
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'gate_deps_not_injected')).toBe(true);
  });

  it('needs_revision + gate 无 positive case 可用 → 重放 skip（skipReason），verdict 保持 needs_revision，不组装 rule', async () => {
    // positive case 缺 path → 无法生成 v2 adversarial cases → merged 为空 →
    // executeDeterministicReplay 返回 skipReason 且 updatedOutput=null →
    // 诊断重放未产出证据（diagnostic_failed），verdict 不受影响。
    const store = await seedLineage(codeBearingArtificerContent({
      affectedTools: undefined,
      goldenTraceCases: [
        { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: {}, expectedDecision: 'allow' },
      ],
    }));
    const calls = { count: 0 };
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub(calls),
      payload: v1EvaluatorOutput('needs_revision'),
    }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (_params) => 'repair-task-r4c',
    });

    const result = await runner.run(EVAL_ID);

    // 重放试图运行但派生不出 gate 输入：skip（诊断证据缺失），verdict 保持
    expect(result.status).toBe('succeeded');
    expect(calls.count).toBe(0);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'no_adversarial_cases_after_merge')).toBe(true);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_diagnostic_failed')).toBe(true);
    // verdict 保持 needs_revision：task succeeded，无 rule 组装
    const task = await stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('succeeded');
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    expect(artifacts.filter((a) => a.artifactKind === 'rule')).toHaveLength(0);
  });

  it('rejected verdict + code-bearing + gateDeps → 不执行重放（rejected → skip 策略）', async () => {
    // 调用者策略层：rejected 不是 needs_revision —— 无诊断重放，仅 skip 事件。
    const store = await seedLineage(codeBearingArtificerContent());
    const calls = { count: 0 };
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub(calls),
      payload: v1EvaluatorOutput('rejected'),
    });

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('succeeded');
    expect(calls.count).toBe(0); // rejected → skip（无 binding、无 diagnostic）
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'evaluation_not_approved')).toBe(true);
  });

  // ── PRI-634 R4 (P1 provenance): diagnosticReplay 必须是执行时权威事实 ──
  // 绝不从 LLM 可伪造的 adversarialResult 字段反推。以下两个反例验证：
  // T1: gateDeps 缺失,即使 LLM 自带 adversarialResult.passed=true,
  //     diagnosticReplay 也不应出现（无 sandbox 执行）。
  // T2: gateDeps 存在但 replay 无法运行（skip）,即使 LLM 自带
  //     adversarialResult.passed=true,diagnosticReplay 也不应出现。
  it('T1 (provenance): needs_revision + LLM-forged adversarialResult + gateDeps missing → repairPayload diagnosticReplay undefined', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const seeded: { payload?: unknown } = {};
    // V2-shaped output: needs_revision + forged adversarialResult (no gateDeps)
    const forgedPayload = {
      ...(v1EvaluatorOutput('needs_revision') as Record<string, unknown>),
      adversarialResult: { passed: true, failedCases: [] },
    };
    const runner = makeRunner(store, { payload: forgedPayload }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (params) => {
        seeded.payload = params.repairPayload;
        return 'repair-task-provenance-t1';
      },
    });

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('succeeded');
    // gateDeps missing → skip event
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped' && e.payload.reason === 'gate_deps_not_injected')).toBe(true);
    // diagnosticReplayEvidence 为 undefined → repairPayload 无 diagnosticReplay
    expect(seeded.payload).toBeDefined();
    const rp = seeded.payload as Record<string, unknown>;
    expect(rp.diagnosticReplay).toBeUndefined();

    // durable artifact 不得保留 LLM forged adversarialResult（P1：剥离）
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as { adversarialResult?: unknown };
    expect(Object.hasOwn(parsed, 'adversarialResult')).toBe(false);
  });

  it('T2 (provenance): needs_revision + LLM-forged adversarialResult + gateDeps present + replay skip → repairPayload diagnosticReplay undefined', async () => {
    // replay skip via no positive case path (affectedTools undefined + pos case no path)
    const store = await seedLineage(codeBearingArtificerContent({
      affectedTools: undefined,
      goldenTraceCases: [
        { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: {}, expectedDecision: 'allow' },
      ],
    }));
    const calls = { count: 0 };
    const seeded: { payload?: unknown } = {};
    const forgedPayload = {
      ...(v1EvaluatorOutput('needs_revision') as Record<string, unknown>),
      adversarialResult: { passed: true, failedCases: [] },
    };
    const runner = makeRunner(store, { gateDeps: makeGateDepsStub(calls), payload: forgedPayload }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (params) => {
        seeded.payload = params.repairPayload;
        return 'repair-task-provenance-t2';
      },
    });

    const result = await runner.run(EVAL_ID);

    // replay skipped (no cases), sandbox never called
    expect(result.status).toBe('succeeded');
    expect(calls.count).toBe(0);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_skipped')).toBe(true);
    // diagnosticReplayEvidence 为 undefined → repairPayload 无 diagnosticReplay
    expect(seeded.payload).toBeDefined();
    const rp = seeded.payload as Record<string, unknown>;
    expect(rp.diagnosticReplay).toBeUndefined();

    // durable artifact 不得保留 LLM forged adversarialResult（P1：剥离）
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as { adversarialResult?: unknown };
    expect(Object.hasOwn(parsed, 'adversarialResult')).toBe(false);
  });

  // T3 (正向): needs_revision + actual deterministic replay pass →
  // durable artifact adversarialResult.passed=true（runtime 写回），
  // diagnosticReplay 为真实执行结果。
  it('T3 (provenance): needs_revision + actual replay pass → durable artifact carries real adversarialResult + diagnosticReplay', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const seeded: { payload?: unknown } = {};
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub({ count: 0 }),
      payload: v1EvaluatorOutput('needs_revision'), // 纯 V1：无 LLM 声明的 adversarialResult
    }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (params) => {
        seeded.payload = params.repairPayload;
        return 'repair-task-provenance-t3';
      },
    });

    const result = await runner.run(EVAL_ID);

    expect(result.status).toBe('succeeded');
    // durable artifact 携带 runtime 写回的 adversarialResult
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as { adversarialResult?: { passed?: boolean } };
    expect(parsed.adversarialResult?.passed).toBe(true);
    // diagnosticReplay 来自执行时权威事实
    expect(seeded.payload).toBeDefined();
    const rp = seeded.payload as { diagnosticReplay?: unknown };
    expect(rp.diagnosticReplay).toEqual({ ran: true, passed: true, failedCaseCount: 0 });
  });

  // ── PRI-634 PR-A (SPEC §16/§17): merged real case ID uniqueness guard ──
  // An LLM-supplied adversarial case whose caseId collides with a
  // runtime-generated v2 case must never reach the sandbox — the evidence Map
  // would silently overwrite and mis-attribute failures. Approved binding
  // path fails loud (R3 terminal-state guard); needs_revision keeps its
  // verdict, records the conflict observably, and stays evidence fail-closed.
  it('PR-A: duplicate real caseId (LLM case collides with v2-unavailable) → conflict telemetry, no sandbox run', async () => {
    const store = await seedLineage(codeBearingArtificerContent());
    const calls = { count: 0 };
    const llmCollidedCases = [{
      caseId: 'v2-unavailable', // collides with the runtime-generated v2 case
      attackType: 'boundary',
      toolName: 'edit_file',
      params: { path: '/project/src/safe.ts' },
      expectedDecision: 'block',
      rationale: 'adversarially crafted collision',
    }];
    const collisionPayload = {
      ...(v1EvaluatorOutput('needs_revision') as Record<string, unknown>),
      adversarialCases: llmCollidedCases,
    };
    const runner = makeRunner(store, {
      gateDeps: makeGateDepsStub(calls),
      payload: collisionPayload,
    }, {
      isRepairLoopEnabled: () => true,
      seedArtificerRepairTask: async (_params) => 'repair-task-collision',
    });

    const result = await runner.run(EVAL_ID);

    // sandbox never ran — the conflict is detected pre-sandbox
    expect(calls.count).toBe(0);
    expect(emitted.some((e) => e.eventType === 'evaluator_adversarial_replay_case_id_conflict' && e.payload.caseId === 'v2-unavailable')).toBe(true);
    // needs_revision diagnostic path: verdict stands, task completes
    expect(result.status).toBe('succeeded');
    // fail-closed provenance: no diagnosticReplay evidence was produced
    const artifacts = await store.listBySourceTaskId(EVAL_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as { adversarialResult?: unknown };
    expect(Object.hasOwn(parsed, 'adversarialResult')).toBe(false);
  });
});
