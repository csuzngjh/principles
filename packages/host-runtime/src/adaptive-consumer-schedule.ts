/**
 * Adaptive consumer schedule (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §4).
 *
 * Problem: the internalization consumer used ONE fixed 120s interval for every
 * situation — an empty queue burned a wake-up every two minutes, and a deep
 * backlog advanced at the same two-minute cadence (one task per cycle), so
 * throughput was capped by the timer rather than by the provider.
 *
 * This module is a PURE decision function. It does not own a timer, a queue, or
 * any persisted state: the existing single `setTimeout` chain in the host keeps
 * scheduling, and the host keeps the cycle counters. Keeping the policy pure is
 * what makes every branch testable without waiting real time.
 *
 * Data sources are the facts the cycle already computes (queue snapshot,
 * recovery sweep) plus the run outcome — never a second source of truth.
 *
 * Delays are bounded by a floor (busy-loop guard) and by the retry policy's
 * own backoff (no duplicated exponential math). Provider-rate-limit handling
 * reuses `RetryPolicy.calculateBackoff` with a higher ceiling: the adapter
 * already hands transport retry/Retry-After to pi-ai, so the scheduler's job is
 * only to stop re-entering the cycle while the provider is unhappy.
 */
import { DefaultRetryPolicy, type RetryPolicy } from '@principles/core/runtime';

export type AdaptiveConsumerState =
  | 'idle'
  | 'low_load'
  | 'backlog'
  | 'recovery_priority'
  | 'rate_limited'
  | 'provider_cooling'
  | 'overloaded';

/** Facts the host observes around ONE consumer cycle. */
export interface AdaptiveConsumerSignals {
  /** Ready (actionable) tasks in the internalization queue at cycle start. */
  readonly readyQueueDepth: number;
  /** Tasks waiting for their retry window. */
  readonly retryQueueDepth: number;
  /** Age of the oldest ready task, or null when the queue is empty/unknown. */
  readonly oldestReadyAgeMs: number | null;
  /** Whether the cycle actually leased and ran a task. */
  readonly lastCycleWorked: boolean;
  /** Wall-clock duration of the finished cycle, or null before the first one. */
  readonly lastCycleDurationMs: number | null;
  /** Consecutive cycles that found no work. */
  readonly consecutiveEmptyCycles: number;
  /** Consecutive cycles that failed (cycle error or task-level failure). */
  readonly consecutiveFailures: number;
  /** The last failure was a provider rate limit (`rate_limit` category). */
  readonly providerLimited: boolean;
  /** Expired leases recovered by the cycle's recovery sweep. */
  readonly recoveredLastCycle: number;
}

export interface AdaptiveConsumerScheduleOptions {
  /** Empty queue + empty retry queue. Baseline behaviour (was 120s). */
  readonly idleDelayMs?: number;
  /** One or two ready tasks: shorten the interval. */
  readonly lowLoadDelayMs?: number;
  /** Sustained backlog: process the next task promptly. */
  readonly backlogDelayMs?: number;
  /** Expired leases were recovered: re-check soon so the retried task resumes. */
  readonly recoveryDelayMs?: number;
  /** Overload (extreme depth or a stalled oldest task): limit new admissions. */
  readonly overloadDelayMs?: number;
  /** Queue depth at which admission is deliberately slowed. */
  readonly overloadQueueDepth?: number;
  /** Oldest-ready age at which the queue is considered stalled. */
  readonly stallAgeMs?: number;
  /** Provider cooldown ceiling (bounded exponential, never unbounded). */
  readonly failureMaxDelayMs?: number;
  /** Hard floor for every state — prevents an empty-queue busy loop. */
  readonly minDelayMs?: number;
  /** Reused backoff authority; defaults to DefaultRetryPolicy(30s base, 5m cap). */
  readonly retryPolicy?: RetryPolicy;
}

export interface AdaptiveConsumerScheduleDecision {
  readonly state: AdaptiveConsumerState;
  readonly delayMs: number;
  readonly reason: string;
  readonly signals: AdaptiveConsumerSignals;
}

/**
 * Baseline values. The previous fixed interval was 120_000ms; every branch that
 * is not evidence of work keeps that baseline or a longer bounded backoff, so
 * this change can only shorten the interval when there is something to do.
 */
export const ADAPTIVE_CONSUMER_DEFAULTS = {
  idleDelayMs: 120_000,
  lowLoadDelayMs: 60_000,
  backlogDelayMs: 15_000,
  recoveryDelayMs: 15_000,
  overloadDelayMs: 60_000,
  overloadQueueDepth: 50,
  stallAgeMs: 10 * 60 * 1000,
  failureMaxDelayMs: 300_000,
  minDelayMs: 5_000,
} as const;

function resolveOptions(options: AdaptiveConsumerScheduleOptions): Required<
  Omit<AdaptiveConsumerScheduleOptions, 'retryPolicy'>
