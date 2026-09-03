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
import type {
  PendingAgentDraftStore,
  AgentDraftPayload,
} from '../feedback/pending-agent-draft-store.js';
import {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
} from '../feedback/redact-sensitive.js';
import type { SummaryRunnerKind } from '../internalization/artifact-summary.js';
import {
  attachSummaryEnvelope,
  type LoadedPredecessorArtifact,
} from '../internalization/attach-summary-envelope.js';
import type { ContextManifest } from '../internalization/context-manifest.js';
import { declaredFields } from '../internalization/context-manifest.js';
import { resolveInjection, type ResolveInjectionEmit, type ResolveInjectionResult } from '../internalization/resolve-injection.js';
import { buildAvailableMap } from '../internalization/summary-field-reader.js';
import { CandidateLineage } from '../internalization/candidate-lineage.js';
import {
  findUnresolvedRequiredPaths,
  mergeContextFields,
  parseContextPath,
  partitionTier2Paths,
  resolveAncestryPaths,
  resolveRelatedPaths,
  toRawStageSources,
  type RelatedContextSource,
} from '../internalization/context-resolution.js';

// ── Context injection outcome (design §6.2/§6.2.2, PR B §33–§37) ────────────

/**
 * Outcome of a Layer 1 context-injection resolution.
 *
 * - `focused`  — use `fields` (path → preview text) as the focused context.
 * - `fallback` — the caller MUST fall back to the legacy full-predecessor
 *   injection (F13). The three original triggers come from `resolveInjection`;
 *   PR B adds two:
 *     - `required_evidence_unresolved` — the allocation looked healthy but a
 *       caller-declared required field never reached the prompt (absent or
 *       budget-truncated). This is the "Stage2 enabled + raw silently absent"
 *       guard (design §35: no silent thin context).
 *     - `lineage_unavailable` — CandidateLineage hit data corruption or a store
 *       failure, so required tier2 evidence cannot be served at all (§21).
 * - `disabled` — `context_manifest_budget` is off; caller keeps its assembly.
 */
export type ContextInjectionOutcome =
  | { readonly mode: 'focused'; readonly fields: Readonly<Record<string, string>> }
  | {
      readonly mode: 'fallback';
      readonly reason:
        | 'empty_allocation'
        | 'tier1_all_absent'
        | 'absent_ratio_exceeded'
        | 'required_evidence_unresolved'
        | 'lineage_unavailable';
      readonly unresolvedRequired: readonly string[];
    }
  | { readonly mode: 'disabled' };

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

/**
 * Type guard: narrow `unknown` to `Record<string, unknown>` for safe property
 * access on parsed JSON. Mirrors the isRecord / isPlainObject helpers in
 * pending-agent-draft-store.ts and sqlite-task-store.ts (rc-1, rc-2: no `as`).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely extract `sourcePainId` from a task's `diagnosticJson` column.
 *
 * `diagnosticJson` is an optional JSON string that may carry PI metadata
 * including the originating pain signal ID (for diagnostician tasks). We
 * parse it defensively (rc-1: treat as unknown): malformed JSON or a
 * non-string sourcePainId yield null rather than throwing, so a corrupt
 * payload cannot break the draft-injection path (rc-9: graceful
 * degradation — painId is optional linkage, not a required field).
 *
 * Mirrors the extractPainIdFromDiagnosticJson helper in
 * sqlite-task-store.ts (Task 8). Inlined here because the original is a
 * module-private function and core must not introduce a new shared
 * utility surface for a single-call-site helper (avoid over-engineering).
 *
 * ERR-013 / rc-5: Object.hasOwn (not `in`) checks the sourcePainId key.
 * ERR-001 / rc-2: no `as` casts — uses a type guard (isPlainObject) to
 * narrow the parsed JSON before property access.
 */
