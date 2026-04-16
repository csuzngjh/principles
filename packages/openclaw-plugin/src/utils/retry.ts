/**
 * Unified Retry Utilities
 *
 * Provides a centralized retry mechanism for all async operations that may fail
 * due to transient errors (network timeouts, resource locks, rate limits, etc).
 *
 * @module utils/retry
 *
 * @example
 * ```typescript
 * import { retryAsync, isRetryableError } from '../utils/retry.js';
 *
 * const result = await retryAsync(
 *   () => llmClient.generate(prompt),
 *   { maxRetries: 3, operation: 'llm-generate' }
 * );
 * ```
 */

// =========================================================================
// Types
// =========================================================================

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2 for exponential) */
  backoffMultiplier?: number;
  /** Operation name for logging */
  operation?: string;
  /** Logger instance (optional, defaults to console) */
  logger?: RetryLogger;
   
  isRetryable?: (_error: unknown) => boolean;
}

export interface RetryLogger {
  warn?: (_message: string) => void;
  info?: (_message: string) => void;
  debug?: (_message: string) => void;
}

export interface RetryResult<T> {
  /** The result value if successful */
  value: T;
  /** Number of attempts made (including successful one) */
  attempts: number;
  /** Total time spent in ms */
  totalTimeMs: number;
}

// =========================================================================
// Defaults
// =========================================================================

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================================
// Error Classification
// =========================================================================

/**
 * Common retryable error patterns.
 * These indicate transient failures that may succeed on retry.
 */
const RETRYABLE_PATTERNS = [
  // Network/timeout errors
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network',
  'timeout',
  'timed out',

  // Rate limiting
  'rate limit',
  'ratelimit',
  '429',
  'too many requests',

  // Resource temporarily unavailable
  'eagain',
  'ebusy',
  'resource temporarily unavailable',
  'lock',
  'locked',

  // LLM-specific
  'overloaded',
  'capacity',
  'service unavailable',
  '503',
  '502',
  'gateway timeout',

  // OpenClaw-specific
  'gateway request',  // Not in gateway context (may succeed later)
  'missing scope',    // Scope not available (may succeed in different context)
];

/**
 * Determines if an error is retryable based on common patterns.
 *
 * @param error - The error to check
 * @returns true if the error is likely transient and worth retrying
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();

  // Check against known retryable patterns
  for (const pattern of RETRYABLE_PATTERNS) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  // Check for specific error codes
  if (error instanceof Error && 'code' in error) {
    const code = String((error as Error & { code: unknown }).code).toLowerCase();
    for (const pattern of RETRYABLE_PATTERNS) {
      if (code.includes(pattern)) {
        return true;
      }
    }
  }

  return false;
}

// =========================================================================
// Core Retry Functions
// =========================================================================

/**
 * Execute an async function with automatic retry on failure.
 *
 * Uses exponential backoff with configurable parameters.
 * Automatically detects retryable errors (timeouts, rate limits, etc).
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    operation = 'unknown',
    logger = console,
    isRetryable = isRetryableError,
  } = options;

  const startTime = Date.now();
  let lastError: unknown = undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info?.(`[PD:Retry] ${operation} succeeded on attempt ${attempt + 1} (total time: ${Date.now() - startTime}ms)`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;
      const shouldRetry = !isLastAttempt && isRetryable(error);

      if (shouldRetry) {
        const delay = Math.min(
          initialDelayMs * Math.pow(backoffMultiplier, attempt),
          maxDelayMs
        );
        logger.warn?.(`[PD:Retry] ${operation} failed on attempt ${attempt + 1}, retrying in ${delay}ms: ${String(error)}`);
        await sleep(delay);
      } else {
        logger.warn?.(`[PD:Retry] ${operation} failed after ${attempt + 1} attempts: ${String(error)}`);
        throw error;
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Execute an async function with retry, returning detailed result info.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns Detailed result including attempts and timing
 */
export async function retryAsyncWithInfo<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let attempts = 0;

  const value = await retryAsync(
    async () => {
      attempts++;
      return fn();
    },
    { ...options, logger: undefined } // Suppress internal logging
  );

  return {
    value,
    attempts,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Create a retry wrapper for a function.
 * Useful for wrapping LLM calls or API clients.
 *
 * @param fn - The async function to wrap
 * @param options - Default retry configuration
 * @returns A wrapped function with retry built-in
 */
export function withRetry<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  options: RetryOptions = {}
): (...args: Args) => Promise<T> {
  return (...args: Args) => retryAsync(() => fn(...args), options);
}

