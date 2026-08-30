import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1, RolloutReviewerValidator } from './rollout-reviewer-output.js';
import type { PIArtifactStore } from './pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, type PITaskMetadata, type RolloutRevisionPayload, type RunnerDecision, type HumanReviewContext } from './pitask-metadata.js';
import {
  planOwnerVerdictOverrideResume,
  markOwnerResolutionApplied,
  canonicalHumanReviewReasonCode,
  computeArtifactContentHash,
  type OwnerOverrideResumePlan,
} from './owner-review.js';
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

    // P0 (verdict drift) — pending completion intent 是 recovery authority:
    // 同 epoch 的 crash/retry 重跑必须 resume 其 effects,禁止重新调用 LLM
    // (非确定性重问可能产生 approve/reject 漂移,与已发生的 activation /
    // revision side effect 形成治理矛盾)。置于主 try 内:resume 的 transient
    // 失败走 retryOrFail → retry_wait → 下一轮继续 resume。
    try {
      const resumed = await this.maybeResumePendingIntent(taskId, leasedTask);
      if (resumed) {
        this.phase = RunnerPhase.Completed;
        return resumed;
      }

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

    // ── P0 (verdict drift): decision + completion intent 原子落库 ──
    // 单次 metadata 写同时持久 verdict 与 completion intent — intent 存在即
    // 证明该 verdict 的 output/run 均已 durable (updateRunOutput 与 artifact
    // 写均在前)。同 epoch crash/retry 重跑经入口门 resume 此 intent,不再
    // 调用 LLM。needs_revision 的 iteration 在此锁定,resume 据此继续同一轮。
    const { decision } = ctx.output.review;
    const recorded = await this.recordCompletionOrThrow(ctx.taskId, ctx.runId, decision);
    if (recorded.kind === 'budget_exhausted') {
      // P0-A: verdict + completion intent (effect=needs_human_review) 已
      // durable;执行终态效果后标 applied — crash 窗口内 resume 会重写
      // needs_human_review,绝不重问 LLM。
      await this.markNeedsHumanReviewOrThrow(ctx.taskId, `rollout_revision_budget_exhausted_applied_${recorded.appliedCount}`, ctx);
      await this.markCompletionIntentAppliedOrThrow(ctx.taskId);
      this.phase = RunnerPhase.Completed;
      return RolloutReviewerRunner.buildSucceededResult(ctx, artifactId, resultRef);
    }

    // ── P0-2 (外部复核): dispatch/routing 是 governance transition 的组成
    // 部分,在 markTaskSucceeded 之前执行;transient 失败 throw → retry →
    // 入口门 resume (幂等 effects,无 LLM 重问)。
    const effect = await this.applyDecisionEffects(ctx, recorded.kind === 'intent' ? recorded.iteration : undefined);
    if (effect.kind === 'human_review') {
      // 任务已转入 needs_human_review — 不得再 markTaskSucceeded 覆盖
      this.phase = RunnerPhase.Completed;
      return RolloutReviewerRunner.buildSucceededResult(ctx, artifactId, resultRef);
    }

    // ── P0 invariant 5: intent APPLIED 后才允许 terminal ──
    await this.markCompletionIntentAppliedOrThrow(ctx.taskId);

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
      ...(effect.dispatchArtifactId ? { dispatchedArtifactId: effect.dispatchArtifactId } : {}),
    });

    this.phase = RunnerPhase.Completed;
    return RolloutReviewerRunner.buildSucceededResult(ctx, artifactId, resultRef);
  }

  private static buildSucceededResult(
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

    const chainIds = await this.collectLineageSourceTaskIds(ctx.taskId, [ctx.taskId], 0);
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
      const artifacts = await this.artifactStore.listBySourceTaskId(taskId).catch(() => null);
      if (!artifacts) continue;
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
  private static readonly LINEAGE_MAX_DEPTH = 5;

  private async collectLineageSourceTaskIds(
    rootTaskId: string,
    acc: string[],
    depth: number,
  ): Promise<string[]> {
    if (depth > RolloutReviewerRunner.LINEAGE_MAX_DEPTH) return acc;
    const task = await this.stateManager.getTask(rootTaskId);
    if (!task) return acc;
    const piTask = hydratePITaskRecord(task);
    for (const depId of piTask?.dependencyTaskIds ?? []) {
      if (acc.includes(depId)) continue;
      acc.push(depId);
      await this.collectLineageSourceTaskIds(depId, acc, depth + 1);
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
      await this.markNeedsHumanReviewOrThrow(ctx.taskId, 'rollout_dispatch_not_wired', ctx);
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
      await this.markNeedsHumanReviewOrThrow(ctx.taskId, `rollout_dispatch_${outcome.decision}`, ctx);
      return false;
    }
    return true;
  }

  /**
   * P0-E: needs_revision → reopen 最近可修复 stage (INV-04, 禁止入 approval)。
   * 路由: code_tool_hook → artificer (规则实现); 其他 channel → scribe (原则措辞)。
   *
   * P0 (verdict drift): iteration 由 completion intent 注入 — record 阶段已按
   * "已 APPLIED 的 rolloutRevisionPayload" 锁定本轮 N。同一 completion 的
   * fresh 执行与 crash resume 使用同一 N,消除"applied 载荷属于上一轮还是
   * 本轮"的歧义;budget 判定不在本方法内。
   *
   * 返回 true = revision transition 完成 (target 已 reopen);false = 任务已
   * 转入 needs_human_review。transient 错误 throw → retryOrFail → retry_wait
   * → 入口门 resume 同一 completion (无 LLM 重问)。
   */
  private async handleRevisionRouting(ctx: SucceedContext, iteration: number): Promise<boolean> {
    const target = await this.resolveRevisionTarget(ctx.taskId, ctx.channel ?? 'prompt');
    if (!target) {
      await this.markNeedsHumanReviewOrThrow(ctx.taskId, 'rollout_revision_target_unresolved', ctx);
      return false;
    }
    if (!this.reopenRevisionTarget) {
      this.emitRolloutReviewerEvent('rollout_revision_not_wired', ctx.taskId, {
        reason: 'reopen_revision_target_dep_not_injected',
        nextAction: 'wire_revision_routing_in_auto_consumer_or_run_once',
      });
      await this.markNeedsHumanReviewOrThrow(ctx.taskId, 'rollout_revision_routing_not_wired', ctx);
      return false;
    }

    const feedback = RolloutReviewerRunner.formatRevisionFeedback(ctx.output);
    // intent 载荷先持久化 (status=pending, N): 失败 = transient 存储错误 →
    // throw (B4: 无 reopen、budget 不增;重试经入口门 resume,不重问 LLM)。
    await this.recordRolloutRevisionRoutingOrThrow(ctx.taskId, {
      requiredChanges: [...ctx.output.review.requiredChanges],
      revisionIteration: iteration,
      sourceRolloutTaskId: ctx.taskId,
      sourceArtifactId: target.viaArtifactId ?? ctx.taskId,
      targetTaskKind: target.kind,
      status: 'pending',
    });
    try {
      const causeId = `rollout-${ctx.taskId}-r${iteration}`;
      // materialize 检查: target 已携带本 cause → 这轮 reopen 已发生过
      // (crash before rollout succeeded 的重放) — 不得再次 reopen
      const targetTask = await this.stateManager.getTask(target.taskId);
      const targetPi = targetTask ? hydratePITaskRecord(targetTask) : null;
      if (targetPi && targetPi.revisionCauseId === causeId) {
        this.emitRolloutReviewerEvent('rollout_revision_already_materialized', ctx.taskId, {
          targetTaskId: target.taskId,
          revisionIteration: iteration,
          causeId,
        });
      } else {
        const outcome = await this.reopenRevisionTarget({
          targetTaskId: target.taskId,
          targetKind: target.kind,
          revisionFeedback: feedback,
          revisionIteration: iteration,
          sourceRolloutTaskId: ctx.taskId,
          sourceArtifactId: target.viaArtifactId ?? ctx.taskId,
        });
        if (!outcome.ok) {
          await this.markNeedsHumanReviewOrThrow(ctx.taskId, `rollout_revision_reopen_failed_${outcome.reason}`, ctx);
          return false;
        }
      }
      // transition materialized → 载荷标 applied (写失败 fail loud,
      // 重放经上面的 materialize 检查安全收敛)
      await this.markRevisionIntentAppliedOrThrow(ctx.taskId, iteration, {
        requiredChanges: [...ctx.output.review.requiredChanges],
        sourceRolloutTaskId: ctx.taskId,
        sourceArtifactId: target.viaArtifactId ?? ctx.taskId,
        targetTaskKind: target.kind,
      });
      this.emitRolloutReviewerEvent('rollout_revision_routed', ctx.taskId, {
        targetTaskId: target.taskId,
        targetKind: target.kind,
        revisionIteration: iteration,
      });
      return true;
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_revision_route_failed', ctx.taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry_then_resume_completion_intent_without_llm',
      });
      throw err;
    }
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

  /**
   * P0 (INV-2): needs_human_review 是 completion effect 的 materialize 操作 —
   * fail-closed。写失败/读回不一致必须 throw (→ retry_wait → 入口门 resume
   * 同一 effect,不问 LLM),禁止 catch+swallow 后让 caller 把 intent 标
   * applied (intent applied ⇔ 其 durable effect 已 materialize)。
   */
  private async markNeedsHumanReviewOrThrow(taskId: string, reason: string, review: { runId: string }): Promise<void> {
    this.emitRolloutReviewerEvent('rollout_reviewer_task_needs_human_review', taskId, {
      reason,
      nextAction: 'owner_inspect_retry_or_archive',
    });
    try {
      // PRI-629: status + humanReviewContext 同一次 task-row mutation 原子落库。
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const piTask = hydratePITaskRecord(raw);
      if (!piTask) throw new Error(`task ${taskId} not hydratable`);
      const sourceArtifactId = `pi-art-${taskId}-${review.runId}`;
      let sourceArtifactHash;
      try {
        const artifact = await this.artifactStore.getArtifactById(sourceArtifactId);
        if (artifact) sourceArtifactHash = computeArtifactContentHash(artifact.contentJson);
      } catch {
        sourceArtifactHash = undefined;
      }
      const context: HumanReviewContext = {
        reasonCode: canonicalHumanReviewReasonCode(reason),
        sourceRunId: review.runId,
        sourceArtifactId,
        ...(sourceArtifactHash !== undefined ? { sourceArtifactHash } : {}),
        revisionEpoch: piTask.revisionCount ?? 0,
        createdAt: new Date().toISOString(),
      };
      const merged: PITaskMetadata = mergePITaskMetadata(piTask, { humanReviewContext: context });
      await this.stateManager.updateTask(taskId, {
        status: 'needs_human_review',
        diagnosticJson: createPITaskDiagnosticJson(merged),
      });
      // read-back invariant (INV-2): 只有 effect durable 才允许 caller 标 applied
      const current = await this.stateManager.getTask(taskId);
      if (!current || current.status !== 'needs_human_review') {
        throw new PDRuntimeError(
          'storage_unavailable',
          `needs_human_review effect not durable for task ${taskId} (read-back status: ${current?.status ?? 'task_missing'})`,
        );
      }
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_mark_human_review_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        reason,
        nextAction: 'task_will_retry_then_resume_completion_intent_without_llm',
      });
      throw err;
    }
  }

  /** B: 读取已持久化的 revision intent (无 → null;旧形状缺 status 视为 applied) */
  private async readRolloutRevisionPayload(taskId: string): Promise<RolloutRevisionPayload | null> {
    const raw = await this.stateManager.getTask(taskId);
    if (!raw) return null;
    const piTask = hydratePITaskRecord(raw);
    return piTask?.rolloutRevisionPayload ?? null;
  }

  // ── P0 (verdict drift): completion intent — record / effects / applied / resume ──

  /**
   * verdict + completion intent 原子落库 (单次 metadata 写)。
   * needs_revision 同时锁定本轮 iteration:
   *   - stored payload pending → 沿用其 iteration (同 epoch 在途修订继续,
   *     兼容旧形状 crash 态,B1);
   *   - stored applied → iteration + 1;appliedCount ≥ 2 → budget_exhausted
   *     (P0-A: 也必须记 completion intent,effect=needs_human_review —
   *     decision durable 而 crash before needs_human_review 写入时,retry
   *     不得重问 LLM 漂移 verdict)。
   */
  private async recordCompletionOrThrow(
    taskId: string,
    runId: string,
    decision: string,
  ): Promise<
    | { kind: 'intent'; iteration?: number }
    | { kind: 'budget_exhausted'; appliedCount: number }
  > {
    const stored = await this.readRolloutRevisionPayload(taskId);
    let iteration: number | undefined;
    let budgetExhausted = false;
    let appliedCount = 0;
    if (decision === 'needs_revision') {
      appliedCount = stored && stored.status !== 'pending' ? stored.revisionIteration : 0;
      if (appliedCount >= 2) {
        budgetExhausted = true;
      } else {
        iteration = stored && stored.status === 'pending' ? stored.revisionIteration : appliedCount + 1;
      }
    }
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const pi = hydratePITaskRecord(raw);
      if (!pi) throw new Error(`task ${taskId} not hydratable`);
      const merged: PITaskMetadata = mergePITaskMetadata(pi, {
        runnerDecision: decision === 'approve_rollout' || decision === 'needs_revision' || decision === 'reject'
          ? decision
          : pi.runnerDecision,
        completionIntent: {
          decision: decision as RunnerDecision,
          sourceRunId: runId,
          revisionEpoch: pi.revisionCount ?? 0,
          status: 'pending',
          ...(iteration !== undefined ? { revisionIteration: iteration } : {}),
          ...(budgetExhausted ? { effect: 'needs_human_review' as const } : {}),
        },
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_completion_record_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry; record is idempotent overwrite',
      });
      throw err;
    }
    if (budgetExhausted) {
      return { kind: 'budget_exhausted', appliedCount };
    }
    return { kind: 'intent', iteration };
  }

  /**
   * 执行 decision 的治理效果 (fresh 与 resume 共用,幂等):
   * approve → activation dispatch (幂等 key,重放 already_activated);
   * needs_revision → revision routing (iteration 由 intent 注入);
   * reject → 无效果 (terminal)。
   */
  private async applyDecisionEffects(
    ctx: SucceedContext,
    iteration?: number,
    /** PRI-629 Owner verdict override — 见方法头注释;机器 verdict 不变 (INV-03) */
    decisionOverride?: 'approve_rollout' | 'reject',
  ): Promise<{ kind: 'completed'; dispatchArtifactId?: string } | { kind: 'human_review' }> {
    const decision = decisionOverride ?? ctx.output.review.decision;
    if (decision === 'approve_rollout') {
      const candidate = await this.resolveActivationCandidate(ctx);
      if (!candidate) {
        await this.markNeedsHumanReviewOrThrow(ctx.taskId, 'rollout_activation_candidate_unresolved', ctx);
        return { kind: 'human_review' };
      }
      const completed = await this.dispatchOrRouteFailure(ctx, candidate);
      return completed ? { kind: 'completed', dispatchArtifactId: candidate } : { kind: 'human_review' };
    }
    if (decision === 'needs_revision') {
      if (iteration === undefined) {
        // intent 缺 iteration 却走到 needs_revision 效果 — authority 记录损坏
        await this.markNeedsHumanReviewOrThrow(ctx.taskId, 'rollout_revision_iteration_missing', ctx);
        return { kind: 'human_review' };
      }
      const completed = await this.handleRevisionRouting(ctx, iteration);
      return completed ? { kind: 'completed' } : { kind: 'human_review' };
    }
    // 'reject' → terminal: 无 dispatch、无 approval、无后继 (INV-04)
    return { kind: 'completed' };
  }

  /** intent APPLIED 后才允许 terminal (P0 invariant 5)。写失败 fail loud。 */
  private async markCompletionIntentAppliedOrThrow(taskId: string): Promise<void> {
    try {
      const raw = await this.stateManager.getTask(taskId);
      if (!raw) throw new Error(`task ${taskId} not found`);
      const pi = hydratePITaskRecord(raw);
      if (!pi?.completionIntent) return; // budget_exhausted 路径无 intent
      const merged: PITaskMetadata = mergePITaskMetadata(pi, {
        completionIntent: { ...pi.completionIntent, status: 'applied' },
      });
      await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    } catch (err) {
      this.emitRolloutReviewerEvent('rollout_completion_mark_applied_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry; resume re-passes materialize checks',
      });
      throw err;
    }
  }

  /**
   * 入口恢复门: pending completion intent (同 epoch) 是 recovery authority。
   * 返回非 null = 本次 run 以 resume 完成 (LLM 未被调用);
   * 返回 null = 走正常 LLM 管线。epoch 不匹配的残留 intent 视为 stale。
   */
  private async maybeResumePendingIntent(
    taskId: string,
    leasedTask: TaskRecord,
  ): Promise<RolloutReviewerRunnerResult | null> {
    const piTask = hydratePITaskRecord(leasedTask);

    // PRI-629: pending Owner Resolution 优先于一切 (SPEC §10/§30) — 应用
    // override,不重新调用 LLM;applied 未 terminal 的 crash 窗口同样收敛。
    const ownerOverride = piTask ? planOwnerVerdictOverrideResume(piTask) : null;
    if (ownerOverride) {
      this.phase = RunnerPhase.Completed;
      return await this.applyOwnerVerdictOverrideAndFinalize(taskId, leasedTask, ownerOverride);
    }

    const intent = piTask?.completionIntent;
    if (!piTask || !intent || intent.status !== 'pending') {
      // P0 (INV-1/INV-5): applied 但任务未 terminal (标 applied 后、
      // markTaskSucceeded 写失败/crash 的窗口) — effects 已 materialize,
      // 不重问 LLM,直接补 terminal,消除 "applied+非终态" 的 LLM 重开窗口。
      if (piTask && intent && intent.status === 'applied'
        && intent.revisionEpoch === (piTask.revisionCount ?? 0)
        && leasedTask.status !== 'needs_human_review') {
        return await this.finalizeAppliedIntentTerminal(taskId, intent.sourceRunId, leasedTask);
      }
      return null;
    }
    if (intent.revisionEpoch !== (piTask.revisionCount ?? 0)) {
      this.emitRolloutReviewerEvent('rollout_completion_intent_stale_epoch', taskId, {
        intentEpoch: intent.revisionEpoch,
        currentEpoch: piTask.revisionCount ?? 0,
        nextAction: 'reopen should have cleared intent; verify reopenTaskForRevision path',
      });
      return null;
    }
    this.emitRolloutReviewerEvent('rollout_completion_intent_resumed', taskId, {
      decision: intent.decision,
      sourceRunId: intent.sourceRunId,
    });

    // P0-A: needs_human_review 效果 (budget exhausted 等) 的 resume —
    // 恢复 durable output (intent 落库前已持久),重写终态人工裁决状态,
    // 不路由、不 dispatch、不问 LLM。
    if (intent.effect === 'needs_human_review') {
      const budgetOutput = await this.recoverIntentOutput(taskId, intent.sourceRunId);
      const stored = await this.readRolloutRevisionPayload(taskId);
      const appliedCount = stored && stored.status !== 'pending' ? stored.revisionIteration : 2;
      await this.markNeedsHumanReviewOrThrow(taskId, `rollout_revision_budget_exhausted_applied_${appliedCount}`, { runId: intent.sourceRunId });
      await this.markCompletionIntentAppliedOrThrow(taskId);
      this.phase = RunnerPhase.Completed;
      return RolloutReviewerRunner.buildResumeResult({
        taskId,
        runId: intent.sourceRunId,
        artifactId: `pi-art-${taskId}-${intent.sourceRunId}`,
        resultRef: `rollout-reviewer://${intent.sourceRunId}`,
        output: budgetOutput,
        attemptCount: leasedTask.attemptCount,
      });
    }

    const output = await this.recoverIntentOutput(taskId, intent.sourceRunId);
    const ctx: SucceedContext = {
      taskId,
      runId: intent.sourceRunId,
      output,
      task: leasedTask,
      contextHash: `resume-${intent.sourceRunId}`,
      sourceEvaluatorArtifactId: output.sourceEvaluatorArtifactId,
      channel: piTask.channel,
    };
    const artifactId = `pi-art-${taskId}-${intent.sourceRunId}`;
    const resultRef = `rollout-reviewer://${intent.sourceRunId}`;

    const effect = await this.applyDecisionEffects(ctx, intent.revisionIteration);
    if (effect.kind === 'human_review') {
      this.phase = RunnerPhase.Completed;
      return RolloutReviewerRunner.buildResumeResult({ taskId, runId: intent.sourceRunId, artifactId, resultRef, output, attemptCount: leasedTask.attemptCount });
    }
    await this.markCompletionIntentAppliedOrThrow(taskId);
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_mark_succeeded_failed', taskId, {
        taskId,
        runId: intent.sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.emitRolloutReviewerEvent('rollout_reviewer_task_succeeded', taskId, {
      attemptCount: leasedTask.attemptCount,
      resultRef,
      reviewDecision: intent.decision,
      reviewConfidence: output.review.confidence,
      resumedFromCompletionIntent: true,
      ...(effect.dispatchArtifactId ? { dispatchedArtifactId: effect.dispatchArtifactId } : {}),
    });
    this.phase = RunnerPhase.Completed;
    return RolloutReviewerRunner.buildResumeResult({ taskId, runId: intent.sourceRunId, artifactId, resultRef, output, attemptCount: leasedTask.attemptCount });
  }

  /**
   * PRI-629: 应用 Owner verdict override 并收敛 terminal。
   *
   * accept_current → effectiveDecision='approve_rollout' — 仍走
   * resolveActivationCandidate → dispatchActivation → ActivationDispatcher
   * 的完整通道风险门:低风险正常 policy,高风险 queued_for_approval
   * (INV-08: Owner review ≠ deployment approval,安全边界不穿透)。
   * reject_current → 'reject' — terminal,无 dispatch、无 approval、无 activation。
   * 顺序: 恢复 durable output → 幂等效果 → intent applied → resolution
   * applied → markTaskSucceeded;任何 crash 窗口重放同一 resolution,无 LLM。
   */
  private async applyOwnerVerdictOverrideAndFinalize(
    taskId: string,
    leasedTask: TaskRecord,
    plan: OwnerOverrideResumePlan,
  ): Promise<RolloutReviewerRunnerResult> {
    const { resolution, overrideDecision } = plan;
    this.emitRolloutReviewerEvent('rollout_owner_resolution_applying', taskId, {
      resolutionId: resolution.resolutionId,
      action: resolution.action,
      machineDecision: resolution.machineDecision,
      effectiveDecision: overrideDecision,
      sourceRunId: resolution.sourceRunId,
    });

    // 恢复裁决时的 durable output — 机器判定必须与 resolution 记录一致
    const output = await this.recoverIntentOutput(taskId, resolution.sourceRunId);
    if (output.review.decision !== resolution.machineDecision) {
      throw new PDRuntimeError(
        'storage_unavailable',
        `owner resolution output mismatch for task ${taskId}: recovered decision '${output.review.decision}' != recorded machine decision '${resolution.machineDecision}'`,
      );
    }

    const ctx: SucceedContext = {
      taskId,
      runId: resolution.sourceRunId,
      output,
      task: leasedTask,
      contextHash: `owner-override-${resolution.resolutionId}`,
      sourceEvaluatorArtifactId: output.sourceEvaluatorArtifactId,
      channel: hydratePITaskRecord(leasedTask)?.channel,
    };
    const artifactId = `pi-art-${taskId}-${resolution.sourceRunId}`;
    const resultRef = `rollout-reviewer://${resolution.sourceRunId}`;

    const effect = await this.applyDecisionEffects(
      ctx,
      undefined,
      overrideDecision === 'approve_rollout' ? 'approve_rollout' : 'reject',
    );
    if (effect.kind === 'human_review') {
      // P0 评审修复: override 后效果仍进 NHR (candidate unresolved / dispatch
      // refused) 属 recovery 类技术故障——但 Owner 裁决 **已被执行**,resolution
      // 必须标 applied。若停留 pending,任务将死胡同: Focus 不再显示决策
      // (recovery 原因),Recover 又被 guard 拒绝 (存在 resolution)。
      // 标 applied 后: 现在及未来 Recover 放行 (只拒 pending),resume 门会
      // 基于 applied override 确定性重放 dispatch,不重问 LLM。
      await markOwnerResolutionApplied({
        updateDiagnosticJson: (tid: string, json: string) => this.stateManager.updateTaskDiagnosticJson(tid, json),
        getTask: (tid: string) => this.stateManager.getTask(tid),
        taskId,
        resolutionId: resolution.resolutionId,
        appliedAt: new Date().toISOString(),
      });
      this.phase = RunnerPhase.Completed;
      return RolloutReviewerRunner.buildResumeResult({
        taskId, runId: resolution.sourceRunId, artifactId, resultRef, output,
        attemptCount: leasedTask.attemptCount,
      });
    }
    await this.markCompletionIntentAppliedOrThrow(taskId);
    await markOwnerResolutionApplied({
      updateDiagnosticJson: (tid: string, json: string) => this.stateManager.updateTaskDiagnosticJson(tid, json),
      getTask: (tid: string) => this.stateManager.getTask(tid),
      taskId,
      resolutionId: resolution.resolutionId,
      appliedAt: new Date().toISOString(),
    });
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_mark_succeeded_failed', taskId, {
        taskId,
        runId: resolution.sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.emitRolloutReviewerEvent('rollout_reviewer_task_succeeded', taskId, {
      attemptCount: leasedTask.attemptCount,
      resultRef,
      reviewDecision: output.review.decision,
      reviewConfidence: output.review.confidence,
      ownerResolutionApplied: resolution.resolutionId,
      effectiveDecision: overrideDecision,
      ...(effect.dispatchArtifactId ? { dispatchedArtifactId: effect.dispatchArtifactId } : {}),
    });
    this.phase = RunnerPhase.Completed;
    return RolloutReviewerRunner.buildResumeResult({
      taskId, runId: resolution.sourceRunId, artifactId, resultRef, output,
      attemptCount: leasedTask.attemptCount,
    });
  }

  /**
   * P0 (INV-1/INV-5): applied intent 的补 terminal — effects 已 materialize
   * (applied ⇒ INV-2 保证),仅 markTaskSucceeded 缺失。不调用 LLM。
   */
  private async finalizeAppliedIntentTerminal(
    taskId: string,
    sourceRunId: string,
    leasedTask: TaskRecord,
  ): Promise<RolloutReviewerRunnerResult> {
    this.emitRolloutReviewerEvent('rollout_completion_intent_finalize_terminal', taskId, {
      sourceRunId,
      taskStatus: leasedTask.status,
    });
    const output = await this.recoverIntentOutput(taskId, sourceRunId);
    const resultRef = `rollout-reviewer://${sourceRunId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitRolloutReviewerEvent('rollout_reviewer_mark_succeeded_failed', taskId, {
        taskId,
        runId: sourceRunId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }
    this.phase = RunnerPhase.Completed;
    return RolloutReviewerRunner.buildResumeResult({
      taskId,
      runId: sourceRunId,
      artifactId: `pi-art-${taskId}-${sourceRunId}`,
      resultRef,
      output,
      attemptCount: leasedTask.attemptCount,
    });
  }

  /**
   * 从 runs 表恢复 intent 落库前已持久化的 validated output。
   * intent 的存在保证 updateRunOutput 曾成功 (顺序: output → artifact →
   * decision+intent);缺失/损坏 = authority 记录的存储腐坏 → fail loud
   * (storage_unavailable → retryOrFail → max attempts → failed,人工介入)。
   */
  private async recoverIntentOutput(taskId: string, sourceRunId: string): Promise<RolloutReviewerOutputV1> {
    const runs = await this.stateManager.getRunsByTask(taskId);
    const run = runs.find((r) => r.runId === sourceRunId);
    const raw = run?.outputPayload;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} has no outputPayload`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} has unparseable outputPayload`);
    }
    // rc-1: 提取 echo 的 lineage 供验证器交叉核对 (持久化前已经过完整
    // validate + lineage echo reconciliation,这里是对存储腐坏的防御)
    let echoedArtifactId: string | undefined;
    if (typeof parsed === 'object' && parsed !== null) {
      const v = (parsed as Record<string, unknown>).sourceEvaluatorArtifactId;
      if (typeof v === 'string') echoedArtifactId = v;
    }
    // runtime-contract-exempt: ERR-001 minimal shape check then full validator.validate — same pattern as fetchAndParseOutput; the cast only narrows post-validation
    const candidate = parsed as RolloutReviewerOutputV1;
    const vr = await this.validator.validate(candidate, taskId, echoedArtifactId);
    if (!vr.valid) {
      throw new PDRuntimeError('storage_unavailable', `completion intent output unrecoverable: run ${sourceRunId} of task ${taskId} failed revalidation (${vr.errors.join('; ')})`);
    }
    return candidate;
  }

  private static buildResumeResult(r: {
    taskId: string;
    runId: string;
    artifactId: string;
    resultRef: string;
    output: RolloutReviewerOutputV1;
    attemptCount: number;
  }): RolloutReviewerRunnerResult {
    return {
      status: 'succeeded',
      taskId: r.taskId,
      runId: r.runId,
      artifactId: r.artifactId,
      resultRef: r.resultRef,
      contextHash: `resume-${r.runId}`,
      output: r.output,
      attemptCount: r.attemptCount,
    };
  }

  /**
   * B: intent 标 APPLIED — transition 已 materialize 后的持久化确认。
   * 写失败 throw (fail loud): 重放会经 materialize 检查安全收敛。
   */
  private async markRevisionIntentAppliedOrThrow(
    taskId: string,
    iteration: number,
    payload: { requiredChanges: string[]; sourceRolloutTaskId: string; sourceArtifactId: string; targetTaskKind: 'scribe' | 'artificer' },
  ): Promise<void> {
    await this.recordRolloutRevisionRouting(taskId, {
      requiredChanges: payload.requiredChanges,
      revisionIteration: iteration,
      sourceRolloutTaskId: payload.sourceRolloutTaskId,
      sourceArtifactId: payload.sourceArtifactId,
      targetTaskKind: payload.targetTaskKind,
      status: 'applied',
    });
  }

  /** 记录修订路由 (budget 依据) */
  private async recordRolloutRevisionRouting(
    taskId: string,
    payload: { requiredChanges: string[]; revisionIteration: number; sourceRolloutTaskId: string; sourceArtifactId: string; targetTaskKind: 'scribe' | 'artificer'; status?: 'pending' | 'applied' },
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
      // C (外部复核): routing intent 持久化失败必须 fail loud (caller 已把
      // record 前置于 reopen — 此 throw 阻止无 budget 记录的 reopen 发生)
      this.emitRolloutReviewerEvent('rollout_revision_record_failed', taskId, {
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'task_will_retry; record is idempotent overwrite',
      });
      throw err;
    }
  }

  /** C: 显式 fail-loud 包装 — routing intent 是 transition 的组成部分。 */
  private async recordRolloutRevisionRoutingOrThrow(
    taskId: string,
    payload: { requiredChanges: string[]; revisionIteration: number; sourceRolloutTaskId: string; sourceArtifactId: string; targetTaskKind: 'scribe' | 'artificer'; status?: 'pending' | 'applied' },
  ): Promise<void> {
    await this.recordRolloutRevisionRouting(taskId, payload);
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
