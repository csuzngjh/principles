/**
 * BasePeerRunner — Abstract base class for all peer runners (PRI-302).
 *
 * Extracts the shared lease → buildContext → invoke → poll → fetch →
 * validate → succeed/fail pipeline from 8 duplicated runner implementations.
 *
 * Subclasses implement:
 *   - permanentErrorCategories (abstract getter)
 *   - buildContext() — runner-specific context assembly
 *   - invokeRuntime() — runner-specific LLM invocation
 *   - validateOutput() — runner-specific output validation
 *   - succeedTask() — runner-specific artifact commit + task success
 *
 * Optional hooks:
 *   - emitSuccessTelemetry() — runner-specific success telemetry (default: no-op)
 *   - checkLineageIntegrity() — lineage strip contract check (default: no-op)
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see Linear PRI-302
 */

import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  RuntimeKind,
} from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory } from '../error-categories.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import { RunnerPhase } from './runner-phase.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../config/pd-config-feature-flags.js';
import type {
  PeerRunnerOptions,
  ResolvedPeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerConfig,
  PeerRunnerResult,
  PeerRunnerValidationResult,
  FailureContext,
} from './peer-runner-types.js';

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_PEER_RUNNER_OPTIONS: Readonly<Omit<ResolvedPeerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'peer-runner',
  coreGrounding: true,
} as const;

function resolvePeerRunnerOptions(
  options: PeerRunnerOptions,
  defaultAgentId: string,
): ResolvedPeerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_PEER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_PEER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_PEER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? defaultAgentId,
    outputLanguage: options.outputLanguage,
    coreGrounding: options.coreGrounding ?? true,
  };
}

// ── BasePeerRunner ───────────────────────────────────────────────────────────

/**
 * Abstract base class for peer runners.
 *
 * TContext — the type returned by buildContext(). Must include contextHash.
 * TOutput — the type of the validated LLM output.
 */
export abstract class BasePeerRunner<TContext extends { contextHash: string }, TOutput> {
  // ── Shared dependencies (protected for subclass access) ──
  protected readonly stateManager: RuntimeStateManager;
  protected readonly runtimeAdapter: PDRuntimeAdapter;
  protected readonly eventEmitter: StoreEventEmitter;
  protected readonly artifactStore: PIArtifactStore;
  protected readonly resolvedOptions: ResolvedPeerRunnerOptions;
  protected readonly config: PeerRunnerConfig;
  private phase: RunnerPhase = RunnerPhase.Idle;

  constructor(
    deps: PeerRunnerDeps,
    options: PeerRunnerOptions,
    config: PeerRunnerConfig,
  ) {
    this.stateManager = deps.stateManager;
    this.runtimeAdapter = deps.runtimeAdapter;
    this.eventEmitter = deps.eventEmitter;
    this.artifactStore = deps.artifactStore;
    this.config = config;
    this.resolvedOptions = resolvePeerRunnerOptions(options, config.defaultAgentId);
  }

  // ── Observability ──────────────────────────────────────────────────────────

  /** Current internal phase. For testing/observability only. */
  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  private getRuntimeKind(): RuntimeKind {
    return (typeof this.runtimeAdapter.kind === 'function'
      ? this.runtimeAdapter.kind()
      : this.resolvedOptions.runtimeKind) as RuntimeKind;
  }

  // ── Abstract: subclass must implement ───────────────────────────────────────

  /** Permanent error categories — runner's inherent property. */
  abstract get permanentErrorCategories(): ReadonlySet<PDErrorCategory>;

  /** Build runner-specific context from task and predecessor outputs. */
  abstract buildContext(taskId: string): Promise<TContext>;

  /** Invoke the runtime with runner-specific prompt builder. */
  abstract invokeRuntime(taskId: string, context: TContext): Promise<RunHandle>;

  /** Validate the LLM output. Receives untrusted data — must perform runtime validation. */
  abstract validateOutput(output: unknown, taskId: string, context: TContext): Promise<PeerRunnerValidationResult>;

