/**
 * SplitDiagnosticianRunner — orchestrates the 3-stage split pipeline (PRI-372).
 *
 * Implements the same `run(taskId)` interface as DiagnosticianRunner,
 * so the PainSignalBridge can use it as a drop-in replacement when
 * the `diagnostician_split_pipeline` feature flag is enabled.
 *
 * Internally creates sub-tasks for each stage and runs them sequentially:
 *   Stage A (diag_rootcause) → Stage B (diag_distiller) → Stage C (diag_router)
 *
 * After Stage C succeeds, onDiagnosisComplete is invoked by the bridge
 * (PainSignalBridge.onPainDetected), not by this router or the router.
 *
 * Key constraints:
 *   - Each stage gets its own task with the correct taskKind
 *   - Stage B depends on Stage A (dependencyTaskIds)
 *   - Stage C depends on both A and B (dependencyTaskIds)
 *   - If any stage fails, the pipeline stops and returns the failure
 *   - The parent diagnostician task is NOT created — the bridge already
 *     creates it; this runner only creates the 3 sub-tasks
 *   - If a sub-runner returns `retried`, this orchestrator waits for the
 *     backoff period and re-runs the stage until it succeeds or fails
 *     (ERR-067 fix: previously `retried` was treated as failure)
 *
 * @see PRI-372
 * @see ERR-067
 */

