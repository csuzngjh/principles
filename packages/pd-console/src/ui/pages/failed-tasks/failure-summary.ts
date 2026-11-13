/**
 * P1-3 — Owner-facing failure summary for a failed task.
 *
 * The Failed Tasks detail panel already receives the task record, its run
 * history, and the server's structured `diagnostics` projection. This module
 * turns those facts into the five answers the Owner needs: which stage failed,
 * what error type, the latest error, how many attempts were used, and what to
 * do next.
 *
 * Honesty rules (P1-3 / rc-9):
 * - Only facts already present in the detail payload are projected; nothing is
 *   inferred from a task kind or invented.
 * - "Retryable" is reported as the ATTEMPT BUDGET state, because whether a
 *   category is permanently non-retryable is decided by the runner, not by the
 *   Console. The copy therefore says "budget remaining" vs "budget exhausted",
 *   never a definitive "the runtime would retry this".
 * - `max_attempts_exceeded` is a TERMINAL MECHANISM, not a cause. It is
 *   reported as supplementary information; the error type always prefers the
 *   real classified category. Rows written before the P1-3 fix only carry
 *   `max_attempts_exceeded` on the newest run / task, so the projection falls
 *   back to the newest earlier attempt that recorded a real category instead of
 *   showing the mechanism as the diagnosis.
 */
import type { FailedTaskDetailData, FailedTaskDetailRun } from '../../utils/validators.js';

export type FailureNextActionCode =
  | 'retry_budget_available'
  | 'force_recovery_required'
  | 'wait_rate_limit'
  | 'inspect_output_schema'
  | 'check_storage'
  | 'investigate_runtime'
  | 'owner_evidence_required'
  | 'owner_binding_required'
  | 'blocked_safety'
  | 'system_fix_in_progress';

export type FailureProblemClass =
  | 'product_defect'
  | 'owner_evidence_required'
  | 'owner_identity_binding'
  | 'budget_exhausted'
  | 'safety_blocked'
  | 'unknown';

const TERMINAL_BUDGET_MARKER = 'max_attempts_exceeded';

export interface FailureSummary {
  /** Stage that failed — the task kind, shown verbatim. */
  stage: string;
  /** Real classified error category (never the budget mechanism when a real category exists). */
  errorCategory: string | null;
  /**
   * Terminal mechanism that stopped execution, when known
   * (`max_attempts_exceeded`). Supplementary — never a replacement for
   * `errorCategory`.
   */
  terminalReason: string | null;
  /** Newest error text: newest failed run reason, else the task lastError. */
  latestError: string | null;
  /** Newest structured validator error of the failed stage (P1-3 diagnostics). */
  latestValidatorError: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** Attempt budget remaining (never negative). */
  remainingAttempts: number;
  /** True when the attempt budget is spent (force recovery may be required). */
  budgetExhausted: boolean;
  nextActionCode: FailureNextActionCode;
  /** P1-4: machine reason code from structured diagnostics. */
  reasonCode: string | null;
  /** P1-4: concrete human-readable cause (not a generic "execution failed"). */
  concreteReason: string | null;
  /** P1-4: bounded raw evidence excerpts already persisted by the producer. */
  evidenceSummary: string[];
  /** P1-4: fields the Owner must supply before this can run. */
  missingFields: string[];
  problemClass: FailureProblemClass;
  ownerActionRequired: boolean;
  autoRetryAllowed: boolean;
  /** P1-4: what retry/manual handling may and may not do. */
  safetyBoundary: string;
}

function findNewestFailedRun(runs: readonly FailedTaskDetailRun[]): FailedTaskDetailRun | null {
  // Server returns runs newest-first.
  return runs.find((run) => run.executionStatus !== 'succeeded') ?? null;
}

/** Newest failed run that recorded a REAL category (not the budget marker). */
function findNewestClassifiedRun(runs: readonly FailedTaskDetailRun[]): FailedTaskDetailRun | null {
  return runs.find(
    (run) => run.executionStatus !== 'succeeded'
      && run.errorCategory !== null
      && run.errorCategory !== TERMINAL_BUDGET_MARKER,
  ) ?? null;
}