  /** Commit artifact + mark task succeeded. Runner-specific commit strategy. */
  abstract succeedTask(
    taskId: string,
    runId: string,
    output: TOutput,
    task: TaskRecord,
    contextHash: string,
    context: TContext,
  ): Promise<PeerRunnerResult<TOutput>>;

  // ── Optional hooks (default no-op) ─────────────────────────────────────────

  /** Emit runner-specific success telemetry. Called after validation passes. */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected emitSuccessTelemetry(_taskId: string, _output: TOutput, _context: TContext): void {
    // default no-op
  }

  /**
   * Check lineage strip contract. Called AFTER validation passes.
   * Receives validated output and context — safe to treat as TOutput / TContext.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected checkLineageIntegrity(_taskId: string, _output: TOutput, _context: TContext): void {
    // default no-op
  }

  /**
   * Transform output after fetch, before validation.
   * Used by runners that need to re-inject lineage fields stripped by the adapter.
   * Receives untrusted data — must NOT assume TOutput shape.
   *
   * Base implementation overrides `generatedAt` with the actual current timestamp,
   * because LLM may echo the prompt's example date instead of generating the real time.
   * Unconditionally sets `generatedAt` — if the LLM omitted it, we add it; if the LLM
   * echoed a stale date, we replace it. Subclasses should call `super.postFetchTransform()`
   * to inherit this behavior instead of duplicating the override.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected postFetchTransform(_taskId: string, untrustedOutput: unknown, _context: TContext): void {
    // Override generatedAt with actual timestamp — LLM may echo prompt example date
    if (typeof untrustedOutput === 'object' && untrustedOutput !== null && !Array.isArray(untrustedOutput)) {
      Reflect.set(untrustedOutput, 'generatedAt', new Date().toISOString());
    }
  }

  // ── Template method: full pipeline ─────────────────────────────────────────

  /**
   * Execute the full peer runner lifecycle for a task.
   *
   * Pipeline: lease → resolveRunId → buildContext → invoke → poll →
   *           fetch → validate → succeedTask (abstract)
   *
   * Each invocation is independent — no mutable state between run() calls.
   */
  async run(taskId: string): Promise<PeerRunnerResult<TOutput>> {
    this.phase = RunnerPhase.Idle;
    const runtimeKind = this.getRuntimeKind();

    // 1. Acquire lease — isolated try/catch so lease_conflict never uses synthetic TaskRecord
    let leasedTask: TaskRecord;
    try {
      leasedTask = await this.stateManager.acquireLease({
        taskId,
        owner: this.resolvedOptions.owner,
        runtimeKind,
      });
    } catch (error) {
      return await this.handleLeaseOrPhaseError(taskId, error);
    }

    // 1b. Validate task kind
    if (leasedTask.taskKind !== this.config.expectedTaskKind) {
      this.emitEvent('wrong_task_kind', taskId, {
        expectedKind: this.config.expectedTaskKind,
        actualKind: leasedTask.taskKind,
      });
      await this.stateManager.markTaskFailed(taskId, 'input_invalid');
      return {
        status: 'failed',
        taskId,
        errorCategory: 'input_invalid',
        failureReason: `Task kind must be '${this.config.expectedTaskKind}', got '${leasedTask.taskKind}'`,
        attemptCount: leasedTask.attemptCount,
      };
    }

    this.emitEvent('task_leased', taskId, {
      taskKind: this.config.expectedTaskKind,
      attemptCount: leasedTask.attemptCount,
    });

    // All subsequent errors use the real leasedTask — no synthetic TaskRecord allowed
    try {
      // 2. Resolve store runId
      const storeRunId = await this.resolveStoreRunId(taskId);

      // 3. Build context
      this.phase = RunnerPhase.BuildingContext;
      const context = await this.buildContext(taskId);
      this.emitEvent('context_built', taskId, { contextHash: context.contextHash });

      // 4. Invoke runtime
      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime(taskId, context);
      this.emitEvent('run_started', taskId, {
        runtimeKind,
      });

      // 5. Poll until terminal
      this.phase = RunnerPhase.Polling;
      const finalStatus = await this.pollUntilTerminal(runHandle);

      // 6. Handle non-success terminal states
      if (finalStatus.status !== 'succeeded') {
        return await this.handleRuntimeFailure(taskId, leasedTask, finalStatus);
      }

      // 7. Fetch output (returns unknown — untrusted LLM/runtime payload)
      this.phase = RunnerPhase.FetchingOutput;
      const untrustedOutput = await this.fetchAndParseOutput(runHandle.runId, taskId);

      // 7b. Post-fetch transform on untrusted data (e.g., re-inject lineage fields).
      // Operates on `unknown` — must NOT assume TOutput shape (ERR-001).
      this.postFetchTransform(taskId, untrustedOutput, context);

      // 8. Validate — the trust boundary. Only validated output becomes TOutput.
      this.phase = RunnerPhase.Validating;
      const validationResult = await this.validateOutput(untrustedOutput, taskId, context);
      if (!validationResult.valid) {
        return await this.handleValidationError({
          taskId,
          task: leasedTask,
          errors: validationResult.errors,
          errorCategory: validationResult.errorCategory,
        });
      }

      // Validation passed — safe to treat as TOutput.
      const output: TOutput = untrustedOutput as TOutput;

      this.emitEvent('output_validated', taskId, {});

      // 8b. Check lineage integrity (receives validated output and context)
      this.checkLineageIntegrity(taskId, output, context);

      // 8c. Emit success telemetry (receives validated output)
      this.emitSuccessTelemetry(taskId, output, context);

      // 9. Succeed task (abstract — subclass implements commit strategy)
      const result = await this.succeedTask(taskId, storeRunId, output, leasedTask, context.contextHash, context);
      if (result.status === 'succeeded') {
        this.phase = RunnerPhase.Completed;
      }
      return result;
    } catch (error) {
      // Post-lease errors use retryOrFail with the real leasedTask
      return await this.handlePostLeaseError(taskId, leasedTask, error);
    }
  }

