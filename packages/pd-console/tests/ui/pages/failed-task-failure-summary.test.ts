/**
 * P1-3 — failure summary projection for the Failed Tasks detail panel.
 *
 * The Owner must be able to answer: which stage failed, what error type, the
 * latest error, how many attempts were used, whether the retry budget is
 * available, and what to do next. These tests pin that projection to facts
 * already present in GET /api/failed-tasks/:id — no invented values.
 */
import { describe, it, expect } from 'vitest';
import { deriveFailureSummary } from '../../../src/ui/pages/failed-tasks/failure-summary.js';
import type { FailedTaskDetailData, FailedTaskDetailRun } from '../../../src/ui/utils/validators.js';

function run(overrides: Partial<FailedTaskDetailRun>): FailedTaskDetailRun {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    attemptNumber: 1,
    executionStatus: 'failed',
    startedAt: '2026-11-12T07:45:45.000Z',
    endedAt: '2026-11-12T07:46:00.000Z',
    reason: 'Validation failed',
    errorCategory: 'output_invalid',
    ...overrides,
  };
}

function detail(overrides: Partial<FailedTaskDetailData> = {}): FailedTaskDetailData {
  return {
    taskId: 'task-1',
    taskKind: 'diag_router',
    status: 'failed',
    createdAt: '2026-11-12T07:40:00.000Z',
    updatedAt: '2026-11-12T07:50:00.000Z',
    attemptCount: 3,
    maxAttempts: 3,
    lastError: 'max_attempts_exceeded',
    runs: [],
    ...overrides,
  };
}

describe('deriveFailureSummary (P1-3)', () => {
  it('projects stage, newest failed run error type and the recorded latest error', () => {
    const summary = deriveFailureSummary(detail({
      runs: [
        // Newest first, as the server returns them.
        run({ runId: 'run-3', attemptNumber: 3, errorCategory: 'output_invalid', reason: 'schema rejected' }),
        run({ runId: 'run-2', attemptNumber: 2, errorCategory: 'output_invalid', reason: 'schema rejected' }),
        run({ runId: 'run-1', attemptNumber: 1, errorCategory: 'output_invalid', reason: 'schema rejected' }),
      ],
    }));

    expect(summary.stage).toBe('diag_router');
    expect(summary.errorCategory).toBe('output_invalid');
    // P1-3: the real error text wins over the budget marker, which is reported
    // separately as the terminal reason.
    expect(summary.latestError).toBe('schema rejected');
    expect(summary.terminalReason).toBe('max_attempts_exceeded');
    expect(summary.attemptCount).toBe(3);
    expect(summary.maxAttempts).toBe(3);
  });

  it('does not let max_attempts_exceeded replace the classified cause (legacy row)', () => {
    // Row written BEFORE the P1-3 fix: the terminal write overwrote the newest
    // run's category and the task's last_error with the budget marker.
    const summary = deriveFailureSummary(detail({
      lastError: 'max_attempts_exceeded',
      runs: [
        run({ runId: 'run-3', attemptNumber: 3, errorCategory: 'max_attempts_exceeded', reason: 'Max attempts exceeded: Validation failed: recommendations[].abstractedPrinciple is required when kind is "principle"' }),
        run({ runId: 'run-2', attemptNumber: 2, errorCategory: 'output_invalid', reason: 'Validation failed: recommendations[].abstractedPrinciple is required when kind is "principle"' }),
        run({ runId: 'run-1', attemptNumber: 1, errorCategory: 'output_invalid', reason: 'Validation failed: recommendations[].abstractedPrinciple is required when kind is "principle"' }),
      ],
    }));

    expect(summary.errorCategory).toBe('output_invalid');
    expect(summary.terminalReason).toBe('max_attempts_exceeded');
    expect(summary.latestError).toContain('abstractedPrinciple');
    expect(summary.nextActionCode).toBe('force_recovery_required');
  });

  it('surfaces the structured diagnostics: terminal cause, validator error and failed stage', () => {
    const summary = deriveFailureSummary(detail({
      taskKind: 'diagnostician',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: 'output_invalid',
      runs: [run({ errorCategory: 'output_invalid', reason: 'Stage C (router) failed' })],
      diagnostics: {
        terminalReason: null,
        terminalErrorCategory: 'output_invalid',
        validatorErrors: ['recommendations[0].abstractedPrinciple is required when kind is "principle"'],
        failedStage: {
          stageTaskId: 'diag_router-task-1',
          stageTaskKind: 'diag_router',
          errorCategory: 'output_invalid',
          terminalReason: 'max_attempts_exceeded',
          attemptCount: 3,
          maxAttempts: 3,
          validatorErrors: ['recommendations[0].abstractedPrinciple is required when kind is "principle"'],
        },
      },
    }));

    expect(summary.errorCategory).toBe('output_invalid');
    expect(summary.latestValidatorError).toContain('abstractedPrinciple');
    expect(summary.latestError).toBe('Stage C (router) failed');
    // The parent did not exhaust its own budget — the stage did.
    expect(summary.terminalReason).toBeNull();
    // Next step is category-specific: a schema-invalid output points at the
    // output contract, not at a generic retry.
    expect(summary.nextActionCode).toBe('inspect_output_schema');
  });

  it('ignores a succeeded run when picking the error type', () => {
    const summary = deriveFailureSummary(detail({
      attemptCount: 2,
      maxAttempts: 3,
      lastError: 'Validation failed',
      runs: [
        run({ runId: 'run-2', attemptNumber: 2, executionStatus: 'succeeded', errorCategory: null, reason: 'task_completed' }),
        run({ runId: 'run-1', attemptNumber: 1, errorCategory: 'timeout', reason: 'adapter timeout' }),
      ],
    }));

    expect(summary.errorCategory).toBe('timeout');
  });

  it('reports the attempt budget as exhausted only when it is truly spent', () => {
    expect(deriveFailureSummary(detail({ attemptCount: 2, maxAttempts: 3 })).budgetExhausted).toBe(false);
    expect(deriveFailureSummary(detail({ attemptCount: 2, maxAttempts: 3 })).remainingAttempts).toBe(1);
    expect(deriveFailureSummary(detail({ attemptCount: 3, maxAttempts: 3 })).budgetExhausted).toBe(true);
    expect(deriveFailureSummary(detail({ attemptCount: 5, maxAttempts: 3 })).remainingAttempts).toBe(0);
  });

  it('maps the next action from the observed error category', () => {
    expect(deriveFailureSummary(detail({ attemptCount: 1, runs: [run({ errorCategory: 'rate_limit' })] })).nextActionCode)
      .toBe('wait_rate_limit');
    expect(deriveFailureSummary(detail({ attemptCount: 1, runs: [run({ errorCategory: 'output_invalid' })] })).nextActionCode)
      .toBe('inspect_output_schema');
    expect(deriveFailureSummary(detail({ attemptCount: 1, runs: [run({ errorCategory: 'storage_unavailable' })] })).nextActionCode)
      .toBe('check_storage');
    expect(deriveFailureSummary(detail({ attemptCount: 1, runs: [run({ errorCategory: 'timeout' })] })).nextActionCode)
      .toBe('retry_budget_available');
    expect(deriveFailureSummary(detail({ attemptCount: 1, runs: [] })).nextActionCode)
      .toBe('investigate_runtime');
    // Exhausted budget dominates the category-specific advice.
    expect(deriveFailureSummary(detail({ attemptCount: 3, runs: [run({ errorCategory: 'rate_limit' })] })).nextActionCode)
      .toBe('force_recovery_required');
  });
});