function classifyProblem(
  reasonCode: string | null,
  errorCategory: string | null,
  budgetExhausted: boolean,
): FailureProblemClass {
  const reason = (reasonCode ?? '').toLowerCase();
  if (reason.includes('safety') || reason.includes('gate_decision_not_accepted')) return 'safety_blocked';
  if (reason.includes('awaiting_owner_binding') || reason.includes('identity') || reason.includes('principle_id') || reason.includes('ledger')) {
    return 'owner_identity_binding';
  }
  if (
    reason.includes('owner_') || reason.includes('evidence') || reason.includes('trusted_fact')
    || reason === 'owner_behavior_examples_required' || reason === 'trusted_fact_provider_absent'
  ) {
    return 'owner_evidence_required';
  }
  if (budgetExhausted || reason === TERMINAL_BUDGET_MARKER || errorCategory === TERMINAL_BUDGET_MARKER) {
    return 'budget_exhausted';
  }
  if (reason !== '' || errorCategory !== null) return 'product_defect';
  return 'unknown';
}

function summaryForClass(problemClass: FailureProblemClass): Pick<FailureSummary, 'ownerActionRequired' | 'autoRetryAllowed' | 'safetyBoundary' | 'nextActionCode'> {
  switch (problemClass) {
    case 'owner_evidence_required':
      return {
        ownerActionRequired: true,
        autoRetryAllowed: false,
        safetyBoundary: '必须先补齐缺失证据再重试；系统不会代填或伪造证据。',
        nextActionCode: 'owner_evidence_required',
      };
    case 'owner_identity_binding':
      return {
        ownerActionRequired: true,
        autoRetryAllowed: false,
        safetyBoundary: '必须先完成 Owner 身份绑定；禁止自动绑定或跨 Principle 关联。',
        nextActionCode: 'owner_binding_required',
      };
    case 'safety_blocked':
      return {
        ownerActionRequired: true,
        autoRetryAllowed: false,
        safetyBoundary: '安全验证未通过即阻断，不能通过重试、跳过测试或放宽校验绕过。',
        nextActionCode: 'blocked_safety',
      };
    case 'budget_exhausted':
      return {
        ownerActionRequired: true,
        autoRetryAllowed: false,
        safetyBoundary: '已达到重试上限；只有 Owner 明确决定后才能强制恢复。',
        nextActionCode: 'force_recovery_required',
      };
    case 'product_defect':
      return {
        ownerActionRequired: false,
        autoRetryAllowed: true,
        safetyBoundary: '系统修复中：自动重试不会改变根因，修复后再重试。',
        nextActionCode: 'system_fix_in_progress',
      };
    default:
      return {
        ownerActionRequired: false,
        autoRetryAllowed: false,
        safetyBoundary: '缺少结构化诊断，不能判断自动重试是否安全；请先查看执行历史与证据。',
        nextActionCode: 'investigate_runtime',
      };
  }
}

