/**
 * Gap tests for retry-with-adaptive-timeout utility.
 *
 * These functions exist in src/utils/retry.ts but were not covered by the
 * original retry.test.ts file. We specifically cover:
 *  - retryWithAdaptiveTimeout basic success / failure semantics
 *  - computeAdaptiveTimeout (already covered) — we add a deterministic
 *    boundary case for sample=[] clamping at min/max thresholds
 */

import { describe, it, expect, vi } from 'vitest';
import {
  retryWithAdaptiveTimeout,
  computeAdaptiveTimeout,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '../../src/utils/retry.js';

// NOTE: no fake timers here. computeAdaptiveTimeout is a pure function and
// retryWithAdaptiveTimeout measures real elapsed time via Date.now(); faking
// timers would freeze Date.now() and make every recorded duration 0, turning
// the duration-recording assertion into a vacuous `0 >= 0` pass (EP-09).

describe('computeAdaptiveTimeout', () => {
  it('returns at least MIN_TIMEOUT_MS when history is empty', () => {
    const t = computeAdaptiveTimeout([], 1);
    expect(t).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
  });

  it('returns at most MAX_TIMEOUT_MS for enormous durations', () => {
    const hugeHistory = Array.from({ length: 50 }, () => 1e9);
    const t = computeAdaptiveTimeout(hugeHistory, 1e9, { minSamples: 1 });
    expect(t).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    expect(t).toBeGreaterThan(0);
  });

  it('uses minSamples threshold: insufficient → fallback clamped to minTimeout', () => {
    const t = computeAdaptiveTimeout([100], 500, { minSamples: 10 });
    expect(t).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
  });

  it('uses percentile + safetyMultiplier: large values scale linearly', () => {
    const small = computeAdaptiveTimeout([100, 200, 300, 400, 500], 1000, {
      minSamples: 1,
      safetyMultiplier: 2,
      minTimeoutMs: 1,
      maxTimeoutMs: 1_000_000,
    });
    const big = computeAdaptiveTimeout([10_000, 20_000, 30_000, 40_000, 50_000], 1000, {
      minSamples: 1,
      safetyMultiplier: 2,
      minTimeoutMs: 1,
      maxTimeoutMs: 1_000_000,
    });
    expect(big).toBeGreaterThan(small);
  });
});

describe('retryWithAdaptiveTimeout', () => {
  // NOTE: no fake timers. See file-top comment — retryWithAdaptiveTimeout
  // measures elapsed time via Date.now(); faking timers would freeze it and
  // make the duration-recording assertion vacuously pass.

  it('returns the fn value on the first successful call', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retryWithAdaptiveTimeout(fn, {
      minSamples: 1,
      minTimeoutMs: 1,
      maxTimeoutMs: 10,
      maxRetries: 0,
      backoffMultiplier: 1,
      logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with original error when fn fails on final attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const p = retryWithAdaptiveTimeout(fn, {
      minSamples: 1,
      minTimeoutMs: 1,
      maxTimeoutMs: 10,
      maxRetries: 0,
      backoffMultiplier: 1,
      logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    });
    await expect(p).rejects.toThrow('boom');
  });

  it('records successful outcome: records duration after fn call count > 0', async () => {
    const durations: number[] = [];
    // DurationHistorySource.getDurations(limit) contract: return up to `limit`
    // most-recent durations. The mock honours the signature so this test would
    // catch a future change where retry.ts starts passing a limit.
    const fakeDurationHistory = {
      getDurations: (limit: number) => durations.slice(-limit),
      recordDuration: (d: number) => {
        durations.push(d);
      },
    };

    const fn = vi.fn().mockResolvedValue('yay');
    await retryWithAdaptiveTimeout(fn, {
      durationHistory: fakeDurationHistory,
      minSamples: 1,
      minTimeoutMs: 1,
      maxTimeoutMs: 10,
      maxRetries: 0,
      backoffMultiplier: 1,
      logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
    });

    expect(durations.length).toBe(1);
    // Real elapsed time (no fake timers): a non-negative millisecond count.
    // We do not assert > 0 because the mocked fn resolves synchronously and
    // the measured delta can legitimately be 0 on fast machines.
    expect(durations[0]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(durations[0])).toBe(true);
  });
});