> & { retryPolicy: RetryPolicy } {
  return {
    idleDelayMs: options.idleDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.idleDelayMs,
    lowLoadDelayMs: options.lowLoadDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.lowLoadDelayMs,
    backlogDelayMs: options.backlogDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.backlogDelayMs,
    recoveryDelayMs: options.recoveryDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.recoveryDelayMs,
    overloadDelayMs: options.overloadDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.overloadDelayMs,
    overloadQueueDepth: options.overloadQueueDepth ?? ADAPTIVE_CONSUMER_DEFAULTS.overloadQueueDepth,
    stallAgeMs: options.stallAgeMs ?? ADAPTIVE_CONSUMER_DEFAULTS.stallAgeMs,
    failureMaxDelayMs: options.failureMaxDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.failureMaxDelayMs,
    minDelayMs: options.minDelayMs ?? ADAPTIVE_CONSUMER_DEFAULTS.minDelayMs,
    retryPolicy: options.retryPolicy ?? new DefaultRetryPolicy({ baseDelayMs: 30_000, maxDelayMs: 300_000 }),
  };
}

function clampDelay(delayMs: number, minDelayMs: number, maxDelayMs: number): number {
  const floored = Math.max(minDelayMs, Math.floor(delayMs));
  return Math.min(floored, maxDelayMs);
}

/**
 * Backoff for consecutive failures / a rate-limited provider.
 *
 * `consecutiveFailures` is 1-based for the retry policy (attempt 1 → base
 * delay). Jitter comes from the shared policy; the ceiling is explicit so a
 * long outage never pushes the next wake-up past five minutes.
 */
function failureDelay(
  consecutiveFailures: number,
  options: ReturnType<typeof resolveOptions>,
  ceilingMs: number,
): number {
  const attempt = Math.max(1, Math.floor(consecutiveFailures));
  return clampDelay(options.retryPolicy.calculateBackoff(attempt), options.minDelayMs, ceilingMs);
}

/**
 * Decide how long to wait before the next consumer cycle.
 *
 * Priority (first match wins):
 *   1. provider rate-limited  → bounded exponential backoff (Retry-After is
 *      honoured inside pi-ai; the scheduler must not hammer the provider)
 *   2. recent failures        → provider/cycle cooling backoff
 *   3. recovery sweep worked  → re-check promptly so retried tasks resume
 *   4. empty queues           → baseline long sleep (no busy loop)
 *   5. overload               → slow admission deliberately
 *   6. queue depth > 2        → backlog cadence
 *   7. otherwise              → low-load cadence
 */
export function nextConsumerDelay(
  signals: AdaptiveConsumerSignals,
  options: AdaptiveConsumerScheduleOptions = {},
): AdaptiveConsumerScheduleDecision {
  const opts = resolveOptions(options);

  if (signals.providerLimited) {
    // Rate limits get a longer ceiling than ordinary failures: the provider is
    // explicitly asking us to slow down.
    return {
      state: 'rate_limited',
      delayMs: failureDelay(Math.max(1, signals.consecutiveFailures), opts, 600_000),
      reason: 'provider reported rate_limit; backing off before the next cycle',
      signals,
    };
  }

  if (signals.consecutiveFailures > 0) {
    return {
      state: 'provider_cooling',
      delayMs: failureDelay(signals.consecutiveFailures, opts, opts.failureMaxDelayMs),
      reason: `consecutive_failures=${signals.consecutiveFailures}; cooling down`,
      signals,
    };
  }

  if (signals.recoveredLastCycle > 0) {
    return {
      state: 'recovery_priority',
      delayMs: clampDelay(opts.recoveryDelayMs, opts.minDelayMs, opts.failureMaxDelayMs),
      reason: `recovered=${signals.recoveredLastCycle} expired lease(s); resuming soon`,
      signals,
    };
  }

  if (signals.readyQueueDepth === 0 && signals.retryQueueDepth === 0) {
    return {
      state: 'idle',
      delayMs: clampDelay(opts.idleDelayMs, opts.minDelayMs, opts.failureMaxDelayMs),
      reason: 'queue empty; keeping the baseline long sleep',
      signals,
    };
  }

  const stalled = signals.oldestReadyAgeMs !== null && signals.oldestReadyAgeMs >= opts.stallAgeMs;
  if (signals.readyQueueDepth >= opts.overloadQueueDepth || stalled) {
    return {
      state: 'overloaded',
      delayMs: clampDelay(opts.overloadDelayMs, opts.minDelayMs, opts.failureMaxDelayMs),
      reason: stalled
        ? `oldest ready task is ${signals.oldestReadyAgeMs}ms old; limiting new admissions`
        : `ready queue depth ${signals.readyQueueDepth} >= ${opts.overloadQueueDepth}; limiting new admissions`,
      signals,
    };
  }

  if (signals.readyQueueDepth > 2 || signals.lastCycleWorked) {
    return {
      state: 'backlog',
      delayMs: clampDelay(opts.backlogDelayMs, opts.minDelayMs, opts.failureMaxDelayMs),
      reason: signals.lastCycleWorked
        ? 'cycle completed work; continuing the backlog promptly'
        : `ready queue depth ${signals.readyQueueDepth}; processing backlog promptly`,
      signals,
    };
  }

  return {
    state: 'low_load',
    delayMs: clampDelay(opts.lowLoadDelayMs, opts.minDelayMs, opts.failureMaxDelayMs),
    reason: `ready queue depth ${signals.readyQueueDepth}; shortening the interval`,
    signals,
  };
}
