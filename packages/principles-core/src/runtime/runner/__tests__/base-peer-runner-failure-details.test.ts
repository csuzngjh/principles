/**
 * P0-2 失败详情可观测性测试（PRI-559）
 *
 * 验证：
 * 1. handleValidationError → persistOutputFailureDetails 写入 errors
 * 2. handlePostLeaseError → 带 evidencePack 的 PDRuntimeError 持久化 details
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type { PeerRunnerDeps, PeerRunnerResult, PeerRunnerValidationResult } from '../peer-runner-types.js';
import { PDRuntimeError } from '../../error-categories.js';

interface TestContext { contextHash: string; }
interface TestOutput { taskId: string; data: string; }

class TestRunner extends BasePeerRunner<TestContext, TestOutput> {
  private readonly permanent: ReadonlySet<PDErrorCategory>;

  constructor(deps: PeerRunnerDeps, permanent: ReadonlySet<PDErrorCategory> = new Set(['output_invalid', 'input_invalid', 'storage_unavailable'])) {
    super(
      deps,
      { owner: 'test', runtimeKind: 'test-double' },
      {
        runnerName: 'test',
        expectedTaskKind: 'dreamer',
        defaultAgentId: 'test',
        resultRefPrefix: 'test',
      },
    );
    this.permanent = permanent;
  }

  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return this.permanent;
  }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> { return { contextHash: 'test' }; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> { return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() }; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(output: unknown): Promise<PeerRunnerValidationResult> {
    if (typeof output !== 'object' || output === null) return { valid: false, errors: ['not an object', 'missing data'], errorCategory: 'output_invalid' };
    return { valid: true, errors: [] };
  }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async succeedTask(): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId: 't', runId: 'r', output: { taskId: 't', data: 'ok' }, attemptCount: 1 };
  }

  /** 暴露 protected 方法以供测试调用 */
  public async testHandleValidationError(ctx: Parameters<BasePeerRunner<TestContext, TestOutput>['handleValidationError']>[0]): Promise<PeerRunnerResult<TestOutput>> {
    return this.handleValidationError(ctx);
  }

  public async testHandlePostLeaseError(
    taskId: string, task: TaskRecord, error: unknown,
  ): Promise<PeerRunnerResult<TestOutput>> {
    return this.handlePostLeaseError(taskId, task, error);
  }

  /** Expose the protected retry/terminal decision surface (P1-3). */
  public async testRetryOrFail(ctx: Parameters<BasePeerRunner<TestContext, TestOutput>['retryOrFail']>[0]): Promise<PeerRunnerResult<TestOutput>> {
    return this.retryOrFail(ctx);
  }
}