function extractPainIdFromDiagnostic(diagnosticJson: unknown): string | null {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticJson);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (!Object.hasOwn(parsed, 'sourcePainId')) return null;
  const { sourcePainId } = parsed;
  if (typeof sourcePainId !== 'string' || sourcePainId.length === 0) return null;
  return sourcePainId;
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
  /**
   * Optional store for agent-authored draft context (Task 12).
   * When undefined, permanent failures do not write a draft — backward compatible.
   */
  private readonly pendingAgentDraftStore?: PendingAgentDraftStore;
  /** Layer 0 summary envelope hash function, injected by the plugin/CLI layer (design §6.1). */
  private readonly contentHashFn?: (input: string) => string;
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
    this.pendingAgentDraftStore = deps.pendingAgentDraftStore;
    this.contentHashFn = deps.contentHashFn;
    this.config = config;
    this.resolvedOptions = resolvePeerRunnerOptions(options, config.defaultAgentId);
  }

  // ── Observability ──────────────────────────────────────────────────────────

  /** Current internal phase. For testing/observability only. */
  get currentPhase(): RunnerPhase {
    return this.phase;
  }

  protected getRuntimeKind(): RuntimeKind {
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

  /**
   * P0 (verdict drift) — completion-intent resume gate. Called right after
   * lease acquisition, BEFORE any LLM invocation. A runner whose task carries
   * a pending durable completion intent in the same revision epoch must
   * resume that intent's effects and return the result here; returning null
   * proceeds with the normal LLM pipeline. Only runners with verdict
   * semantics (evaluator / rollout_reviewer) need to override this.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected async maybeResumePendingIntent(
    _taskId: string,
    _leasedTask: TaskRecord,
  ): Promise<PeerRunnerResult<TOutput> | null> {
    return null;
  }

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

    // 1c. P0 (verdict drift) — completion-intent resume gate. A pending durable
    // completion intent from the SAME revision epoch is the recovery authority:
    // its effects are resumed idempotently; the LLM is NOT re-invoked, so a
    // non-deterministic re-run can never drift the verdict against side
    // effects that already happened (activation / repair seed / validation).
    const resumed = await this.maybeResumePendingIntent(taskId, leasedTask);
    if (resumed) {
      this.phase = RunnerPhase.Completed;
      return resumed;
    }

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

  protected async pollUntilTerminal(runHandle: RunHandle): Promise<RunStatus> {
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
  protected async fetchAndParseOutput(runId: string, taskId: string): Promise<unknown> {
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

    // PRI-559 P0-2: 同步持久化失败详情（若 PDRuntimeError 携带 details）。
    if (classified.details && Object.keys(classified.details).length > 0) {
      await this.persistOutputFailureDetails(taskId, undefined, {
        errorCategory: classified.category,
        errorMessage: classified.message,
        ...classified.details,
      });
    }

    return this.retryOrFail({ taskId, task, errorCategory: classified.category, failureReason: classified.message });
  }

  protected async handlePostLeaseError(
    taskId: string,
    task: TaskRecord,
    error: unknown,
  ): Promise<PeerRunnerResult<TOutput>> {
    const classified = this.classifyError(error);

    this.emitEvent('run_failed', taskId, {
      errorCategory: classified.category,
      errorMessage: classified.message,
    });

    // PRI-559 P0-2: 适配器抛出的 PDRuntimeError 可能携带 evidencePack
    // （schemaRef/validationErrors/repairAttempts 等），持久化到 diagnosticJson
    // 使失败详情可追溯。details 不存在时跳过（其他错误类别无此信息）。
    if (classified.details && Object.keys(classified.details).length > 0) {
      await this.persistOutputFailureDetails(taskId, task.diagnosticJson, {
        errorCategory: classified.category,
        errorMessage: classified.message,
        ...classified.details,
      });
    }

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

    // PRI-559 P0-2: validator 失败的具体错误列表（字符串数组）持久化到
    // diagnosticJson，使“哪个字段校验失败”可追溯（此前只进 runs.reason）。
    await this.persistOutputFailureDetails(ctx.taskId, ctx.task.diagnosticJson, {
      errorCategory: category,
      validatorErrors: [...ctx.errors],
      errorCount: ctx.errors.length,
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
      // Task 12: inject agent-authored draft into pending_agent_drafts so the
      // feedback-report pipeline (Task 13) can later merge the agent's
      // perspective into the maintainer-facing report. Best-effort: failures
      // are observed via telemetry (rc-9) but never propagate, so a draft
      // write error cannot break the markFailed terminal-state contract.
      this.injectAgentDraftOnPermanentFailure(ctx);
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
  private classifyError(error: unknown): {
    category: PDErrorCategory;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (error instanceof PDRuntimeError) {
      // PRI-559 P0-2: 保留 details（如结构化输出失败的 evidencePack），
      // 供失败详情持久化到 diagnosticJson，避免“为什么失败”不可追溯。
      return { category: error.category, message: error.message, details: error.details };
    }
    if (error instanceof Error) {
      return { category: 'execution_failed', message: error.message };
    }
    return { category: 'execution_failed', message: String(error) };
  }

  /**
   * PRI-559 P0-2: 把结构化输出失败详情持久化到 task.diagnosticJson。
   *
   * 与 pi_metadata 信封并列新增 `output_failure_details` 键（不破坏
   * parsePITaskMetadata 对 pi_metadata 的严格校验）。失败详情包括：
   *   - schemaRef / provider / model（定位环境）
   *   - validationErrors（具体字段路径 + 错误消息 + 实际值预览）
   *   - repairAttempts / repairSummary / finalFailureReason（修复循环诊断）
   *   - rawOutputPreview（原始输出预览）
   *   - validatorErrors（runner 层 validator 的字符串错误列表）
   *
   * 持久化失败不影响主流程（best-effort，记录事件即可）。
   */
  protected async persistOutputFailureDetails(
    taskId: string,
    existingDiagnosticJson: string | null | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      let parsed: Record<string, unknown> = {};
      if (existingDiagnosticJson) {
        const candidate = JSON.parse(existingDiagnosticJson) as unknown;
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
          // runtime-contract-exempt: ERR-001 上方 typeof/Array.isArray 守卫已收窄
          parsed = candidate as Record<string, unknown>;
        }
      }
      parsed.output_failure_details = {
        recordedAt: new Date().toISOString(),
        ...details,
      };
      await this.stateManager.updateTask(taskId, { diagnosticJson: JSON.stringify(parsed) });
    } catch (err) {
      this.emitEvent('mark_failed_error', taskId, {
        errorCategory: 'storage_unavailable',
        errorMessage: `persistOutputFailureDetails failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

  // ── Layer 0: summary envelope (design §6.1, PR 1 task 3.11) ────────────────

  /**
   * Whether the Layer 0 `artifact_summary_redundancy` flag is on.
   * Returns false when effectiveConfig is not provided (legacy behavior:
   * no summary written, contentJson shape unchanged).
   */
  protected isArtifactSummaryEnabled(): boolean {
    const { effectiveConfig } = this.config;
    if (!effectiveConfig) return false;
    const flags = computeFeatureFlagsFromConfig(effectiveConfig);
    return isFeatureEnabled(flags, 'artifact_summary_redundancy');
  }

  /**
   * Build the artifact `contentJson` string, optionally carrying the Layer 0
   * summary envelope (design §6.1). Single wiring point shared by all 8
   * writer paths (task 3.11), so no runner duplicates the flag check,
   * the envelope construction, or the degradation telemetry.
   *
   * Contract (Requirements 1.1 / 1.8 / 1.10, F11):
   *   - flag off → returns `JSON.stringify(output)` verbatim; contentJson is
   *     byte-identical to the pre-Layer-0 shape (CP-32)
   *   - flag on, derivation succeeds → `summary` (and `predecessorSummary`
   *     when an edge predecessor was loaded) merged as sibling keys
   *   - any derivation/predecessor degradation → an `artifact_summary_*`
   *     telemetry event with an explicit reason (rc-9), and the task still
   *     succeeds with its original result (summary is never load-bearing)
   *   - never throws: a summary failure must not turn into `output_invalid`
   *
   * `loadedPredecessor` MUST be an object the runner's own `buildContext`
   * already loaded — this method performs zero artifact-store reads (F3).
   */
  // eslint-disable-next-line @typescript-eslint/max-params -- single shared wiring point (task 3.11); matches the 4 inputs every writer needs (taskId, kind, output, predecessor).
  protected buildArtifactContentJson(
    taskId: string,
    runnerKind: SummaryRunnerKind,
    output: unknown,
    loadedPredecessor: LoadedPredecessorArtifact | null,
  ): string {
    if (!this.isArtifactSummaryEnabled()) {
      return JSON.stringify(output);
    }

    try {
      const hashFn = this.contentHashFn;
      // Without an injected hash we cannot compute the predecessor
      // contentHash that staleness detection depends on, so the predecessor
      // ref is skipped explicitly rather than written without a hash.
      const effectivePredecessor = hashFn ? loadedPredecessor : null;
      if (!hashFn && loadedPredecessor !== null) {
        this.emitEvent('artifact_summary_predecessor_skipped', taskId, {
          runnerKind,
          reason: 'content_hash_fn_not_injected',
          nextAction: 'Inject contentHashFn into PeerRunnerDeps (plugin/CLI layer) to enable predecessorSummary.',
        });
      }

      const envelope = attachSummaryEnvelope(
        runnerKind,
        output,
        effectivePredecessor,
        hashFn ?? ((input: string) => input),
        (event) => {
          this.emitEvent(event.type, taskId, { runnerKind: event.runnerKind, reason: event.reason });
        },
      );

      if (envelope.summary === undefined) {
        // Self-derivation failed; attachSummaryEnvelope already emitted
        // artifact_summary_skipped with the reason.
        return JSON.stringify(output);
      }

      // Merge as sibling keys. Spreading `output` first keeps every original
      // key byte-identical; only `summary` / `predecessorSummary` are added.
      if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        // Non-object outputs cannot carry sibling keys. deriveArtifactSummary
        // would have already failed here, but stay defensive rather than
        // producing a malformed envelope.
        return JSON.stringify(output);
      }

      const outputRecord = output as Record<string, unknown>;
      // P1 data-integrity guard (CodeRabbit PR #1273): several stage output
      // schemas already declare a top-level `summary` field (diag_rootcause's
      // symptom summary, diag_router's DiagnosticianOutputV1.summary). The
      // Layer 0 envelope would OVERWRITE that legitimate field if added
      // unconditionally (design §7 promises "不删不改任何既有字段"). When the
      // collision is detected, skip writing the envelope `summary` key, emit a
      // structured degradation (rc-9), and still attach `predecessorSummary`
      // (which does not collide). The self-summary remains derivable on the
      // read side from the unchanged output via deriveArtifactSummary.
      const hasSummaryCollision = Object.hasOwn(outputRecord, 'summary');
      if (hasSummaryCollision) {
        this.emitEvent('artifact_summary_skipped', taskId, {
          runnerKind,
          reason: 'output_summary_key_collision',
          nextAction: 'Runner output already declares a top-level `summary` field; the Layer 0 envelope summary key is skipped to avoid overwriting it. predecessorSummary is still attached.',
        });
      }

      return JSON.stringify({
        ...outputRecord,
        ...(hasSummaryCollision ? {} : { summary: envelope.summary }),
        ...(envelope.predecessorSummary !== undefined
          ? { predecessorSummary: envelope.predecessorSummary }
          : {}),
      });
    } catch (summaryErr) {
      // F11: a summary failure must never change task success/failure.
      this.emitEvent('artifact_summary_skipped', taskId, {
        runnerKind,
        reason: 'unexpected_error',
        errorMessage: summaryErr instanceof Error ? summaryErr.message : String(summaryErr),
      });
      return JSON.stringify(output);
    }
  }

  // ── Layer 1: manifest + budget injection (design §6.2/§6.3, PR 2 task 5.9) ──

  /**
   * Whether the Layer 1 `context_manifest_budget` flag is on. Returns false
   * when effectiveConfig is absent (legacy: existing buildContext assembly).
   */
  protected isContextManifestBudgetEnabled(): boolean {
    const { effectiveConfig } = this.config;
    if (!effectiveConfig) return false;
    const flags = computeFeatureFlagsFromConfig(effectiveConfig);
    return isFeatureEnabled(flags, 'context_manifest_budget');
  }

  /**
   * Whether the Layer 2 `progressive_evaluator` flag is on (design §6.5, PR 4).
   * When on, the evaluator runner runs two-stage evaluation; off = single stage.
   */
  protected isProgressiveEvaluatorEnabled(): boolean {
    const { effectiveConfig } = this.config;
    if (!effectiveConfig) return false;
    const flags = computeFeatureFlagsFromConfig(effectiveConfig);
    return isFeatureEnabled(flags, 'progressive_evaluator');
  }

  /**
   * Run a single LLM evaluation: startRun → pollUntilTerminal → fetchAndParseOutput.
   * Returns the untrusted payload (unknown). Used by the two-stage progressive
   * evaluator to run Stage 1 and Stage 2 independently (design §6.5, PR 4 task 9.11).
   *
   * This method is protected (not private) so the EvaluatorRunner can call it
   * twice (once per stage) from its overridden invokeRuntime.
   */
  protected async runSingleEvaluation(taskId: string, promptMessage: string): Promise<unknown> {
    const runtimeKind = this.getRuntimeKind();
    const runHandle = await this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: promptMessage,
      contextItems: [],
      outputSchemaRef: this.config.resultRefPrefix.includes('evaluator')
        ? 'evaluator-output-v1'
        : `${this.config.expectedTaskKind}-output-v1`,
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
    this.emitEvent('run_started', taskId, { runtimeKind, stage: 'progressive_evaluation' });

    const finalStatus = await this.pollUntilTerminal(runHandle);
    if (finalStatus.status !== 'succeeded') {
      throw new PDRuntimeError(
        finalStatus.status === 'timed_out' ? 'timeout' : 'execution_failed',
        `Progressive evaluation run ${runHandle.runId} ended with status ${finalStatus.status}`,
      );
    }
    return this.fetchAndParseOutput(runHandle.runId, taskId);
  }

  /**
   * Resolve the cross-level context injection for a runner via the Layer 1
   * manifest + budget path (design §6.2/§6.3/§6.2.2).
   *
   * Single wiring point shared by the peer runners (task 5.9). This SYNC
   * variant resolves only Channel 1 (the predecessor's Layer 0
   * summary/predecessorSummary envelope); it is correct for runners whose
   * manifest declares no tier2 raw field and no related reference. Runners
   * that need tier2/related evidence use `resolveContextInjectionAsync`.
   *
   * `predecessorContentJson` is the loaded predecessor artifact's contentJson
   * (the same object buildContext already holds — zero extra store reads, F3).
   *
   * budgetTokens scope (design §6.2.1): covers ONLY manifest-declared fields.
   *
   * `taskId` is used for telemetry event attribution (runnerKind comes from
   * the manifest itself via event.runnerKind).
   */
  protected resolveContextInjection(
    taskId: string,
    manifest: ContextManifest,
    predecessorContentJson: unknown,
  ): ContextInjectionOutcome {
    if (!this.isContextManifestBudgetEnabled()) {
      return { mode: 'disabled' };
    }
    const paths = declaredFields(manifest);
    const available = buildAvailableMap(paths, predecessorContentJson);
    return this.runResolveInjection({ taskId, manifest, available, requiredPaths: [] });
  }

  /**
   * Async variant: resolves ALL THREE fact-acquisition channels before running
   * the same allocation + information-floor core (design §6.4/§6.6, PR B).
   *
   *   1. predecessor summary envelope — pure, from `predecessorContentJson`
   *   2. ancestry raw (`<stage>.raw.*`) — `CandidateLineage` from
   *      `startArtifactId`; the nearest ancestor of a stage wins
   *   3. related references (`<ns>.summary.*` / `<ns>.raw.*`) — caller-supplied
   *      causal references, e.g. the PR-A replay evidence
   *
   * `requiredPaths` is the required-evidence gate (design §33–§37): a listed
   * path that ends up absent OR budget-truncated forces an observable fallback
   * instead of a silently thin focused context. Pass an empty list (or omit it)
   * when tier2 is genuinely optional.
   */
  protected async resolveContextInjectionAsync(params: {
    readonly taskId: string;
    readonly manifest: ContextManifest;
    readonly predecessorContentJson: unknown;
    /** Lineage traversal start — normally the predecessor artifact id. */
    readonly startArtifactId?: string;
    readonly relatedSources?: readonly RelatedContextSource[];
    readonly requiredPaths?: readonly string[];
  }): Promise<ContextInjectionOutcome> {
    const { taskId, manifest } = params;
    if (!this.isContextManifestBudgetEnabled()) {
      return { mode: 'disabled' };
    }

    const paths = declaredFields(manifest);
    const requiredPaths = params.requiredPaths ?? [];
    const summaryFields = buildAvailableMap(paths, params.predecessorContentJson);
    const extras: ReadonlyMap<string, unknown>[] = [];

    // Channel 2 — ancestry. Related namespaces are excluded explicitly so a
    // related reference can never be mistaken for an ancestor stage
    // (INV-LINEAGE-SCOPE, design §33).
    const relatedNamespaces = (params.relatedSources ?? []).map((s) => s.namespace);
    const { ancestry: rawAncestryPaths } = partitionTier2Paths(manifest.tier2, relatedNamespaces);
    // Ancestor-declared SUMMARY paths travel the same walk as the raw ones:
    // `readSummaryField` only ever reads the single loaded predecessor, so a
    // manifest naming an ancestor further up the chain (the Evaluator's
    // `scribe.*` / `dreamer.*` / `diagnostician.*`) resolves here or never.
    const summaryAncestryPaths = [...manifest.tier0, ...manifest.tier1].filter((fieldPath) => {
      const parsed = parseContextPath(fieldPath);
      return parsed !== null && parsed.layer === 'summary';
    });
    const ancestryPaths = [...rawAncestryPaths, ...summaryAncestryPaths];

    if (ancestryPaths.length > 0 && params.startArtifactId !== undefined) {
      const lineage = new CandidateLineage({
        artifacts: this.artifactStore,
        tasks: {
          getTaskById: async (id: string) => {
            const task = await this.stateManager.getTask(id);
            return task === null ? null : { taskId: id, taskKind: task.taskKind };
          },
        },
      });
      const chain = await lineage.resolve(params.startArtifactId);
      if (!chain.ok) {
        // rc-9: corruption / store failure is observable, never a silent
        // "no tier2 today". Required evidence cannot be served without it.
        this.emitEvent('context_lineage_unavailable', taskId, {
          runnerKind: manifest.runnerKind,
          manifestId: manifest.manifestId,
          errorKind: chain.error.kind,
          detail: chain.error.detail,
          fallback: 'full_predecessor_injection',
          nextAction: 'verify_durable_artifact_ancestry_before_tier2_resolution',
        });
        if (requiredPaths.length > 0) {
          return { mode: 'fallback', reason: 'lineage_unavailable', unresolvedRequired: [...requiredPaths] };
        }
      } else {
        extras.push(resolveAncestryPaths(ancestryPaths, toRawStageSources(chain.value.nodes)));
      }
    }

    // Channel 3 — related (causal) references. Never ancestry: a related source
    // is supplied explicitly by the caller and is not part of the lineage walk.
    if (params.relatedSources !== undefined && params.relatedSources.length > 0) {
      extras.push(resolveRelatedPaths(paths, params.relatedSources));
    }

    const available = mergeContextFields(summaryFields, extras);
    return this.runResolveInjection({ taskId, manifest, available, requiredPaths });
  }

  /**
   * Allocation + information-floor core shared by both variants (design
   * §6.2.2). Allocates, emits the Layer 1 events, then applies PR B's
   * required-evidence gate before reporting `focused`.
   */
  private runResolveInjection(params: {
    readonly taskId: string;
    readonly manifest: ContextManifest;
    readonly available: ReadonlyMap<string, unknown>;
    readonly requiredPaths: readonly string[];
  }): ContextInjectionOutcome {
    const { taskId, manifest, available, requiredPaths } = params;
    const emit = (event: ResolveInjectionEmit): void => {
      if (event.type === 'manifest_resolution_insufficient') {
        this.emitEvent('manifest_resolution_insufficient', taskId, {
          runnerKind: event.runnerKind,
          manifestId: event.manifestId,
          absentCount: event.absentCount,
          declaredCount: event.declaredCount,
          absentRatio: event.absentRatio,
          fallback: event.fallback,
        });
      } else {
        // context_truncated — surface as telemetry so Layer 3 can show it.
        this.emitEvent('context_truncated', taskId, {
          runnerKind: event.runnerKind,
          manifestId: event.manifestId,
          fieldPath: event.fieldPath,
          reason: event.reason,
          remainingBudgetTokens: event.remainingBudgetTokens,
        });
      }
    };
    const result: ResolveInjectionResult = resolveInjection(manifest, available, emit);

    // Required-evidence gate (design §33–§37): the allocation can look healthy
    // while a caller-declared required field is absent OR was dropped by the
    // budget. That is exactly the "Stage2 enabled + raw silently absent" hole —
    // it degrades observably, never becomes a thinner prompt.
    const unresolvedRequired = findUnresolvedRequiredPaths({
      required: requiredPaths,
      absent: result.allocated.absent,
      truncated: result.allocated.truncated,
    });
    if (unresolvedRequired.length > 0) {
      this.emitEvent('required_context_evidence_unresolved', taskId, {
        runnerKind: manifest.runnerKind,
        manifestId: manifest.manifestId,
        requiredPaths: unresolvedRequired,
        fallback: 'full_predecessor_injection',
        nextAction: 'verify_durable_ancestry_or_related_reference_availability',
      });
      return { mode: 'fallback', reason: 'required_evidence_unresolved', unresolvedRequired };
    }

    if (result.kind === 'focused') {
      return { mode: 'focused', fields: result.allocated.fields };
    }
    return { mode: 'fallback', reason: result.reason, unresolvedRequired: [] };
  }

  // ── Agent draft injection (Task 12) ────────────────────────────────────────

  /**
   * Task 12: Construct an AgentDraftPayload from the permanent-failure
   * context and write it to pending_agent_drafts via the injected
   * PendingAgentDraftStore. Best-effort: never throws. All failures are
   * observed via telemetry (rc-9: no silent fallback) so the maintainer
   * can diagnose draft-write issues without the markFailed terminal-state
   * contract being broken.
   *
   * No-op when pendingAgentDraftStore is not injected (backward compatible).
   *
   * ERR checklist:
   * - EP-01 / ERR-001, ERR-005, ERR-013: diagnosticJson parsed as unknown,
   *   narrowed with typeof + Object.hasOwn. No `as` casts on parsed data.
   * - EP-03 / ERR-002: insertPendingDraft returns { ok: false, error };
   *   we emit a telemetry event with reason + nextAction (rc-9).
   * - EP-03 / ERR-074, ERR-089: every branch (store missing, insert
   *   returns !ok, insert throws) applies the SAME best-effort contract —
   *   never propagate, always observe.
   * - EP-08 / ERR-003, ERR-024: redactAbsolutePaths / redactTokenLikeValues
   *   / redactEnvLikeValues are applied to observedFailure BEFORE persist.
   */
  private injectAgentDraftOnPermanentFailure(ctx: FailureContext): void {
    if (!this.pendingAgentDraftStore) return;

    const { taskKind } = ctx.task;
    const { errorCategory } = ctx;
    const observedFailureRaw = ctx.failureReason;
    // Apply all three redactors in sequence (mirrors redactTelemetryString
    // composition). Order: paths → tokens → env. Each is a no-op on
    // non-matching input, so the composition is safe regardless of content.
    const observedFailure = redactEnvLikeValues(
      redactAbsolutePaths(redactTokenLikeValues(observedFailureRaw)),
    );

    const agentDraft: AgentDraftPayload = {
      summary: `${taskKind} failed with category=${errorCategory} at ${new Date().toISOString()}`,
      observedFailure,
      // commandSummary omitted: RunRecord has no toolCalls field (verified
      // against run-store.ts). Adding it later requires extending RunRecord
      // + adapter contract — out of scope for Task 12.
    };

    // rc-7 / ERR-015: read painId fresh from the current task record's
    // diagnosticJson. ctx.task is the leased task snapshot; diagnosticJson
    // is the canonical source for sourcePainId linkage.
    const painId = extractPainIdFromDiagnostic(ctx.task.diagnosticJson);

    try {
      const result = this.pendingAgentDraftStore.insertPendingDraft({
        taskId: ctx.taskId,
        painId: painId ?? undefined,
        agentDraft,
      });
      if (!result.ok) {
        // rc-9: surface the failure with a reason + nextAction — never silent.
        this.emitEvent('agent_draft_insert_failed', ctx.taskId, {
          errorCategory,
          attemptCount: ctx.task.attemptCount,
          errorMessage: result.error,
          nextAction: 'Inspect pending_agent_drafts table integrity; draft will be retried on next permanent failure of the same taskId (idempotent UPDATE).',
        });
        return;
      }
      this.emitEvent('agent_draft_inserted', ctx.taskId, {
        errorCategory,
        attemptCount: ctx.task.attemptCount,
        draftId: result.id,
        painIdLinked: painId !== null,
      });
    } catch (err) {
      // Defensive: insertPendingDraft is documented to never throw (it
      // catches internally and returns { ok: false }), but a misbehaving
      // store implementation or a synchronous throw before the inner try
      // must not break the markFailed contract.
      this.emitEvent('agent_draft_insert_failed', ctx.taskId, {
        errorCategory,
        attemptCount: ctx.task.attemptCount,
        errorMessage: err instanceof Error ? err.message : String(err),
        nextAction: 'PendingAgentDraftStore.insertPendingDraft threw unexpectedly; inspect the store implementation.',
      });
    }
  }
}
