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
    expect(summary.latestError).toBe('max_attempts_exceeded');
    expect(summary.attemptCount).toBe(3);
    expect(summary.maxAttempts).toBe(3);
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