function makeDeps(): PeerRunnerDeps {
  const stateManager = {
    workspaceDir: 'C:/ws/d01',
    updateTask: vi.fn(),
    markTaskFailed: vi.fn().mockResolvedValue({ taskId: 't', status: 'failed' }),
    markTaskRetryWait: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    getTaskHistory: vi.fn(),
    invalidateTask: vi.fn(),
    assertInitialized: vi.fn(),
    getRetryPolicy: vi.fn(),
    _taskStore: {},
    _runStore: {},
    emitter: { on: vi.fn(), emitTelemetry: vi.fn() },
  } as unknown as RuntimeStateManager;

  const eventEmitter = { on: vi.fn(), emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;
  const runtimeAdapter = { start: vi.fn(), supports: vi.fn(), close: vi.fn() } as unknown as PDRuntimeAdapter;
  const artifactStore = { read: vi.fn(), readJson: vi.fn(), write: vi.fn() } as unknown as PIArtifactStore;

  return { stateManager, runtimeAdapter, eventEmitter, artifactStore };
}

describe('P0-2: 失败详情可观测性', () => {
  let runner: TestRunner;
  let deps: PeerRunnerDeps;

  beforeEach(() => {
    deps = makeDeps();
    runner = new TestRunner(deps);
  });

  describe('persistOutputFailureDetails via handleValidationError', () => {
    it('validator errors 被持久化到 diagnosticJson', async () => {
      const task: TaskRecord = {
        taskId: 'task-001',
        taskKind: 'dreamer',
        status: 'leased',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        attemptCount: 1,
        maxAttempts: 3,
        // 预存键必须在合并写入中幸存（评审 P1：第二次写曾以旧快照整体覆盖）
        diagnosticJson: '{"pi_metadata":{"channel":"prompt"}}',
      };

      await runner.testHandleValidationError({
        taskId: 'task-001',
        task,
        errors: ['not an object', 'missing field: thesis'],
        errorCategory: 'output_invalid',
      });

      // markTaskFailed 被调用（retryOrFail 路径）
      expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith('task-001', 'output_invalid', expect.stringContaining('Validation failed:'));

      // updateTask 恰好一次：output_failure_details（PRI-559 可观测性）与
      // lastValidatorErrors（PRI-700-B 修复回喂）在同一次合并写入中落库
      expect(deps.stateManager.updateTask).toHaveBeenCalledTimes(1);
      const {calls} = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
      const lastCall = calls[calls.length - 1];
      if (lastCall === undefined) throw new Error('expected updateTask to have been called');
      const [patchTaskId, patch] = lastCall;
      expect(patchTaskId).toBe('task-001');
      expect(patch.diagnosticJson).toBeDefined();
      const parsed = JSON.parse(patch.diagnosticJson as string);
      expect(parsed.output_failure_details).toBeDefined();
      expect(parsed.output_failure_details.validatorErrors).toEqual(['not an object', 'missing field: thesis']);
      expect(parsed.output_failure_details.errorCategory).toBe('output_invalid');
      expect(parsed.output_failure_details.errorCount).toBe(2);
      expect(parsed.output_failure_details.recordedAt).toBeDefined();
      // PRI-700-B 回喂契约：attempt 级来源标识 + 当次错误全文
      expect(parsed.lastValidatorErrors).toBeDefined();
      expect(parsed.lastValidatorErrors.errors).toEqual(['not an object', 'missing field: thesis']);
      expect(parsed.lastValidatorErrors.errorCategory).toBe('output_invalid');
      expect(parsed.lastValidatorErrors.sourceAttemptCount).toBe(1);
      expect(parsed.lastValidatorErrors.recordedAt).toBeDefined();
      // 合而非替换：预存 pi_metadata 键幸存
      expect(parsed.pi_metadata).toEqual({ channel: 'prompt' });
    });
  });

  describe('handlePostLeaseError with evidencePack', () => {
    it('PDRuntimeError 带 details 时持久化 evidencePack', async () => {
      const task: TaskRecord = {
        taskId: 'task-002',
        taskKind: 'dreamer',
        status: 'leased',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        attemptCount: 1,
        maxAttempts: 3,
        diagnosticJson: '{"pi_metadata":{}}',
      };

      const evidencePack = {
        schemaRef: 'philosopher-output-v1',
        provider: 'llamacpp',
        model: 'qwen3.8-27b',
        validationErrors: [{ path: '/thesis', message: 'expected string but got undefined', value: undefined }],
        repairAttempts: [],
        finalFailureReason: 'repair_exhausted',
      };

      const error = new PDRuntimeError('output_invalid', 'LLM output does not match schema', { evidencePack });

      await runner.testHandlePostLeaseError('task-002', task, error);

      // updateTask 被调用，持久化 evidencePack 到 output_failure_details
      expect(deps.stateManager.updateTask).toHaveBeenCalledTimes(1);
      const {calls} = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
      const lastCall = calls[calls.length - 1];
      if (lastCall === undefined) throw new Error('expected updateTask to have been called');
      const [patchTaskId, patch] = lastCall;
      expect(patchTaskId).toBe('task-002');
      expect(patch.diagnosticJson).toBeDefined();
      const parsed = JSON.parse(patch.diagnosticJson as string);
      expect(parsed.output_failure_details).toBeDefined();

      // 原有 pi_metadata 被保留（不破坏）
      expect(parsed.pi_metadata).toEqual({});

      // evidencePack 内容被持久化
      expect(parsed.output_failure_details.evidencePack).toBeDefined();
      expect(parsed.output_failure_details.evidencePack.schemaRef).toBe('philosopher-output-v1');
      expect(parsed.output_failure_details.evidencePack.validationErrors).toHaveLength(1);
      expect(parsed.output_failure_details.evidencePack.finalFailureReason).toBe('repair_exhausted');
      expect(parsed.output_failure_details.recordedAt).toBeDefined();
    });

    it('D-01: repair-skip evidence is persisted where an operator reads it', async () => {
      // The adapter puts `repairSkipped` / `repairSkipReason` in the failure
      // details; this test pins the RUNNER's persisted copy, not just the
      // in-memory error object. Without it, "operator can distinguish skipped
      // from exhausted" would be true only inside the adapter.
      const task: TaskRecord = {
        taskId: 'task-skip',
        taskKind: 'diag_rootcause',
        status: 'leased',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        attemptCount: 1,
        maxAttempts: 3,
        diagnosticJson: '{"pi_metadata":{},"sourcePainId":"pain_host_d01"}',
      };

      const evidencePack = {
        schemaRef: 'diag-rootcause-output-v1',
        provider: 'zai',
        model: 'glm-5.3-flash',
        validationErrors: [
          { path: '/intentTension/source', message: 'Expected required property', value: undefined },
          { path: '/intentTension/description', message: 'Unexpected property', value: 'Agent ...' },
        ],
        repairAttempts: [],
        finalFailureReason: 'repair_skipped',
        repairSkipped: true,
        repairSkipReason: 'request_budget_exhausted',
        repairAttemptsConfigured: 3,
        repairAttemptsSkippedByRequestBudget: 3,
      };

      const error = new PDRuntimeError('output_invalid', 'LLM output does not match schema', { evidencePack });

      await runner.testHandlePostLeaseError('task-skip', task, error);

      expect(deps.stateManager.updateTask).toHaveBeenCalledTimes(1);
      const { calls } = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
      const lastCall = calls[calls.length - 1];
      if (lastCall === undefined) throw new Error('expected updateTask to have been called');
      const parsed = JSON.parse(lastCall[1].diagnosticJson as string);

      expect(parsed.output_failure_details.evidencePack).toMatchObject({
        finalFailureReason: 'repair_skipped',
        repairSkipped: true,
        repairSkipReason: 'request_budget_exhausted',
        repairAttemptsConfigured: 3,
        repairAttemptsSkippedByRequestBudget: 3,
      });
      // The concrete field paths survive too — that is what makes the record
      // actionable, not just labelled.
      expect(parsed.output_failure_details.evidencePack.validationErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/intentTension/source', message: 'Expected required property' }),
        ]),
      );
    });

    it('PRI-707: 适配器截断证据（truncated/stopReason/outputTokens）经 classifyError 持久化到 diagnosticJson', async () => {
      const task: TaskRecord = {
        taskId: 'task-707',
        taskKind: 'dreamer',
        status: 'leased',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        attemptCount: 1,
        maxAttempts: 3,
        diagnosticJson: '{"pi_metadata":{}}',
      };

      // Shape the adapter (pi-ai-runtime-adapter) throws on a token-limit cut:
      // finish metadata travels in err.details, no evidencePack wrapper.
      const error = new PDRuntimeError(
        'output_invalid',
        '[output_invalid] LLM response truncated (finish_reason=length); no valid JSON could be extracted',
        {
          truncated: true,
          stopReason: 'length',
          outputTokens: 64,
          rawOutputPreview: '{"diagnosisId":"diag-trunc',
          nextAction: 'The output hit the token limit...',
        },
      );

      await runner.testHandlePostLeaseError('task-707', task, error);

      expect(deps.stateManager.updateTask).toHaveBeenCalledTimes(1);
      const { calls } = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
      const lastCall = calls[calls.length - 1];
      if (lastCall === undefined) throw new Error('expected updateTask to have been called');
      const [, patch] = lastCall;
      const parsed = JSON.parse(patch.diagnosticJson as string);

      // Original pi_metadata preserved + truncation evidence durable.
      expect(parsed.pi_metadata).toEqual({});
      expect(parsed.output_failure_details).toBeDefined();
      expect(parsed.output_failure_details.truncated).toBe(true);
      expect(parsed.output_failure_details.stopReason).toBe('length');
      expect(parsed.output_failure_details.outputTokens).toBe(64);
      expect(parsed.output_failure_details.errorCategory).toBe('output_invalid');
    });
  });
});

