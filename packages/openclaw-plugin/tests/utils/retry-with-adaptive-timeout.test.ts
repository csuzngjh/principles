/**
 * Gap tests for retry-with-adaptive-timeout utility.
 *
 * These functions exist in src/utils/retry.ts but were not covered by the
 * original retry.test.ts file. We specifically cover:
 *  - retryWithAdaptiveTimeout basic success / failure semantics
 *  - computeAdaptiveTimeout (already covered) — we add a deterministic
 *    boundary case for sample=[] clamping at min/max thresholds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryWithAdaptiveTimeout,
  computeAdaptiveTimeout,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '../../src/utils/retry.js';

describe('computeAdaptiveTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const fakeDurationHistory = {
      getDurations: () => durations.slice(),
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
    expect(durations[0]).toBeGreaterThanOrEqual(0);
  });
});
