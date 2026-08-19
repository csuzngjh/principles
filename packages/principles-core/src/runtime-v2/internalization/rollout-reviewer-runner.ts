import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1, RolloutReviewerValidator } from './rollout-reviewer-output.js';
import type { PIArtifactStore, PIArtifactRecord } from './pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, type PITaskMetadata } from './pitask-metadata.js';
import { RunnerPhase } from '../runner/runner-phase.js';
import { RolloutReviewerPromptBuilder } from './rollout-reviewer-prompt-builder.js';
import { reconcileLineageEcho } from './peer-runner-contracts.js';

export type RolloutReviewerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface RolloutReviewerRunnerResult {
  readonly status: RolloutReviewerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: RolloutReviewerOutputV1;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

export interface RolloutReviewerRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedRolloutReviewerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS: Readonly<Omit<ResolvedRolloutReviewerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'rollout_reviewer',
} as const;

export function resolveRolloutReviewerRunnerOptions(options: RolloutReviewerRunnerOptions): ResolvedRolloutReviewerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS.agentId,
  };
}

export interface RolloutReviewerRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: RolloutReviewerValidator;
  readonly artifactStore: PIArtifactStore;
  /**
   * P0-F (INV-06): approve_rollout → 自动 activation policy dispatch。
   * 核心 runner 保持纯编排 (架构边界,同 PRI-509 seeder 模式); 由 host
   * (auto-consumer / run-once) 注入真实的 ActivationDispatcher 调用。
   * 未注入 → 显式 degraded 事件 (rc-9), 不静默跳过。
   */
  readonly dispatchActivation?: (input: RolloutAutoDispatchInput) => Promise<RolloutAutoDispatchOutcome>;
  /**
   * P0-E (INV-04): needs_revision → reopen 最近可修复 stage (scribe/artificer)。
   * 未注入 → needs_human_review (Owner 注意队列, 不入 approval)。
   */
  readonly reopenRevisionTarget?: (input: RolloutRevisionRoutingInput) => Promise<{ ok: boolean; reason: string; reopenedTaskId?: string }>;
}

/** approve_rollout 自动 dispatch 的输入 (host 负责接线 ActivationDispatcher) */
export interface RolloutAutoDispatchInput {
  /** 被评审且已 validated 的 principle/rule artifact (dispatch 目标) */
  readonly artifactId: string;
  readonly channel: string;
  readonly confidence?: number;
  readonly rolloutTaskId: string;
}

export interface RolloutAutoDispatchOutcome {
  readonly decision: string;
  readonly activationId?: string;
  readonly reason?: string;
}

/** needs_revision 修订路由输入 (host 层经 orchestrator 的 revision-reopen 能力实现,注入式) */
export interface RolloutRevisionRoutingInput {
  readonly targetTaskId: string;
  readonly targetKind: 'scribe' | 'artificer';
  readonly revisionFeedback: string;
  readonly revisionIteration: number;
  readonly sourceRolloutTaskId: string;
  readonly sourceArtifactId: string;
}

interface FailureContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errorCategory: PDErrorCategory;
  readonly failureReason: string;
}

interface SucceedContext {
  readonly taskId: string;
  readonly runId: string;
  readonly output: RolloutReviewerOutputV1;
  readonly task: TaskRecord;
  readonly contextHash: string;
  /** 被评审的 evaluator artifact (dispatch 目标) — 由 buildContext 解析 */
  readonly sourceEvaluatorArtifactId?: string;
  /** 本 lineage 的 activation channel (路由修订目标 + dispatch 用) */
  readonly channel?: string;
}

interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

const ROLLOUT_REVIEWER_PERMANENT_ERROR_CATEGORIES: ReadonlySet<PDErrorCategory> = new Set<PDErrorCategory>([
  'storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid',
]);

export class RolloutReviewerRunner {
  private phase: RunnerPhase = RunnerPhase.Idle;
  private readonly resolvedOptions: ResolvedRolloutReviewerRunnerOptions;
  private readonly stateManager: RuntimeStateManager;
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly validator: RolloutReviewerValidator;
  private readonly artifactStore: PIArtifactStore;

  private readonly dispatchActivation?: RolloutReviewerRunnerDeps['dispatchActivation'];
  private readonly reopenRevisionTarget?: RolloutReviewerRunnerDeps['reopenRevisionTarget'];

  constructor(deps: RolloutReviewerRunnerDeps, options: RolloutReviewerRunnerOptions) {
    this.stateManager = deps.stateManager;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.validator = deps.validator;
    this.artifactStore = deps.artifactStore;
    this.dispatchActivation = deps.dispatchActivation;
    this.reopenRevisionTarget = deps.reopenRevisionTarget;
    this.resolvedOptions = resolveRolloutReviewerRunnerOptions(options);
  }

  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  private emitRolloutReviewerEvent(
    eventType: string,
    taskId: string,
    payload: Record<string, unknown>,
  ): void {
    this.eventEmitter.emitTelemetry({
      eventType: eventType as TelemetryEvent['eventType'],
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: this.resolvedOptions.owner,
      agentId: this.resolvedOptions.agentId,
      payload,
    });
  }

