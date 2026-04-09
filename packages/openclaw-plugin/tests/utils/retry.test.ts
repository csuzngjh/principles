/**
 * Tests for Unified Retry Utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryAsync,
  retryAsyncWithInfo,
  withRetry,
  retryLLMCall,
  retryFileOperation,
  retryNetworkRequest,
  isRetryableError,
  computeDynamicTimeout,
  computeRetrySchedule,
  computeAdaptiveTimeout,
  percentile,
  clampTimeout,
  MAX_TIMEOUT_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type DurationDataSource,
} from '../../src/utils/retry.js';

describe('retryAsync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result on first successful call', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retryAsync(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const resultPromise = retryAsync(fn, { initialDelayMs: 100 });

    // Advance past first retry delay
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries exceeded', async () => {
    vi.useRealTimers(); // Use real timers for this test

    const fn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(retryAsync(fn, { maxRetries: 1, initialDelayMs: 1, logger: { warn: vi.fn() } }))
      .rejects.toThrow('ETIMEDOUT');
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('should not retry on non-retryable error', async () => {
    const error = new Error('Invalid input');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(retryAsync(fn)).rejects.toThrow('Invalid input');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use custom isRetryable function', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('custom error'))
      .mockResolvedValue('success');

    const resultPromise = retryAsync(fn, {
      initialDelayMs: 100,
      isRetryable: (err) => String(err).includes('custom'),
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('retryAsyncWithInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return detailed result info', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retryAsyncWithInfo(fn);

    expect(result.value).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a retry wrapper', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const wrapped = withRetry(fn, { initialDelayMs: 100 });
    const resultPromise = wrapped('arg1', 'arg2');

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
  });
});

describe('isRetryableError', () => {
  it('should detect timeout errors', () => {
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableError(new Error('connection timeout'))).toBe(true);
  });

  it('should detect rate limit errors', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('should detect LLM errors', () => {
    expect(isRetryableError(new Error('service overloaded'))).toBe(true);
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('should detect OpenClaw errors', () => {
    expect(isRetryableError(new Error('missing scope: operator.admin'))).toBe(true);
    expect(isRetryableError(new Error('gateway request required'))).toBe(true);
  });

  it('should return false for non-retryable errors', () => {
    expect(isRetryableError(new Error('Invalid input'))).toBe(false);
    expect(isRetryableError(new Error('File not found'))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('computeDynamicTimeout', () => {
  const createMockDataSource = (durations: number[]): DurationDataSource => ({
    getCompletionDurations: vi.fn().mockReturnValue(durations),
  });

  it('should return fallback when insufficient samples', () => {
    const source = createMockDataSource([1000, 2000]);
    const result = computeDynamicTimeout(source, 'test-workflow', 30000);

    expect(result).toBe(30000);
  });

  it('should compute P95 × safety multiplier', () => {
    // Create data where P95 is around 10000
    const durations = Array(50).fill(0).map((_, i) => 1000 + i * 200);
    const source = createMockDataSource(durations);
    const result = computeDynamicTimeout(source, 'test-workflow', 30000);

    // P95 should be around 10800, multiplied by 1.5 = ~16200
    expect(result).toBeGreaterThan(10000);
    expect(result).toBeLessThan(30000);
  });

  it('should clamp to min timeout', () => {
    const durations = [100, 200, 300, 400, 500];
    const source = createMockDataSource(durations);
    const result = computeDynamicTimeout(source, 'test-workflow', 1000);

    expect(result).toBe(MIN_TIMEOUT_MS);
  });

  it('should clamp to max timeout', () => {
    const durations = Array(50).fill(0).map(() => 1_000_000);
    const source = createMockDataSource(durations);
    const result = computeDynamicTimeout(source, 'test-workflow', 30000);

    expect(result).toBe(MAX_TIMEOUT_MS);
  });
});

describe('computeRetrySchedule', () => {
  it('should generate exponential backoff schedule', () => {
    const schedule = computeRetrySchedule(30000);

    expect(schedule).toHaveLength(MAX_TIMEOUT_RETRIES + 1);
    expect(schedule[0]).toBe(30000);
    expect(schedule[1]).toBe(60000);
    expect(schedule[2]).toBe(120000);
  });

  it('should clamp values to max timeout', () => {
    const schedule = computeRetrySchedule(200000);

    // 200000 × 2 = 400000, but should clamp to MAX_TIMEOUT_MS
    expect(schedule[1]).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
  });
});

describe('computeAdaptiveTimeout', () => {
  it('should return fallback when insufficient samples', () => {
    const result = computeAdaptiveTimeout([1000, 2000], 30000);
    expect(result).toBe(30000);
  });

  it('should compute P95 × safety multiplier', () => {
    const durations = Array(50).fill(0).map((_, i) => 1000 + i * 200);
    const result = computeAdaptiveTimeout(durations, 30000);

    expect(result).toBeGreaterThan(10000);
    expect(result).toBeLessThan(30000);
  });

  it('should respect custom options', () => {
    const durations = [100, 200, 300];
    const result = computeAdaptiveTimeout(durations, 10000, {
      minSamples: 1,
      safetyMultiplier: 3,
    });

    // P95 ≈ 300, × 3 = 900, clamped to min
    expect(result).toBe(MIN_TIMEOUT_MS);
  });
});

describe('percentile', () => {
  it('should compute P50 (median)', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('should compute P95', () => {
    const values = Array(100).fill(0).map((_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });

  it('should return median for small samples', () => {
    expect(percentile([1, 2, 3], 95)).toBe(2);
  });

  it('should handle empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('clampTimeout', () => {
  it('should clamp to min', () => {
    expect(clampTimeout(100)).toBe(MIN_TIMEOUT_MS);
  });

  it('should clamp to max', () => {
    expect(clampTimeout(1_000_000)).toBe(MAX_TIMEOUT_MS);
  });

  it('should keep value in range', () => {
    expect(clampTimeout(60000)).toBe(60000);
  });
});

describe('preset retry functions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retryLLMCall should have appropriate defaults', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const resultPromise = retryLLMCall(fn);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('retryFileOperation should have appropriate defaults', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValue('success');

    const resultPromise = retryFileOperation(fn);
    await vi.advanceTimersByTimeAsync(50);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('retryNetworkRequest should have appropriate defaults', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('success');

    const resultPromise = retryNetworkRequest(fn);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result).toBe('success');
  });
});
