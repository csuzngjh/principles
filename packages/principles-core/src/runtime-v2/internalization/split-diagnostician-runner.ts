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
 * (PainSignalBridge.onPainDetected), not by this wrapper or the router.
 *
 * Key constraints:
 *   - Each stage gets its own task with the correct taskKind
 *   - Stage B depends on Stage A (dependencyTaskIds)
 *   - Stage C depends on both A and B (dependencyTaskIds)
 *   - If any stage fails, the pipeline stops and returns the failure
 *   - The parent diagnostician task is NOT created — the bridge already
 *     creates it; this runner only creates the 3 sub-tasks
 *
 * @see PRI-372
 */

import type { DiagRootCauseRunner } from './diag-rootcause-runner.js';
import type { DiagDistillerRunner } from './diag-distiller-runner.js';
import type { DiagRouterRunner } from './diag-router-runner.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { RunnerResult } from '../runner/runner-result.js';
import type { DiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
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
}

// ── SplitDiagnosticianRunner ─────────────────────────────────────────────────

/**
 * Orchestrates the 3-stage split diagnostician pipeline.
 *
 * This class is a thin orchestrator — it does NOT extend BasePeerRunner.
 * It creates sub-tasks, runs each stage's runner, and returns a RunnerResult
 * compatible with the monolithic DiagnosticianRunner's output.
 */
export class SplitDiagnosticianRunner {
  private readonly rootCauseRunner: DiagRootCauseRunner;
  private readonly distillerRunner: DiagDistillerRunner;
  private readonly routerRunner: DiagRouterRunner;
  private readonly stateManager: RuntimeStateManager;
  private readonly perStageTimeoutMs: number;

  constructor(deps: SplitDiagnosticianRunnerDeps) {
    this.rootCauseRunner = deps.rootCauseRunner;
    this.distillerRunner = deps.distillerRunner;
    this.routerRunner = deps.routerRunner;
    this.stateManager = deps.stateManager;
    this.perStageTimeoutMs = deps.perStageTimeoutMs ?? 300_000;
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

    // Create Stage A task (no dependencies — entry point of the pipeline)
    await this.stateManager.createTask({
      taskId: stageATaskId,
      taskKind: 'diag_rootcause',
      inputRef: parentTaskId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: this.perStageTimeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const resultA = await this.rootCauseRunner.run(stageATaskId);
    if (resultA.status !== 'succeeded') {
      try {
        await this.stateManager.markTaskFailed(parentTaskId, resultA.errorCategory ?? 'execution_failed');
      } catch { /* best-effort — return failure regardless */ }
      return {
        status: resultA.status,
        taskId: parentTaskId,
        errorCategory: resultA.errorCategory,
        failureReason: resultA.failureReason ?? `Stage A (rootcause) failed for ${parentTaskId}`,
        attemptCount: resultA.attemptCount,
      };
    }

    // ── Stage B: Distiller ─────────────────────────────────────────────────
    const stageBTaskId = `diag_distiller-${parentTaskId}`;

    // Create Stage B task (depends on Stage A)
    await this.stateManager.createTask({
      taskId: stageBTaskId,
      taskKind: 'diag_distiller',
      inputRef: parentTaskId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [stageATaskId],
        channel: 'prompt',
        timeoutMs: this.perStageTimeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const resultB = await this.distillerRunner.run(stageBTaskId);
    if (resultB.status !== 'succeeded') {
      try {
        await this.stateManager.markTaskFailed(parentTaskId, resultB.errorCategory ?? 'execution_failed');
      } catch { /* best-effort — return failure regardless */ }
      return {
        status: resultB.status,
        taskId: parentTaskId,
        errorCategory: resultB.errorCategory,
        failureReason: resultB.failureReason ?? `Stage B (distiller) failed for ${parentTaskId}`,
        attemptCount: resultB.attemptCount,
      };
    }

    // ── Stage C: Router ────────────────────────────────────────────────────
    const stageCTaskId = `diag_router-${parentTaskId}`;

    // Create Stage C task (depends on both A and B)
    await this.stateManager.createTask({
      taskId: stageCTaskId,
      taskKind: 'diag_router',
      inputRef: parentTaskId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [stageATaskId, stageBTaskId],
        channel: 'prompt',
        timeoutMs: this.perStageTimeoutMs,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const resultC = await this.routerRunner.run(stageCTaskId);
    if (resultC.status !== 'succeeded') {
      try {
        await this.stateManager.markTaskFailed(parentTaskId, resultC.errorCategory ?? 'execution_failed');
      } catch { /* best-effort — return failure regardless */ }
      return {
        status: resultC.status,
        taskId: parentTaskId,
        errorCategory: resultC.errorCategory,
        failureReason: resultC.failureReason ?? `Stage C (router) failed for ${parentTaskId}`,
        attemptCount: resultC.attemptCount,
      };
    }

    // ── Pipeline complete ──────────────────────────────────────────────────
    // onDiagnosisComplete is invoked by the bridge (PainSignalBridge.onPainDetected)
    // after this run() returns succeeded — not by the router or this wrapper (P0-1 fix).
    // P0-2 fix: mark parent task as succeeded so it reaches terminal state.
    const parentResultRef = resultC.resultRef ?? `split-pipeline://${parentTaskId}`;
    try {
      await this.stateManager.markTaskSucceeded(parentTaskId, parentResultRef);
    } catch { /* best-effort — return success regardless */ }
    return {
      status: 'succeeded',
      taskId: parentTaskId,
      contextHash: resultC.contextHash,
      output: resultC.output,
      attemptCount: resultA.attemptCount + resultB.attemptCount + resultC.attemptCount,
    };
  }
}
