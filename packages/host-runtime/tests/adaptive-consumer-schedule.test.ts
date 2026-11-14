/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §4.2 — adaptive scheduler.
 *
 * Every case is decided from explicit signals (no real clock, no real timer),
 * which is exactly how the host uses it: the cycle produces facts, the policy
 * turns them into the next delay.
 */
import { describe, it, expect } from 'vitest';
import { nextConsumerDelay, ADAPTIVE_CONSUMER_DEFAULTS, type AdaptiveConsumerSignals } from '../src/adaptive-consumer-schedule.js';

function signals(overrides: Partial<AdaptiveConsumerSignals> = {}): AdaptiveConsumerSignals {
  return {
    readyQueueDepth: 0,
    retryQueueDepth: 0,
    oldestReadyAgeMs: null,
    lastCycleWorked: false,
    lastCycleDurationMs: null,
    consecutiveEmptyCycles: 0,
    consecutiveFailures: 0,
    providerLimited: false,
    recoveredLastCycle: 0,
    ...overrides,
  };
}

/** Deterministic retry policy (jitter factor 0) so delays are exact. */
const noJitter = {
  calculateBackoff: (attempt: number) => 30_000 * Math.pow(2, attempt - 1),
  shouldRetry: () => true,
  markRetryWait: async (taskId: string, errorCategory: 'execution_failed') => ({ taskId, errorCategory }),
  markFailed: async (taskId: string, errorCategory: 'execution_failed') => ({ taskId, errorCategory }),
};

describe('nextConsumerDelay', () => {
  it('keeps the baseline long sleep for an empty queue (no busy loop)', () => {
    const decision = nextConsumerDelay(signals());
    expect(decision.state).toBe('idle');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.idleDelayMs);
  });

  it('shortens the interval for one or two ready tasks', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 2 }));
    expect(decision.state).toBe('low_load');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.lowLoadDelayMs);
  });

  it('raises frequency for a sustained backlog', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 5 }));
    expect(decision.state).toBe('backlog');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.backlogDelayMs);
  });

  it('continues promptly after a cycle that actually ran a task', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 1, lastCycleWorked: true }));
    expect(decision.state).toBe('backlog');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.backlogDelayMs);
  });

  it('prioritises freshly recovered expired leases', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 0, recoveredLastCycle: 2 }));
    expect(decision.state).toBe('recovery_priority');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.recoveryDelayMs);
  });

  it('honours rate limiting with bounded exponential backoff and outranks backlog', () => {
    const first = nextConsumerDelay(
      signals({ readyQueueDepth: 9, providerLimited: true, consecutiveFailures: 1 }),
      { retryPolicy: noJitter },
    );
    expect(first.state).toBe('rate_limited');
    expect(first.delayMs).toBe(30_000);

    const later = nextConsumerDelay(
      signals({ readyQueueDepth: 9, providerLimited: true, consecutiveFailures: 6 }),
      { retryPolicy: noJitter },
    );
    expect(later.state).toBe('rate_limited');
    expect(later.delayMs).toBe(600_000);
  });

  it('cools down after ordinary failures with a hard ceiling', () => {
    const first = nextConsumerDelay(signals({ readyQueueDepth: 3, consecutiveFailures: 1 }), { retryPolicy: noJitter });
    expect(first.state).toBe('provider_cooling');
    expect(first.delayMs).toBe(30_000);

    const third = nextConsumerDelay(signals({ readyQueueDepth: 3, consecutiveFailures: 3 }), { retryPolicy: noJitter });
    expect(third.delayMs).toBe(120_000);

    const capped = nextConsumerDelay(signals({ readyQueueDepth: 3, consecutiveFailures: 12 }), { retryPolicy: noJitter });
    expect(capped.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.failureMaxDelayMs);
  });

  it('limits new admissions when the queue is extremely deep', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 50 }));
    expect(decision.state).toBe('overloaded');
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.overloadDelayMs);
  });

  it('treats a stalled oldest ready task as overload even at low depth', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 3, oldestReadyAgeMs: 11 * 60 * 1000 }));
    expect(decision.state).toBe('overloaded');
  });

  it('never returns a delay below the busy-loop floor', () => {
    const decision = nextConsumerDelay(signals({ readyQueueDepth: 4 }), { backlogDelayMs: 10 });
    expect(decision.delayMs).toBe(ADAPTIVE_CONSUMER_DEFAULTS.minDelayMs);
  });

  it('does not treat retry_wait work as an empty queue', () => {
    const decision = nextConsumerDelay(signals({ retryQueueDepth: 4 }));
    expect(decision.state).toBe('low_load');
  });
});
