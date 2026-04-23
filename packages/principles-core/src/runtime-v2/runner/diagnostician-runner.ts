/**
 * DiagnosticianRunner -- explicit runner-driven diagnostician execution.
 *
 * Replaces heartbeat-prompt-driven execution with a deterministic pipeline:
 *   lease -> build context -> invoke runtime -> poll -> fetch output -> validate -> succeed/fail
 *
 * Per D-01: Phase-based step pipeline, each phase is independent method.
 * Per D-02: Polling loop with configurable interval and timeout.
 * Per D-03: Retry with backoff on transient errors, fail on permanent.
 * Per D-04: All store operations through RuntimeStateManager.
 *
 * Runner does NOT:
 *   - Import from evolution-worker.ts or prompt.ts
 *   - Write artifact files (M5 scope)
 *   - Emit principle candidates (M5 scope)
 *   - Persist RunnerPhase to TaskStore
 */
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { ContextAssembler } from '../store/context-assembler.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  StartRunInput,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';
import type { DiagnosticianOutputV1, DiagnosticianInvocationInput } from '../diagnostician-output.js';
import type { TaskRecord } from '../task-status.js';
import type { PDErrorCategory } from '../error-categories.js';
import type { DiagnosticianRunnerOptions, ResolvedDiagnosticianRunnerOptions } from './diagnostician-runner-options.js';
import type { DiagnosticianValidator } from './diagnostician-validator.js';
import type { RunnerResult } from './runner-result.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { PDRuntimeError } from '../error-categories.js';
import { RunnerPhase } from './runner-phase.js';
import { resolveRunnerOptions } from './diagnostician-runner-options.js';

/** Dependencies injected into DiagnosticianRunner. */
export interface DiagnosticianRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly contextAssembler: ContextAssembler;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: DiagnosticianValidator;
}

/** Context for retry-or-fail decision. */
interface FailureContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errorCategory: PDErrorCategory;
  readonly failureReason: string;
}

/** Context for succeed-task phase. */
interface SucceedContext {
  readonly taskId: string;
  readonly runId: string;
  readonly output: DiagnosticianOutputV1;
  readonly task: TaskRecord;
  readonly contextHash: string;
}

/** Context for validation-error handling. */
interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: PDErrorCategory;
}

export class DiagnosticianRunner {
  private phase: RunnerPhase = RunnerPhase.Idle;
  private readonly resolvedOptions: ResolvedDiagnosticianRunnerOptions;
  private readonly stateManager: RuntimeStateManager;
  private readonly contextAssembler: ContextAssembler;
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly validator: DiagnosticianValidator;

  constructor(deps: DiagnosticianRunnerDeps, options: DiagnosticianRunnerOptions) {
    this.stateManager = deps.stateManager;
    this.contextAssembler = deps.contextAssembler;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.validator = deps.validator;
    this.resolvedOptions = resolveRunnerOptions(options);
  }

  /** Get the current internal phase. For testing/observability only. */
  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  /**
   * Emit a diagnostician telemetry event via the store event emitter.
   */
  private emitDiagnosticianEvent(
    eventType: string,
    taskId: string,
    payload: Record<string, unknown>,
  ): void {
    this.eventEmitter.emitTelemetry({
      eventType: eventType as TelemetryEvent['eventType'],
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: this.resolvedOptions.owner,
      agentId: 'diagnostician',
      payload,
    });
  }