import type { DiagRootCauseRunner } from './diag-rootcause-runner.js';
import type { DiagDistillerRunner } from './diag-distiller-runner.js';
import type { DiagRouterRunner } from './diag-router-runner.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { RunnerResult } from '../runner/runner-result.js';
import type { PeerRunnerResult, PeerRunnerResultStatus } from '../runner/peer-runner-types.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';
import type { TaskRecord } from '../task-status.js';
import type { DiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import type { RetryPolicy } from '../store/lifecycle/retry-policy.js';
import { DefaultDiagnosticianValidator } from '../runner/default-validator.js';
import { PDRuntimeError } from '../error-categories.js';
import { createPITaskDiagnosticJson } from './pitask-metadata.js';

// ── P1-3: failed-stage projection ────────────────────────────────────────────

/**
 * Facts about a failed stage task, projected onto the parent task so the parent
 * is not left with only `max_attempts_exceeded`.
 *
 * Root cause (lab evidence 2026-11-12): the parent `diagnosis_*` task reported
 * `attempt_count=1`, `last_error=max_attempts_exceeded`, and NO
 * `output_failure_details`. Every diagnostic detail lived on the child
 * `diag_router-*` task, so an Owner looking at the parent could not tell which
 * stage failed, why, or what the validator rejected.
 */
interface StageFailureProjection {
  readonly stageTaskId: string;
  readonly stageTaskKind: string;
  readonly errorCategory: string | null;
  readonly terminalReason: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly failureReason: string | null;
  readonly validatorErrors: readonly string[];
  readonly recordedAt: string;
}

function parseDiagnosticJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {};
  // runtime-contract-exempt: ERR-001 the guards above narrow `candidate` to a
  // non-null non-array object; field values are still validated on read.
  return candidate as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readStringField(obj: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(obj, key)) return null;
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Build the projection from the failed stage task's own persisted facts.
 * Prefers the freshest structured source available:
 *   - `lastValidatorErrors.errors` (written per attempt by BasePeerRunner)
 *   - `output_failure_details.validatorErrors` (adapter/validator evidence)
 * Nothing here is inferred from prose; a missing fact stays null/empty.
 */
function buildStageFailureProjection(
  stageTask: TaskRecord,
  stageResult: PeerRunnerResult<unknown>,
): StageFailureProjection {
  const parsed = parseDiagnosticJsonObject(stageTask.diagnosticJson);
  const lastValidatorErrors = Object.hasOwn(parsed, 'lastValidatorErrors') && typeof parsed.lastValidatorErrors === 'object' && parsed.lastValidatorErrors !== null && !Array.isArray(parsed.lastValidatorErrors)
    ? parsed.lastValidatorErrors as Record<string, unknown>
    : {};
  const outputFailureDetails = Object.hasOwn(parsed, 'output_failure_details') && typeof parsed.output_failure_details === 'object' && parsed.output_failure_details !== null && !Array.isArray(parsed.output_failure_details)
    ? parsed.output_failure_details as Record<string, unknown>
    : {};
  const terminalFailure = Object.hasOwn(parsed, 'terminal_failure') && typeof parsed.terminal_failure === 'object' && parsed.terminal_failure !== null && !Array.isArray(parsed.terminal_failure)
    ? parsed.terminal_failure as Record<string, unknown>
    : {};

  const validatorErrors = readStringArray(lastValidatorErrors.errors);
  const fallbackErrors = validatorErrors.length > 0 ? validatorErrors : readStringArray(outputFailureDetails.validatorErrors);

  return {
    stageTaskId: stageTask.taskId,
    stageTaskKind: stageTask.taskKind,
    errorCategory: stageTask.lastError ?? stageResult.errorCategory ?? null,
    terminalReason: readStringField(terminalFailure, 'reason') ?? stageResult.terminalReason ?? null,
    attemptCount: stageTask.attemptCount,
    maxAttempts: stageTask.maxAttempts,
    failureReason: stageResult.failureReason ?? null,
    validatorErrors: fallbackErrors,
    recordedAt: new Date().toISOString(),
  };
}


// ── Dependencies ─────────────────────────────────────────────────────────────

interface SplitDiagnosticianRunnerDeps {
  readonly rootCauseRunner: DiagRootCauseRunner;
  readonly distillerRunner: DiagDistillerRunner;
  readonly routerRunner: DiagRouterRunner;
  readonly stateManager: RuntimeStateManager;
  readonly committer: DiagnosticianCommitter;
  /** Per-stage timeout in ms. Default: 600_000 (10 min). Split pipeline total = 3 × this value. */
  readonly perStageTimeoutMs?: number;
  /** Retry policy for backoff calculation. Defaults to stateManager.getRetryPolicy(). */
  readonly retryPolicy?: RetryPolicy;
}

// ── SplitDiagnosticianRunner ─────────────────────────────────────────────────

/**
 * Orchestrates the 3-stage split diagnostician pipeline.
 *
 * This class is a thin orchestrator — it does NOT extend BasePeerRunner.
 * It creates sub-tasks, runs each stage's runner, and returns a RunnerResult
 * compatible with the monolithic DiagnosticianRunner's output.
 *
 * ERR-067 fix: when a sub-runner returns `retried`, this orchestrator
 * waits for the backoff period and re-runs the stage, up to maxAttempts.
 * Previously, `retried` was treated as failure, breaking the retry chain.
 */
export class SplitDiagnosticianRunner {
  private readonly rootCauseRunner: DiagRootCauseRunner;
  private readonly distillerRunner: DiagDistillerRunner;
  private readonly routerRunner: DiagRouterRunner;
  private readonly stateManager: RuntimeStateManager;
  private readonly perStageTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  /**
   * PRI-818 (R-04): same authority the live Stage C path uses for semantic
   * validation (diag-router-runner.ts). A cached succeeded run must pass the
   * identical gate before it is allowed to skip the router stage.
   */
  private readonly cacheOutputValidator: DefaultDiagnosticianValidator;

  constructor(deps: SplitDiagnosticianRunnerDeps) {
    this.rootCauseRunner = deps.rootCauseRunner;
    this.distillerRunner = deps.distillerRunner;
    this.routerRunner = deps.routerRunner;
    this.stateManager = deps.stateManager;
    this.perStageTimeoutMs = deps.perStageTimeoutMs ?? 600_000;
    this.retryPolicy = deps.retryPolicy ?? deps.stateManager.getRetryPolicy();
    this.cacheOutputValidator = new DefaultDiagnosticianValidator();
  }

  /**
   * Execute the full split pipeline A→B→C for a parent diagnostician task.
   *
   * The `taskId` parameter is the parent diagnostician task ID (e.g. `diagnosis_pain-001`).
   * Sub-tasks are derived from it:
   *   - Stage A: `diag_rootcause-{parentTaskId}`
   *   - Stage B: `diag_distiller-{parentTaskId}`
   *   - Stage C: `diag_router-{parentTaskId}`
   *
   * Returns a RunnerResult compatible with DiagnosticianRunner.run().
   */
  async run(parentTaskId: string): Promise<RunnerResult> {
    // Bug-N fix: acquire lease on the parent task so markTaskSucceeded (called
    // at the end of run()) has a run record to update. Without this, the
    // parent task is marked succeeded in the tasks table but no run record
    // is created, leaving runs/tasks truth out of sync (8 diagnosis_manual_*
    // tasks hit this in production). The parent task is created by
    // PainSignalBridge but never lease-acquired — this runner must do it.
    try {
      await this.stateManager.acquireLease({
        taskId: parentTaskId,
        owner: 'split-diagnostician-orchestrator',
        runtimeKind: 'openclaw',
      });
    } catch (error) {
      // lease_conflict = another worker is already running this task.
      // Non-mutating: do not call markTaskFailed/markTaskRetryWait (rc-3 fail-loud).
      const isLeaseConflict = error instanceof PDRuntimeError && error.category === 'lease_conflict';
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        taskId: parentTaskId,
        errorCategory: isLeaseConflict ? 'lease_conflict' : 'execution_failed',
        failureReason: `Parent task ${parentTaskId} lease acquisition failed: ${errorMessage}`,
        attemptCount: 1,
      };
    }

    // ── Stage A: Root Cause ────────────────────────────────────────────────
    const stageATaskId = `diag_rootcause-${parentTaskId}`;

    await this.ensureSubTask({
      taskId: stageATaskId,
      taskKind: 'diag_rootcause',
      parentTaskId,
      dependencyTaskIds: [],
    });

    // Recovery resume: a previous partial run may have already completed Stage
    // A. Re-running it would attempt to lease a `succeeded` task and dead-end
    // the parent with lease_conflict (observed in PRI-983 E2E recovery). The
    // stage artifact is committed before the task is marked succeeded, and
    // Stage B reads that artifact itself — so skip the re-run.
    const cachedA = await this.reuseSucceededStage(stageATaskId);
    const resultA = cachedA ?? await this.runStageWithRetry({
      taskId: stageATaskId,
      runFn: (id) => this.rootCauseRunner.run(id),
      stageLabel: 'A (rootcause)',
    });

    if (resultA.status !== 'succeeded') {
      return this.failParent(parentTaskId, resultA);
    }

    // ── Stage B: Distiller ─────────────────────────────────────────────────
    const stageBTaskId = `diag_distiller-${parentTaskId}`;

    await this.ensureSubTask({
      taskId: stageBTaskId,
      taskKind: 'diag_distiller',
      parentTaskId,
      dependencyTaskIds: [stageATaskId],
    });

    // Same recovery-resume rule as Stage A: a succeeded B already committed
    // its distiller artifact, which Stage C reads directly.
    const cachedB = await this.reuseSucceededStage(stageBTaskId);
    const resultB = cachedB ?? await this.runStageWithRetry({
      taskId: stageBTaskId,
      runFn: (id) => this.distillerRunner.run(id),
      stageLabel: 'B (distiller)',
    });

    if (resultB.status !== 'succeeded') {
      return this.failParent(parentTaskId, resultB);
    }

    // ── Stage C: Router ────────────────────────────────────────────────────
    const stageCTaskId = `diag_router-${parentTaskId}`;

    await this.ensureSubTask({
      taskId: stageCTaskId,
      taskKind: 'diag_router',
      parentTaskId,
      dependencyTaskIds: [stageATaskId, stageBTaskId],
    });

    // Stage C may already be succeeded from a previous partial run
    const stageCTask = await this.stateManager.getTask(stageCTaskId);
    let resultC: PeerRunnerResult<DiagnosticianOutputV2>;
    if (stageCTask && stageCTask.status === 'succeeded') {
      const runs = await this.stateManager.getRunsByTask(stageCTaskId);
      // PRI-818 (R1 review 818-2): getRunsByTask returns runs in started_at
      // ASC order. A superseded older succeeded run (e.g. one written before
      // cache validation existed and rejected below) must never shadow a
      // newer valid one — pick the LATEST succeeded run.
      const succeededRuns = runs.filter((r) => r.executionStatus === 'succeeded');
      const [succeededRun] = succeededRuns.slice(-1);
      const outputPayload = succeededRun?.outputPayload;
      // EP-01 / rc-1: JSON.parse of persisted DB content is a trust boundary —
      // outputPayload may be corrupt/malformed (e.g. partial write, DB
      // corruption). Without this guard, JSON.parse on corrupt data throws an
      // unhandled SyntaxError that propagates through run() to the bridge —
      // the parent task stays leased/running (stuck task, consistent with
      // PRI-518/PRI-520 observations). Fail safe: if parse fails, treat the
      // cache as unusable and fall through to re-run Stage C normally so the
      // standard retry/failure path produces a structured result.
      let parsedOutput: unknown;
      let cacheUsable = true;
      if (outputPayload !== undefined && outputPayload !== null) {
        try {
          parsedOutput = JSON.parse(outputPayload);
        } catch {
          cacheUsable = false;
        }
      } else {
        // No persisted payload at all — an undefined output would flow to the
        // bridge as a succeeded diagnosis. Treat as unusable (PRI-818).
        parsedOutput = undefined;
        cacheUsable = false;
      }
      // PRI-818 (R-04, rc-2): parseable ≠ valid. A payload that survives
      // JSON.parse but fails Stage C's own semantic validation would
      // previously bypass the router validator entirely (raw `as` cast) and
      // reach admission/persistence as a diagnosis. Re-run the identical
      // DefaultDiagnosticianValidator the live Stage C path uses (single
      // authority); the `as` only satisfies the validator's declared parameter
      // type — its first step re-guards the value at runtime, so no untrusted
      // data escapes validation (same pattern as diag-router-runner post-gate).
      if (cacheUsable) {
        try {
          const cacheValidation = await this.cacheOutputValidator.validate(
            parsedOutput as DiagnosticianOutputV2,
            stageCTaskId,
          );
          if (!cacheValidation.valid) {
            cacheUsable = false;
          }
        } catch {
          // PRI-821 (R4 review F-1): the validator's semantic checks assume
          // string fields (e.g. `summary.trim()`); a truthy non-string field
          // can throw TypeError here — unlike the live path, this call is
          // NOT wrapped by BasePeerRunner's catch, so the error would escape
          // run() and strand the parent leased. Fail safe: treat the cache
          // as unusable and take the reset+rerun path below.
          cacheUsable = false;
        }
      }
      if (cacheUsable) {
        resultC = {
          status: 'succeeded',
          taskId: stageCTaskId,
          attemptCount: stageCTask.attemptCount,
          contextHash: '',
          output: parsedOutput as DiagnosticianOutputV2,
        };
      } else {
        // PRI-818 (R1 review 818-1): the Stage C task is `succeeded`, but
        // BasePeerRunner.acquireLease only accepts pending/retry_wait — a
        // plain rerun would throw lease_conflict and dead-end the parent
        // with no recovery path. Reset the sub-task to pending first (same
        // raw-reset precedent as PainSignalBridge.onPainDetected; the
        // canTransitionTo guard does not model cache invalidation, and the
        // recovery sweep uses the same bypass). attemptCount is deliberately
        // preserved — the rerun consumes no fresh retry budget.
        await this.stateManager.updateTask(stageCTaskId, { status: 'pending', lastError: null, resultRef: null });
        resultC = await this.runStageWithRetry({
          taskId: stageCTaskId,
          runFn: (id) => this.routerRunner.run(id),
          stageLabel: 'C (router)',
        });
      }
    } else {
      resultC = await this.runStageWithRetry({
        taskId: stageCTaskId,
        runFn: (id) => this.routerRunner.run(id),
        stageLabel: 'C (router)',
      });
    }

    if (resultC.status !== 'succeeded') {
      return this.failParent(parentTaskId, resultC);
    }

    // ── Pipeline complete ──────────────────────────────────────────────────
    // onDiagnosisComplete is invoked by the bridge (PainSignalBridge.onPainDetected)
    // after this run() returns succeeded — not by the router or this wrapper (P0-1 fix).
    // P0-2 fix: mark parent task as succeeded so it reaches terminal state.
    const parentResultRef = resultC.resultRef ?? `split-pipeline://${parentTaskId}`;
    try {
      await this.stateManager.markTaskSucceeded(parentTaskId, parentResultRef);
    } catch (error) {
      // rc-3/rc-9 fail-loud (PRI-520): never report success before the parent
      // terminal transition is durable. If markTaskSucceeded cannot persist,
      // the parent task stays leased/running in storage while we would claim
      // succeeded — the most damaging "it said it finished, but the state says
      // otherwise" failure (ERR-002/ERR-015/ERR-088). Surface a structured
      // storage_unavailable result so operators see the persistence failure,
      // not a false success.
      const persistErrorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        taskId: parentTaskId,
        errorCategory: 'storage_unavailable',
        failureReason: `failed to persist parent task success for ${parentTaskId}. Persistence error: ${persistErrorMessage}`,
        attemptCount: resultC.attemptCount,
      };
    }

    const stageA = await this.stateManager.getTask(stageATaskId);
    const stageB = await this.stateManager.getTask(stageBTaskId);
    const stageC = await this.stateManager.getTask(stageCTaskId);

    return {
      status: 'succeeded',
      taskId: parentTaskId,
      contextHash: resultC.contextHash,
      output: resultC.output,
      attemptCount: (stageA?.attemptCount ?? resultA.attemptCount) + (stageB?.attemptCount ?? resultB.attemptCount) + (stageC?.attemptCount ?? resultC.attemptCount),
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Ensure a sub-task exists. If it already exists in `retry_wait` status,
   * transition it to `pending` WITHOUT resetting attemptCount (ERR-067 fix:
   * previously attemptCount was reset to 0, losing retry progress).
   *
   * If it exists in `failed` status, also transition to `pending` without
   * resetting attemptCount — the retry policy will check shouldRetry().
   */
  private async ensureSubTask(opts: {
    taskId: string;
    taskKind: 'diag_rootcause' | 'diag_distiller' | 'diag_router';
    parentTaskId: string;
    dependencyTaskIds: string[];
  }): Promise<void> {
    const { taskId, taskKind, parentTaskId, dependencyTaskIds } = opts;
    const existing = await this.stateManager.getTask(taskId);
    if (!existing) {
      await this.stateManager.createTask({
        taskId,
        taskKind,
        inputRef: parentTaskId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: createPITaskDiagnosticJson({
          dependencyTaskIds,
          channel: 'prompt',
          timeoutMs: this.perStageTimeoutMs,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
        }),
      });
      return;
    }

    // ERR-067 fix: do NOT reset attemptCount on retry_wait/failed tasks.
    // The retry policy (shouldRetry) uses attemptCount to decide whether
    // to retry. Resetting it would cause infinite retries.
    // P1-2 fix: check shouldRetry() before transitioning failed → pending.
    if (existing.status === 'retry_wait') {
      await this.stateManager.updateTask(taskId, {
        status: 'pending',
        lastError: null,
      });
    } else if (existing.status === 'failed') {
      if (!this.retryPolicy.shouldRetry(existing)) {
        // Task has exhausted its retry budget — do not re-pend
        return;
      }
      await this.stateManager.updateTask(taskId, {
        status: 'pending',
        lastError: null,
      });
    }
  }

  /**
   * Recovery resume for Stages A/B: when a previous partial run already
   * completed the stage, re-leasing it would fail (a `succeeded` task is not
   * leasable) and dead-end the parent with `lease_conflict`. The stage's
   * artifact is committed before the task is marked succeeded, and the next
   * stage reads that artifact directly, so skipping the re-run is safe.
   */
  private async reuseSucceededStage(taskId: string): Promise<PeerRunnerResult<unknown> | null> {
    const task = await this.stateManager.getTask(taskId);
    if (!task || task.status !== 'succeeded') return null;
    return { status: 'succeeded', taskId, attemptCount: task.attemptCount };
  }

  /**
   * Run a stage's runner with retry support (ERR-067 fix).
   *
   * When the sub-runner returns `retried`, this method:
   * 1. Waits for the backoff period calculated by the retry policy
   * 2. Re-runs the sub-runner
   * 3. Repeats until the result is `succeeded` or `failed`
   *
   * This ensures that transient LLM failures (e.g., schema non-compliance)
   * are actually retried instead of being treated as terminal failures.
   */
  private async runStageWithRetry<TOutput>(opts: {
    taskId: string;
    runFn: (taskId: string) => Promise<PeerRunnerResult<TOutput>>;
    stageLabel: string;
  }): Promise<PeerRunnerResult<TOutput>> {
    const { taskId, runFn, stageLabel } = opts;
    const maxRetries = 10; // Safety limit to prevent infinite loops
    let attempt = 0;

    while (true) {
      attempt++;
      const result = await runFn(taskId);

      if (result.status === 'succeeded' || result.status === 'failed') {
        return result;
      }

      if (result.status === 'retried') {
        // Get the current task state for shouldRetry check and backoff calculation
        const task = await this.stateManager.getTask(taskId);

        // P1-1 fix: check shouldRetry() against task's maxAttempts
        if (task && !this.retryPolicy.shouldRetry(task)) {
          return {
            status: 'failed',
            taskId: result.taskId,
            errorCategory: result.errorCategory ?? 'max_attempts_exceeded',
            failureReason: `Stage ${stageLabel}: attemptCount (${task.attemptCount}) >= maxAttempts (${task.maxAttempts}). ${result.failureReason ?? ''}`,
            attemptCount: result.attemptCount,
          };
        }

        if (attempt >= maxRetries) {
          // Safety: break out of potential infinite loop
          return {
            status: 'failed',
            taskId: result.taskId,
            errorCategory: result.errorCategory ?? 'max_attempts_exceeded',
            failureReason: `Stage ${stageLabel}: max retry loop iterations (${maxRetries}) exceeded. ${result.failureReason ?? ''}`,
            attemptCount: result.attemptCount,
          };
        }

        // Calculate backoff from task state
        const backoffMs = task
          ? this.retryPolicy.calculateBackoff(task.attemptCount)
          : 30_000; // fallback: 30s

        // Wait for backoff period
        await new Promise((resolve) => setTimeout(resolve, backoffMs));

        // Re-run the stage — the sub-runner will acquire the lease on the
        // retry_wait task and attempt execution again
        continue;
      }

      // Unknown status — treat as failure (fail-loud, ERR-009)
      return {
        status: 'failed',
        taskId: result.taskId,
        errorCategory: result.errorCategory ?? 'execution_failed',
        failureReason: `Stage ${stageLabel}: unexpected status '${result.status as PeerRunnerResultStatus}'`,
        attemptCount: result.attemptCount,
      };
    }
  }

  /**
   * Mark the parent task as failed and return a failure result.
   *
   * P1-3: before the terminal write, project the failed stage's own facts onto
   * the parent (diagnosticJson.failed_stage). The parent keeps the real
   * classified `last_error` (the stage's category), while the terminal
   * mechanism (`max_attempts_exceeded`) travels as a nested fact rather than
   * replacing the diagnosis. Projection is best-effort (rc-9): the failure text
   * below always carries the stage facts, so a failed projection write can
   * never hide the cause.
   */
  private async failParent(
    parentTaskId: string,
    stageResult: PeerRunnerResult<unknown>,
  ): Promise<RunnerResult> {
    const stageErrorCategory = stageResult.errorCategory;
    const stageFailureReason = stageResult.failureReason ?? `Stage failed for parent task ${parentTaskId}`;

    let stageFacts = '';
    try {
      const stageTask = await this.stateManager.getTask(stageResult.taskId);
      if (stageTask) {
        const projection = buildStageFailureProjection(stageTask, stageResult);
        stageFacts = ` [stage ${projection.stageTaskKind} ${projection.stageTaskId}: attempts ${projection.attemptCount}/${projection.maxAttempts}`
          + `, error ${projection.errorCategory ?? 'unknown'}`
          + `${projection.terminalReason ? `, terminal ${projection.terminalReason}` : ''}`
          + `${projection.validatorErrors.length > 0 ? `, last validator error: ${projection.validatorErrors[projection.validatorErrors.length - 1]}` : ''}]`;
        await this.persistParentStageFailure(parentTaskId, projection);
      }
    } catch {
      // Projection is supplementary; the classified category + failureReason
      // below remain authoritative. Never let it change the terminal outcome.
    }

    try {
      await this.stateManager.markTaskFailed(
        parentTaskId,
        stageErrorCategory ?? 'execution_failed',
        `${stageFailureReason}${stageFacts}`,
      );
    } catch (error) {
      // rc-3/rc-9 fail-loud (PRI-520): if markTaskFailed cannot persist, the
      // parent task stays leased/running while we report the earlier stage
      // category. That hides the persistence failure behind the stage failure
      // (ERR-002/ERR-015/ERR-088). Surface storage_unavailable as the primary
      // category, but preserve the original stage outcome in failureReason so
      // operators can see both the why-it-failed and why-it-stuck.
      const persistErrorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        taskId: parentTaskId,
        errorCategory: 'storage_unavailable',
        failureReason: `failed to persist parent task failure for ${parentTaskId}. Persistence error: ${persistErrorMessage}. Original stage outcome: ${stageErrorCategory ?? 'execution_failed'} — ${stageFailureReason}${stageFacts}`,
        attemptCount: stageResult.attemptCount,
      };
    }
    return {
      status: stageResult.status === 'retried' ? 'failed' : stageResult.status,
      taskId: parentTaskId,
      errorCategory: stageErrorCategory,
      failureReason: `${stageFailureReason}${stageFacts}`,
      attemptCount: stageResult.attemptCount,
    };
  }

  /**
   * P1-3: merge `diagnosticJson.failed_stage` into the parent without touching
   * any other key (pi_metadata must stay intact for parsePITaskMetadata).
   * Re-reads the parent row (rc-7) so concurrent metadata written during the
   * same run is not clobbered by a stale snapshot.
   */
  private async persistParentStageFailure(
    parentTaskId: string,
    projection: StageFailureProjection,
  ): Promise<void> {
    const current = await this.stateManager.getTask(parentTaskId);
    const parsed = parseDiagnosticJsonObject(current?.diagnosticJson);
    parsed.failed_stage = projection;
    await this.stateManager.updateTask(parentTaskId, { diagnosticJson: JSON.stringify(parsed) });
  }
}
