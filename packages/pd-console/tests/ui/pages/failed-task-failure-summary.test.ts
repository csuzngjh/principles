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
import type { FailedHumanReviewProjection, FailedTaskDetailData, FailedTaskDetailRun } from '../../../src/ui/utils/validators.js';

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

describe('deriveFailureSummary (P1-4 structured Owner diagnosis)', () => {
  const diagnostics = (
    humanReview: FailedHumanReviewProjection | null,
    evidenceSummary: string[] = [],
  ): FailedTaskDetailData['diagnostics'] => ({
    terminalReason: null,
    terminalErrorCategory: null,
    validatorErrors: [],
    failedStage: null,
    humanReview,
    identityPreflight: null,
    evidenceSummary,
  });

  it('surfaces missing evidence and never allows the system to fill it in', () => {
    const summary = deriveFailureSummary(detail({
      taskKind: 'artificer',
      status: 'needs_human_review',
      attemptCount: 0,
      lastError: null,
      diagnostics: diagnostics({
        reasonCode: 'owner_behavior_examples_required',
        detail: JSON.stringify({
          missingFields: ['sourcePainId', 'ownerDesiredOutcome'],
          nextAction: 'Provide the examples via the evidence recovery entry.',
        }),
        missingFields: ['sourcePainId', 'ownerDesiredOutcome'],
        nextAction: 'Provide the examples via the evidence recovery entry.',
        sourceRunId: 'evidence-preflight',
        sourceArtifactId: null,
        createdAt: '2026-11-12T06:38:08.126Z',
      }),
    }));

    expect(summary.reasonCode).toBe('owner_behavior_examples_required');
    expect(summary.missingFields).toEqual(['sourcePainId', 'ownerDesiredOutcome']);
    expect(summary.problemClass).toBe('owner_evidence_required');
    expect(summary.ownerActionRequired).toBe(true);
    expect(summary.autoRetryAllowed).toBe(false);
    expect(summary.safetyBoundary).toContain('不会代填');
    expect(summary.nextActionCode).toBe('owner_evidence_required');
  });

  it('marks identity binding as Owner work, never automatic binding', () => {
    const summary = deriveFailureSummary(detail({
      taskKind: 'scribe',
      status: 'needs_human_review',
      attemptCount: 0,
      lastError: null,
      diagnostics: diagnostics({
        reasonCode: 'awaiting_owner_binding',
        detail: 'Owner must bind the principle identity.',
        missingFields: [],
        nextAction: 'Bind the Owner identity.',
        sourceRunId: null,
        sourceArtifactId: null,
        createdAt: null,
      }),
    }));

    expect(summary.problemClass).toBe('owner_identity_binding');
    expect(summary.autoRetryAllowed).toBe(false);
    expect(summary.safetyBoundary).toContain('禁止自动绑定');
    expect(summary.nextActionCode).toBe('owner_binding_required');
  });

  it('a pre-generation identity block says nothing was generated (production scribe rows', () => {
    // Production rows: humanReviewContext.detail === '' and only the
    // identityPreflight block carries the cause. The page must not render a
    // blank concrete reason nor imply a failed generation.
    const base = detail({ taskKind: 'scribe', status: 'needs_human_review', attemptCount: 0, lastError: null });
    const summary = deriveFailureSummary({
      ...base,
      diagnostics: {
        ...diagnostics({
          reasonCode: null,
          detail: '',
          missingFields: [],
          nextAction: null,
          sourceRunId: null,
          sourceArtifactId: null,
          createdAt: null,
        }),
        identityPreflight: {
          status: null,
          reasonCode: 'awaiting_owner_binding',
          detail: 'missing',
          nextAction: 'Review the candidate identity and current ledger evidence in the Owner Console.',
          stage: 'preflight_before_generation',
          generated: false,
        },
      },
    });

    expect(summary.problemClass).toBe('owner_identity_binding');
    expect(summary.concreteReason).toContain('尚未生成任何产物');
    expect(summary.concreteReason).toContain('missing');
    expect(summary.concreteReason).not.toBe('');
  });

  it('keeps a safety failure blocked and non-bypassable', () => {
    const summary = deriveFailureSummary(detail({
      status: 'needs_human_review',
      attemptCount: 1,
      lastError: null,
      diagnostics: diagnostics({
        reasonCode: 'gate_decision_not_accepted_shadow',
        detail: 'Expected block but got allow',
        missingFields: [],
        nextAction: 'Fix rule execution; do not skip the test.',
        sourceRunId: null,
        sourceArtifactId: null,
        createdAt: null,
      }),
    }));

    expect(summary.problemClass).toBe('safety_blocked');
    expect(summary.autoRetryAllowed).toBe(false);
    expect(summary.safetyBoundary).toContain('不能通过重试');
    expect(summary.nextActionCode).toBe('blocked_safety');
  });

  it('reports a product defect with its concrete reason and evidence, not a blank error', () => {
    const summary = deriveFailureSummary(detail({
      taskKind: 'rollout_reviewer',
      attemptCount: 1,
      lastError: null,
      diagnostics: diagnostics({
        reasonCode: 'candidate_kind_invalid',
        detail: 'candidate_kind_invalid',
        missingFields: [],
        nextAction: 'Map the candidate kind to its legal channel.',
        sourceRunId: 'run-2',
        sourceArtifactId: 'pi-art-1',
        createdAt: null,
      }, ['humanReview.detail: candidate_kind_invalid', 'identityPreflight: {"status":"failed"}']),
    }));

    expect(summary.problemClass).toBe('product_defect');
    expect(summary.ownerActionRequired).toBe(false);
    expect(summary.autoRetryAllowed).toBe(true);
    expect(summary.safetyBoundary).toContain('系统修复中');
    expect(summary.concreteReason).toBe('candidate_kind_invalid');
    expect(summary.evidenceSummary).toHaveLength(2);
    expect(summary.latestError).not.toBe('');
    expect(summary.latestError).not.toBeUndefined();
  });

  it('reports budget exhaustion as a hard limit', () => {
    const summary = deriveFailureSummary(detail({
      attemptCount: 3,
      maxAttempts: 3,
      lastError: 'max_attempts_exceeded',
      runs: [run({ errorCategory: 'max_attempts_exceeded' })],
    }));

    expect(summary.problemClass).toBe('budget_exhausted');
    expect(summary.autoRetryAllowed).toBe(false);
    expect(summary.safetyBoundary).toContain('重试上限');
  });
});