  /**
   * Execute the full diagnostician lifecycle for a task.
   *
   * The runner does NOT hold mutable state between run() calls.
   * Each invocation is independent.
   */
  async run(taskId: string): Promise<RunnerResult> {
    this.phase = RunnerPhase.Idle;
    try {
      // 1. Acquire lease (atomically creates RunRecord in the store)
      const leasedTask = await this.stateManager.acquireLease({
        taskId,
        owner: this.resolvedOptions.owner,
        runtimeKind: this.resolvedOptions.runtimeKind,
      });

      // Emit: diagnostician_task_leased
      this.emitDiagnosticianEvent('diagnostician_task_leased', taskId, {
        taskKind: leasedTask.taskKind,
        attemptCount: leasedTask.attemptCount,
      });

      // Look up the store's runId for this attempt (acquireLease creates it).
      // The adapter's RunHandle.runId is separate from the store's runId.
      const storeRunId = await this.resolveStoreRunId(taskId);

      // 2. Build context
      this.phase = RunnerPhase.BuildingContext;
      const context = await this.buildContext(taskId);
      const contextHash: string = context.contextHash;

      // Emit: diagnostician_context_built
      this.emitDiagnosticianEvent('diagnostician_context_built', taskId, {
        contextHash,
        sourceCount: context.sourceRefs.length,
      });

      // 3. Invoke runtime (skip CreatingRun -- acquireLease already created it)
      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime(context, taskId);

      // Emit: diagnostician_run_started
      this.emitDiagnosticianEvent('diagnostician_run_started', taskId, {
        runtimeKind: this.resolvedOptions.runtimeKind,
      });

      // 4. Poll until terminal
      this.phase = RunnerPhase.Polling;
      const finalStatus = await this.pollUntilTerminal(runHandle);

      // 5. Handle non-success terminal states
      if (finalStatus.status !== 'succeeded') {
        return await this.handleRuntimeFailure(taskId, leasedTask, finalStatus);
      }

      // 6. Fetch output
      this.phase = RunnerPhase.FetchingOutput;
      const output = await this.fetchAndParseOutput(runHandle.runId);

      // 7. Validate (delegate to validator)
      this.phase = RunnerPhase.Validating;
      const validationResult = await this.validator.validate(output, taskId);
      if (!validationResult.valid) {
        return await this.handleValidationError({
          taskId, task: leasedTask, errors: validationResult.errors, errorCategory: validationResult.errorCategory,
        });
      }

      // 8. Succeed task -- store output and mark succeeded using store's runId
      return await this.succeedTask({ taskId, runId: storeRunId, output, task: leasedTask, contextHash });
    } catch (error) {
      return await this.handleLeaseOrPhaseError(taskId, error);
    }
  }

  // -- Phase methods (each independently testable) --

  private async buildContext(taskId: string): Promise<DiagnosticianContextPayload> {
    return this.contextAssembler.assemble(taskId);
  }

  /**
   * Resolve the store's runId for the latest run of a task.
   * acquireLease creates a RunRecord with a deterministic ID (run_{taskId}_{attempt}).
   * The adapter's RunHandle.runId is separate -- we need the store's ID for
   * updateRunOutput and other store operations.
   */
  private async resolveStoreRunId(taskId: string): Promise<string> {
    const runs = await this.stateManager.getRunsByTask(taskId);
    const latestRun = runs[runs.length - 1];
    if (!latestRun) {
      throw new PDRuntimeError('storage_unavailable', `No run record found for task ${taskId} after lease acquisition`);
    }
    return latestRun.runId;
  }

  private async invokeRuntime(context: DiagnosticianContextPayload, taskId: string): Promise<RunHandle> {
    const invocationInput: DiagnosticianInvocationInput = {
      agentId: 'diagnostician',
      taskId,
      context,
      outputSchemaRef: 'diagnostician-output-v1',
      timeoutMs: this.resolvedOptions.timeoutMs,
    };

    const startInput: StartRunInput = {
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: invocationInput,
      contextItems: [{ role: 'system', content: JSON.stringify(invocationInput) }],
      outputSchemaRef: 'diagnostician-output-v1',
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

    // Timeout -- cancel the run gracefully, preserving the timeout error
    try {
      await this.runtimeAdapter.cancelRun(runHandle.runId);
    } catch {
      // Cancellation failed but timeout error is the primary failure to report
    }
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms`);
  }

  private async fetchAndParseOutput(runId: string): Promise<DiagnosticianOutputV1> {
    const result = await this.runtimeAdapter.fetchOutput(runId);
    if (!result || !result.payload) {
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }
    return result.payload as DiagnosticianOutputV1;
  }

  private async succeedTask(ctx: SucceedContext): Promise<RunnerResult> {
    // Store output in run record (D-04)
    await this.stateManager.updateRunOutput(ctx.runId, JSON.stringify(ctx.output));

    // Mark task succeeded
    const resultRef = `run://${ctx.runId}`;
    await this.stateManager.markTaskSucceeded(ctx.taskId, resultRef);

    // Emit: diagnostician_task_succeeded
    this.emitDiagnosticianEvent('diagnostician_task_succeeded', ctx.taskId, {
      attemptCount: ctx.task.attemptCount,
      resultRef,
    });

    this.phase = RunnerPhase.Completed;
    return {
      status: 'succeeded',
      taskId: ctx.taskId,
      contextHash: ctx.contextHash,
      output: ctx.output,
      attemptCount: ctx.task.attemptCount,
    };
  }

  private async handleRuntimeFailure(
    taskId: string,
    task: TaskRecord,
    runStatus: RunStatus,
  ): Promise<RunnerResult> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status, runStatus.reason);

