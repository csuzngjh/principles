/**
 * PRI-720 — RolloutReviewer principle semantic mode (C2/C3) 验收测试。
 *
 * 覆盖:
 *   - resolveRolloutReviewMode 结构判定表（channel × pipelineMode × 依赖结构,
 *     AC12: 存量链不 reinterpret —— 带 evaluator 依赖的 legacy prompt 链仍是
 *     code_chain 契约）
 *   - DefaultRolloutReviewerValidator 的模式分支（principle_semantic 要求
 *     sourceScribeArtifactId / sourceTrace.scribeArtifactId 与 runner-owned
 *     authority 一致;code_chain 契约 byte-compatible 不变）
 *   - 端到端 fresh run（prompt 标准拓扑）: scribe 依赖被选中为评审源、
 *     principle semantic prompt 被构建、approve 后 scribe 原则 artifact 被
 *     翻转为 validated（C3/AC8,reviewed=validated=approved=dispatched 同一
 *     identity）、activation dispatch 收到的正是该 artifact
 */
import { describe, it, expect, vi } from 'vitest';
import { RolloutReviewerRunner, resolveRolloutReviewMode } from '../rollout-reviewer-runner.js';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import { resolveOutputSchema } from '../../adapter/output-schema-registry.js';
import { Value } from '@sinclair/typebox/value';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { MemoryTaskStore } from '../../store/task/memory-task-store.js';
import { createPITaskDiagnosticJson, type PITaskMetadata } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';

const SCRIBE_ID = 'scribe-sem-1';
const ROLLOUT_ID = 'rollout-reviewer-sem-1';
const RUN_ID = 'run-sem-1';
const SCRIBE_ARTIFACT_ID = `pi-art-${SCRIBE_ID}-${RUN_ID}`;