export function deriveFailureSummary(data: FailedTaskDetailData): FailureSummary {
  const {diagnostics} = data;
  const failedRun = findNewestFailedRun(data.runs);
  const classifiedRun = findNewestClassifiedRun(data.runs);
  const remainingAttempts = Math.max(0, data.maxAttempts - data.attemptCount);
  const budgetExhausted = remainingAttempts === 0;

  const terminalReason = diagnostics?.terminalReason
    ?? (budgetExhausted || data.lastError === TERMINAL_BUDGET_MARKER ? TERMINAL_BUDGET_MARKER : null);

  // Cause first, mechanism last. The server's terminal record carries the
  // classified category; historical rows fall back to the newest attempt that
  // recorded a real one.
  const errorCategory = diagnostics?.terminalErrorCategory
    ?? classifiedRun?.errorCategory
    ?? diagnostics?.failedStage?.errorCategory
    ?? failedRun?.errorCategory
    ?? null;

  // The latest error text must never be only the budget marker when a real
  // message exists (P1-3: "max_attempts_exceeded 必须是补充信息而非唯一文案").
  const failedRunReason = failedRun?.reason ?? null;
  const realRunReason = failedRunReason !== null && failedRunReason !== TERMINAL_BUDGET_MARKER
    ? failedRunReason
    : null;
  const taskLastError = data.lastError !== TERMINAL_BUDGET_MARKER ? data.lastError : null;
  const latestError = realRunReason
    ?? taskLastError
    ?? diagnostics?.failedStage?.validatorErrors[diagnostics.failedStage.validatorErrors.length - 1]
    ?? diagnostics?.validatorErrors[diagnostics.validatorErrors.length - 1]
    ?? failedRunReason
    ?? data.lastError;

  const latestValidatorError = diagnostics?.validatorErrors[diagnostics.validatorErrors.length - 1]
    ?? diagnostics?.failedStage?.validatorErrors[diagnostics.failedStage.validatorErrors.length - 1]
    ?? null;

  // P1-4: structured diagnosis comes from persisted facts only.
  const reasonCode = diagnostics?.humanReview?.reasonCode
    ?? diagnostics?.identityPreflight?.reasonCode
    ?? diagnostics?.terminalErrorCategory
    ?? null;
  const humanReviewDetail = diagnostics?.humanReview?.detail ?? null;
  // P1-3: a pre-generation identity block says so explicitly. `generated:false`
  // means NO artifact exists yet — never present it as a failed generation.
  const identityNarrative = diagnostics?.identityPreflight?.stage === 'preflight_before_generation'
    && diagnostics.identityPreflight.generated === false
    ? `生成前身份预检阻断（尚未生成任何产物）：缺少可绑定的正式 Principle 身份（detail=${diagnostics.identityPreflight.detail ?? 'unknown'}）。`
    : null;
  const concreteReason = (humanReviewDetail !== null && humanReviewDetail.trim() !== '' ? humanReviewDetail : null)
    ?? identityNarrative
    ?? diagnostics?.identityPreflight?.detail
    ?? latestError;
  const missingFields = diagnostics?.humanReview?.missingFields ?? [];
  const evidenceSummary = diagnostics?.evidenceSummary ?? [];
  const problemClass = classifyProblem(reasonCode, errorCategory, budgetExhausted);
  const classSummary = summaryForClass(problemClass);

  let budgetActionCode: FailureNextActionCode;
  if (budgetExhausted) {
    budgetActionCode = 'force_recovery_required';
  } else if (errorCategory === 'rate_limit') {
    budgetActionCode = 'wait_rate_limit';
  } else if (errorCategory === 'output_invalid') {
    budgetActionCode = 'inspect_output_schema';
  } else if (errorCategory === 'storage_unavailable' || errorCategory === 'artifact_commit_failed') {
    budgetActionCode = 'check_storage';
  } else if (errorCategory !== null) {
    budgetActionCode = 'retry_budget_available';
  } else {
    budgetActionCode = 'investigate_runtime';
  }

  // Terminal classes (evidence / identity / safety / budget) own the next step.
  // A product defect keeps the category-specific operational hint (rate limit,
  // schema, storage) while its safety boundary says the system is being fixed.
  const nextActionCode = problemClass === 'product_defect' || problemClass === 'unknown'
    ? budgetActionCode
    : classSummary.nextActionCode;

  return {
    stage: data.taskKind,
    errorCategory,
    terminalReason,
    latestError,
    latestValidatorError,
    attemptCount: data.attemptCount,
    maxAttempts: data.maxAttempts,
    remainingAttempts,
    budgetExhausted,
    nextActionCode,
    reasonCode,
    concreteReason,
    evidenceSummary,
    missingFields,
    problemClass,
    ownerActionRequired: classSummary.ownerActionRequired,
    autoRetryAllowed: classSummary.autoRetryAllowed && !budgetExhausted,
    safetyBoundary: classSummary.safetyBoundary,
  };
}
