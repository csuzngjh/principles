import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { EvaluatorOutputV1, EvaluatorValidator } from './evaluator-output.js';
import type { PIArtifactStore } from './pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RunnerPhase } from '../runner/runner-phase.js';
import { EvaluatorPromptBuilder } from './evaluator-prompt-builder.js';

export type EvaluatorRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface EvaluatorRunnerResult {
  readonly status: EvaluatorRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: EvaluatorOutputV1;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

export interface EvaluatorRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedEvaluatorRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_EVALUATOR_RUNNER_OPTIONS: Readonly<Omit<ResolvedEvaluatorRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'evaluator',
} as const;

export function resolveEvaluatorRunnerOptions(options: EvaluatorRunnerOptions): ResolvedEvaluatorRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_EVALUATOR_RUNNER_OPTIONS.agentId,
  };
}

export interface EvaluatorRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: EvaluatorValidator;
  readonly artifactStore: PIArtifactStore;
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
  readonly output: EvaluatorOutputV1;
  readonly task: TaskRecord;
  readonly contextHash: string;
}

interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

const EVALUATOR_PERMANENT_ERROR_CATEGORIES: ReadonlySet<PDErrorCategory> = new Set<PDErrorCategory>([
  'storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid',
]);

export class EvaluatorRunner {
  private phase: RunnerPhase = RunnerPhase.Idle;
  private readonly resolvedOptions: ResolvedEvaluatorRunnerOptions;
  private readonly stateManager: RuntimeStateManager;
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly validator: EvaluatorValidator;
  private readonly artifactStore: PIArtifactStore;

