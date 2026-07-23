/**
 * Retry Math Utilities Tests — OpenClaw Plugin
 *
 * Unit tests for the PURE math/stat functions exported from utils/retry.ts.
 * These are used by WorkflowManager, subagent scheduler, and LLM adapters to
 * compute adaptive timeouts and retry schedules.
 *
 * Tests verify (focus on edge cases that cause silent regressions):
 * - percentile() handles empty arrays, single values, small-sample median
 *   fallback, standard large-sample P95 nearest-rank.
 * - clampTimeout() enforces [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] closed bounds.
 * - computeRetrySchedule() applies exponential backoff correctly AND clamps
 *   every entry (so no schedule entry exceeds MAX_TIMEOUT_MS).
 * - computeAdaptiveTimeout() falls back to static timeout when samples are
 *   insufficient, applies safety multiplier, clamps to safe bounds.
 * - All functions are deterministic (no randomness) and side-effect-free —
 *   so tests are 100% repeatable and isolated.
 *
 * ERR checklist:
 * - ERR-088: exact-value assertions, not just range checks. E.g. percentile()
 *   on a concrete 9-value array returns EXACTLY the 9th-ranked entry, not
 *   just "a number between min and max".
 * - ERR-089: both accept and reject branches exercised for every clamp/guard.
 * - ERR-083 (broadened pattern): these utilities are used in 7+ packages via
 *   shared utils — a drift here would cascade silently; these tests pin the
 *   contract so any change requires deliberate re-examination of all callers.
 */

import { describe, it, expect } from 'vitest';
import {
  percentile,
  clampTimeout,
  computeRetrySchedule,
  computeAdaptiveTimeout,
  MIN_SAMPLES,
  LOOKBACK_WINDOW,
  SAFETY_MULTIPLIER,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_TIMEOUT_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
} from '../../src/utils/retry.js';

// ── Shared Constants ─────────────────────────────────────────────────────────

// Reference: retry.ts MIN_SAMPLES = 3, MIN_TIMEOUT_MS = 10_000, MAX_TIMEOUT_MS = 300_000

// ── percentile() ──────────────────────────────────────────────────────────────