  async run(taskId: string): Promise<RolloutReviewerRunnerResult> {
    this.phase = RunnerPhase.Idle;

    let leasedTask: TaskRecord;
    try {
      leasedTask = await this.stateManager.acquireLease({
        taskId,
        owner: this.resolvedOptions.owner,
        runtimeKind: this.resolvedOptions.runtimeKind,
      });
    } catch (error) {
      return await this.handleLeaseOrPhaseError(taskId, error);
    }

    if (leasedTask.taskKind !== 'rollout_reviewer') {
      this.emitRolloutReviewerEvent('rollout_reviewer_wrong_task_kind', taskId, {
        expectedKind: 'rollout_reviewer',
        actualKind: leasedTask.taskKind,
      });
      return this.retryOrFail({
        taskId,
        task: leasedTask,
        errorCategory: 'input_invalid',
        failureReason: `Task kind must be 'rollout_reviewer', got '${leasedTask.taskKind}'`,
      });
    }

    this.emitRolloutReviewerEvent('rollout_reviewer_task_leased', taskId, {
      taskKind: 'rollout_reviewer',
      attemptCount: leasedTask.attemptCount,
    });

    try {
      const storeRunId = await this.resolveStoreRunId(taskId);

      this.phase = RunnerPhase.BuildingContext;
      const { contextHash, evaluatorArtifact, sourceEvaluatorArtifactId } = await this.buildContext(taskId);

      if (!evaluatorArtifact || !sourceEvaluatorArtifactId) {
        return this.retryOrFail({
          taskId,
          task: leasedTask,
          errorCategory: 'input_invalid',
          failureReason: sourceEvaluatorArtifactId ? 'Evaluator dependency artifact not found' : 'Evaluator dependency artifact ID not resolved',
        });
      }

      this.emitRolloutReviewerEvent('rollout_reviewer_context_built', taskId, { contextHash });

      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime({ taskId, contextHash, evaluatorArtifact, sourceEvaluatorArtifactId });

      this.emitRolloutReviewerEvent('rollout_reviewer_run_started', taskId, {
        runtimeKind: this.resolvedOptions.runtimeKind,
      });

      this.phase = RunnerPhase.Polling;
      const finalStatus = await this.pollUntilTerminal(runHandle);

      if (finalStatus.status !== 'succeeded') {
        return await this.handleRuntimeFailure(taskId, leasedTask, finalStatus);
      }

      this.phase = RunnerPhase.FetchingOutput;
      const output = await this.fetchAndParseOutput(runHandle.runId);

      // Lineage echo reconciliation (PRI-272 / ERR-004 / ERR-008 class):
      // taskId and sourceEvaluatorArtifactId are runner-owned lineage
      // metadata whose authoritative sources are the task record and the
      // artifact store read in buildContext(). LLMs routinely truncate or
      // alter long IDs when echoing them back, and a mismatch fails
      // validation as output_invalid — a permanent error with no retry —
      // dead-ending the candidate before it can reach the approval queue.
      // Overwrite the echoed lineage with the authoritative values before
      // validation; emit telemetry whenever an echo differed so the
      // correction rate stays observable (rc-9-no-silent-fallback).
      this.reconcileLineageEcho(taskId, output, sourceEvaluatorArtifactId);

      this.phase = RunnerPhase.Validating;
      const validationResult = await this.validator.validate(output, taskId, sourceEvaluatorArtifactId ?? undefined);
      if (!validationResult.valid) {
        return await this.handleValidationError({
          taskId,
          task: leasedTask,
          errors: validationResult.errors,
          errorCategory: validationResult.errorCategory,
        });
      }

      this.emitRolloutReviewerEvent('rollout_reviewer_output_validated', taskId, {
        reviewDecision: output.review.decision,
        reviewConfidence: output.review.confidence,
      });

      return await this.succeedTask({
        taskId,
        runId: storeRunId,
        output,
        task: leasedTask,
        contextHash,
        sourceEvaluatorArtifactId,
        channel: hydratePITaskRecord(leasedTask)?.channel,
      });
    } catch (error) {
      return await this.handlePostLeaseError(taskId, leasedTask, error);
    }
  }

