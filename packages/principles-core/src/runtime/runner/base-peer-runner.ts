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
import type { PeerRunnerTelemetryEmitter } from './peer-runner-types.js';
import { hashContextRefs } from './context-hash.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { TaskRecord } from '../task-status.js';
import { parseSeedSourcePainId } from '../internalization/pitask-metadata.js';
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
  redactSensitiveFields,
  redactTelemetryString,
} from '../feedback/redact-sensitive.js';
import { safeStringifyPreview } from '../adapter/output-repair-contract.js';
import {
  DEFAULT_EXECUTION_TIMING,
  resolveExecutionTiming,
  type ExecutionTiming,
} from '../config/execution-timing.js';
import { LeaseHeartbeat, type LeaseHeartbeatEvent } from '../store/lifecycle/lease-heartbeat.js';

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * P1-3: bounded per-attempt validator-error history. Kept small because it is
 * appended to diagnosticJson on every failed attempt; the newest 10 attempts
 * are enough to show a repeated (unrepaired) failure without unbounded growth.
 */
const MAX_VALIDATOR_ERROR_HISTORY = 10;

/**
 * Parse a persisted diagnosticJson string into a plain record (rc-1/rc-2:
 * untrusted runtime data stays `unknown` until narrowed). Malformed or
 * non-object JSON yields `{}` so callers always get a merge target instead of
 * throwing inside a failure path.
 */
function parseDiagnosticJsonRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {};
  // runtime-contract-exempt: ERR-001 the typeof/Array.isArray guards above have
  // already narrowed `candidate` to a non-null, non-array object.
  return candidate as Record<string, unknown>;
}

/**
 * P1-3: read the existing bounded per-attempt validator-error history.
 * Untrusted JSON (rc-1/rc-4): entries are validated element-by-element, and a
 * malformed entry invalidates only itself — never the whole history.
 */
function readValidatorErrorHistory(raw: string | null | undefined): Record<string, unknown>[] {
  const parsed = parseDiagnosticJsonRecord(raw);
  if (!Object.hasOwn(parsed, 'validator_error_history')) return [];
  const history = parsed.validator_error_history;
  if (!Array.isArray(history)) return [];
  return history.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

const DEFAULT_PEER_RUNNER_OPTIONS: Readonly<Omit<ResolvedPeerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: DEFAULT_EXECUTION_TIMING.stageTimeoutMs,
  defaultMaxAttempts: 3,
  agentId: 'peer-runner',
  coreGrounding: true,
  leaseTtlMs: DEFAULT_EXECUTION_TIMING.leaseTtlMs,
  heartbeatIntervalMs: DEFAULT_EXECUTION_TIMING.heartbeatIntervalMs,
} as const;