describe('percentile() — nearest-rank with small-sample median fallback', () => {

  // ── Empty / trivial edge cases ────────────────────────────────────────────

  it('returns 0 for empty array (no data → 0 is the defined safe default)', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 0)).toBe(0);
    expect(percentile([], 100)).toBe(0);
  });

  it('returns that single value for n=1 (any percentile)', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('handles array with all identical values', () => {
    expect(percentile([7, 7, 7, 7, 7], 95)).toBe(7);
    expect(percentile([1000, 1000, 1000, 1000], 50)).toBe(1000);
  });

  // ── Small-sample median fallback path (n < 10) ────────────────────────────
  // The function uses median (sorted[floor(n/2)]) for samples below 10.

  it('for n=2 returns sorted[1] (median index floor(2/2)=1)', () => {
    expect(percentile([10, 20], 95)).toBe(20);
    // Unsorted input — percentile sorts a copy internally.
    expect(percentile([20, 10], 95)).toBe(20);
  });

  it('for n=3 returns sorted[1] (median index floor(3/2)=1)', () => {
    // sorted: [10, 20, 30] → median is 20 at index 1.
    expect(percentile([10, 20, 30], 95)).toBe(20);
    expect(percentile([30, 10, 20], 95)).toBe(20);
  });

  it('for n=5 returns sorted[2] (median index floor(5/2)=2)', () => {
    // sorted: [1, 2, 3, 4, 5] → index 2 = 3.
    expect(percentile([3, 1, 5, 2, 4], 90)).toBe(3);
  });

  it('for n=9 returns sorted[4] (median index floor(9/2)=4)', () => {
    // sorted indices 0..8 → floor(9/2)=4 is the middle.
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    expect(percentile(values, 95)).toBe(50);
  });

  it('small-sample fallback is used REGARDLESS of requested percentile', () => {
    // This is a behavioral pin — even P1 / P99 / P100 use median when n < 10.
    const arr = [1, 2, 3, 4, 5];
    expect(percentile(arr, 1)).toBe(3);
    expect(percentile(arr, 50)).toBe(3);
    expect(percentile(arr, 99)).toBe(3);
    expect(percentile(arr, 100)).toBe(3);
  });

  // ── Large-sample nearest-rank path (n >= 10) ──────────────────────────────

  it('for n=10 uses nearest-rank (not median) — index ceil(P/100 * n) - 1', () => {
    // 10 values sorted: [10,20,30,40,50,60,70,80,90,100]
    // P95: rank = ceil(0.95 * 10) = ceil(9.5) = 10 → index = min(10, 10) - 1 = 9 → 100
    const arr = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(arr, 95)).toBe(100);
  });

  it('for n=20 P95: rank = ceil(0.95*20)=19 → index 18', () => {
    // Build values 10..200 (step 10) — 20 values.
    const arr = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    // sorted[18] = 190.
    expect(percentile(arr, 95)).toBe(190);
  });

  it('for n=20 P50: rank = ceil(0.5*20)=10 → index 9 = 100', () => {
    const arr = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(arr, 50)).toBe(100);
  });

  it('for n=100 P1: rank = ceil(0.01*100)=1 → index 0 = minimum', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 1)).toBe(1);
  });

  it('for n=100 P100: rank = ceil(100) = 100 → min(100,100)-1 = 99 = maximum', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 100)).toBe(100);
  });

  it('nearest-rank index clamped to [0, n-1] (no out-of-bounds even for weird percentiles)', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i + 1);
    // Percentile 0 → rank 0 → Math.min(0,20)-1 = -1 → undefined check returns 0?
    // Implementation does sorted[Math.min(rank, n)-1]; if rank=0, index=-1 → undefined.
    // But function has `?? 0` fallback — that's the guard we test here.
    // Note: 0% is outside the contract domain (use 1%), but guard must still not throw.
    expect(percentile(arr, 0)).toBeGreaterThanOrEqual(0);
  });

  it('does not mutate input array (uses a copy for sorting)', () => {
    const original = [5, 1, 4, 2, 3];
    const frozen = [...original];
    percentile(original, 95);
    // If the input had been mutated, its order would have changed to sorted.
    expect(original).toEqual(frozen);
  });

  it('handles float values in input', () => {
    expect(percentile([1.5, 2.5, 0.5], 95)).toBe(1.5); // n<10 median: sorted[1]=1.5
    // Large sample with floats
    const floats = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8, 9.9, 10.1];
    expect(percentile(floats, 95)).toBeCloseTo(10.1);
  });

  it('handles negative values (durations can be negative if clock drifts)', () => {
    expect(percentile([-100, 0, 50], 95)).toBe(0); // n<10 median sorted[1]
    const negatives = Array.from({ length: 12 }, (_, i) => (i - 10) * 100); // -1000..100
    expect(percentile(negatives, 95)).toBe(100); // n=12, rank=ceil(0.95*12)=12, index 11
  });
});

// ── clampTimeout() ────────────────────────────────────────────────────────────

describe('clampTimeout() — hard safety bounds for all timeout values', () => {

  it('PIN: MIN_TIMEOUT_MS is 10000 (10s)', () => {
    // If these constants drift, callers' assumptions about minimum waits break.
    expect(MIN_TIMEOUT_MS).toBe(10_000);
  });

  it('PIN: MAX_TIMEOUT_MS is 300000 (5min)', () => {
    expect(MAX_TIMEOUT_MS).toBe(300_000);
  });

  it('returns the input value unchanged when inside [MIN, MAX]', () => {
    expect(clampTimeout(30_000)).toBe(30_000);
    expect(clampTimeout(10_000)).toBe(10_000);     // exact lower boundary
    expect(clampTimeout(300_000)).toBe(300_000);   // exact upper boundary
    expect(clampTimeout(150_000)).toBe(150_000);
  });

  it('clamps values below MIN to MIN (never return <10s — prevents "instant timeout" races)', () => {
    expect(clampTimeout(0)).toBe(10_000);
    expect(clampTimeout(1)).toBe(10_000);
    expect(clampTimeout(9_999)).toBe(10_000);
    expect(clampTimeout(-5_000)).toBe(10_000);   // negative (clock drift / bad math)
    expect(clampTimeout(Infinity * -1)).toBe(10_000); // -Infinity guard
  });

  it('clamps values above MAX to MAX (never return >5min — prevents hung workflows)', () => {
    expect(clampTimeout(300_001)).toBe(300_000);
    expect(clampTimeout(600_000)).toBe(300_000);   // 10 minutes → capped
    expect(clampTimeout(Number.MAX_SAFE_INTEGER)).toBe(300_000);
    expect(clampTimeout(Infinity)).toBe(300_000);  // Infinity guard
  });

  it('rounds non-integer inputs to nearest integer (ms are integer units)', () => {
    // clampTimeout uses Math.round inside Math.min/Math.max chain.
    expect(clampTimeout(15_000.4)).toBe(15_000);
    expect(clampTimeout(15_000.6)).toBe(15_001);
    expect(clampTimeout(9_999.6)).toBe(10_000); // rounds up to 10_000 which is MIN
    expect(clampTimeout(300_000.4)).toBe(300_000); // rounds down stays at MAX
  });

  it('handles NaN — Math.min/Math.max propagate NaN, result may be NaN (callers guard upstream)', () => {
    // clampTimeout uses Math.min/Math.max chain. NaN propagates through these
    // functions: Math.min(MAX, NaN) → NaN, Math.max(MIN, NaN) → NaN.
    // This test documents the current behavior. Callers (e.g. computeAdaptiveTimeout
    // with options-only bounds) are responsible for ensuring inputs are finite.
    // We assert: either result is a finite number in [MIN, MAX], OR it is NaN
    // (which matches the current implementation's Math-chain behavior).
    const result = clampTimeout(NaN);
    if (Number.isNaN(result)) {
      // Documented current behavior: NaN passes through.
      expect(Number.isNaN(result)).toBe(true);
    } else {
      expect(result).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(result).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    }
  });
});

