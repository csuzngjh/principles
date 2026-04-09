/**
 * Dynamic Timeout Calculator for Subagent Workflows
 *
 * This module is now a thin re-export layer for backwards compatibility.
 * All functionality has been consolidated into utils/retry.ts.
 *
 * @module subagent-workflow/dynamic-timeout
 * @deprecated Use `../../utils/retry.js` directly instead
 */

// Re-export everything from the unified retry module
export {
  // Constants
  MIN_SAMPLES,
  LOOKBACK_WINDOW,
  SAFETY_MULTIPLIER,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_TIMEOUT_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,

  // Interfaces
  DurationDataSource,

  // Functions
  percentile,
  clampTimeout,
  computeDynamicTimeout,
  computeRetrySchedule,
} from '../../utils/retry.js';