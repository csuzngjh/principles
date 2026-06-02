/**
 * DreamerRunner — First real peer runner for the Internalization Engine (PRI-67).
 *
 * Follows the lease → build context → invoke runtime → poll → fetch output →
 * validate → succeed/fail pipeline established by DiagnosticianRunner.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Philosopher/Scribe (host layer enqueues next task)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - No timer-based scheduling (sleep via setTimeout is polling-only, not cron-like)
 *   - Uses RuntimeStateManager for all state operations
 *
 * Pipeline (same as DiagnosticianRunner):
 *   1. acquireLease — isolated try/catch, lease_conflict is non-mutating
 *   2. resolve store runId via getRunsByTask
 *   3. resolve predecessor context from dependencyTaskIds (no ContextAssembler)
 *   4. startRun with outputSchemaRef: 'dreamer-output-v1'
 *   5. pollUntilTerminal
 *   6. fetchOutput → parse as DreamerOutput
 *   7. validate via DreamerValidator
 *   8. updateRunOutput → persist serialized output
 *   9. markTaskSucceeded with 'dreamer://' + storeRunId
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
import type { DreamerOutput, DreamerValidator } from './dreamer-output.js';
import type { PIArtifactStore } from './pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { RunnerPhase } from '../runner/runner-phase.js';
import { DreamerPromptBuilder } from './dreamer-prompt-builder.js';

// ── Result Types ─────────────────────────────────────────────────────────────

export type DreamerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface DreamerRunnerResult {
  readonly status: DreamerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: DreamerOutput;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options ───────────────────────────────────────────────────────

export interface DreamerRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedDreamerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_DREAMER_RUNNER_OPTIONS: Readonly<Omit<ResolvedDreamerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'dreamer',
} as const;

function resolveDreamerRunnerOptions(options: DreamerRunnerOptions): ResolvedDreamerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_DREAMER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_DREAMER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_DREAMER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_DREAMER_RUNNER_OPTIONS.agentId,
  };
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DreamerRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
  readonly validator: DreamerValidator;
  readonly artifactStore: PIArtifactStore;
}

// ── Context types for error handling ─────────────────────────────────────────

interface FailureContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errorCategory: PDErrorCategory;
  readonly failureReason: string;
}

interface SucceedContext {
  readonly taskId: string;
  readonly runId: string;
  readonly output: DreamerOutput;
  readonly task: TaskRecord;
  readonly contextHash: string;
}

interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: PDErrorCategory;
}

// ── DreamerRunner ─────────────────────────────────────────────────────────────

export class DreamerRunner {
  private phase: RunnerPhase = RunnerPhase.Idle;
  private readonly resolvedOptions: ResolvedDreamerRunnerOptions;
  private readonly stateManager: RuntimeStateManager;
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly validator: DreamerValidator;
  private readonly artifactStore: PIArtifactStore;

  constructor(deps: DreamerRunnerDeps, options: DreamerRunnerOptions) {
    this.stateManager = deps.stateManager;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.validator = deps.validator;
    this.artifactStore = deps.artifactStore;
    this.resolvedOptions = resolveDreamerRunnerOptions(options);
  }

  /** Get the current internal phase. For testing/observability only. */
  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  private emitDreamerEvent(
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

  /**
   * Execute the full Dreamer lifecycle for a task.
   *
   * The runner does NOT hold mutable state between run() calls.
   * Each invocation is independent.
   */
  async run(taskId: string): Promise<DreamerRunnerResult> {
    this.phase = RunnerPhase.Idle;

    // 1. Acquire lease — isolated try/catch so lease_conflict never uses synthetic TaskRecord
     
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

    this.emitDreamerEvent('dreamer_task_leased', taskId, {
      taskKind: 'dreamer',
      attemptCount: leasedTask.attemptCount,
    });

    if (leasedTask.taskKind !== 'dreamer') {
      this.emitDreamerEvent('dreamer_wrong_task_kind', taskId, {
        expectedKind: 'dreamer',
        actualKind: leasedTask.taskKind,
      });
      await this.stateManager.markTaskFailed(taskId, 'input_invalid');
      return {
        status: 'failed',
        taskId,
        errorCategory: 'input_invalid',
        failureReason: `Task kind must be 'dreamer', got '${leasedTask.taskKind}'`,
        attemptCount: leasedTask.attemptCount,
      };
    }

    // All subsequent errors use the real leasedTask — no synthetic TaskRecord allowed
    try {
      // acquireLease creates a RunRecord; resolve its runId for store operations
      const storeRunId = await this.resolveStoreRunId(taskId);

      // 2. Build context from predecessor task outputs (no ContextAssembler)
      this.phase = RunnerPhase.BuildingContext;
      const { contextHash, contextRefs, predecessorOutput } = await this.buildContext(taskId);

      this.emitDreamerEvent('dreamer_context_built', taskId, { contextHash });

      // 3. Invoke runtime
      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime({ taskId, contextHash, contextRefs, predecessorOutput });

      this.emitDreamerEvent('dreamer_run_started', taskId, {
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
      const output = await this.fetchAndParseOutput(runHandle.runId, taskId);

      // Re-inject taskId stripped by stripLineageFields (PRI-272 / ERR-008).
      // The runner owns the correct taskId; LLM-supplied values must not be trusted.
      (output as unknown as Record<string, unknown>).taskId = taskId;

      // 7. Validate
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

      this.emitDreamerEvent('dreamer_output_validated', taskId, {
        candidateCount: output.candidates.length,
      });

      // 8. Succeed task
      return await this.succeedTask({
        taskId,
        runId: storeRunId,
        output,
        task: leasedTask,
        contextHash,
      });
    } catch (error) {
      // handleLeaseOrPhaseError is only for lease errors (before lease).
      // Post-lease errors use retryOrFail with the real leasedTask.
      return await this.handlePostLeaseError(taskId, leasedTask, error);
    }
  }

  // ── Phase methods ─────────────────────────────────────────────────────────

  /**
   * Build context from predecessor task outputs.
   *
   * Dreamer doesn't use ContextAssembler — it resolves predecessor context
   * from dependencyTaskIds via stateManager.getTask(). The predecessor's
   * resultRef/outputArtifactRefs become the Dreamer's input context.
   *
   * Degradation semantics (intentional partial failure):
   *   - If ALL dependencies fail → builds empty context (continues, not fail-closed)
   *   - If SOME dependencies fail → builds partial context + emits dreamer_context_partial
   *   - Only fulfilled results contribute contextRefs
   *
   * This is a deliberate design choice: Dreamer can produce output with partial
   * context, whereas the host layer's task-ready validation is fail-closed.
   * Partial context is reported via telemetry.
   *
   * @see hydratePITaskRecord (PRI-65) for fail-closed PI metadata access
   */
  private async buildContext(taskId: string): Promise<{ contextHash: string; contextRefs: string[]; predecessorOutput: unknown }> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    const contextRefs: string[] = [];
    const rejectedDeps: string[] = [];
    let predecessorOutput: unknown = null;
    if (deps.length > 0) {
      const results = await Promise.allSettled(
        deps.map((depId) => this.stateManager.getTask(depId)),
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const depId = deps[i];
        if (!result || depId === undefined) continue;
        if (result.status === 'rejected') {
          rejectedDeps.push(depId);
        } else if (result.status === 'fulfilled' && result.value) {
          if (result.value.resultRef) {
            contextRefs.push(result.value.resultRef);
          }
          const depPiTask = result.value ? hydratePITaskRecord(result.value) : null;
          if (depPiTask?.outputArtifactRefs) {
            contextRefs.push(...depPiTask.outputArtifactRefs.map((a) => a.ref));
          }
          if (result.value.status === 'succeeded' && predecessorOutput === null) {
            const artifacts = await this.artifactStore.listBySourceTaskId(depId);
            if (artifacts.length > 0 && artifacts[0]) {
              try {
                predecessorOutput = JSON.parse(artifacts[0].contentJson);
              } catch {
                predecessorOutput = artifacts[0].contentJson;
              }
            }
          }
        }
      }
    }

    if (rejectedDeps.length > 0) {
      this.emitDreamerEvent('dreamer_context_partial', taskId, {
        rejectedCount: rejectedDeps.length,
        rejectedDeps,
      });
    }

    const contextHash = DreamerRunner.hashContextRefs(contextRefs);

    return { contextHash, contextRefs, predecessorOutput };
  }

  /**
   * Compute a deterministic hash from context references.
   * Used for telemetry and result tracking, not for caching.
   */
  private static hashContextRefs(refs: readonly string[]): string {
    if (refs.length === 0) return 'empty';
    // Simple deterministic hash via DJB2-style accumulator
    // Not cryptographic — only used for observability
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

  private async resolveLineageArtifactIds(taskId: string): Promise<{ ids: string[]; hasRejected: boolean }> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) return { ids: [], hasRejected: false };

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];
    if (deps.length === 0) return { ids: [], hasRejected: false };

    const lineageIds: string[] = [];
    let hasRejected = false;
    const results = await Promise.allSettled(
      deps.map((depId) => this.artifactStore.listBySourceTaskId(depId)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const artifact of result.value) {
          lineageIds.push(artifact.artifactId);
        }
      } else {
        hasRejected = true;
      }
    }
    return { ids: lineageIds, hasRejected };
  }

  private async invokeRuntime(params: {
    taskId: string;
    contextHash: string;
    contextRefs: readonly string[];
    predecessorOutput: unknown;
  }): Promise<RunHandle> {
    const builder = new DreamerPromptBuilder();
    const { message } = builder.buildPrompt({
      taskId: params.taskId,
      contextHash: params.contextHash,
      contextRefs: params.contextRefs,
      predecessorOutput: params.predecessorOutput,
    });

    const startInput: StartRunInput = {
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: params.taskId },
      inputPayload: message,
      contextItems: [],
      outputSchemaRef: 'dreamer-output-v1',
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

    // Timeout — cancel gracefully, preserve timeout error with cancel status
    let cancelFailed = false;
    try {
      await this.runtimeAdapter.cancelRun(runHandle.runId);
    } catch (cancelErr) {
      cancelFailed = true;
      this.emitDreamerEvent('dreamer_cancel_run_failed', runHandle.runId, {
        runId: runHandle.runId,
        errorMessage: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
    const cancelNote = cancelFailed ? ' (cancelRun also failed)' : '';
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms${cancelNote}`);
  }

  private async fetchAndParseOutput(runId: string, taskId: string): Promise<DreamerOutput> {
    const result = await this.fetchOutputWithTelemetry(runId, taskId);
    if (!result || !result.payload) {
      this.emitDreamerEvent('dreamer_output_extraction_failed', taskId, {
        runId,
        stage: 'payload_missing',
        errorMessage: `No output available for run ${runId}`,
      });
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }
    const payload = result.payload as Record<string, unknown>;
    if (typeof payload !== 'object' || payload === null) {
      this.emitDreamerEvent('dreamer_output_extraction_failed', taskId, {
        runId,
        stage: 'payload_not_object',
        errorMessage: `Output payload is not an object for run ${runId}`,
      });
      throw new PDRuntimeError('output_invalid', `Output payload is not an object for run ${runId}`);
    }
    return result.payload as DreamerOutput;
  }

  private async fetchOutputWithTelemetry(runId: string, taskId: string): Promise<Awaited<ReturnType<PDRuntimeAdapter['fetchOutput']>>> {
    try {
      return await this.runtimeAdapter.fetchOutput(runId);
    } catch (fetchErr) {
      this.emitDreamerEvent('dreamer_output_extraction_failed', taskId, {
        runId,
        stage: 'fetchOutput',
        errorMessage: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      });
      throw fetchErr;
    }
  }

  private async succeedTask(ctx: SucceedContext): Promise<DreamerRunnerResult> {
    // Store output before marking succeeded so run record reflects output
    try {
      await this.stateManager.updateRunOutput(ctx.runId, JSON.stringify(ctx.output));
    } catch (updateErr) {
      this.emitDreamerEvent('dreamer_update_output_failed', ctx.taskId, {
        runId: ctx.runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    // Emit per-candidate telemetry
    for (const candidate of ctx.output.candidates) {
      this.emitDreamerEvent('dreamer_candidate_generated', ctx.taskId, {
        candidateIndex: candidate.candidateIndex,
        confidence: candidate.confidence,
        riskLevel: candidate.riskLevel,
      });
    }

    // Write PIArtifact via artifactStore (idempotent upsert)
    // PIArtifact is the core durable output of DreamerRunner.
    // If artifact write fails, the task must NOT be marked succeeded —
    // downstream runners (Philosopher/Scribe) require durable artifact input.
    let lineageArtifactIds: string[] = [];
    let lineageHasRejected = false;
    try {
      const lineageResult = await this.resolveLineageArtifactIds(ctx.taskId);
      lineageArtifactIds = lineageResult.ids;
      lineageHasRejected = lineageResult.hasRejected;
    } catch (lineageErr) {
      this.emitDreamerEvent('dreamer_lineage_resolve_failed', ctx.taskId, {
        runId: ctx.runId,
        errorMessage: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
      });
    }

    if (lineageHasRejected) {
      this.emitDreamerEvent('dreamer_lineage_partial', ctx.taskId, {
        runId: ctx.runId,
        resolvedCount: lineageArtifactIds.length,
        warning: 'Some dependency artifact queries were rejected; lineage may be incomplete',
      });
    }

    const artifactId = `pi-art-${ctx.taskId}-${ctx.runId}`;
    const now = new Date().toISOString();
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
      this.emitDreamerEvent('dreamer_artifact_write_failed', ctx.taskId, {
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

    // Mark task succeeded with dreamer:// resultRef
    const resultRef = `dreamer://${ctx.runId}`;
    try {
      await this.stateManager.markTaskSucceeded(ctx.taskId, resultRef);
    } catch (stateErr) {
      this.emitDreamerEvent('dreamer_mark_succeeded_failed', ctx.taskId, {
        taskId: ctx.taskId,
        runId: ctx.runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitDreamerEvent('dreamer_task_succeeded', ctx.taskId, {
      attemptCount: ctx.task.attemptCount,
      resultRef,
      candidateCount: ctx.output.candidates.length,
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
  ): Promise<DreamerRunnerResult> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status, runStatus.reason);

    this.emitDreamerEvent('dreamer_run_failed', taskId, {
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

  private async handleValidationError(ctx: ValidationErrorContext): Promise<DreamerRunnerResult> {
    const category = ctx.errorCategory ?? 'output_invalid';

    this.emitDreamerEvent('dreamer_output_invalid', ctx.taskId, {
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
  ): Promise<DreamerRunnerResult> {
    const classified = this.classifyError(error);

    // lease_conflict is concurrent-access conflict, not a state change.
    // No mutation methods (markTaskFailed/markTaskRetryWait) are called.
    if (classified.category === 'lease_conflict') {
      this.emitDreamerEvent('dreamer_run_failed', taskId, {
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

    // Non-lease errors (e.g., storage_unavailable before lease) must not
    // use synthetic TaskRecord. Build one with real defaults from options.
    this.emitDreamerEvent('dreamer_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    const task: TaskRecord = {
      taskId,
      taskKind: 'dreamer',
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
  ): Promise<DreamerRunnerResult> {
    const classified = this.classifyError(error);

    this.emitDreamerEvent('dreamer_run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async retryOrFail(ctx: FailureContext): Promise<DreamerRunnerResult> {
    // Check if error is permanent (never retry)
    if (this.isPermanentError(ctx.errorCategory)) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitDreamerEvent('dreamer_mark_failed_error', ctx.taskId, {
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
      this.emitDreamerEvent('dreamer_task_failed', ctx.taskId, {
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

    // Check retry policy
    const shouldRetry = this.stateManager.getRetryPolicy().shouldRetry(ctx.task);
    if (shouldRetry) {
      try {
        await this.stateManager.markTaskRetryWait(ctx.taskId, ctx.errorCategory);
      } catch (stateErr) {
        this.emitDreamerEvent('dreamer_mark_retry_error', ctx.taskId, {
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
      this.emitDreamerEvent('dreamer_task_retried', ctx.taskId, {
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

    // Max attempts exceeded
    try {
      await this.stateManager.markTaskFailed(ctx.taskId, 'max_attempts_exceeded');
    } catch (stateErr) {
      this.emitDreamerEvent('dreamer_mark_failed_error', ctx.taskId, {
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
    this.emitDreamerEvent('dreamer_task_failed', ctx.taskId, {
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

// ── Exports ───────────────────────────────────────────────────────────────────

export { resolveDreamerRunnerOptions, DEFAULT_DREAMER_RUNNER_OPTIONS };