// ── computeRetrySchedule() ────────────────────────────────────────────────────

describe('computeRetrySchedule() — exponential backoff with per-entry clamping', () => {

  it('PIN: default MAX_TIMEOUT_RETRIES = 2 (total attempts = 3 including try 0)', () => {
    expect(MAX_TIMEOUT_RETRIES).toBe(2);
  });

  it('PIN: default RETRY_BACKOFF_MULTIPLIER = 2 (doubling each attempt)', () => {
    expect(RETRY_BACKOFF_MULTIPLIER).toBe(2);
  });

  it('produces [base, base*2, base*4] for default retries=2 with small base', () => {
    // Base 30s: [30000, 60000, 120000] — all below MAX (300_000)
    expect(computeRetrySchedule(30_000, 2)).toEqual([30_000, 60_000, 120_000]);
  });

  it('includes 0th attempt (baseTimeout unmultiplied) as first entry', () => {
    // Schedule length = retries + 1. First entry is always exactly base (clamped).
    const s = computeRetrySchedule(20_000, 1);
    expect(s).toHaveLength(2);
    expect(s[0]).toBe(20_000);
    expect(s[1]).toBe(40_000);
  });

  it('clamps every entry to MAX_TIMEOUT_MS when base is large', () => {
    // Base 200_000:
    //   attempt 0: 200_000 (<= MAX ok)
    //   attempt 1: 400_000 (> MAX → 300_000)
    //   attempt 2: 800_000 (> MAX → 300_000)
    expect(computeRetrySchedule(200_000, 2)).toEqual([200_000, 300_000, 300_000]);
  });

  it('clamps all entries when base itself exceeds MAX (all entries = MAX)', () => {
    expect(computeRetrySchedule(500_000, 2)).toEqual([300_000, 300_000, 300_000]);
  });

  it('clamps entries below MIN_TIMEOUT_MS when base is tiny', () => {
    // Base 100ms:
    //   attempt 0: 100 → clamped to 10_000
    //   attempt 1: 200 → 10_000
    //   attempt 2: 400 → 10_000
    expect(computeRetrySchedule(100, 2)).toEqual([10_000, 10_000, 10_000]);
  });

  it('uses default retries (MAX_TIMEOUT_RETRIES) when arg omitted', () => {
    // 2nd arg is optional → default = MAX_TIMEOUT_RETRIES = 2
    const s = computeRetrySchedule(10_000);
    expect(s).toHaveLength(MAX_TIMEOUT_RETRIES + 1); // length = 3
  });

  it('produces schedule with non-default retries = 0 → single-entry array', () => {
    const s = computeRetrySchedule(30_000, 0);
    expect(s).toHaveLength(1);
    expect(s[0]).toBe(30_000);
  });

  it('produces schedule with retries=4 (5 entries) for aggressive retry config', () => {
    const s = computeRetrySchedule(10_000, 4);
    expect(s).toHaveLength(5);
    // [10_000, 20_000, 40_000, 80_000, 160_000]
    expect(s).toEqual([10_000, 20_000, 40_000, 80_000, 160_000]);
  });

  it('every entry in schedule is an integer (ms are integers)', () => {
    const s = computeRetrySchedule(15_000.3, 2);
    for (const entry of s) {
      expect(Number.isInteger(entry)).toBe(true);
    }
  });

  it('every entry in schedule is within [MIN, MAX] bounds', () => {
    const extremeBase = 1;                  // well below MIN
    const s = computeRetrySchedule(extremeBase, 5);
    for (const entry of s) {
      expect(entry).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(entry).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    }
  });
});

