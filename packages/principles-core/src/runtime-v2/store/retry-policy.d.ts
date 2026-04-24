/**
 * Retry Policy — exponential backoff with jitter and maxAttempts enforcement.
 *
 * Provides:
 *   - calculateBackoff: compute delay for a given attempt number
 *   - shouldRetry: check if a task has attempts remaining
 *   - markRetryWait: transition a task to retry_wait (caller applies via TaskStore)
 *   - markFailed: transition a task to failed (caller applies via TaskStore)
 *
 * The actual task state transitions (markRetryWait, markFailed) are applied by the
 * caller via TaskStore — RetryPolicy provides the calculation logic only.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 19 (Error categories and retry)
 * Source: Diagnostician v2 Detailed Design, Section 20 (Retry and backoff)
 */
import type { TaskRecord } from '../task-status.js';
import type { PDErrorCategory } from '../error-categories.js';
export interface RetryPolicyConfig {
    /** Initial base delay in ms (default: 30_000 = 30 seconds) */
    baseDelayMs?: number;
    /** Maximum delay cap in ms (default: 60_000 = 60 seconds) */
    maxDelayMs?: number;
    /** Exponential multiplier (default: 2) */
    multiplier?: number;
    /** Jitter factor (default: 0.2 = +/- 10% of delay) */
    jitterFactor?: number;
}
export interface RetryPolicy {
    /**
     * Calculate backoff delay for a given attempt number.
     *
     * Formula: cap(min(baseDelay * multiplier^(attempt-1), maxDelay), jitter)
     *   where jitter = +/- (jitterFactor / 2) * cappedDelay
     *
     * @param attemptNumber - 1-based attempt number
     * @returns Delay in milliseconds
     */
    calculateBackoff(attemptNumber: number): number;
    /**
     * Check whether a task should be retried based on attempt count vs maxAttempts.
     *
     * @param task - The task record to evaluate
     * @returns true if attemptCount < maxAttempts, false otherwise
     */
    shouldRetry(task: TaskRecord): boolean;
    /**
     * Mark a task as waiting for retry (transition to retry_wait state).
     *
     * The caller is responsible for actually updating the task via TaskStore.
     * This method returns the error category for the caller to use.
     *
     * @param taskId - The task to mark
     * @param errorCategory - The error category that triggered the retry
     * @returns The taskId and errorCategory for the caller to apply
     */
    markRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<{
        taskId: string;
        errorCategory: PDErrorCategory;
    }>;
    /**
     * Mark a task as permanently failed (transition to failed state).
     *
     * The caller is responsible for actually updating the task via TaskStore.
     * This method returns the error category for the caller to use.
     *
     * @param taskId - The task to mark
     * @param errorCategory - The error category that caused the failure
     * @returns The taskId and errorCategory for the caller to apply
     */
    markFailed(taskId: string, errorCategory: PDErrorCategory): Promise<{
        taskId: string;
        errorCategory: PDErrorCategory;
    }>;
}
export declare class DefaultRetryPolicy implements RetryPolicy {
    private readonly baseDelayMs;
    private readonly maxDelayMs;
    private readonly multiplier;
    private readonly jitterFactor;
    constructor(config?: RetryPolicyConfig);
    /**
     * Exponential backoff with jitter.
     *
     * Examples with defaults (base=30s, max=60s, multiplier=2, jitter=0.2):
     *   attempt 1: raw=30000, capped=30000, jitter=3000 → 28500-31500 ms
     *   attempt 2: raw=60000, capped=60000, jitter=6000 → 54000-66000 ms
     *   attempt 3: raw=120000, capped=60000, jitter=6000 → 54000-66000 ms (capped)
     */
    calculateBackoff(attemptNumber: number): number;
    /**
     * Returns true if the task has attempts remaining.
     *
     * Fails safe: if maxAttempts is not set or is invalid, defaults to allowing retry.
     */
    shouldRetry(task: TaskRecord): boolean;
    markRetryWait(taskId: string, errorCategory: PDErrorCategory): Promise<{
        taskId: string;
        errorCategory: PDErrorCategory;
    }>;
    markFailed(taskId: string, errorCategory: PDErrorCategory): Promise<{
        taskId: string;
        errorCategory: PDErrorCategory;
    }>;
}
//# sourceMappingURL=retry-policy.d.ts.map