// =========================================================================
// Specialized Retry Presets
// =========================================================================

/**
 * Retry an LLM API call with appropriate defaults.
 * LLM calls often timeout or hit rate limits.
 */
export async function retryLLMCall<T>(
  fn: () => Promise<T>,
  operation = 'llm-call'
): Promise<T> {
  return retryAsync(fn, {
    maxRetries: 3,
    initialDelayMs: 2000,
    maxDelayMs: 60_000,
    operation,
  });
}

/**
 * Retry a file operation with appropriate defaults.
 * File operations may fail due to locks or concurrent access.
 */
export async function retryFileOperation<T>(
  fn: () => Promise<T>,
  operation = 'file-op'
): Promise<T> {
  return retryAsync(fn, {
    maxRetries: 5,
    initialDelayMs: 50,
    maxDelayMs: 5000,
    operation,
  });
}

/**
 * Retry a network request with appropriate defaults.
 * Network requests may fail due to transient connectivity issues.
 */
export async function retryNetworkRequest<T>(
  fn: () => Promise<T>,
  operation = 'network-request'
): Promise<T> {
  return retryAsync(fn, {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30_000,
    operation,
  });
}

// =========================================================================
// Dynamic Timeout Support (from dynamic-timeout.ts)
// =========================================================================

/** Minimum samples needed before trusting learned timeout values */
export const MIN_SAMPLES = 3;

/** Number of recent completion durations to consider */
export const LOOKBACK_WINDOW = 50;

/** Safety multiplier applied to P95 */
export const SAFETY_MULTIPLIER = 1.5;

/** Absolute minimum timeout — never go below this (10s) */
export const MIN_TIMEOUT_MS = 10_000;

/** Absolute maximum timeout cap — never exceed this (5min) */
export const MAX_TIMEOUT_MS = 300_000;

/** Maximum retry attempts for workflow timeout */
export const MAX_TIMEOUT_RETRIES = 2;

/** Backoff multiplier for retry schedule */
export const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Interface for a data source that provides historical workflow durations.
 * Compatible with WorkflowStore's getCompletionDurations API.
 * This is the primary interface used by WorkflowManager.
 */
export interface DurationDataSource {
  getCompletionDurations(workflowType: string, limit: number): number[];
}

/**
 * Interface for duration history storage (simpler alternative).
 */
export interface DurationHistorySource {
  /** Get recent completion durations in ms */
  getDurations(limit: number): number[];
  /** Record a new completion duration */
  recordDuration(durationMs: number): void;
}

/**
 * Options for adaptive retry with dynamic timeout.
 */
export interface AdaptiveRetryOptions extends RetryOptions {
  /** Source for historical duration data */
  durationHistory?: DurationHistorySource;
  /** Minimum samples before using adaptive timeout */
  minSamples?: number;
  /** Percentile to use (default: 95) */
  percentile?: number;
  /** Safety multiplier for computed timeout (default: 1.5) */
  safetyMultiplier?: number;
  /** Minimum allowed timeout in ms (default: 10000) */
  minTimeoutMs?: number;
  /** Maximum allowed timeout in ms (default: 300000) */
  maxTimeoutMs?: number;
}

/**
 * Calculates P95 (or any percentile) from an array of numbers.
 * Falls back to median for small samples (< 10).
 *
 * @param values - Array of duration values
 * @param p - Percentile to compute (0-100)
 * @returns The computed percentile value
 */
export function percentile(values: number[], p: number): number {
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
 * Clamp timeout to safe bounds.
 */
export function clampTimeout(ms: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(ms)));
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
 * This is the primary function used by WorkflowManager.
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
    const fallback = clampTimeout(defaultTimeout);
     
    console.info(`[PD:DynamicTimeout] Insufficient samples (${history.length} < ${MIN_SAMPLES}) for '${workflowType}', falling back to static timeout: ${fallback}ms`);
    return fallback;
  }

  const p95 = percentile(history, 95);
  const adaptive = p95 * SAFETY_MULTIPLIER;
  const result = clampTimeout(adaptive);
   
  console.info(`[PD:DynamicTimeout] Computed adaptive timeout for '${workflowType}': P95=${p95}ms (from ${history.length} samples) × ${SAFETY_MULTIPLIER} = ${result}ms`);
  return result;
}

