/**
 * Dynamic Timeout Calculator for Subagent Workflows
 *
 * Learns from historical completion times to set adaptive timeouts.
 * Uses P95 of recent completion durations with a safety multiplier.
 *
 * Design rationale:
 * - P95 captures tail latency (slow but real completions)
 * - 1.5x safety margin accounts for variable LLM response times
 * - Min 3 samples needed before trusting learned values
 * - Floor/ceiling prevents extreme values from causing issues
 *
 * @module subagent-workflow/dynamic-timeout
 */

// =========================================================================
// Configuration
// =========================================================================

/** Minimum samples needed before trusting learned timeout values */
const MIN_SAMPLES = 3;

/** Number of recent completion durations to consider */
const LOOKBACK_WINDOW = 50;

/** Safety multiplier applied to P95 */
const SAFETY_MULTIPLIER = 1.5;

/** Absolute minimum timeout — never go below this (10s) */
const MIN_TIMEOUT_MS = 10_000;

/** Absolute maximum timeout cap — never exceed this (5min) */
const MAX_TIMEOUT_MS = 300_000;

/** Retry configuration */
export const MAX_TIMEOUT_RETRIES = 2;

export const RETRY_BACKOFF_MULTIPLIER = 2;

// =========================================================================
// Core Algorithm
// =========================================================================

/**
 * Calculates P95 from an array of numbers.
 * Falls back to median for small samples (< 10).
 */
function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    // For small samples, use median to avoid overfitting
    if (n < 10) {
        return sorted[Math.floor(n / 2)];
    }

    // Standard percentile calculation (nearest-rank method)
    const rank = Math.ceil((p / 100) * n);
    return sorted[Math.min(rank, n) - 1];
}

/**
 * Interface for a data source that provides historical workflow durations.
 * Decoupled from WorkflowStore for testability.
 */
export interface DurationDataSource {
    getCompletionDurations(workflowType: string, limit: number): number[];
}

/**
 * Computes an adaptive timeout for a workflow type based on historical data.
 *
 * Algorithm:
 * 1. Fetch last LOOKBACK_WINDOW completion durations
 * 2. If < MIN_SAMPLES: fall back to the provided defaultTimeout
 * 3. Otherwise: P95(durations) × SAFETY_MULTIPLIER
 * 4. Clamp to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]
 *
 * @param dataSource - Source for historical duration data
 * @param workflowType - e.g. 'empathy-observer', 'deep-reflect'
 * @param defaultTimeout - Fallback when insufficient data (from spec)
 * @returns Computed timeout in milliseconds
 */
export function computeDynamicTimeout(
    dataSource: DurationDataSource,
    workflowType: string,
    defaultTimeout: number,
): number {
    const history = dataSource.getCompletionDurations(workflowType, LOOKBACK_WINDOW);

    if (history.length < MIN_SAMPLES) {
        // Not enough data — use the spec's static timeout
        return clampTimeout(defaultTimeout);
    }

    const p95 = percentile(history, 95);
    const adaptive = p95 * SAFETY_MULTIPLIER;
    return clampTimeout(adaptive);
}

/**
 * Clamp timeout to safe bounds.
 */
function clampTimeout(ms: number): number {
    return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(ms)));
}

/**
 * Computes retry timeout schedule for a workflow.
 * Returns an array of timeout values for each attempt (including initial).
 *
 * Example output: [30000, 60000, 120000] for 3 attempts with base 30s
 */
export function computeRetrySchedule(
    baseTimeoutMs: number,
    maxRetries: number = MAX_TIMEOUT_RETRIES,
): number[] {
    const schedule: number[] = [];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const timeout = baseTimeoutMs * Math.pow(RETRY_BACKOFF_MULTIPLIER, attempt);
        schedule.push(clampTimeout(timeout));
    }
    return schedule;
}