function resolvePeerRunnerOptions(
  options: PeerRunnerOptions,
  defaultAgentId: string,
): ResolvedPeerRunnerOptions {
  // SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1: one resolver owns the
  // relationship between stage timeout, lease TTL and renewal cadence. The
  // stage timeout can no longer silently equal the lease TTL.
  const timing = resolveExecutionTiming({
    stageTimeoutMs: options.timeoutMs,
    leaseTtlMs: options.leaseTtlMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_PEER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: timing.stageTimeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_PEER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? defaultAgentId,
    outputLanguage: options.outputLanguage,
    coreGrounding: options.coreGrounding ?? true,
    leaseTtlMs: timing.leaseTtlMs,
    heartbeatIntervalMs: timing.heartbeatIntervalMs,
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
  protected readonly eventEmitter: PeerRunnerTelemetryEmitter;
  protected readonly artifactStore: PIArtifactStore;
  protected readonly resolvedOptions: ResolvedPeerRunnerOptions;
  /**
   * Effective execution timing for this runner (SPEC-PD-PIPELINE-RELIABILITY-
   * AND-EFFICIENCY-001 §5.1). Exposed so subclasses (e.g. the split
   * diagnostician orchestrator) share the exact same budgets.
   */
  protected readonly executionTiming: ExecutionTiming;
  protected readonly config: PeerRunnerConfig;
  /**
   * Optional store for agent-authored draft context (Task 12).
   * When undefined, permanent failures do not write a draft — backward compatible.
   */
  private readonly pendingAgentDraftStore?: PendingAgentDraftStore;
  private phase: RunnerPhase = RunnerPhase.Idle;

  /**
   * PRI-700 因子 B: 当前 run() 的 leased attempt 序号（每次 run() 在
   * buildContext 前刷新）。子类用它区分"同一 attempt 的重复 buildContext"
   * 与"跨 attempt 重试"——前者不应重复回喂同一 validator 错误，后者允许
   * 回喂（每次 output-invalid 后 handleValidationError 已用当次新错误
   * 覆盖 lastValidatorErrors，rc-7）。
   */
  protected currentLeasedAttempt: number | undefined;

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
    this.config = config;
    this.resolvedOptions = resolvePeerRunnerOptions(options, config.defaultAgentId);
    this.executionTiming = {
      stageTimeoutMs: this.resolvedOptions.timeoutMs,
      parentBudgetMs: resolveExecutionTiming({ stageTimeoutMs: this.resolvedOptions.timeoutMs }).parentBudgetMs,
      leaseTtlMs: this.resolvedOptions.leaseTtlMs,
      heartbeatIntervalMs: this.resolvedOptions.heartbeatIntervalMs,
    };
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

  /**
   * The exact input payload submitted to the runtime when it must be persisted
   * as post-restart verification evidence (PRI-1146 P2-01). The default is
   * "nothing to persist"; runners whose receipts must be re-verifiable in a
   * new process return the exact submitted message, which BasePeerRunner
   * writes to the run row's `input_payload`. Persistence failure is loud — an
   * unverifiable receipt must never be committed silently (rc-9).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected getInvocationInputPayload(_context: TContext): string | undefined {
    return undefined;
  }

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

  /**
   * Deep copy of the model output taken before `postFetchTransform` mutates it.
   *
   * The failure evidence must show what the model produced; a subclass that
   * rewrites nested fields in place would otherwise make the preview describe
   * the rewritten object. The payload is parsed JSON, so cloning is lossless.
   * A clone failure is observable (rc-9) instead of silently degrading to the
   * mutated reference.
   */
  private snapshotBeforeTransform(taskId: string, untrustedOutput: unknown): unknown {
    try {
      return structuredClone(untrustedOutput);
    } catch (error) {
      this.emitEvent('raw_output_snapshot_failed', taskId, {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return untrustedOutput;
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
        // SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.2: the lease is a
        // heartbeat-sustained window, not the stage's maximum duration.
        durationMs: this.executionTiming.leaseTtlMs,
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
    // SPEC §5.2: keep the lease alive for the whole execution window. Without
    // this the per-cycle recovery sweep reclaims any stage longer than its TTL
    // while it is still executing.
    //
    // The commit-time ownership probe is enabled only when acquisition actually
    // produced an identifiable lease (status `leased` + our own owner). Runners
    // driven by a manager double that never models a lease keep the legacy
    // behaviour; in production `DefaultLeaseManager` always returns both.
    const leaseObservable = leasedTask.status === 'leased'
      && (leasedTask.leaseOwner ?? null) === this.resolvedOptions.owner;
    const heartbeat = this.startLeaseHeartbeat(taskId, leaseObservable);
    try {
      // 2. Resolve store runId
      const storeRunId = await this.resolveStoreRunId(taskId);

      // 3. Build context
      this.phase = RunnerPhase.BuildingContext;
      this.currentLeasedAttempt = leasedTask.attemptCount;
      const context = await this.buildContext(taskId);
      this.emitEvent('context_built', taskId, { contextHash: context.contextHash });

      // 4. Invoke runtime
      this.phase = RunnerPhase.Invoking;
      const runHandle = await this.invokeRuntime(taskId, context);
      const invocationInputPayload = this.getInvocationInputPayload(context);
      if (invocationInputPayload !== undefined) {
        try {
          await this.stateManager.runStore.updateRun(storeRunId, { inputPayload: invocationInputPayload });
        } catch (persistError) {
          this.emitEvent('input_payload_persist_failed', taskId, {
            errorMessage: persistError instanceof Error ? persistError.message : String(persistError),
          });
          throw persistError;
        }
      }
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
      // Snapshot first: subclasses may rewrite nested fields in place, and the
      // failure preview must describe what the MODEL produced, not the rewritten
      // object (SPEC §7). Derived JSON data, so a deep clone is lossless.
      const rawOutputSnapshot = this.snapshotBeforeTransform(taskId, untrustedOutput);
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
          // SPEC-PD-DIAG-ROUTER-RELIABILITY-001 §7: the raw model output is only
          // in scope here. Without it a runner-level rejection leaves
          // `runs.output_payload` NULL and nothing to diagnose (the adapter's
          // evidence pack only covers adapter-level failures, which fail earlier).
          rawOutput: rawOutputSnapshot,
        });
      }

      // Validation passed — safe to treat as TOutput.
      const output: TOutput = untrustedOutput as TOutput;

      this.emitEvent('output_validated', taskId, {});

      // 8b. Check lineage integrity (receives validated output and context)
      this.checkLineageIntegrity(taskId, output, context);

      // 8c. Emit success telemetry (receives validated output)
      this.emitSuccessTelemetry(taskId, output, context);

      // 8d. Ownership fence (SPEC §5.3). A worker whose lease was reclaimed
      // between the last renewal and this commit must not write a terminal
      // success: the result belongs to an execution nobody owns any more.
      if (!(await heartbeat.assertOwned())) {
        this.emitStaleCommitRejected(taskId, 'before_success_commit');
        return {
          status: 'failed',
          taskId,
          errorCategory: 'lease_conflict',
          failureReason: 'Lease lost before commit; stale success write rejected',
          attemptCount: leasedTask.attemptCount,
        };
      }

      // 9. Succeed task (abstract — subclass implements commit strategy)
      const result = await this.succeedTask(taskId, storeRunId, output, leasedTask, context.contextHash, context);
      if (result.status === 'succeeded') {
        this.phase = RunnerPhase.Completed;
      }
      return result;
    } catch (error) {
      // Post-lease errors use retryOrFail with the real leasedTask
      return await this.handlePostLeaseError(taskId, leasedTask, error);
    } finally {
      await heartbeat.stop();
    }
  }

  // ── Lease heartbeat ────────────────────────────────────────────────────────

  /**
   * Start renewal for the lease this run holds.
   *
   * The heartbeat renews with the SAME owner identity used for acquisition and
   * probes the persisted row at commit time. Its failures are emitted, never
   * swallowed (rc-9): a renewal that cannot prove ownership is a reliability
   * incident, not a background detail.
   */
  private startLeaseHeartbeat(taskId: string, observeOwnership: boolean): LeaseHeartbeat {
    const timing = this.executionTiming;
    this.eventEmitter.emitTelemetry({
      eventType: 'execution_timing_resolved',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: this.resolvedOptions.owner,
      agentId: this.resolvedOptions.agentId,
      payload: {
        stageTimeoutMs: timing.stageTimeoutMs,
        parentBudgetMs: timing.parentBudgetMs,
        leaseTtlMs: timing.leaseTtlMs,
        heartbeatIntervalMs: timing.heartbeatIntervalMs,
      },
    });
    const heartbeat = new LeaseHeartbeat({
      taskId,
      owner: this.resolvedOptions.owner,
      leaseTtlMs: timing.leaseTtlMs,
      intervalMs: timing.heartbeatIntervalMs,
      renewLease: (id, owner, durationMs) => this.stateManager.renewLease(id, owner, durationMs),
      ...(observeOwnership
        ? {
            readOwnership: async (id: string) => {
              const task = await this.stateManager.getTask(id);
              return task ? { status: task.status, leaseOwner: task.leaseOwner ?? null } : null;
            },
          }
        : {}),
      emit: (event) => this.emitLeaseHeartbeatEvent(taskId, event),
    });
    heartbeat.start();
    return heartbeat;
  }

  private emitLeaseHeartbeatEvent(taskId: string, event: LeaseHeartbeatEvent): void {
    const payload = {
      owner: event.owner,
      renewalCount: event.renewalCount,
      ...(event.detail ? { detail: event.detail } : {}),
    };
    // Literal per branch so the telemetry registry can see each name
    // (scripts/check-telemetry-events.cjs cannot resolve a computed ternary).
    if (event.type === 'renewed') {
      this.eventEmitter.emitTelemetry({
        eventType: 'lease_renewed',
        traceId: taskId,
        timestamp: event.occurredAt,
        sessionId: this.resolvedOptions.owner,
        agentId: this.resolvedOptions.agentId,
        payload,
      });
      return;
    }
    if (event.type === 'renewal_failed') {
      this.eventEmitter.emitTelemetry({
        eventType: 'lease_renewal_failed',
        traceId: taskId,
        timestamp: event.occurredAt,
        sessionId: this.resolvedOptions.owner,
        agentId: this.resolvedOptions.agentId,
        payload,
      });
      return;
    }
    this.eventEmitter.emitTelemetry({
      eventType: 'lease_ownership_lost',
      traceId: taskId,
      timestamp: event.occurredAt,
      sessionId: this.resolvedOptions.owner,
      agentId: this.resolvedOptions.agentId,
      payload,
    });
  }

  /**
   * Record that a stale worker tried to write a terminal state after losing its
   * lease. This is the observable proof that fencing worked — without it the
   * guard would silently discard work.
   */
  protected emitStaleCommitRejected(taskId: string, phase: string): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'stale_commit_rejected',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: this.resolvedOptions.owner,
      agentId: this.resolvedOptions.agentId,
      payload: { taskId, phase, owner: this.resolvedOptions.owner },
    });
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

  /**
   * Compute a deterministic hash from context references (observability only).
   * Public so post-restart evidence reconstruction re-derives the exact same
   * `contextHash` the runner recorded (PRI-1146 P2-01) — one implementation,
   * never a second copy.
   */
  static hashContextRefs(refs: readonly string[]): string {
    return hashContextRefs(refs);
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
    /**
     * SPEC-PD-DIAG-ROUTER-RELIABILITY-001 §7: the untrusted output that failed
     * validation. Persisted as a bounded, redacted preview in the existing
     * `diagnosticJson.output_failure_details` — never in `runs.output_payload`,
     * which consumers treat as already-validated V2 output (writing raw
     * invalid text there would break lineage verification).
     */
    rawOutput?: unknown;
  }): Promise<PeerRunnerResult<TOutput>> {
    const category = ctx.errorCategory ?? 'output_invalid';

    this.emitEvent('output_invalid', ctx.taskId, {
      errorCount: ctx.errors.length,
      errorCategory: category,
    });

    // PRI-559 P0-2 + PRI-700 因子 B (Owner 决策 2026-09-07): 单次合并写入。
    // 两个键（output_failure_details 可追溯性 + lastValidatorErrors 修复回喂）
    // 必须在同一次 updateTask 中落库——分成两次写时，第二次会以旧快照整体
    // 覆盖 diagnosticJson，抹掉第一次写入的 output_failure_details（评审
    // P1 + CI 失败：updateTask 被调 2 次而非 1 次）。lastValidatorErrors
    // 携带 sourceAttemptCount（= 本 attempt 序号）供读取侧做跨 attempt/跨
    // 进程新鲜度判定——运行时错误不清除它也不会串 attempt（读取侧只接受
    // sourceAttemptCount === 本 attempt-1 的记录）。
    //
    // P1-3: `validator_error_history` is appended in the SAME merged write.
    // output_failure_details/lastValidatorErrors only describe the CURRENT
    // attempt; the lab evidence showed three identical failures where every
    // earlier attempt's validator errors were gone, making "did the repair
    // feedback change anything?" unanswerable. The history is bounded and lives
    // in the existing diagnosticJson field — the runs table stays untouched.
    const recordedAt = new Date().toISOString();
    const history = readValidatorErrorHistory(ctx.task.diagnosticJson);
    const boundedHistory = [
      ...history,
      {
        attempt: ctx.task.attemptCount,
        recordedAt,
        errorCategory: category,
        errors: [...ctx.errors],
      },
    ].slice(-MAX_VALIDATOR_ERROR_HISTORY);

    // SPEC §7 evidence: structured redaction FIRST (key-name based: password /
    // apiKey / client_secret / authorization / nested token), then serialize,
    // then string-level redaction for credentials embedded inside plain values.
    // Serializing first would let JSON-quoted keys and escaped Windows paths slip
    // past the string regexes — proven leak in the 2026-11-12 review.
    let rawOutputPreview: string | undefined;
    if (ctx.rawOutput !== undefined) {
      const structured = redactSensitiveFields(ctx.rawOutput);
      const sanitized = structured.ok ? structured.value : ctx.rawOutput;
      const serialized = safeStringifyPreview(sanitized, 2000);
      const redacted = redactTelemetryString(serialized);
      rawOutputPreview = typeof redacted === 'string' ? redacted : serialized;
    }

    await this.persistOutputFailureDetails(ctx.taskId, ctx.task.diagnosticJson, {
      errorCategory: category,
      validatorErrors: [...ctx.errors],
      errorCount: ctx.errors.length,
      ...(rawOutputPreview !== undefined ? { rawOutputPreview } : {}),
    }, {
      lastValidatorErrors: {
        recordedAt,
        errorCategory: category,
        errors: [...ctx.errors],
        sourceAttemptCount: ctx.task.attemptCount,
      },
      validator_error_history: boundedHistory,
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

    // Max attempts exceeded.
    //
    // P1-3 root cause fix: the exhausted-budget branch used to call
    // markTaskFailed(taskId, 'max_attempts_exceeded', ...), REPLACING
    // task.last_error and the newest run's errorCategory with the budget
    // mechanism. The classified cause (e.g. output_invalid) was erased, so a
    // task whose schema validation failed three times ended up indistinguishable
    // from an unclassified runtime hang. The budget is HOW execution stopped,
    // not WHY it failed:
    //   - task.last_error keeps the classified category (single truth for
    //     "what went wrong");
    //   - diagnosticJson.terminal_failure records the terminal mechanism plus
    //     the classified category/attempts, in the SAME diagnosticJson the
    //     output-failure details already use (no new table, no second truth);
    //   - the newest run keeps the classified errorCategory, and its reason
    //     still says "Max attempts exceeded: <classified reason>".
    await this.persistTerminalFailure(ctx);
    const maxAttemptsReason = `Max attempts exceeded: ${ctx.failureReason}`;
    try {
      await this.stateManager.markTaskFailed(ctx.taskId, ctx.errorCategory, maxAttemptsReason);
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
      terminalReason: 'max_attempts_exceeded',
      attemptCount: ctx.task.attemptCount,
      failureReason: maxAttemptsReason,
    });
    this.phase = RunnerPhase.Failed;
    return {
      status: 'failed',
      taskId: ctx.taskId,
      errorCategory: ctx.errorCategory,
      terminalReason: 'max_attempts_exceeded',
      failureReason: maxAttemptsReason,
      attemptCount: ctx.task.attemptCount,
    };
  }

  /**
   * P1-3: persist `diagnosticJson.terminal_failure` before the terminal
   * markTaskFailed write.
   *
   * Re-reads the task row first (rc-7 loop-state freshness): the in-memory
   * context snapshot predates this attempt's own output_failure_details write,
   * and merging from the stale snapshot would erase the very validator errors
   * this record exists to preserve alongside.
   *
   * Best-effort (rc-9): a persistence failure is observable via
   * `mark_failed_error` and must not block the terminal state transition —
   * the classified `last_error` on the task row is still correct without it.
   */
  private async persistTerminalFailure(ctx: FailureContext): Promise<void> {
    try {
      const fresh = await this.stateManager.getTask(ctx.taskId);
      const parsed = parseDiagnosticJsonRecord(fresh?.diagnosticJson ?? ctx.task.diagnosticJson);
      parsed.terminal_failure = {
        recordedAt: new Date().toISOString(),
        reason: 'max_attempts_exceeded',
        errorCategory: ctx.errorCategory,
        failureReason: ctx.failureReason,
        attemptCount: ctx.task.attemptCount,
        maxAttempts: ctx.task.maxAttempts,
      };
      await this.stateManager.updateTask(ctx.taskId, { diagnosticJson: JSON.stringify(parsed) });
    } catch (err) {
      this.emitEvent('mark_failed_error', ctx.taskId, {
        errorCategory: 'storage_unavailable',
        attemptCount: ctx.task.attemptCount,
        errorMessage: `persistTerminalFailure failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
  // eslint-disable-next-line @typescript-eslint/max-params
  protected async persistOutputFailureDetails(
    taskId: string,
    existingDiagnosticJson: string | null | undefined,
    details: Record<string, unknown>,
    extraTopLevelKeys?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const parsed = parseDiagnosticJsonRecord(existingDiagnosticJson);
      parsed.output_failure_details = {
        recordedAt: new Date().toISOString(),
        ...details,
      };
      // PRI-700 因子 B: additional top-level keys (lastValidatorErrors) must
      // land in the SAME updateTask — a second write from a stale snapshot
      // would erase output_failure_details (评审 P1).
      if (extraTopLevelKeys !== undefined) {
        Object.assign(parsed, extraTopLevelKeys);
      }
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
    // rc-9: parseSeedSourcePainId degrades corrupt payloads to null —
    // linkage is optional and must not break draft insertion.
    const painId = parseSeedSourcePainId(ctx.task.diagnosticJson);

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