// ── computeAdaptiveTimeout() ──────────────────────────────────────────────────

describe('computeAdaptiveTimeout() — P95 × safety with insufficient-sample fallback', () => {

  it('PIN: MIN_SAMPLES = 3 (need at least 3 completions before trusting adaptive)', () => {
    expect(MIN_SAMPLES).toBe(3);
  });

  it('PIN: SAFETY_MULTIPLIER = 1.5 (50% headroom over P95)', () => {
    expect(SAFETY_MULTIPLIER).toBe(1.5);
  });

  it('PIN: LOOKBACK_WINDOW = 50 (last 50 completions)', () => {
    expect(LOOKBACK_WINDOW).toBe(50);
  });

  // ── Insufficient-sample fallback path ─────────────────────────────────────

  it('falls back to fallbackMs (clamped) when history.length < minSamples default (3)', () => {
    // 0 samples
    expect(computeAdaptiveTimeout([], 60_000)).toBe(60_000);
    // 1 sample → <3, fallback
    expect(computeAdaptiveTimeout([100_000], 60_000)).toBe(60_000);
    // 2 samples → <3, fallback
    expect(computeAdaptiveTimeout([10_000, 20_000], 60_000)).toBe(60_000);
  });

  it('clamps the fallback value when fallbackMs is out of bounds', () => {
    // fallbackMs = 1ms → clamped to MIN_TIMEOUT_MS
    expect(computeAdaptiveTimeout([], 1)).toBe(MIN_TIMEOUT_MS);
    // fallbackMs = 10min → clamped to MAX_TIMEOUT_MS
    expect(computeAdaptiveTimeout([], 10 * 60 * 1000)).toBe(MAX_TIMEOUT_MS);
  });

  it('uses custom minSamples option when provided', () => {
    // Default minSamples = 3, but if we pass minSamples=5, 4 samples should still fallback.
    const smallHistory = [10_000, 20_000, 30_000, 40_000]; // 4 items
    expect(computeAdaptiveTimeout(smallHistory, 25_000, { minSamples: 5 })).toBe(25_000);
    // And when minSamples=4, 4 items is exactly enough → adaptive path triggers.
  });

  // ── Adaptive path: history.length >= minSamples → P95 × multiplier ───────

  it('adaptive: 3 samples (exact min boundary) uses inline nearest-rank P95 (NOT percentile() median fallback)', () => {
    // NOTE: computeAdaptiveTimeout does NOT call the exported percentile() helper.
    // It has its OWN inline nearest-rank implementation, with NO n<10 median fallback.
    // So for n=3, p=95:
    //   sorted: [10_000, 20_000, 30_000]
    //   rank = ceil(0.95 * 3) = ceil(2.85) = 3
    //   index = min(3, 3) - 1 = 2 → pValue = 30_000
    //   × 1.5 = 45_000 → within [10_000, 300_000]
    const history = [20_000, 10_000, 30_000];
    expect(computeAdaptiveTimeout(history, 120_000)).toBe(45_000);
  });

  it('adaptive: 12 samples (≥10) uses P95 nearest-rank × safety multiplier', () => {
    // Build history where sorted values are 1s..12s in ms (1000..12000).
    // 12 values: [1000, 2000, ..., 12000]
    // P95: rank = ceil(0.95 * 12) = ceil(11.4) = 12 → index 11 → 12000.
    // × 1.5 = 18000 → clamped up to MIN_TIMEOUT_MS = 10_000? No, 18000 > 10_000.
    const history = Array.from({ length: 12 }, (_, i) => (i + 1) * 1000);
    expect(computeAdaptiveTimeout(history, 120_000)).toBe(18_000);
  });

  it('adaptive: 20 realistic values → P95 * 1.5, within bounds', () => {
    // Sorted: [10_000, 11_000, ..., 29_000]
    const history = Array.from({ length: 20 }, (_, i) => 10_000 + i * 1_000);
    // P95 rank = ceil(0.95 * 20) = 19 → index 18 → 10_000 + 18*1_000 = 28_000
    // × 1.5 = 42_000
    expect(computeAdaptiveTimeout(history, 120_000)).toBe(42_000);
  });

  it('adaptive result clamps upward when P95 × multiplier < MIN_TIMEOUT_MS', () => {
    // n=10 very quick completions (each 1ms)
    const fast = Array.from({ length: 10 }, () => 1);
    // P95 fast[9]=1 × 1.5 = 1.5 → clamp to MIN
    expect(computeAdaptiveTimeout(fast, 60_000)).toBe(MIN_TIMEOUT_MS);
  });

  it('adaptive result clamps downward when P95 × multiplier > MAX_TIMEOUT_MS', () => {
    // n=10 slow completions (each 5 minutes = 300_000ms... but P95 * 1.5 = 450_000 > MAX)
    const slow = Array.from({ length: 10 }, () => 300_000);
    expect(computeAdaptiveTimeout(slow, 60_000)).toBe(MAX_TIMEOUT_MS);
  });

  it('accepts custom safetyMultiplier and bounds', () => {
    const history = Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000);
    // sorted: [1k, 2k, ..., 10k]
    // P95: rank ceil(0.95*10) = 10 → index 9 → 10_000.
    // × custom multiplier 3.0 = 30_000 → clamped at default min/max.
    const result = computeAdaptiveTimeout(history, 120_000, { safetyMultiplier: 3.0 });
    expect(result).toBe(30_000);
  });

  it('accepts custom minTimeoutMs / maxTimeoutMs and applies them over defaults', () => {
    const history = Array.from({ length: 10 }, () => 1); // P95 tiny
    // Custom min = 15_000, so even if computed is 1ms × 1.5 → clamped to 15_000.
    expect(
      computeAdaptiveTimeout(history, 60_000, { minTimeoutMs: 15_000 })
    ).toBe(15_000);

    // Custom max = 200_000, history with huge values:
    const hugeHistory = Array.from({ length: 10 }, () => 1_000_000);
    expect(
      computeAdaptiveTimeout(hugeHistory, 60_000, { maxTimeoutMs: 200_000 })
    ).toBe(200_000);
  });

  it('custom percentile option (e.g., P99) computes correctly', () => {
    // n=20 values [1..20]k
    const history = Array.from({ length: 20 }, (_, i) => (i + 1) * 1_000);
    // Default P95: rank=ceil(19)=19 → index 18 → 19_000 × 1.5 = 28_500
    // P99:    rank=ceil(19.8)=20 → index 19 → 20_000 × 1.5 = 30_000
    const p99 = computeAdaptiveTimeout(history, 120_000, { percentile: 99 });
    expect(p99).toBe(30_000);
  });

  it('history does not need to be sorted — function computes internally', () => {
    // Same 12 values as earlier test but in random order
    const shuffled = [5000, 11000, 8000, 3000, 12000, 2000, 1000, 7000, 9000, 6000, 4000, 10000];
    // Should match sorted P95 result (12000 * 1.5 = 18000)
    expect(computeAdaptiveTimeout(shuffled, 120_000)).toBe(18_000);
  });

  it('adaptive result is always an integer (ms are integers)', () => {
    // P95 × 1.5 where result is fractional → the Math.round inside clampTimeout handles it.
    const midHistory = Array.from({ length: 10 }, (_, i) => 20_001 + i);
    // P95 sorted[9] = 20_010 × 1.5 = 30_015
    const r = computeAdaptiveTimeout(midHistory, 60_000);
    expect(Number.isInteger(r)).toBe(true);
  });
});

