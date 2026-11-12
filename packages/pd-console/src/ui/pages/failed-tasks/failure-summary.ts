/**
 * P1-3 — Owner-facing failure summary for a failed task.
 *
 * The Failed Tasks detail panel already receives the task record and its run
 * history. This module turns those facts into the five answers the Owner needs:
 * which stage failed, what error type, the latest error, how many attempts were
 * used, and what to do next.
 *
 * Honesty rules (P1-3 / rc-9):
 * - Only facts already present in the detail payload are projected; nothing is
 *   inferred from a task kind or invented.
 * - "Retryable" is reported as the ATTEMPT BUDGET state, because whether a
 *   category is permanently non-retryable is decided by the runner, not by the
 *   Console. The copy therefore says "budget remaining" vs "budget exhausted",
 *   never a definitive "the runtime would retry this".
 */
import type { FailedTaskDetailData, FailedTaskDetailRun } from '../../utils/validators.js';

export type FailureNextActionCode =
  | 'retry_budget_available'
  | 'force_recovery_required'
  | 'wait_rate_limit'
  | 'inspect_output_schema'
  | 'check_storage'
  | 'investigate_runtime';

export interface FailureSummary {
  /** Stage that failed — the task kind, shown verbatim. */
  stage: string;
  /** Error category from the newest failed run (null when no run recorded one). */
  errorCategory: string | null;
  /** Newest error text: task lastError, else the newest failed run's reason. */
  latestError: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** Attempt budget remaining (never negative). */
  remainingAttempts: number;
  /** True when the attempt budget is spent (force recovery may be required). */
  budgetExhausted: boolean;
  nextActionCode: FailureNextActionCode;
}

function findNewestFailedRun(runs: readonly FailedTaskDetailRun[]): FailedTaskDetailRun | null {
  // Server returns runs newest-first. Prefer a failed run that carries an
  // error category; fall back to any non-succeeded run.
  const withCategory = runs.find(
    (run) => run.executionStatus !== 'succeeded' && run.errorCategory !== null,
  );
  if (withCategory) return withCategory;
  return runs.find((run) => run.executionStatus !== 'succeeded') ?? null;
}

export function deriveFailureSummary(data: FailedTaskDetailData): FailureSummary {
  const failedRun = findNewestFailedRun(data.runs);
  const errorCategory = failedRun?.errorCategory ?? null;
  const remainingAttempts = Math.max(0, data.maxAttempts - data.attemptCount);
  const budgetExhausted = remainingAttempts === 0;

  let nextActionCode: FailureNextActionCode;
  if (budgetExhausted) {
    nextActionCode = 'force_recovery_required';
  } else if (errorCategory === 'rate_limit') {
    nextActionCode = 'wait_rate_limit';
  } else if (errorCategory === 'output_invalid') {
    nextActionCode = 'inspect_output_schema';
  } else if (errorCategory === 'storage_unavailable' || errorCategory === 'artifact_commit_failed') {
    nextActionCode = 'check_storage';
  } else if (errorCategory !== null) {
    nextActionCode = 'retry_budget_available';
  } else {
    nextActionCode = 'investigate_runtime';
  }

  return {
    stage: data.taskKind,
    errorCategory,
    latestError: data.lastError ?? failedRun?.reason ?? null,
    attemptCount: data.attemptCount,
    maxAttempts: data.maxAttempts,
    remainingAttempts,
    budgetExhausted,
    nextActionCode,
  };
}
