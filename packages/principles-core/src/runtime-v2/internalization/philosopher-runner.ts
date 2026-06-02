/**
 * PhilosopherRunner — Second peer runner for the Internalization Engine (PRI-90).
 *
 * Reads a Dreamer artifact, invokes PDRuntimeAdapter for philosophical analysis,
 * validates output, writes Philosopher PIArtifact, and marks task succeeded.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Scribe (host layer enqueues next task)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - No timer-based scheduling (sleep via setTimeout is polling-only)
 *   - Uses RuntimeStateManager for all state operations
 *
 * Pipeline:
 *   1. acquireLease — isolated try/catch, lease_conflict is non-mutating
 *   2. resolve Dreamer dependency from dependencyTaskIds
 *   3. fetch Dreamer artifact via PIArtifactStore
 *   4. startRun with outputSchemaRef: 'philosopher-output-v1'
 *   5. pollUntilTerminal
 *   6. fetchOutput → parse as PhilosopherOutputV1
 *   7. validate via PhilosopherValidator
 *   8. updateRunOutput → persist serialized output
 *   9. write PIArtifact → markTaskSucceeded with philosopher:// resultRef
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { PhilosopherOutputV1, PhilosopherValidator } from './philosopher-output.js';
import type { PIArtifactStore } from './pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RunnerPhase } from '../runner/runner-phase.js';
import { PhilosopherPromptBuilder } from './philosopher-prompt-builder.js';

// ── Result Types ──────────────────────────────────────────────────────────────

export type PhilosopherRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface PhilosopherRunnerResult {
  readonly status: PhilosopherRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: PhilosopherOutputV1;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options ───────────────────────────────────────────────────────

export interface PhilosopherRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedPhilosopherRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_PHILOSOPHER_RUNNER_OPTIONS: Readonly<Omit<ResolvedPhilosopherRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'philosopher',
} as const;

function resolvePhilosopherRunnerOptions(options: PhilosopherRunnerOptions): ResolvedPhilosopherRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_PHILOSOPHER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_PHILOSOPHER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_PHILOSOPHER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_PHILOSOPHER_RUNNER_OPTIONS.agentId,
  };
}

// ── Dependencies ──────────────────────────────────────────────────────────────

export interface PhilosopherRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: PhilosopherValidator;
  readonly artifactStore: PIArtifactStore;
}

// ── Context types for error handling ──────────────────────────────────────────

interface FailureContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errorCategory: PDErrorCategory;
  readonly failureReason: string;
}

interface SucceedContext {
  readonly taskId: string;
  readonly runId: string;
  readonly output: PhilosopherOutputV1;
  readonly task: TaskRecord;
  readonly contextHash: string;
}

interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

// ── PhilosopherRunner ──────────────────────────────────────────────────────────

export class PhilosopherRunner {
  private phase: RunnerPhase = RunnerPhase.Idle;
  private readonly resolvedOptions: ResolvedPhilosopherRunnerOptions;
  private readonly stateManager: RuntimeStateManager;
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly validator: PhilosopherValidator;
  private readonly artifactStore: PIArtifactStore;

  constructor(deps: PhilosopherRunnerDeps, options: PhilosopherRunnerOptions) {
    this.stateManager = deps.stateManager;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.validator = deps.validator;
    this.artifactStore = deps.artifactStore;
    this.resolvedOptions = resolvePhilosopherRunnerOptions(options);
  }

  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  private emitPhilosopherEvent(
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

  async run(taskId: string): Promise<PhilosopherRunnerResult> {
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

    if (leasedTask.taskKind !== 'philosopher') {
      this.emitPhilosopherEvent('philosopher_wrong_task_kind', taskId, {
        expectedKind: 'philosopher',
        actualKind: leasedTask.taskKind,
      });
      await this.stateManager.markTaskFailed(taskId, 'input_invalid');
      return {
        status: 'failed',
        taskId,
        errorCategory: 'input_invalid',
        failureReason: `Task kind must be 'philosopher', got '${leasedTask.taskKind}'`,
        attemptCount: leasedTask.attemptCount,
      };
    }

    this.emitPhilosopherEvent('philosopher_task_leased', taskId, {
      taskKind: 'philosopher',
      attemptCount: leasedTask.attemptCount,
    });

    try {
      const storeRunId = await this.resolveStoreRunId(taskId);

      this.phase = RunnerPhase.BuildingContext;
      const { contextHash, dreamerArtifact, sourceDreamerArtifactId } = await this.buildContext(taskId);

      if (!dreamerArtifact) {
        return this.retryOrFail({
          taskId,
          task: leasedTask,
          errorCategory: 'input_invalid',
          failureReason: 'Dreamer dependency artifact not found',
        });
      }

      this.emitPhilosopherEvent('philosopher_context_built', taskId, { contextHash });

      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime({ taskId, contextHash, dreamerArtifact, sourceDreamerArtifactId });

      this.emitPhilosopherEvent('philosopher_run_started', taskId, {
        runtimeKind: this.resolvedOptions.runtimeKind,
      });

      this.phase = RunnerPhase.Polling;
      const finalStatus = await this.pollUntilTerminal(runHandle);

      if (finalStatus.status !== 'succeeded') {
        return await this.handleRuntimeFailure(taskId, leasedTask, finalStatus);
      }

      this.phase = RunnerPhase.FetchingOutput;
      const output = await this.fetchAndParseOutput(runHandle.runId);

      // Re-inject taskId stripped by stripLineageFields (PRI-272 / ERR-008).
      (output as unknown as Record<string, unknown>).taskId = taskId;

      this.phase = RunnerPhase.Validating;
      const validationResult = await this.validator.validate(output, taskId);
      if (!validationResult.valid) {
        return await this.handleValidationError({
          taskId,
          task: leasedTask,
          errors: validationResult.errors,
          errorCategory: validationResult.errorCategory,
        });
      }

      this.emitPhilosopherEvent('philosopher_output_validated', taskId, {
        principleTitle: output.principleCandidate.title,
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

  // ── Phase methods ─────────────────────────────────────────────────────────

  private async buildContext(taskId: string): Promise<{ contextHash: string; dreamerArtifact: string | null; sourceDreamerArtifactId: string | null }> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    if (deps.length === 0) {
      this.emitPhilosopherEvent('philosopher_no_dependencies', taskId, {});
      return { contextHash: 'empty', dreamerArtifact: null, sourceDreamerArtifactId: null };
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.status !== 'succeeded') {
        this.emitPhilosopherEvent('philosopher_dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const depPiTask = hydratePITaskRecord(depTask);
      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = depPiTask?.outputArtifactRefs?.[0]?.ref ?? `pi-artifact://${depId}`;
        return {
          contextHash: PhilosopherRunner.hashContextRefs([artifactRef]),
          dreamerArtifact: firstArtifact.contentJson,
          sourceDreamerArtifactId: firstArtifact.artifactId,
        };
      }
    }

    this.emitPhilosopherEvent('philosopher_no_dreamer_artifact', taskId, {});
    return { contextHash: 'empty', dreamerArtifact: null, sourceDreamerArtifactId: null };
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
    dreamerArtifact: string | null;
    sourceDreamerArtifactId: string | null;
  }): Promise<RunHandle> {
    let parsedDreamerArtifact: unknown = null;
    if (params.dreamerArtifact) {
      try {
        parsedDreamerArtifact = JSON.parse(params.dreamerArtifact);
      } catch {
        parsedDreamerArtifact = params.dreamerArtifact;
      }
    }

    const builder = new PhilosopherPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId: params.taskId,
      contextHash: params.contextHash,
      dreamerArtifact: parsedDreamerArtifact,
      sourceDreamerArtifactId: params.sourceDreamerArtifactId ?? '',
    });

    const startInput: StartRunInput = {
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: params.taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'philosopher-output-v1',
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

    let cancelFailed = false;
    try {
      await this.runtimeAdapter.cancelRun(runHandle.runId);
    } catch (cancelErr) {
      cancelFailed = true;
      this.emitPhilosopherEvent('philosopher_cancel_run_failed', runHandle.runId, {
        runId: runHandle.runId,
        errorMessage: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
    const cancelNote = cancelFailed ? ' (cancelRun also failed)' : '';
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms${cancelNote}`);
  }

  private async fetchAndParseOutput(runId: string): Promise<PhilosopherOutputV1> {
    const result = await this.runtimeAdapter.fetchOutput(runId);
    if (!result || !result.payload) {
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }
    return result.payload as PhilosopherOutputV1;
  }

  private async succeedTask(ctx: SucceedContext): Promise<PhilosopherRunnerResult> {
    try {
      await this.stateManager.updateRunOutput(ctx.runId, JSON.stringify(ctx.output));
    } catch (updateErr) {
      this.emitPhilosopherEvent('philosopher_update_output_failed', ctx.taskId, {
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
      this.emitPhilosopherEvent('philosopher_artifact_write_failed', ctx.taskId, {
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

    const resultRef = `philosopher://${ctx.runId}`;
    try {
      await this.stateManager.markTaskSucceeded(ctx.taskId, resultRef);
    } catch (stateErr) {
      this.emitPhilosopherEvent('philosopher_mark_succeeded_failed', ctx.taskId, {
        taskId: ctx.taskId,
        runId: ctx.runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitPhilosopherEvent('philosopher_task_succeeded', ctx.taskId, {
      attemptCount: ctx.task.attemptCount,
      resultRef,
      principleTitle: ctx.output.principleCandidate.title,
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
  ): Promise<PhilosopherRunnerResult> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status);

    this.emitPhilosopherEvent('philosopher_run_failed', taskId, {
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

  private async handleValidationError(ctx: ValidationErrorContext): Promise<PhilosopherRunnerResult> {
    const category = (ctx.errorCategory ?? 'output_invalid') as PDErrorCategory;

    this.emitPhilosopherEvent('philosopher_output_invalid', ctx.taskId, {
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
  ): Promise<PhilosopherRunnerResult> {
    const classified = this.classifyError(error);

    if (classified.category === 'lease_conflict') {
      this.emitPhilosopherEvent('philosopher_run_failed', taskId, {
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

    this.emitPhilosopherEvent('philosopher_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    const task: TaskRecord = {
      taskId,
      taskKind: 'philosopher',
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
  ): Promise<PhilosopherRunnerResult> {
    const classified = this.classifyError(error);

    this.emitPhilosopherEvent('philosopher_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async retryOrFail(ctx: FailureContext): Promise<PhilosopherRunnerResult> {
    if (this.isPermanentError(ctx.errorCategory)) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitPhilosopherEvent('philosopher_mark_failed_error', ctx.taskId, {
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
      this.emitPhilosopherEvent('philosopher_task_failed', ctx.taskId, {
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
        this.emitPhilosopherEvent('philosopher_mark_retry_error', ctx.taskId, {
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
      this.emitPhilosopherEvent('philosopher_task_retried', ctx.taskId, {
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
      this.emitPhilosopherEvent('philosopher_mark_failed_error', ctx.taskId, {
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
    this.emitPhilosopherEvent('philosopher_task_failed', ctx.taskId, {
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

  // ── Error classification ──────────────────────────────────────────────────

  private readonly PERMANENT_ERROR_CATEGORIES: ReadonlySet<PDErrorCategory> = new Set(
    Object.freeze(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid'] as const),
  );

  private isPermanentError(category: PDErrorCategory): boolean {
    return this.PERMANENT_ERROR_CATEGORIES.has(category);
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

export { resolvePhilosopherRunnerOptions, DEFAULT_PHILOSOPHER_RUNNER_OPTIONS };