  constructor(deps: EvaluatorRunnerDeps, options: EvaluatorRunnerOptions) {
    this.stateManager = deps.stateManager;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.validator = deps.validator;
    this.artifactStore = deps.artifactStore;
    this.resolvedOptions = resolveEvaluatorRunnerOptions(options);
  }

  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  private emitEvaluatorEvent(
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

  async run(taskId: string): Promise<EvaluatorRunnerResult> {
    this.phase = RunnerPhase.Idle;

    // eslint-disable-next-line @typescript-eslint/init-declarations
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

    if (leasedTask.taskKind !== 'evaluator') {
      this.emitEvaluatorEvent('evaluator_wrong_task_kind', taskId, {
        expectedKind: 'evaluator',
        actualKind: leasedTask.taskKind,
      });
      return this.retryOrFail({
        taskId,
        task: leasedTask,
        errorCategory: 'input_invalid',
        failureReason: `Task kind must be 'evaluator', got '${leasedTask.taskKind}'`,
      });
    }

    this.emitEvaluatorEvent('evaluator_task_leased', taskId, {
      taskKind: 'evaluator',
      attemptCount: leasedTask.attemptCount,
    });

    try {
      const storeRunId = await this.resolveStoreRunId(taskId);

      this.phase = RunnerPhase.BuildingContext;
      const { contextHash, artificerArtifact, sourceArtificerArtifactId } = await this.buildContext(taskId);

      if (!artificerArtifact || !sourceArtificerArtifactId) {
        return this.retryOrFail({
          taskId,
          task: leasedTask,
          errorCategory: 'input_invalid',
          failureReason: sourceArtificerArtifactId ? 'Artificer dependency artifact not found' : 'Artificer dependency artifact ID not resolved',
        });
      }

      this.emitEvaluatorEvent('evaluator_context_built', taskId, { contextHash });

      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime({ taskId, contextHash, artificerArtifact, sourceArtificerArtifactId });

      this.emitEvaluatorEvent('evaluator_run_started', taskId, {
        runtimeKind: this.resolvedOptions.runtimeKind,
      });

      this.phase = RunnerPhase.Polling;
      const finalStatus = await this.pollUntilTerminal(runHandle);

      if (finalStatus.status !== 'succeeded') {
        return await this.handleRuntimeFailure(taskId, leasedTask, finalStatus);
      }

      this.phase = RunnerPhase.FetchingOutput;
      const output = await this.fetchAndParseOutput(runHandle.runId);

      this.phase = RunnerPhase.Validating;
      const validationResult = await this.validator.validate(output, taskId, sourceArtificerArtifactId ?? undefined);
      if (!validationResult.valid) {
        return await this.handleValidationError({
          taskId,
          task: leasedTask,
          errors: validationResult.errors,
          errorCategory: validationResult.errorCategory,
        });
      }

      this.emitEvaluatorEvent('evaluator_output_validated', taskId, {
        evaluationDecision: output.evaluation.decision,
        evaluationScore: output.evaluation.score,
      });

      return await this.succeedTask({
        taskId,
        runId: storeRunId,
        output,
        task: leasedTask,
        contextHash,
      });
    } catch (error) {
      return await this.handlePostLeaseError(taskId, leasedTask, error);
    }
  }

  private async buildContext(taskId: string): Promise<{ contextHash: string; artificerArtifact: string | null; sourceArtificerArtifactId: string | null }> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      this.emitEvaluatorEvent('evaluator_no_dependencies', taskId, {});
      return { contextHash: 'empty', artificerArtifact: null, sourceArtificerArtifactId: null };
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'artificer') continue;
      if (depTask.status !== 'succeeded') {
        this.emitEvaluatorEvent('evaluator_dependency_not_succeeded', taskId, {
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
        this.emitEvaluatorEvent('evaluator_artificer_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });
        return {
          contextHash: EvaluatorRunner.hashContextRefs([artifactRef]),
          artificerArtifact: firstArtifact.contentJson,
          sourceArtificerArtifactId: firstArtifact.artifactId,
        };
      }
    }

    this.emitEvaluatorEvent('evaluator_no_artificer_artifact', taskId, {});
    return { contextHash: 'empty', artificerArtifact: null, sourceArtificerArtifactId: null };
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
    artificerArtifact: string | null;
    sourceArtificerArtifactId: string;
  }): Promise<RunHandle> {
    let parsedArtificerArtifact: unknown = null;
    if (params.artificerArtifact) {
      try {
        parsedArtificerArtifact = JSON.parse(params.artificerArtifact);
      } catch {
        parsedArtificerArtifact = params.artificerArtifact;
      }
    }

    const builder = new EvaluatorPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId: params.taskId,
      contextHash: params.contextHash,
      artificerArtifact: parsedArtificerArtifact,
      sourceArtificerArtifactId: params.sourceArtificerArtifactId,
    });

    const startInput: StartRunInput = {
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: params.taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'evaluator-output-v1',
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
      this.emitEvaluatorEvent('evaluator_cancel_run_failed', runHandle.runId, {
        runId: runHandle.runId,
        errorMessage: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
    const cancelNote = cancelFailed ? ' (cancelRun also failed)' : '';
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms${cancelNote}`);
  }

  private async fetchAndParseOutput(runId: string): Promise<EvaluatorOutputV1> {
    const result = await this.runtimeAdapter.fetchOutput(runId);
    if (!result || !result.payload) {
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }
    const payload = result.payload as Record<string, unknown>;
    if (typeof payload !== 'object' || payload === null) {
      throw new PDRuntimeError('output_invalid', `Output payload is not an object for run ${runId}`);
    }
    if (typeof payload.evaluation !== 'object' || payload.evaluation === null) {
      throw new PDRuntimeError('output_invalid', `Output payload missing evaluation object for run ${runId}`);
    }
    return result.payload as EvaluatorOutputV1;
  }

  private async succeedTask(ctx: SucceedContext): Promise<EvaluatorRunnerResult> {
    try {
      await this.stateManager.updateRunOutput(ctx.runId, JSON.stringify(ctx.output));
    } catch (updateErr) {
      this.emitEvaluatorEvent('evaluator_update_output_failed', ctx.taskId, {
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
      this.emitEvaluatorEvent('evaluator_artifact_write_failed', ctx.taskId, {
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

    const resultRef = `evaluator://${ctx.runId}`;

    if (ctx.output.evaluation.decision === 'approved') {
      const principleArtifactId = await this.resolvePrincipleBearerArtifact(ctx.output, ctx.taskId);
      if (principleArtifactId) {
        try {
          const updated = await this.artifactStore.updateValidationStatus(
            principleArtifactId,
            'validated',
          );
          if (!updated) {
            this.emitEvaluatorEvent('evaluator_source_validation_update_not_found', ctx.taskId, {
              runId: ctx.runId,
              sourceArtifactId: principleArtifactId,
              reason: 'principle_artifact_not_found_in_store',
              nextAction: 'verify_artifact_lineage_and_store_consistency',
            });
          }
        } catch (updateErr) {
          this.emitEvaluatorEvent('evaluator_source_validation_update_failed', ctx.taskId, {
            runId: ctx.runId,
            sourceArtifactId: principleArtifactId,
            errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }
      }
    }

    try {
      await this.stateManager.markTaskSucceeded(ctx.taskId, resultRef);
    } catch (stateErr) {
      this.emitEvaluatorEvent('evaluator_mark_succeeded_failed', ctx.taskId, {
        taskId: ctx.taskId,
        runId: ctx.runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitEvaluatorEvent('evaluator_task_succeeded', ctx.taskId, {
      attemptCount: ctx.task.attemptCount,
      resultRef,
      evaluationDecision: ctx.output.evaluation.decision,
      evaluationScore: ctx.output.evaluation.score,
    });

    this.phase = RunnerPhase.Completed;
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

  private async handleRuntimeFailure(
    taskId: string,
    task: TaskRecord,
    runStatus: RunStatus,
  ): Promise<EvaluatorRunnerResult> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status);

    this.emitEvaluatorEvent('evaluator_run_failed', taskId, {
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

  private async handleValidationError(ctx: ValidationErrorContext): Promise<EvaluatorRunnerResult> {
    const category = (ctx.errorCategory ?? 'output_invalid') as PDErrorCategory;

    this.emitEvaluatorEvent('evaluator_output_invalid', ctx.taskId, {
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
  ): Promise<EvaluatorRunnerResult> {
    const classified = this.classifyError(error);

    if (classified.category === 'lease_conflict') {
      this.emitEvaluatorEvent('evaluator_run_failed', taskId, {
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

    this.emitEvaluatorEvent('evaluator_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    const task: TaskRecord = {
      taskId,
      taskKind: 'evaluator',
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
  ): Promise<EvaluatorRunnerResult> {
    const classified = this.classifyError(error);

    this.emitEvaluatorEvent('evaluator_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async retryOrFail(ctx: FailureContext): Promise<EvaluatorRunnerResult> {
    if (this.isPermanentError(ctx.errorCategory)) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitEvaluatorEvent('evaluator_mark_failed_error', ctx.taskId, {
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
      this.emitEvaluatorEvent('evaluator_task_failed', ctx.taskId, {
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
        this.emitEvaluatorEvent('evaluator_mark_retry_error', ctx.taskId, {
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
      this.emitEvaluatorEvent('evaluator_task_retried', ctx.taskId, {
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
      this.emitEvaluatorEvent('evaluator_mark_failed_error', ctx.taskId, {
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
    this.emitEvaluatorEvent('evaluator_task_failed', ctx.taskId, {
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
    return EVALUATOR_PERMANENT_ERROR_CATEGORIES.has(category);
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

  private async resolvePrincipleBearerArtifact(
    output: EvaluatorOutputV1,
    taskId: string,
  ): Promise<string | null> {
    // Strategy 1: Use scribeArtifactId from sourceTrace (the Scribe artifact carries principleDraft)
    const scribeArtifactId = output.sourceTrace?.scribeArtifactId;
    if (typeof scribeArtifactId === 'string' && scribeArtifactId.trim() !== '') {
      const scribeArtifact = await this.artifactStore.getArtifactById(scribeArtifactId);
      if (scribeArtifact && scribeArtifact.artifactKind === 'principle') {
        return scribeArtifactId;
      }
      // Scribe artifact not found or wrong kind — fall through to lineage search
      this.emitEvaluatorEvent('evaluator_scribe_artifact_not_principle', taskId, {
        scribeArtifactId,
        actualKind: scribeArtifact?.artifactKind ?? 'not_found',
      });
    }

    // Strategy 2: Search lineage for all principle-kind artifacts with principleDraft content
    const lineageArtifactIds = await this.resolveLineageArtifactIds(taskId);
    const candidates: string[] = [];
    for (const lineageId of lineageArtifactIds) {
      const artifact = await this.artifactStore.getArtifactById(lineageId);
      if (!artifact) continue;
      if (artifact.artifactKind !== 'principle') continue;
      if (this.hasPrincipleDraftContent(artifact.contentJson)) {
        candidates.push(lineageId);
      }
    }

    if (candidates.length === 1) {
      const [only] = candidates;
      return only ?? null;
    }

    if (candidates.length > 1) {
      this.emitEvaluatorEvent('evaluator_principle_bearer_ambiguous', taskId, {
        candidateArtifactIds: candidates,
        reason: 'multiple_principle_bearing_artifacts_in_lineage',
        nextAction: 'disambiguate_principle_source_or_fix_lineage',
      });
      return null;
    }

    // Strategy 3: Fallback — no principle-bearing artifact found
    this.emitEvaluatorEvent('evaluator_no_principle_bearer_found', taskId, {
      runId: output.taskId,
      scribeArtifactId: scribeArtifactId ?? 'not_provided',
      lineageCount: lineageArtifactIds.length,
      reason: 'no_principle_bearing_artifact_in_lineage',
      nextAction: 'verify_scribe_artifact_exists_and_has_principle_draft',
    });
    return null;
  }

  private async resolveLineageArtifactIds(taskId: string): Promise<string[]> {
    try {
      const task = await this.stateManager.getTask(taskId);
      if (!task) return [];
      const piTask = hydratePITaskRecord(task);
      const deps = piTask?.dependencyTaskIds ?? [];
      const results = await Promise.allSettled(
        deps.map((depId) => this.artifactStore.listBySourceTaskId(depId)),
      );
      const ids: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const artifact of result.value) {
            ids.push(artifact.artifactId);
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private hasPrincipleDraftContent(contentJson: string): boolean {
    try {
      const parsed: unknown = JSON.parse(contentJson);
      if (!EvaluatorRunner.isRecord(parsed)) return false;
      // Check for principleDraft.title + principleDraft.statement
      if (Object.hasOwn(parsed, 'principleDraft')) {
        const draft = parsed.principleDraft;
        if (EvaluatorRunner.isRecord(draft)
          && Object.hasOwn(draft, 'title') && typeof draft.title === 'string' && draft.title.trim() !== ''
          && Object.hasOwn(draft, 'statement') && typeof draft.statement === 'string' && draft.statement.trim() !== '') {
          return true;
        }
      }
      // Check for principleId + text (alternative principle format)
      if (Object.hasOwn(parsed, 'principleId') && typeof parsed.principleId === 'string' && parsed.principleId.trim() !== ''
        && Object.hasOwn(parsed, 'text') && typeof parsed.text === 'string' && parsed.text.trim() !== '') {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { DEFAULT_EVALUATOR_RUNNER_OPTIONS };