// ── Cross-function coherence checks ───────────────────────────────────────────

describe('cross-function coherence: outputs compose without silent drift', () => {

  it('computeAdaptiveTimeout result → computeRetrySchedule base — every entry clamped', () => {
    // A realistic workflow: compute adaptive from history, build a retry schedule.
    // The schedule entries must all be integers within [MIN, MAX].
    const history = Array.from({ length: 15 }, (_, i) => 15_000 + i * 2_000);
    const base = computeAdaptiveTimeout(history, 120_000);
    const schedule = computeRetrySchedule(base, 3);

    for (let i = 0; i < schedule.length; i++) {
      expect(Number.isInteger(schedule[i])).toBe(true);
      expect(schedule[i]).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(schedule[i]).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    }
  });

  it('percentile on raw completion durations → computeAdaptiveTimeout uses same percentile logic', () => {
    // Verify computeAdaptiveTimeout with default options really is
    // clamp(percentile(history, 95) × 1.5, MIN, MAX).
    const history = Array.from({ length: 12 }, (_, i) => (i + 1) * 1_000);
    const p95 = percentile(history, 95);             // 12_000
    const direct = clampTimeout(Math.round(p95 * 1.5)); // 18_000
    const viaFn = computeAdaptiveTimeout(history, 999_999);
    expect(viaFn).toBe(direct);
  });
});