/**
 * Computes retry timeout schedule for a workflow.
 * Returns an array of timeout values for each attempt (including initial).
 *
 * Example output: [30000, 60000, 120000] for 3 attempts with base 30s
 *
 * @param baseTimeoutMs - Base timeout in milliseconds
 * @param maxRetries - Maximum retry attempts (default: MAX_TIMEOUT_RETRIES)
 * @returns Array of timeout values for each attempt
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

/**
 * Compute adaptive timeout from historical data (simplified API).
 * Alternative to computeDynamicTimeout for simpler use cases.
 */
export function computeAdaptiveTimeout(
  history: number[],
  fallbackMs: number,
  options: {
    minSamples?: number;
    percentile?: number;
    safetyMultiplier?: number;
    minTimeoutMs?: number;
    maxTimeoutMs?: number;
  } = {}
): number {
  const {
    minSamples = MIN_SAMPLES,
    percentile: p = 95,
    safetyMultiplier = SAFETY_MULTIPLIER,
    minTimeoutMs = MIN_TIMEOUT_MS,
    maxTimeoutMs = MAX_TIMEOUT_MS,
  } = options;

  if (history.length < minSamples) {
    return Math.max(minTimeoutMs, Math.min(maxTimeoutMs, fallbackMs));
  }

  const sorted = [...history].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const pValue = sorted[Math.min(rank, sorted.length) - 1];
  const adaptive = pValue * safetyMultiplier;

  return Math.max(minTimeoutMs, Math.min(maxTimeoutMs, Math.round(adaptive)));
}

/**
 * Execute an async function with adaptive timeout and retry.
 *
 * Combines:
 * 1. Dynamic timeout based on P95 of historical completions
 * 2. Exponential backoff on retry
 * 3. Automatic duration recording after success
 *
 * @param fn - The async function to execute
 * @param options - Configuration including history source
 * @returns The result of the function
 */
export async function retryWithAdaptiveTimeout<T>(
  fn: () => Promise<T>,
  options: AdaptiveRetryOptions = {}
): Promise<T> {
  const {
    durationHistory,
    minSamples = 3,
    percentile: p = 95,
    safetyMultiplier = 1.5,
    minTimeoutMs = 10_000,
    maxTimeoutMs = 300_000,
    maxRetries = 3,
    backoffMultiplier = 2,
    operation = 'adaptive',
    logger = console,
    isRetryable = isRetryableError,
  } = options;

  // Compute base timeout from history
  const history = durationHistory?.getDurations(50) ?? [];
  const baseTimeout = computeAdaptiveTimeout(history, minTimeoutMs * 3, {
    minSamples,
    percentile: p,
    safetyMultiplier,
    minTimeoutMs,
    maxTimeoutMs,
  });

  const startTime = Date.now();
  let lastError: unknown = undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutMs = Math.min(
      baseTimeout * Math.pow(backoffMultiplier, attempt),
      maxTimeoutMs
    );

    try {
      logger.debug?.(`[PD:Retry] ${operation} attempt ${attempt + 1}: timeout=${timeoutMs}ms (base=${baseTimeout}ms, samples=${history.length})`);
      const result = await fn();
      const duration = Date.now() - startTime;

      // Record successful completion for future adaptive timeout
      durationHistory?.recordDuration(duration);

      if (attempt > 0) {
        logger.info?.(`[PD:Retry] ${operation} succeeded on attempt ${attempt + 1} (duration=${duration}ms)`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;
      const shouldRetry = !isLastAttempt && isRetryable(error);

      if (shouldRetry) {
        logger.warn?.(`[PD:Retry] ${operation} failed on attempt ${attempt + 1}, retrying: ${String(error)}`);
      } else {
        logger.warn?.(`[PD:Retry] ${operation} failed after ${attempt + 1} attempts: ${String(error)}`);
        throw error;
      }
    }
  }

  throw lastError;
}