  // ── Telemetry ──────────────────────────────────────────────────────────────

  /**
   * Emit a telemetry event with the runner's name prefix.
   * Event type: `{runnerName}_{eventType}`
   */
  protected emitEvent(
    eventType: string,
    taskId: string,
    payload: Record<string, unknown>,
  ): void {
    this.eventEmitter.emitTelemetry({
      eventType: `${this.config.runnerName}_${eventType}` as TelemetryEvent['eventType'],
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: this.resolvedOptions.owner,
      agentId: this.resolvedOptions.agentId,
      payload,
    });
  }

  // ── Polling ────────────────────────────────────────────────────────────────

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

    // Deadline reached — one final poll before cancelling
    try {
      const finalPoll = await this.runtimeAdapter.pollRun(runHandle.runId);
      if (terminalStatuses.includes(finalPoll.status)) {
        return finalPoll;
      }
    } catch { /* fall through to cancel/timeout */ }

    // Timeout — cancel gracefully
    let cancelFailed = false;
    try {
      await this.runtimeAdapter.cancelRun(runHandle.runId);
    } catch (cancelErr) {
      cancelFailed = true;
      this.emitEvent('cancel_run_failed', runHandle.runId, {
        runId: runHandle.runId,
        errorMessage: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
      });
    }
    const cancelNote = cancelFailed ? ' (cancelRun also failed)' : '';
    throw new PDRuntimeError('timeout', `Run ${runHandle.runId} timed out after ${this.resolvedOptions.timeoutMs}ms${cancelNote}`);
  }

  // ── Output fetching ────────────────────────────────────────────────────────

  /**
   * Fetch raw output from the runtime adapter.
   *
   * Returns `unknown` — the payload is untrusted LLM/runtime output.
   * Callers MUST validate before treating as TOutput (ERR-001, ERR-005).
   */
  private async fetchAndParseOutput(runId: string, taskId: string): Promise<unknown> {
    let result: Awaited<ReturnType<PDRuntimeAdapter['fetchOutput']>>;
    try {
      result = await this.runtimeAdapter.fetchOutput(runId);
    } catch (fetchErr) {
      this.emitEvent('output_extraction_failed', taskId, {
        runId,
        stage: 'fetchOutput',
        errorMessage: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      });
      throw fetchErr;
    }

    if (!result || !result.payload) {
      this.emitEvent('output_extraction_failed', taskId, {
        runId,
        stage: 'payload_missing',
        errorMessage: `No output available for run ${runId}`,
      });
      throw new PDRuntimeError('output_invalid', `No output available for run ${runId}`);
    }

    // Structural check: payload must be a non-null object.
    // This is NOT a type assertion — we still return `unknown`.
    const { payload } = result;
    if (typeof payload !== 'object' || payload === null) {
      this.emitEvent('output_extraction_failed', taskId, {
        runId,
        stage: 'payload_not_object',
        errorMessage: `Output payload is not an object for run ${runId}`,
      });
      throw new PDRuntimeError('output_invalid', `Output payload is not an object for run ${runId}`);
    }

    return payload;
  }

  // ── Lineage resolution ─────────────────────────────────────────────────────

  /** Resolve artifact IDs from predecessor tasks for lineage tracking. */
  protected async resolveLineageArtifactIds(taskId: string): Promise<{ ids: string[]; hasRejected: boolean }> {
    const { hydratePITaskRecord } = await import('../internalization/pitask-metadata.js');
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

  // ── Store helpers ──────────────────────────────────────────────────────────

  private async resolveStoreRunId(taskId: string): Promise<string> {
    // Tolerant read: a malformed HISTORICAL run row must not block recovery of
    // a task whose lease just created a fresh valid run. acquireLease always
    // inserts a valid 'running' run in the same transaction, so `runs` is
    // guaranteed non-empty here under normal operation. We observe any
    // degraded rows via telemetry (ERR-002) without throwing.
    const { runs, degradedRuns } = await this.stateManager.getValidRunsByTaskTolerant(taskId);
    if (degradedRuns.length > 0) {
      this.eventEmitter.emitTelemetry({
        eventType: 'degradation_triggered',
        traceId: taskId,
        timestamp: new Date().toISOString(),
        sessionId: this.resolvedOptions.owner,
        agentId: this.resolvedOptions.agentId,
        payload: {
          component: 'BasePeerRunner',
          runnerName: this.config.runnerName,
          trigger: 'malformed_historical_run_rows',
          degradedCount: degradedRuns.length,
          runIds: degradedRuns.map((r) => r.runId),
          errors: degradedRuns.map((r) => r.error),
          nextAction:
            'Quarantine malformed run rows: pd runtime internalization integrity-repair --confirm',
        },
      });
    }
    const latestRun = runs[runs.length - 1];
    if (!latestRun) {
      throw new PDRuntimeError(
        'execution_failed',
        `No valid run records found for task ${taskId} after lease acquisition. ` +
          `If historical runs are malformed, quarantine them first: pd runtime internalization integrity-repair --confirm`,
      );
    }
    return latestRun.runId;
  }

  /** Compute a deterministic hash from context references (observability only). */
  protected static hashContextRefs(refs: readonly string[]): string {
    if (refs.length === 0) return 'empty';
    const str = refs.join('|');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
    }
    return `ctx-${Math.abs(hash).toString(16)}`;
  }

  // ── Error handling ─────────────────────────────────────────────────────────

  private async handleLeaseOrPhaseError(
    taskId: string,
    error: unknown,
  ): Promise<PeerRunnerResult<TOutput>> {
    const classified = this.classifyError(error);

    // lease_conflict is concurrent-access conflict, not a state change.
    // No mutation methods (markTaskFailed/markTaskRetryWait) are called.
    if (classified.category === 'lease_conflict') {
      this.emitEvent('run_failed', taskId, {
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
    this.emitEvent('run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    const task: TaskRecord = {
      taskId,
      taskKind: this.config.expectedTaskKind,
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
  ): Promise<PeerRunnerResult<TOutput>> {
    const classified = this.classifyError(error);

    this.emitEvent('run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  private async handleRuntimeFailure(
    taskId: string,
    task: TaskRecord,
    runStatus: RunStatus,
  ): Promise<PeerRunnerResult<TOutput>> {
    const errorCategory = this.mapRunStatusToErrorCategory(runStatus.status, runStatus.reason);

    this.emitEvent('run_failed', taskId, {
      runStatus: runStatus.status,
      errorCategory,
    });

    return this.retryOrFail({
      taskId,
      task,
      errorCategory,
      failureReason: runStatus.reason
        ? `Runtime execution ended with status: ${runStatus.status}. Reason: ${runStatus.reason}`
        : `Runtime execution ended with status: ${runStatus.status}`,
    });
  }

  protected async handleValidationError(ctx: {
    taskId: string;
    task: TaskRecord;
    errors: readonly string[];
    errorCategory?: PDErrorCategory;
  }): Promise<PeerRunnerResult<TOutput>> {
    const category = ctx.errorCategory ?? 'output_invalid';

    this.emitEvent('output_invalid', ctx.taskId, {
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

  // ── Retry/fail state machine ───────────────────────────────────────────────

  /**
   * Core retry-or-fail decision.
   *
   * Uses try/catch around markTaskFailed/markTaskRetryWait for robustness.
   * If state manager operations fail, returns storage_unavailable instead of
   * propagating the exception (ERR-002: graceful degradation with reason).
   */
  protected async retryOrFail(ctx: FailureContext): Promise<PeerRunnerResult<TOutput>> {
    // Permanent errors — never retry
    if (this.permanentErrorCategories.has(ctx.errorCategory)) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory, ctx.failureReason);
      } catch (stateErr) {
        this.emitEvent('mark_failed_error', ctx.taskId, {
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
      this.emitEvent('task_failed', ctx.taskId, {
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

    // ADR-0019: Rate-limit graceful degradation. When the diagnostician_llm_degradation
    // feature flag is enabled AND the error is rate_limit, mark the task as failed with
    // `rate_limit` errorCategory (not max_attempts_exceeded) + emit observable telemetry.
    // rc-9 (no silent fallback): telemetry event carries nextAction.
    if (ctx.errorCategory === 'rate_limit' && this.isDegradationEnabled()) {
      try {
        await this.stateManager.markTaskFailed(ctx.taskId, 'rate_limit', `LLM rate limit degraded: ${ctx.failureReason}`);
      } catch (stateErr) {
        this.emitEvent('mark_failed_error', ctx.taskId, {
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
      this.emitEvent('diag_llm_rate_limit_degraded', ctx.taskId, {
        errorCategory: 'rate_limit',
        attemptCount: ctx.task.attemptCount,
        failureReason: ctx.failureReason,
        nextAction: 'Retry diagnosis manually with `pd pain retry` when rate limit clears, or enable fallback provider.',
      });
      this.phase = RunnerPhase.Failed;
      return {
        status: 'failed',
        taskId: ctx.taskId,
        errorCategory: 'rate_limit',
        failureReason: `LLM rate limit degraded: ${ctx.failureReason}`,
        attemptCount: ctx.task.attemptCount,
      };
    }

    // Retry policy check
    const shouldRetry = this.stateManager.getRetryPolicy().shouldRetry(ctx.task);
    if (shouldRetry) {
      try {
        await this.stateManager.markTaskRetryWait(ctx.taskId, ctx.errorCategory, ctx.failureReason);
      } catch (stateErr) {
        this.emitEvent('mark_retry_error', ctx.taskId, {
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
      this.emitEvent('task_retried', ctx.taskId, {
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
      await this.stateManager.markTaskFailed(
        ctx.taskId,
        'max_attempts_exceeded',
        `Max attempts exceeded: ${ctx.failureReason}`,
      );
    } catch (stateErr) {
      this.emitEvent('mark_failed_error', ctx.taskId, {
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
    this.emitEvent('task_failed', ctx.taskId, {
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
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * ADR-0019: Check if diagnostician LLM rate-limit degradation is enabled.
   * Reads the `diagnostician_llm_degradation` feature flag from effectiveConfig.
   * Returns false when effectiveConfig is not provided (legacy behavior).
   */
  protected isDegradationEnabled(): boolean {
    const { effectiveConfig } = this.config;
    if (!effectiveConfig) return false;
    const flags = computeFeatureFlagsFromConfig(effectiveConfig);
    return isFeatureEnabled(flags, 'diagnostician_llm_degradation');
  }
}