    // Emit: diagnostician_run_failed
    this.emitDiagnosticianEvent('diagnostician_run_failed', taskId, {
      runStatus: runStatus.status,
      errorCategory,
    });

    return this.retryOrFail({ taskId, task, errorCategory, failureReason: `Runtime execution ended with status: ${runStatus.status}` });
  }

  private async handleValidationError(ctx: ValidationErrorContext): Promise<RunnerResult> {
    const category = ctx.errorCategory ?? 'output_invalid';

    // Emit: diagnostician_output_invalid
    this.emitDiagnosticianEvent('diagnostician_output_invalid', ctx.taskId, {
      errorCount: ctx.errors.length,
      errorCategory: category,
    });

    return this.retryOrFail({ taskId: ctx.taskId, task: ctx.task, errorCategory: category, failureReason: `Validation failed: ${ctx.errors.join('; ')}` });
  }

  private async handleLeaseOrPhaseError(
    taskId: string,
    error: unknown,
  ): Promise<RunnerResult> {
    const classified = this.classifyError(error);

    // Emit: diagnostician_run_failed (for phase/lease errors before retry decision)
    this.emitDiagnosticianEvent('diagnostician_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    // When acquireLease fails we don't have a TaskRecord yet.
    // Build a synthetic one for retry policy evaluation.
    const task: TaskRecord = {
      taskId,
      taskKind: 'diagnostician',
      status: 'leased',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 1,
      maxAttempts: 3,
    };
    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async retryOrFail(ctx: FailureContext): Promise<RunnerResult> {
    // Check if error is permanent (never retry)
    if (this.isPermanentError(ctx.errorCategory)) {
      await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory);

      // Emit: diagnostician_task_failed (permanent)
      this.emitDiagnosticianEvent('diagnostician_task_failed', ctx.taskId, {
        errorCategory: ctx.errorCategory,
        attemptCount: ctx.task.attemptCount,
        failureReason: ctx.failureReason,
      });

      this.phase = RunnerPhase.Failed;
      return { status: 'failed', taskId: ctx.taskId, errorCategory: ctx.errorCategory, failureReason: ctx.failureReason, attemptCount: ctx.task.attemptCount };
    }

    // Check retry policy
    const shouldRetry = this.stateManager.getRetryPolicy().shouldRetry(ctx.task);
    if (shouldRetry) {
      await this.stateManager.markTaskRetryWait(ctx.taskId, ctx.errorCategory);

      // Emit: diagnostician_task_retried
      this.emitDiagnosticianEvent('diagnostician_task_retried', ctx.taskId, {
        errorCategory: ctx.errorCategory,
        attemptCount: ctx.task.attemptCount,
      });

      this.phase = RunnerPhase.Failed;
      return { status: 'retried', taskId: ctx.taskId, errorCategory: ctx.errorCategory, failureReason: ctx.failureReason, attemptCount: ctx.task.attemptCount };
    }

    // Max attempts exceeded
    await this.stateManager.markTaskFailed(ctx.taskId, 'max_attempts_exceeded');

    // Emit: diagnostician_task_failed (max_attempts_exceeded)
    this.emitDiagnosticianEvent('diagnostician_task_failed', ctx.taskId, {
      errorCategory: 'max_attempts_exceeded',
      attemptCount: ctx.task.attemptCount,
      failureReason: ctx.failureReason,
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

  // -- Error classification --

  private readonly PERMANENT_ERROR_CATEGORIES: ReadonlySet<PDErrorCategory> = new Set([
    'storage_unavailable',
    'workspace_invalid',
    'capability_missing',
  ]);

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
  private mapRunStatusToErrorCategory(status: string, _reason?: string): PDErrorCategory {
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