  /**
   * Reconcile LLM-echoed lineage fields with the runner-owned authoritative
   * values via the shared lineage echo gate (PRI-541, see
   * peer-runner-contracts.ts). Thin wrapper: this runner does not extend
   * BasePeerRunner, so it calls the shared helper directly and emits its own
   * telemetry (no automatic runnerName prefix).
   *
   * The prompt asks the model to copy taskId / sourceEvaluatorArtifactId /
   * sourceTrace.evaluatorArtifactId verbatim, but long artifact IDs are
   * routinely truncated or altered on echo. Because a mismatch is classified
   * output_invalid (a permanent error — no retry), a bad echo permanently
   * blocks the candidate from reaching the approval queue. Lineage is
   * runner-owned metadata (rc-6): the authoritative values come from the
   * task record and the artifact store read in buildContext().
   *
   * Whenever an echo differed (or sourceTrace was missing), a
   * rollout_reviewer_lineage_echo_corrected telemetry event is emitted so
   * the correction rate stays observable (rc-9-no-silent-fallback).
   */
  private reconcileLineageEcho(taskId: string, output: RolloutReviewerOutputV1, authoritativeEvaluatorArtifactId: string): void {
    const correctedFields = reconcileLineageEcho(output, {
      topFields: [
        { field: 'taskId', authoritativeValue: taskId },
        { field: 'sourceEvaluatorArtifactId', authoritativeValue: authoritativeEvaluatorArtifactId },
      ],
      trace: {
        traceField: 'sourceTrace',
        fields: [{ field: 'evaluatorArtifactId', authoritativeValue: authoritativeEvaluatorArtifactId }],
      },
    });

    if (correctedFields.length > 0) {
      this.emitRolloutReviewerEvent('rollout_reviewer_lineage_echo_corrected', taskId, {
        correctedFields,
        authoritativeSourceEvaluatorArtifactId: authoritativeEvaluatorArtifactId,
      });
    }
  }