// ── P1-3: failure classification matrix ─────────────────────────────────────
//
// The eight spec scenarios, each asserted at the runner's real retry/terminal
// decision seam:
//   1. 正常真实纠正      → valid output, no failure state (validateOutput seam)
//   2. 模型超时          → timeout is transient → retry_wait
//   3. 非法 JSON          → output_invalid is transient → retry_wait
//   4. schema 校验失败    → output_invalid is transient → retry_wait
//   5. provider 暂时不可用 → rate_limit is transient → retry_wait
//   6. 重复投递          → lease_conflict is non-mutating (no retry, no fail write)
//   7. 超过最大尝试      → classified cause survives; terminal reason recorded
//   8. 依赖不满足        → capability_missing is permanent → fail immediately
describe('P1-3: 失败分类与终态判定矩阵', () => {
  const taskAt = (attemptCount: number, maxAttempts = 3): TaskRecord => ({
    taskId: 'task-matrix',
    taskKind: 'dreamer',
    status: 'leased',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    attemptCount,
    maxAttempts,
  });

  async function runMatrixCase(opts: {
    readonly errorCategory: PDErrorCategory;
    readonly attemptCount: number;
    readonly shouldRetry: boolean;
    readonly permanent?: ReadonlySet<PDErrorCategory>;
  }): Promise<{ runner: TestRunner; deps: PeerRunnerDeps; result: PeerRunnerResult<TestOutput> }> {
    const deps = makeDeps();
    (deps.stateManager.getRetryPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      shouldRetry: () => opts.shouldRetry,
      calculateBackoff: () => 1000,
    });
    const runner = new TestRunner(deps, opts.permanent ?? new Set(['storage_unavailable', 'capability_missing']));
    const result = await runner.testRetryOrFail({
      taskId: 'task-matrix',
      task: taskAt(opts.attemptCount),
      errorCategory: opts.errorCategory,
      failureReason: `classified: ${opts.errorCategory}`,
    });
    return { runner, deps, result };
  }

  it('1. 正常真实纠正：合法输出不进入失败状态', async () => {
    const deps = makeDeps();
    const runner = new TestRunner(deps);
    expect(await runner.validateOutput({ taskId: 't', data: 'ok' })).toEqual({ valid: true, errors: [] });
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it.each([
    ['2. 模型超时', 'timeout'],
    ['3. 非法 JSON', 'output_invalid'],
    ['4. schema 校验失败', 'output_invalid'],
    ['5. provider 暂时不可用', 'rate_limit'],
  ] as const)('%s：可重试错误 → retry_wait，不提前宣告失败', async (_name, category) => {
    const { deps, result } = await runMatrixCase({ errorCategory: category, attemptCount: 1, shouldRetry: true });
    expect(result.status).toBe('retried');
    expect(result.errorCategory).toBe(category);
    expect(deps.stateManager.markTaskRetryWait).toHaveBeenCalledWith('task-matrix', category, expect.any(String));
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
  });

  it('6. 重复投递：lease_conflict 不产生任何状态变更', async () => {
    const deps = makeDeps();
    (deps.stateManager as unknown as { acquireLease: ReturnType<typeof vi.fn> }).acquireLease = vi.fn().mockRejectedValue(
      new PDRuntimeError('lease_conflict', 'Task task-matrix is leased'),
    );
    const runner = new TestRunner(deps);
    const result = await runner.run('task-matrix');
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('lease_conflict');
    expect(deps.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('7. 超过最大尝试：保留真实分类错误，终态原因作为补充信息', async () => {
    const { deps, result } = await runMatrixCase({ errorCategory: 'output_invalid', attemptCount: 3, shouldRetry: false });
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.terminalReason).toBe('max_attempts_exceeded');
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      'task-matrix',
      'output_invalid',
      'Max attempts exceeded: classified: output_invalid',
    );

    const { calls } = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
    const parsed = JSON.parse(calls[calls.length - 1]?.[1].diagnosticJson as string);
    expect(parsed.terminal_failure).toMatchObject({
      reason: 'max_attempts_exceeded',
      errorCategory: 'output_invalid',
      attemptCount: 3,
      maxAttempts: 3,
      // D-01 / rc-9: an exhausted pain must stay recoverable and say so.
      painInternalized: false,
      retryable: true,
      // D-01 review: the command must be runnable — explicit workspace and
      // `--force`, because this branch is exactly "max attempts exhausted".
      nextAction: 'pd runtime recovery failed-tasks --workspace "C:/ws/d01" --confirm --force',
    });
  });

  it('7b. D-01: a pain-bound task that exhausts attempts keeps a retry pointer (not a silent drop)', async () => {
    const deps = makeDeps();
    (deps.stateManager.getRetryPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      shouldRetry: () => false,
      calculateBackoff: () => 1000,
    });
    const runner = new TestRunner(deps, new Set(['storage_unavailable', 'capability_missing']));
    const painId = 'pain_host_ebd93fb1254b625d5a1736fd10ab451999a10c7cfc16af58a1ac6428cd00c353';
    const task: TaskRecord = {
      ...taskAt(3),
      taskKind: 'diag_rootcause',
      diagnosticJson: JSON.stringify({ sourcePainId: painId }),
    };

    const result = await runner.testRetryOrFail({
      taskId: 'task-matrix',
      task,
      errorCategory: 'output_invalid',
      failureReason: 'classified: output_invalid',
    });

    expect(result.status).toBe('failed');
    const { calls } = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
    const parsed = JSON.parse(calls[calls.length - 1]?.[1].diagnosticJson as string);
    expect(parsed.terminal_failure).toMatchObject({
      painInternalized: false,
      retryable: true,
      sourcePainId: painId,
      nextAction: `pd pain retry --pain-id ${painId} --workspace "C:/ws/d01"`,
      nextActionRequires: [
        'the workspace above still contains .pd/state.db',
        'a runtime binding exists: pass --runtime <kind> --provider <p> --model <m> --apiKeyEnv <ENV> unless .pd/config.yaml already binds one',
      ],
    });
  });

  it('8. 依赖不满足：permanent 错误立即失败且不重试', async () => {
    const { deps, result } = await runMatrixCase({ errorCategory: 'capability_missing', attemptCount: 1, shouldRetry: true });
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('capability_missing');
    expect(result.terminalReason).toBeUndefined();
    expect(deps.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
    expect(deps.stateManager.markTaskFailed).toHaveBeenCalledWith('task-matrix', 'capability_missing', expect.any(String));
  });
});

describe('P1-3: 每次尝试的 validator 错误结构化保留', () => {
  it('validator_error_history 逐次追加，不覆盖先前尝试', async () => {
    const deps = makeDeps();
    const runner = new TestRunner(deps);
    const firstTask = {
      taskId: 'task-history',
      taskKind: 'dreamer',
      status: 'leased',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: '{"pi_metadata":{"channel":"prompt"}}',
    } satisfies TaskRecord;

    await runner.testHandleValidationError({
      taskId: 'task-history',
      task: firstTask,
      errors: ['attempt-1 error'],
      errorCategory: 'output_invalid',
    });

    const [firstCall] = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls;
    const afterFirst = JSON.parse(firstCall?.[1].diagnosticJson as string);
    expect(afterFirst.validator_error_history).toHaveLength(1);
    expect(afterFirst.validator_error_history[0]).toMatchObject({ attempt: 1, errors: ['attempt-1 error'] });

    // Attempt 2 starts from the persisted diagnosticJson of attempt 1.
    await runner.testHandleValidationError({
      taskId: 'task-history',
      task: { ...firstTask, attemptCount: 2, diagnosticJson: JSON.stringify(afterFirst) },
      errors: ['attempt-2 error'],
      errorCategory: 'output_invalid',
    });

    const { calls } = (deps.stateManager.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock;
    const afterSecond = JSON.parse(calls[calls.length - 1]?.[1].diagnosticJson as string);
    expect(afterSecond.validator_error_history).toHaveLength(2);
    expect(afterSecond.validator_error_history.map((entry: { attempt: number }) => entry.attempt)).toEqual([1, 2]);
    expect(afterSecond.validator_error_history[1].errors).toEqual(['attempt-2 error']);
    // The prior attempt's record survives the second merged write.
    expect(afterSecond.validator_error_history[0].errors).toEqual(['attempt-1 error']);
    // Untouched keys survive too.
    expect(afterSecond.pi_metadata).toEqual({ channel: 'prompt' });
  });
});