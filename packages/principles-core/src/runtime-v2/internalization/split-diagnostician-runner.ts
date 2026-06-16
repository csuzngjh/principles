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
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import type { DiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import type { RetryPolicy } from '../store/lifecycle/retry-policy.js';
import { createPITaskDiagnosticJson } from './pitask-metadata.js';

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface SplitDiagnosticianRunnerDeps {
  readonly rootCauseRunner: DiagRootCauseRunner;
  readonly distillerRunner: DiagDistillerRunner;
  readonly routerRunner: DiagRouterRunner;
  readonly stateManager: RuntimeStateManager;
  readonly committer: DiagnosticianCommitter;
  /** Per-stage timeout in ms. Default: 300_000 (5 min). Split pipeline total = 3 × this value. */
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

  constructor(deps: SplitDiagnosticianRunnerDeps) {
    this.rootCauseRunner = deps.rootCauseRunner;
    this.distillerRunner = deps.distillerRunner;
    this.routerRunner = deps.routerRunner;
    this.stateManager = deps.stateManager;
    this.perStageTimeoutMs = deps.perStageTimeoutMs ?? 300_000;
    this.retryPolicy = deps.retryPolicy ?? deps.stateManager.getRetryPolicy();
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
    // ── Stage A: Root Cause ────────────────────────────────────────────────
    const stageATaskId = `diag_rootcause-${parentTaskId}`;

    await this.ensureSubTask({
      taskId: stageATaskId,
      taskKind: 'diag_rootcause',
      parentTaskId,
      dependencyTaskIds: [],
    });

    const resultA = await this.runStageWithRetry({
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

    const resultB = await this.runStageWithRetry({
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
    let resultC: PeerRunnerResult<DiagnosticianOutputV1>;
    if (stageCTask && stageCTask.status === 'succeeded') {
      const runs = await this.stateManager.getRunsByTask(stageCTaskId);
      const succeededRun = runs.find((r) => r.executionStatus === 'succeeded');
      const outputPayload = succeededRun?.outputPayload;
      const output = outputPayload ? JSON.parse(outputPayload) : undefined;
      resultC = {
        status: 'succeeded',
        taskId: stageCTaskId,
        attemptCount: stageCTask.attemptCount,
        contextHash: '',
        output,
      };
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
    } catch { /* best-effort — return success regardless */ }

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
   */
  private async failParent(
    parentTaskId: string,
    stageResult: PeerRunnerResult<unknown>,
  ): Promise<RunnerResult> {
    try {
      await this.stateManager.markTaskFailed(parentTaskId, stageResult.errorCategory ?? 'execution_failed');
    } catch { /* best-effort — return failure regardless */ }
    return {
      status: stageResult.status === 'retried' ? 'failed' : stageResult.status,
      taskId: parentTaskId,
      errorCategory: stageResult.errorCategory,
      failureReason: stageResult.failureReason ?? `Stage failed for parent task ${parentTaskId}`,
      attemptCount: stageResult.attemptCount,
    };
  }
}
