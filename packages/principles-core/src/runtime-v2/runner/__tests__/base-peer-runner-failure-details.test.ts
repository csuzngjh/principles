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
  constructor(deps: PeerRunnerDeps) {
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
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['output_invalid', 'input_invalid', 'storage_unavailable']);
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
}

function makeDeps(): PeerRunnerDeps {
  const stateManager = {
    updateTask: vi.fn(),
    markTaskFailed: vi.fn().mockResolvedValue({ taskId: 't', status: 'failed' }),
    markTaskRetryWait: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    getTaskHistory: vi.fn(),
    invalidateTask: vi.fn(),
    assertInitialized: vi.fn(),
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