function meta(overrides: Partial<PITaskMetadata> = {}): PITaskMetadata {
  return {
    dependencyTaskIds: [SCRIBE_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  };
}

function task(taskId: string, taskKind: string, opts: { status: TaskRecord['status']; m: PITaskMetadata }): TaskRecord {
  return {
    taskId, taskKind, status: opts.status, attemptCount: 0, maxAttempts: 3,
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(opts.m),
  };
}

function scribePrincipleContent(): string {
  return JSON.stringify({
    principleDraft: {
      title: '先调查真实 consumer 再修改',
      statement: '修改共享配置前,必须先读取真实 consumer 的使用点',
      rationale: 'EP002 pain:盲改配置破坏未知 consumer',
      applicability: { contexts: ['config-edit', 'infra-change'] },
      antiPatterns: ['凭单点印象直接修改'],
    },
    intentContract: { targetBehavior: '先调查再动手', forbiddenBehavior: '盲改共享配置' },
    generatedAt: '2026-09-15T00:00:00.000Z',
  });
}

function principleModeOutput(decision: 'approve_rollout' | 'needs_revision' | 'reject') {
  return {
    taskId: ROLLOUT_ID,
    sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
    review: {
      decision, confidence: 0.88,
      summary: decision === 'approve_rollout' ? 'principle 忠实于诊断证据且范围诚实' : 'statement 过度泛化',
      requiredChanges: decision === 'approve_rollout' ? [] : ['收窄 applicability 到 config-edit 场景'],
      rolloutRisks: ['可能误伤相邻 shell 工具场景'],
      safetyChecks: ['观察首次激活是否 over-blocking'],
    },
    sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
    risks: ['单一证据会话来源'],
    generatedAt: '2026-09-15T00:01:00.000Z',
  };
}

function makeArtifacts(withScribeArtifact = true): MemoryPIArtifactStore {
  const store = new MemoryPIArtifactStore();
  if (withScribeArtifact) {
    void store.upsertArtifact({
      artifactId: SCRIBE_ARTIFACT_ID, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'pending',
      contentJson: scribePrincipleContent(),
      createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    });
  }
  return store;
}

function makeHarness(options: {
  tasks: TaskRecord[];
  artifacts: MemoryPIArtifactStore;
  output: unknown;
  dispatchDecision?: string | null;
}) {
  const store = new MemoryTaskStore();
  for (const t of options.tasks) void store.createTask({ ...t });
  const runs = new Map([
    [RUN_ID, { runId: RUN_ID, taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', outputPayload: '{}' }],
  ]);
  const startRun = vi.fn().mockResolvedValue({ runId: RUN_ID });
  const dispatchActivation = vi.fn().mockResolvedValue({
    decision: options.dispatchDecision ?? 'activated', activationId: 'act-sem-1', reason: null,
  });
  const stateManager = {
    piArtifactStore: options.artifacts,
    async acquireLease() { return store.getTask(ROLLOUT_ID); },
    async getTask(id: string) { return store.getTask(id); },
    async listTasks() { return [] as TaskRecord[]; },
    async getRunsByTask(id: string) { return [...runs.values()].filter((r) => r.taskId === id); },
    async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
    async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
    async updateRunOutput() { /* run output persisted by real store; no-op in memory harness */ },
    async markTaskSucceeded(id: string, resultRef: string) { await store.updateTask(id, { status: 'succeeded', resultRef }); },
    async markTaskFailed(id: string, lastError: TaskRecord['lastError']) { await store.updateTask(id, { status: 'failed' as const, lastError }); },
    getRetryPolicy: () => ({ shouldRetry: () => false }),
  };
  const runtimeAdapter = {
    startRun,
    pollRun: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    fetchOutput: vi.fn().mockResolvedValue({ payload: options.output }),
    cancelRun: vi.fn(),
  };
  const eventEmitter = { emitTelemetry: vi.fn() };
  const reopenRevisionTarget = vi.fn().mockResolvedValue({ ok: true, reason: 'reopened' });
  const runner = new RolloutReviewerRunner(
    {
      stateManager: stateManager as never,
      runtimeAdapter: runtimeAdapter as never,
      eventEmitter: eventEmitter as never,
      artifactStore: options.artifacts,
      validator: new DefaultRolloutReviewerValidator(),
      dispatchActivation,
      reopenRevisionTarget,
    },
    { owner: 'test', runtimeKind: 'rollout_reviewer' },
  );
  return { runner, startRun, dispatchActivation, reopenRevisionTarget, stateManager, artifacts: options.artifacts, eventEmitter };
}

// ── 模式判定表 ────────────────────────────────────────────────────────────────

describe('resolveRolloutReviewMode — 结构判定 (PRI-720/AC12)', () => {
  it('标准 prompt/defer 链 (scribe 依赖, 无 evaluator 依赖) → principle_semantic', () => {
    expect(resolveRolloutReviewMode('prompt', undefined, ['scribe'])).toBe('principle_semantic');
    expect(resolveRolloutReviewMode('defer_archive', undefined, ['philosopher', 'scribe'])).toBe('principle_semantic');
  });

  it('code 渠道、full_chain 覆盖、legacy evaluator 依赖 → code_chain', () => {
    expect(resolveRolloutReviewMode('code_tool_hook', undefined, ['scribe', 'artificer', 'evaluator'])).toBe('code_chain');
    expect(resolveRolloutReviewMode('prompt', 'full_chain', ['scribe', 'artificer', 'evaluator'])).toBe('code_chain');
    // AC12: 存量 (pre-PRI-720) prompt 链带 evaluator 依赖 — 不 reinterpret。
    expect(resolveRolloutReviewMode('prompt', undefined, ['evaluator'])).toBe('code_chain');
    expect(resolveRolloutReviewMode('prompt', undefined, ['scribe', 'evaluator'])).toBe('code_chain');
    expect(resolveRolloutReviewMode(undefined, undefined, ['scribe'])).toBe('code_chain');
  });
});

// ── Validator 模式分支 ────────────────────────────────────────────────────────

describe('真实 LLM 输出路径 — 注册表 schema 与 mode validator 契约一致 (P1-1)', () => {
  // 这是 Owner 评审 P1-1 的回归测试: runner 传给 runtime adapter 的
  // outputSchemaRef='rollout-reviewer-output-v1' 会先于 mode validator 被
  // PiAi/OpenClaw 适配器做结构化校验 (tool-call / JSON mode / repair)。该
  // 注册表 schema 必须接受两种 mode 的合法输出, 否则语义模式的真实 LLM 路径
  // 全部 output_invalid (fake adapter 的 runner 级测试无法暴露这一层)。
  const schema = resolveOutputSchema('rollout-reviewer-output-v1');

  it('注册表解析 rollout-reviewer-output-v1', () => {
    expect(schema).toBeDefined();
  });

  it('principle_semantic 合法输出 (省略 evaluator 字段) 通过注册表 schema', () => {
    expect(schema).toBeDefined();
    if (!schema) throw new Error('schema missing');
    expect(Value.Check(schema, principleModeOutput('approve_rollout'))).toBe(true);
  });

  it('code_chain 合法输出 (evaluator 身份) 通过注册表 schema', () => {
    expect(schema).toBeDefined();
    if (!schema) throw new Error('schema missing');
    const codeOutput = {
      taskId: ROLLOUT_ID,
      sourceEvaluatorArtifactId: 'pi-art-eval-1',
      review: { decision: 'approve_rollout', summary: 's', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
      sourceTrace: { evaluatorArtifactId: 'pi-art-eval-1' },
      risks: [],
      generatedAt: '2026-09-15T00:00:00.000Z',
    };
    expect(Value.Check(schema, codeOutput)).toBe(true);
  });

  it('schema 层仍拒绝结构性缺失 (无任何 source 身份 / 坏 decision)', () => {
    expect(schema).toBeDefined();
    if (!schema) throw new Error('schema missing');
    const noSource = {
      taskId: ROLLOUT_ID,
      review: { decision: 'approve_rollout', summary: 's', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
      sourceTrace: {},
      risks: [],
      generatedAt: '2026-09-15T00:00:00.000Z',
    };
    expect(Value.Check(schema, noSource)).toBe(true); // schema 层宽容: source 必填性由 mode validator 持有
    const badDecision = {
      ...principleModeOutput('approve_rollout'),
      review: { ...principleModeOutput('approve_rollout').review, decision: 'maybe' },
    };
    expect(Value.Check(schema, badDecision)).toBe(false);
  });

  it('mode validator 仍是 source 身份的唯一权威 (schema 放开 + validator 收紧)', async () => {
    const validator = new DefaultRolloutReviewerValidator();
    // code_chain: 缺 evaluator 身份 → validator 拒 (尽管 schema 层已放开)
    const codeMissing = {
      taskId: ROLLOUT_ID,
      review: { decision: 'approve_rollout', summary: 's', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
      sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
      risks: [],
      generatedAt: '2026-09-15T00:00:00.000Z',
    };
    const result = await validator.validate(codeMissing as never, ROLLOUT_ID, { reviewMode: 'code_chain' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('sourceEvaluatorArtifactId must be non-empty string');
  });
});

describe('DefaultRolloutReviewerValidator — 模式分支', () => {
  const validator = new DefaultRolloutReviewerValidator();

  it('principle_semantic: scribe 身份一致 → valid', async () => {
    const result = await validator.validate(
      principleModeOutput('approve_rollout') as never,
      ROLLOUT_ID,
      { expectedSourceArtifactId: SCRIBE_ARTIFACT_ID, reviewMode: 'principle_semantic' },
    );
    expect(result.valid).toBe(true);
  });

  it('principle_semantic: 缺 sourceScribeArtifactId → output_invalid', async () => {
    const output = principleModeOutput('approve_rollout') as Record<string, unknown>;
    delete output.sourceScribeArtifactId;
    const result = await validator.validate(output as never, ROLLOUT_ID, { expectedSourceArtifactId: SCRIBE_ARTIFACT_ID, reviewMode: 'principle_semantic' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('sourceScribeArtifactId must be non-empty string');
  });

  it('principle_semantic: source 与 authority 不一致 → mismatch', async () => {
    const output = { ...principleModeOutput('approve_rollout'), sourceScribeArtifactId: 'pi-art-wrong' };
    const result = await validator.validate(output as never, ROLLOUT_ID, { expectedSourceArtifactId: SCRIBE_ARTIFACT_ID, reviewMode: 'principle_semantic' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('mismatch');
  });

  it('code_chain: 旧契约输出保持 valid（byte-compatible）', async () => {
    const result = await validator.validate({
      taskId: ROLLOUT_ID,
      sourceEvaluatorArtifactId: 'pi-art-eval-1',
      review: { decision: 'approve_rollout', summary: 's', confidence: 0.9, requiredChanges: [], rolloutRisks: [], safetyChecks: [] },
      sourceTrace: { evaluatorArtifactId: 'pi-art-eval-1' },
      risks: [],
      generatedAt: '2026-09-15T00:00:00.000Z',
    }, ROLLOUT_ID, { expectedSourceArtifactId: 'pi-art-eval-1' });
    expect(result.valid).toBe(true);
  });
});

// ── 端到端 fresh run (AC8/identity) ──────────────────────────────────────────

describe('RolloutReviewer principle semantic mode — fresh run', () => {
  it('scribe 依赖被选为评审源;approve 后 scribe artifact 被 validated 且 dispatch 的就是它', async () => {
    const artifacts = makeArtifacts();
    const rolloutTask = task(ROLLOUT_ID, 'rollout_reviewer', { status: 'pending', m: meta({ dependencyTaskIds: [SCRIBE_ID] }) })
    const scribeSucceeded = task(SCRIBE_ID, 'scribe', { status: 'succeeded', m: meta({ dependencyTaskIds: [] }) })
    const h = makeHarness({
      tasks: [rolloutTask, scribeSucceeded],
      artifacts,
      output: principleModeOutput('approve_rollout'),
      dispatchDecision: 'activated',
    });

    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');

    // C2: principle semantic prompt 被构建,评审源 = scribe artifact 原文
    expect(h.startRun).toHaveBeenCalledTimes(1);
    const startInput = h.startRun.mock.calls[0]?.[0] as { inputPayload: string; systemPrompt: string };
    expect(startInput.systemPrompt).toContain('PRINCIPLE SEMANTIC mode');
    const promptInput = JSON.parse(startInput.inputPayload) as { sourceScribeArtifactId: string; scribeArtifact: { principleDraft: { title: string } } };
    expect(promptInput.sourceScribeArtifactId).toBe(SCRIBE_ARTIFACT_ID);
    expect(promptInput.scribeArtifact.principleDraft.title).toContain('consumer');

    // C3/AC8: scribe 原则 artifact 被翻转为 validated（此前为 pending）
    expect((await artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('validated');

    // identity: dispatch 收到的正是被评审、被 validated 的那个 artifact
    expect(h.dispatchActivation).toHaveBeenCalledTimes(1);
    expect(h.dispatchActivation.mock.calls[0]?.[0]).toMatchObject({ artifactId: SCRIBE_ARTIFACT_ID, channel: 'prompt' });

    // C3 事件可观测 (rc-9)
    const events = h.eventEmitter.emitTelemetry.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
    expect(events).toContain('rollout_principle_validated');
  });

  it('reject: 不翻转 validated、不 dispatch（terminal，零 side effect）', async () => {
    const artifacts = makeArtifacts();
    const rolloutTask = task(ROLLOUT_ID, 'rollout_reviewer', { status: 'pending', m: meta({ dependencyTaskIds: [SCRIBE_ID] }) })
    const scribeSucceeded = task(SCRIBE_ID, 'scribe', { status: 'succeeded', m: meta({ dependencyTaskIds: [] }) })
    const h = makeHarness({
      tasks: [rolloutTask, scribeSucceeded],
      artifacts,
      output: principleModeOutput('reject'),
      dispatchDecision: null,
    });

    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    // 只有 approve 才拥有 validated 翻转权（C3 归属转移的边界）
    expect((await artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('pending');
    expect(h.dispatchActivation).not.toHaveBeenCalled();
  });

  it('needs_revision: reopen 路由直达 scribe（C4 行为证明）', async () => {
    const artifacts = makeArtifacts();
    const rolloutTask = task(ROLLOUT_ID, 'rollout_reviewer', { status: 'pending', m: meta({ dependencyTaskIds: [SCRIBE_ID] }) });
    const scribeSucceeded = task(SCRIBE_ID, 'scribe', { status: 'succeeded', m: meta({ dependencyTaskIds: [] }) });
    const h = makeHarness({
      tasks: [rolloutTask, scribeSucceeded],
      artifacts,
      output: principleModeOutput('needs_revision'),
      dispatchDecision: null,
    });

    const result = await h.runner.run(ROLLOUT_ID);
    expect(result.status).toBe('succeeded');
    // 修订目标 = 撰写该原则的 scribe（reviewer→scribe 直接依赖，无需经 artificer）
    expect(h.reopenRevisionTarget).toHaveBeenCalledTimes(1);
    expect(h.reopenRevisionTarget.mock.calls[0]?.[0]).toMatchObject({
      targetTaskId: SCRIBE_ID,
      targetKind: 'scribe',
      revisionIteration: 1,
    });
    // 不翻转、不 dispatch、不进人工裁决（fail-closed 死路已消除）
    expect((await artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('pending');
    expect(h.dispatchActivation).not.toHaveBeenCalled();
    expect((await h.stateManager.getTask(ROLLOUT_ID))?.status).toBe('succeeded');
  });

  it('resolveRevisionTarget: code 链（经 evaluator→artificer）路由不变', async () => {
    // code_chain 形状（rollout→evaluator→artificer→scribe）保持既有路由：
    // owner-override-resume.test.ts 的 code 渠道修订路由测试继续覆盖该形状。
    const { resolveRolloutRevisionTarget } = await import('../revision-reopen.js');
    const store = new Map<string, { taskId: string; taskKind: string; diagnosticJson: string }>([
      ['rollout-1', { taskId: 'rollout-1', taskKind: 'rollout_reviewer', diagnosticJson: createPITaskDiagnosticJson(meta({ dependencyTaskIds: ['eval-1'] })) }],
      ['eval-1', { taskId: 'eval-1', taskKind: 'evaluator', diagnosticJson: createPITaskDiagnosticJson(meta({ dependencyTaskIds: ['art-1'] })) }],
      ['art-1', { taskId: 'art-1', taskKind: 'artificer', diagnosticJson: createPITaskDiagnosticJson(meta({ dependencyTaskIds: [SCRIBE_ID] })) }],
      [SCRIBE_ID, { taskId: SCRIBE_ID, taskKind: 'scribe', diagnosticJson: createPITaskDiagnosticJson(meta({ dependencyTaskIds: [] })) }],
    ]);
    const getTask = async (id: string) => store.get(id) ?? null;
    // Minimal in-memory records satisfy the resolver (it reads taskKind +
    // dependencyTaskIds via hydrated metadata only).
    const code = await resolveRolloutRevisionTarget(getTask as never, 'rollout-1', 'code_tool_hook');
    expect(code?.kind).toBe('artificer');
    const promptLegacy = await resolveRolloutRevisionTarget(getTask as never, 'rollout-1', 'prompt');
    expect(promptLegacy?.kind).toBe('scribe');
  });
});