  private async buildContext(taskId: string): Promise<{ contextHash: string; evaluatorArtifact: string | null; sourceEvaluatorArtifactId: string | null }> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      this.emitRolloutReviewerEvent('rollout_reviewer_no_dependencies', taskId, {});
      return { contextHash: 'empty', evaluatorArtifact: null, sourceEvaluatorArtifactId: null };
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'evaluator') continue;
      if (depTask.status !== 'succeeded') {
        this.emitRolloutReviewerEvent('rollout_reviewer_dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = firstArtifact.artifactId;
        this.emitRolloutReviewerEvent('rollout_reviewer_evaluator_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });
        return {
          contextHash: RolloutReviewerRunner.hashContextRefs([artifactRef]),
          evaluatorArtifact: firstArtifact.contentJson,
          sourceEvaluatorArtifactId: firstArtifact.artifactId,
        };
      }
    }

    this.emitRolloutReviewerEvent('rollout_reviewer_no_evaluator_artifact', taskId, {});
    return { contextHash: 'empty', evaluatorArtifact: null, sourceEvaluatorArtifactId: null };
  }

  private static hashContextRefs(refs: readonly string[]): string {
    if (refs.length === 0) return 'empty';
    const str = refs.join('|');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
    }
    return `ctx-${Math.abs(hash).toString(16)}`;
  }

  private async resolveStoreRunId(taskId: string): Promise<string> {
    const runs = await this.stateManager.getRunsByTask(taskId);
    const latestRun = runs[runs.length - 1];
    if (!latestRun) {
      throw new PDRuntimeError('execution_failed', `No run records found for task ${taskId} after lease acquisition`);
    }
    return latestRun.runId;
  }

  private async invokeRuntime(params: {
    taskId: string;
    contextHash: string;
    evaluatorArtifact: string | null;
    sourceEvaluatorArtifactId: string;
  }): Promise<RunHandle> {
    let parsedEvaluatorArtifact: unknown = null;
    if (params.evaluatorArtifact) {
      try {
        parsedEvaluatorArtifact = JSON.parse(params.evaluatorArtifact);
      } catch {
        parsedEvaluatorArtifact = params.evaluatorArtifact;
      }
    }

    const builder = new RolloutReviewerPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId: params.taskId,
      contextHash: params.contextHash,
      evaluatorArtifact: parsedEvaluatorArtifact,
      sourceEvaluatorArtifactId: params.sourceEvaluatorArtifactId,
    });

    const startInput: StartRunInput = {
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: params.taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'rollout-reviewer-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    };

    return this.runtimeAdapter.startRun(startInput);
  }

  private async pollUntilTerminal(runHandle: RunHandle): Promise<RunStatus> {
    const deadline = Date.now() + this.resolvedOptions.timeoutMs;
    const terminalStatuses: readonly string[] = ['succeeded', 'failed', 'timed_out', 'cancelled'];

    while (Date.now() < deadline) {
      const status = await this.runtimeAdapter.pollRun(runHandle.runId);
      if (terminalStatuses.includes(status.status)) {
        return status;
      }
      await this.sleep(this.resolvedOptions.pollIntervalMs);
    }

    try {
      const finalPoll = await this.runtimeAdapter.pollRun(runHandle.runId);
      if (terminalStatuses.includes(finalPoll.status)) {
        return finalPoll;
      }
    } catch { /* fall through to cancel/timeout */ }

    let cancelFailed = false;
    try {
      await this.runtimeAdapter.cancelRun(runHandle.runId);
    } catch (cancelErr) {
      cancelFailed = true;
      this.emitRolloutReviewerEvent('rollout_reviewer_cancel_run_failed', runHandle.runId, {
        runId: runHandle.runId,
        errorMessage: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
    const cancelNote = cancelFailed ? ' (cancelRun also failed)' : '';
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms${cancelNote}`);
  }

  private async fetchAndParseOutput(runId: string): Promise<RolloutReviewerOutputV1> {
    const result = await this.runtimeAdapter.fetchOutput(runId);
    if (!result || !result.payload) {
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }
    const payload = result.payload as Record<string, unknown>;
    if (typeof payload !== 'object' || payload === null) {
      throw new PDRuntimeError('output_invalid', `Output payload is not an object for run ${runId}`);
    }
    if (typeof payload.review !== 'object' || payload.review === null) {
      throw new PDRuntimeError('output_invalid', `Output payload missing review object for run ${runId}`);
    }
    return result.payload as RolloutReviewerOutputV1;
  }

  private async succeedTask(ctx: SucceedContext): Promise<RolloutReviewerRunnerResult> {
    try {
      await this.stateManager.updateRunOutput(ctx.runId, JSON.stringify(ctx.output));
    } catch (updateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_update_output_failed', ctx.taskId, {
        runId: ctx.runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    const artifactId = `pi-art-${ctx.taskId}-${ctx.runId}`;
    const now = new Date().toISOString();

    let lineageArtifactIds: string[] = [];
    try {
      const piTask = hydratePITaskRecord(ctx.task);
      const deps = piTask?.dependencyTaskIds ?? [];
      const results = await Promise.allSettled(
        deps.map((depId) => this.artifactStore.listBySourceTaskId(depId)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const artifact of result.value) {
            lineageArtifactIds.push(artifact.artifactId);
          }
        }
      }
    } catch { /* lineage resolution failure is non-fatal */ }

    try {
      await this.artifactStore.upsertArtifact({
        artifactId,
        artifactKind: 'principle',
        sourceTaskId: ctx.taskId,
        lineageArtifactIds,
        validationStatus: 'pending',
        contentJson: JSON.stringify(ctx.output),
        createdAt: now,
        updatedAt: now,
      });
    } catch (artifactErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_artifact_write_failed', ctx.taskId, {
        runId: ctx.runId,
        errorMessage: artifactErr instanceof Error ? artifactErr.message : String(artifactErr),
      });
      return this.retryOrFail({
        taskId: ctx.taskId,
        task: ctx.task,
        errorCategory: 'artifact_commit_failed',
        failureReason: `PIArtifact write failed: ${artifactErr instanceof Error ? artifactErr.message : String(artifactErr)}`,
      });
    }

    const resultRef = `rollout-reviewer://${ctx.runId}`;

    // ── P0-3 (外部复核): verdict durability 是终态的前置条件 ──
    // decision 写失败必须 fail (retry_wait 重试),不得吞掉后把任务标 succeeded
    // ——否则 commit 门读到 missing decision,链路语义不可判定。
    await this.recordRunnerDecisionOrThrow(ctx.taskId, ctx.output.review.decision);

    // ── P0-2 (外部复核): dispatch 是 governance transition 的组成部分 ──
    // 在 markTaskSucceeded 之前执行:
    //   - transient 失败 (throw) → 冒泡到 run() 的 retryOrFail → retry_wait 自动重试
    //     (dispatcher 幂等 key 保证重放安全; crash-after-dispatch 重跑 → already_activated)
    //   - refused / invalid / candidate 不可解析 → needs_human_review (不得伪装 succeeded)
    //   - 只有 activated / already_activated / queued_for_approval 视为 transition 完成
    const { decision } = ctx.output.review;
    let dispatchArtifactId: string | null = null;
    if (decision === 'approve_rollout') {
      const candidate = await this.resolveActivationCandidate(ctx);
      if (!candidate) {
        await this.markNeedsHumanReview(ctx.taskId, 'rollout_activation_candidate_unresolved');
        this.phase = RunnerPhase.Completed;
        return this.buildSucceededResult(ctx, artifactId, resultRef);
      }
      dispatchArtifactId = candidate;
      const completed = await this.dispatchOrRouteFailure(ctx, candidate);
      if (!completed) {
        // dispatchOrRouteFailure 已把任务转入 needs_human_review;
        // runner 本身执行成功 (verdict 有效),返回 succeeded 描述本次运行
        this.phase = RunnerPhase.Completed;
        return this.buildSucceededResult(ctx, artifactId, resultRef);
      }
    } else if (decision === 'needs_revision') {
      await this.handleRevisionRouting(ctx);
    }
    // 'reject' → terminal: 无 dispatch、无 approval、无后继 (INV-04)

    try {
      await this.stateManager.markTaskSucceeded(ctx.taskId, resultRef);
    } catch (stateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_mark_succeeded_failed', ctx.taskId, {
        taskId: ctx.taskId,
        runId: ctx.runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitRolloutReviewerEvent('rollout_reviewer_task_succeeded', ctx.taskId, {
      attemptCount: ctx.task.attemptCount,
      resultRef,
      reviewDecision: ctx.output.review.decision,
      reviewConfidence: ctx.output.review.confidence,
      ...(dispatchArtifactId ? { dispatchedArtifactId: dispatchArtifactId } : {}),
    });

    this.phase = RunnerPhase.Completed;
    return this.buildSucceededResult(ctx, artifactId, resultRef);
  }

  private buildSucceededResult(
    ctx: SucceedContext,
    artifactId: string,
    resultRef: string,
  ): RolloutReviewerRunnerResult {
    return {
      status: 'succeeded',
      taskId: ctx.taskId,
      runId: ctx.runId,
      artifactId,
      resultRef,
      contextHash: ctx.contextHash,
      output: ctx.output,
      attemptCount: ctx.task.attemptCount,
    };
  }

  /**
   * P0-1 (外部复核): 解析 activation 候选 artifact — 与 review source 分离。
   *
   * 事实基线 (evaluator-runner 产物形状):
   *   - evaluator 任务名下存在 kind='principle' 但 **pending** 的 evaluation
   *     输出 artifact (pi-art-<evalTask>-<run>),其 contentJson 是 EvaluatorOutputV1,
   *     不含可激活的 principleId/text —— 不是合法 activation 目标。
   *   - prompt/defer_archive 渠道的合法目标 = **scribe** 的 validated principle
   *     artifact (evaluator approved 时被 updateValidationStatus 翻 validated)。
   *   - code_tool_hook 渠道的合法目标 = evaluator assemble 的 validated **rule**
   *     artifact (pi-rule-<evalTask>-<run>, V2 对抗通过)。
   *
   * 解析策略: 沿 dep 链 (rollout→evaluator→artificer→scribe) 收集各 source task
   * 的 artifacts,按 channel 期望的 kind+validated 过滤;恰好一个候选才接受;
   * 零候选或多个候选 (历史脏数据) 一律 unresolved → needs_human_review,
   * 禁止 firstArtifact/created_at 猜测。
   */
  private async resolveActivationCandidate(ctx: SucceedContext): Promise<string | null> {
    const channel = ctx.channel ?? 'prompt';
    const wantKind = channel === 'code_tool_hook' ? 'rule' : 'principle';

    const chainIds = await this.collectLineageSourceTaskIds(ctx.taskId, [ctx.taskId], 0, 5);
    const matches: string[] = [];
    for (const taskId of chainIds) {
      // P0-1 加固: prompt/defer 渠道排除决策型 runner 名下的 artifacts —
      // evaluator 名下的 principle 是评审输出(即使历史脏数据把它翻成
      // validated 也不是可激活的原则文本;合法 bearer 属于 scribe)。
      if (wantKind === 'principle') {
        const ownerTask = await this.stateManager.getTask(taskId);
        if (ownerTask?.taskKind === 'evaluator' || ownerTask?.taskKind === 'rollout_reviewer') {
          continue;
        }
      }
      let artifacts: PIArtifactRecord[] = [];
      try {
        artifacts = await this.artifactStore.listBySourceTaskId(taskId);
      } catch {
        continue;
      }
      for (const a of artifacts) {
        if (a.artifactKind === wantKind && a.validationStatus === 'validated') {
          matches.push(a.artifactId);
        }
      }
    }

    if (matches.length === 1) {
      const [candidateId] = matches;
      this.emitRolloutReviewerEvent('rollout_activation_candidate_resolved', ctx.taskId, {
        artifactId: candidateId ?? '',
        channel,
        kind: wantKind,
        searchedTaskIds: chainIds,
      });
      return candidateId ?? null;
    }
    this.emitRolloutReviewerEvent('rollout_activation_candidate_unresolved', ctx.taskId, {
      channel,
      kind: wantKind,
      matchCount: matches.length,
      matchedArtifactIds: matches,
      reason: matches.length === 0 ? 'no_validated_candidate_in_lineage' : 'ambiguous_validated_candidates',
      nextAction: 'inspect lineage artifacts; dispatch manually via pd activation dispatch after fixing',
    });
    return null;
  }

  /** 收集 lineage 上所有 source task id (BFS 沿 dependencyTaskIds, 有界深度)。 */
  private async collectLineageSourceTaskIds(
    rootTaskId: string,
    acc: string[],
    depth: number,
    maxDepth: number,
  ): Promise<string[]> {
    if (depth > maxDepth) return acc;
    const task = await this.stateManager.getTask(rootTaskId);
    if (!task) return acc;
    const piTask = hydratePITaskRecord(task);
    for (const depId of piTask?.dependencyTaskIds ?? []) {
      if (acc.includes(depId)) continue;
      acc.push(depId);
      await this.collectLineageSourceTaskIds(depId, acc, depth + 1, maxDepth);
    }
    return acc;
  }

  /**
   * P0-2 (外部复核): dispatch + 结果分类。
   * 返回 true = governance transition 完成 (activated / already_activated /
   * queued_for_approval);false = 已转入 needs_human_review。
   * transient 异常直接冒泡 (caller → retryOrFail → retry_wait 自动重试)。
   */
  private async dispatchOrRouteFailure(ctx: SucceedContext, candidateArtifactId: string): Promise<boolean> {
    if (!this.dispatchActivation) {
      this.emitRolloutReviewerEvent('rollout_dispatch_not_wired', ctx.taskId, {
        reason: 'dispatch_activation_dep_not_injected',
        nextAction: 'wire_activation_dispatcher_in_auto_consumer_or_run_once',
      });
      await this.markNeedsHumanReview(ctx.taskId, 'rollout_dispatch_not_wired');
      return false;
    }
    // throw 在此冒泡: transient (db locked / network) → retry_wait,由消费循环重试
    const outcome = await this.dispatchActivation({
      artifactId: candidateArtifactId,
      channel: ctx.channel ?? 'prompt',
      confidence: ctx.output.review.confidence,
      rolloutTaskId: ctx.taskId,
    });

    const completed = outcome.decision === 'activated'
      || outcome.decision === 'already_activated'
      || outcome.decision === 'queued_for_approval';
    this.emitRolloutReviewerEvent(
      completed ? 'rollout_activation_dispatched' : 'rollout_activation_dispatch_refused',
      ctx.taskId,
      {
        artifactId: candidateArtifactId,
        channel: ctx.channel ?? 'prompt',
        decision: outcome.decision,
        activationId: outcome.activationId ?? null,
        reason: outcome.reason ?? null,
        nextAction: completed ? null : 'owner_inspect_artifact_then_manual_dispatch_or_archive',
      },
    );
    if (!completed) {
      await this.markNeedsHumanReview(ctx.taskId, `rollout_dispatch_${outcome.decision}`);
      return false;
    }
    return true;
  }

  /** P0-3: verdict 持久化失败 → fail loud (retry),绝不静默继续。 */
  private async recordRunnerDecisionOrThrow(taskId: string, decision: string): Promise<void> {
    await this.recordRunnerDecision(taskId, decision);
  }

  /**
   * P0-E: needs_revision → reopen 最近可修复 stage (INV-04, 禁止入 approval)。
   * 路由: code_tool_hook → artificer (规则实现); 其他 channel → scribe (原则措辞)。
   * Budget: rolloutRevisionPayload.revisionIteration, 上限 2; 耗尽或路由失败 →
   * needs_human_review (Owner 注意队列)。
   */
  private async handleRevisionRouting(ctx: SucceedContext): Promise<void> {
    const priorIteration = await this.resolvePriorRevisionIteration(ctx.taskId);
    const iteration = priorIteration + 1;

    if (iteration > 2) {
      await this.markNeedsHumanReview(ctx.taskId, `rollout_revision_budget_exhausted_iteration_${priorIteration}`);
      return;
    }

    const target = await this.resolveRevisionTarget(ctx.taskId, ctx.channel ?? 'prompt');
    if (!target) {
      await this.markNeedsHumanReview(ctx.taskId, 'rollout_revision_target_unresolved');
      return;
    }
    if (!this.reopenRevisionTarget) {
      this.emitRolloutReviewerEvent('rollout_revision_not_wired', ctx.taskId, {
        reason: 'reopen_revision_target_dep_not_injected',
        nextAction: 'wire_revision_routing_in_auto_consumer_or_run_once',
      });
      await this.markNeedsHumanReview(ctx.taskId, 'rollout_revision_routing_not_wired');
      return;
    }

    const feedback = RolloutReviewerRunner.formatRevisionFeedback(ctx.output);
    try {
      const outcome = await this.reopenRevisionTarget({
        targetTaskId: target.taskId,
        targetKind: target.kind,
        revisionFeedback: feedback,
        revisionIteration: iteration,
        sourceRolloutTaskId: ctx.taskId,
        sourceArtifactId: target.viaArtifactId ?? ctx.taskId,
      });
      if (!outcome.ok) {
        await this.markNeedsHumanReview(ctx.taskId, `rollout_revision_reopen_failed_${outcome.reason}`);
        return;
      }
      await this.recordRolloutRevisionRouting(ctx.taskId, {
        requiredChanges: [...ctx.output.review.requiredChanges],
        revisionIteration: iteration,
        sourceRolloutTaskId: ctx.taskId,
        sourceArtifactId: target.viaArtifactId ?? ctx.taskId,
        targetTaskKind: target.kind,
      });
      this.emitRolloutReviewerEvent('rollout_revision_routed', ctx.taskId, {
        targetTaskId: outcome.reopenedTaskId ?? target.taskId,
        targetKind: target.kind,
        revisionIteration: iteration,
      });
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_revision_route_failed', ctx.taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await this.markNeedsHumanReview(ctx.taskId, 'rollout_revision_route_threw');
    }
  }

  /** revision budget: rollout 任务元数据上已记录的修订轮数 (rc-7: 每轮现读) */
  private async resolvePriorRevisionIteration(taskId: string): Promise<number> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) return 0;
    const piTask = hydratePITaskRecord(task);
    if (!piTask?.rolloutRevisionPayload) return 0;
    return typeof piTask.rolloutRevisionPayload.revisionIteration === 'number'
      ? piTask.rolloutRevisionPayload.revisionIteration
      : 0;
  }

  /**
   * 解析修订目标任务 (只读遍历 dep 链):
   *   rollout → evaluator → artificer → scribe
   * code_tool_hook → artificer; 其他 → scribe (走到底)。
   */
  private async resolveRevisionTarget(
    taskId: string,
    channel: string,
  ): Promise<{ taskId: string; kind: 'scribe' | 'artificer'; viaArtifactId?: string } | null> {
    const rawTask = await this.stateManager.getTask(taskId);
    if (!rawTask) return null;
    const piTask = hydratePITaskRecord(rawTask);

    // 第一跳: rollout deps → evaluator; evaluator deps → artificer
    let artificerTaskId: string | null = null;
    let artificerDeps: string[] = [];
    const firstHop = piTask?.dependencyTaskIds ?? [];
    for (const depId of firstHop) {
      const dep = await this.stateManager.getTask(depId);
      if (!dep) continue;
      if (dep.taskKind === 'artificer') {
        const depPi = hydratePITaskRecord(dep);
        artificerTaskId = dep.taskId;
        artificerDeps = depPi?.dependencyTaskIds ?? [];
        break;
      }
      if (dep.taskKind === 'evaluator') {
        const evalPi = hydratePITaskRecord(dep);
        for (const evalDepId of evalPi?.dependencyTaskIds ?? []) {
          const evalDep = await this.stateManager.getTask(evalDepId);
          if (!evalDep || evalDep.taskKind !== 'artificer') continue;
          const evalDepPi = hydratePITaskRecord(evalDep);
          artificerTaskId = evalDep.taskId;
          artificerDeps = evalDepPi?.dependencyTaskIds ?? [];
          break;
        }
        if (artificerTaskId) break;
      }
    }
    if (!artificerTaskId) return null;

    if (channel === 'code_tool_hook') {
      return { taskId: artificerTaskId, kind: 'artificer' };
    }
    for (const depId of artificerDeps) {
      const dep = await this.stateManager.getTask(depId);
      if (!dep || dep.taskKind !== 'scribe') continue;
      return { taskId: dep.taskId, kind: 'scribe' };
    }
    return null;
  }

  private static formatRevisionFeedback(output: RolloutReviewerOutputV1): string {
    const lines = ['Rollout review 判定 needs_revision,请修订后重新走验证链:'];
    for (const change of output.review.requiredChanges) {
      lines.push(`- 必须修改: ${change}`);
    }
    for (const risk of output.review.rolloutRisks) {
      lines.push(`- 风险: ${risk}`);
    }
    return lines.join('\n');
  }

  private async markNeedsHumanReview(taskId: string, reason: string): Promise<void> {
    this.emitRolloutReviewerEvent('rollout_reviewer_task_needs_human_review', taskId, {
      reason,
      nextAction: 'owner_inspect_retry_or_archive',
    });
    try {
      await this.stateManager.updateTask(taskId, { status: 'needs_human_review' });
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_mark_human_review_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'manual_intervention_required',
      });
    }
  }

  /** 把 verdict 持久化进任务元数据 (commit 门控输入, 同 evaluator 模式) */
  private async recordRunnerDecision(taskId: string, decision: string): Promise<void> {
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) return;
      const piTask = hydratePITaskRecord(raw);
      if (!piTask) return;
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
        runnerDecision: decision === 'approve_rollout' || decision === 'needs_revision' || decision === 'reject'
          ? decision
          : undefined,
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      // P0-3 (外部复核): verdict durability 是 succeeded 的前置 — 写失败必须
      // fail loud (retry_wait),吞掉会让 commit 门读到 missing decision。
      this.emitRolloutReviewerEvent('rollout_decision_record_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        decision,
        nextAction: 'task_will_retry; check_task_store_consistency',
      });
      throw err;
    }
  }

  /** 记录修订路由 (budget 依据) */
  private async recordRolloutRevisionRouting(
    taskId: string,
    payload: { requiredChanges: string[]; revisionIteration: number; sourceRolloutTaskId: string; sourceArtifactId: string; targetTaskKind: 'scribe' | 'artificer' },
  ): Promise<void> {
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) return;
      const piTask = hydratePITaskRecord(raw);
      if (!piTask) return;
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
        rolloutRevisionPayload: payload,
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_revision_record_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleRuntimeFailure(
    taskId: string,
    task: TaskRecord,
    runStatus: RunStatus,
  ): Promise<RolloutReviewerRunnerResult> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status);

    this.emitRolloutReviewerEvent('rollout_reviewer_run_failed', taskId, {
      runStatus: runStatus.status,
      errorCategory,
    });

    return this.retryOrFail({
      taskId,
      task,
      errorCategory,
      failureReason: `Runtime execution ended with status: ${runStatus.status}`,
    });
  }

  private async handleValidationError(ctx: ValidationErrorContext): Promise<RolloutReviewerRunnerResult> {
    const category = (ctx.errorCategory ?? 'output_invalid') as PDErrorCategory;

    this.emitRolloutReviewerEvent('rollout_reviewer_output_invalid', ctx.taskId, {
      errorCount: ctx.errors.length,
      errorCategory: category,
    });

    return this.retryOrFail({
      taskId: ctx.taskId,
      task: ctx.task,
      errorCategory: category,
      failureReason: `Validation failed: ${ctx.errors.join('; ')}`,
    });
  }

  private async handleLeaseOrPhaseError(
    taskId: string,
    error: unknown,
  ): Promise<RolloutReviewerRunnerResult> {
    const classified = this.classifyError(error);

    if (classified.category === 'lease_conflict') {
      this.emitRolloutReviewerEvent('rollout_reviewer_run_failed', taskId, {
        errorCategory: 'lease_conflict',
        errorMessage: classified.message,
      });
      return {
        status: 'failed',
        taskId,
        errorCategory: 'lease_conflict',
        failureReason: classified.message,
        attemptCount: 1,
      };
    }

    this.emitRolloutReviewerEvent('rollout_reviewer_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    const task: TaskRecord = {
      taskId,
      taskKind: 'rollout_reviewer',
      status: 'leased',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
      maxAttempts: this.resolvedOptions.defaultMaxAttempts,
    };
    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async handlePostLeaseError(
    taskId: string,
    task: TaskRecord,
    error: unknown,
  ): Promise<RolloutReviewerRunnerResult> {
    const classified = this.classifyError(error);

    this.emitRolloutReviewerEvent('rollout_reviewer_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async retryOrFail(ctx: FailureContext): Promise<RolloutReviewerRunnerResult> {
    if (this.isPermanentError(ctx.errorCategory)) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitRolloutReviewerEvent('rollout_reviewer_mark_failed_error', ctx.taskId, {
          errorCategory: 'storage_unavailable',
          attemptCount: ctx.task.attemptCount,
          errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
        });
        return {
          status: 'failed',
          taskId: ctx.taskId,
          errorCategory: 'storage_unavailable',
          failureReason: `State manager error: ${ctx.failureReason}`,
          attemptCount: ctx.task.attemptCount,
        };
      }
      this.emitRolloutReviewerEvent('rollout_reviewer_task_failed', ctx.taskId, {
        errorCategory: ctx.errorCategory,
        attemptCount: ctx.task.attemptCount,
        failureReason: ctx.failureReason,
      });
      this.phase = RunnerPhase.Failed;
      return {
        status: 'failed',
        taskId: ctx.taskId,
        errorCategory: ctx.errorCategory,
        failureReason: ctx.failureReason,
        attemptCount: ctx.task.attemptCount,
      };
    }

    const shouldRetry = this.stateManager.getRetryPolicy().shouldRetry(ctx.task);
    if (shouldRetry) {
      try {
        await this.stateManager.markTaskRetryWait(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitRolloutReviewerEvent('rollout_reviewer_mark_retry_error', ctx.taskId, {
          errorCategory: 'storage_unavailable',
          attemptCount: ctx.task.attemptCount,
          errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
        });
        return {
          status: 'failed',
          taskId: ctx.taskId,
          errorCategory: 'storage_unavailable',
          failureReason: `State manager error: ${ctx.failureReason}`,
          attemptCount: ctx.task.attemptCount,
        };
      }
      this.emitRolloutReviewerEvent('rollout_reviewer_task_retried', ctx.taskId, {
        errorCategory: ctx.errorCategory,
        attemptCount: ctx.task.attemptCount,
      });
      this.phase = RunnerPhase.RetryWaiting;
      return {
        status: 'retried',
        taskId: ctx.taskId,
        errorCategory: ctx.errorCategory,
        failureReason: ctx.failureReason,
        attemptCount: ctx.task.attemptCount,
      };
    }

    try {
      await this.stateManager.markTaskFailed(ctx.taskId, 'max_attempts_exceeded');
    } catch (stateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_mark_failed_error', ctx.taskId, {
        errorCategory: 'storage_unavailable',
        attemptCount: ctx.task.attemptCount,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      return {
        status: 'failed',
        taskId: ctx.taskId,
        errorCategory: 'storage_unavailable',
        failureReason: `State manager error: ${ctx.failureReason}`,
        attemptCount: ctx.task.attemptCount,
      };
    }
    this.emitRolloutReviewerEvent('rollout_reviewer_task_failed', ctx.taskId, {
      errorCategory: 'max_attempts_exceeded',
      attemptCount: ctx.task.attemptCount,
      failureReason: `Max attempts exceeded: ${ctx.failureReason}`,
    });
    this.phase = RunnerPhase.Failed;
    return {
      status: 'failed',
      taskId: ctx.taskId,
      errorCategory: 'max_attempts_exceeded',
      failureReason: `Max attempts exceeded: ${ctx.failureReason}`,
      attemptCount: ctx.task.attemptCount,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private isPermanentError(category: PDErrorCategory): boolean {
    return ROLLOUT_REVIEWER_PERMANENT_ERROR_CATEGORIES.has(category);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private classifyError(error: unknown): { category: PDErrorCategory; message: string } {
    if (error instanceof PDRuntimeError) {
      return { category: error.category, message: error.message };
    }
    if (error instanceof Error) {
      return { category: 'execution_failed', message: error.message };
    }
    return { category: 'execution_failed', message: String(error) };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private mapRunStatusToErrorCategory(status: string): PDErrorCategory {
    switch (status) {
      case 'failed': return 'execution_failed';
      case 'timed_out': return 'timeout';
      case 'cancelled': return 'cancelled';
      default: return 'execution_failed';
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { DEFAULT_ROLLOUT_REVIEWER_RUNNER_OPTIONS };
