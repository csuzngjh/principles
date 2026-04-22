/**
 * DefaultRetryPolicy unit tests.
 *
 * Pure unit tests — no I/O, no database.
 */
import { describe, it, expect } from 'vitest';
import { DefaultRetryPolicy } from './retry-policy.js';
import type { TaskRecord } from '../task-status.js';

describe('DefaultRetryPolicy', () => {
  const policy = new DefaultRetryPolicy({
    baseDelayMs: 30_000,
    maxDelayMs: 60_000,
    multiplier: 2,
    jitterFactor: 0.2,
  });

  describe('calculateBackoff', () => {
    it('returns base delay for first attempt', () => {
      const delay = policy.calculateBackoff(1);
      // With jitter of 0.2, range is 0.9x to 1.1x of 30000
      expect(delay).toBeGreaterThanOrEqual(27_000);
      expect(delay).toBeLessThanOrEqual(33_000);
    });

    it('doubles for second attempt', () => {
      const delay1 = policy.calculateBackoff(1);
      const delay2 = policy.calculateBackoff(2);
      expect(delay2).toBeGreaterThan(delay1);
    });

    it('caps at maxDelayMs', () => {
      const delay = policy.calculateBackoff(10);
      expect(delay).toBeLessThanOrEqual(66_000); // maxDelay + jitter
    });

    it('returns consistent-ish values (deterministic within jitter)', () => {
      // Multiple calls should all be within the jitter range
      for (let i = 0; i < 5; i++) {
        const delay = policy.calculateBackoff(1);
        expect(delay).toBeGreaterThanOrEqual(27_000);
        expect(delay).toBeLessThanOrEqual(33_000);
      }
    });
  });

  describe('shouldRetry', () => {
    function makeTask(attemptCount: number, maxAttempts: number): TaskRecord {
      return {
        taskId: 'test-task',
        taskKind: 'diagnostician',
        status: 'retry_wait',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount,
        maxAttempts,
      };
    }

    it('returns true when attempts remain', () => {
      expect(policy.shouldRetry(makeTask(1, 3))).toBe(true);
      expect(policy.shouldRetry(makeTask(2, 3))).toBe(true);
    });

    it('returns false when maxAttempts reached', () => {
      expect(policy.shouldRetry(makeTask(3, 3))).toBe(false);
      expect(policy.shouldRetry(makeTask(4, 3))).toBe(false);
    });

    it('fails safe when maxAttempts is invalid', () => {
      expect(policy.shouldRetry({ ...makeTask(0, 0), maxAttempts: 0 })).toBe(true);
      expect(policy.shouldRetry({ ...makeTask(0, -1), maxAttempts: -1 })).toBe(true);
      // NaN is not a valid number, but shouldRetry safely returns true (allow retry)
      // JavaScript: typeof NaN === 'number' is true, but NaN comparisons are all false
      // so task.attemptCount < NaN is false... but our guard handles this
      const nanTask = { ...makeTask(0, 1), maxAttempts: NaN as any };
      expect(policy.shouldRetry(nanTask)).toBe(true);
    });
  });

  describe('markRetryWait', () => {
    it('returns taskId and errorCategory', async () => {
      const result = await policy.markRetryWait('task-1', 'lease_expired');
      expect(result.taskId).toBe('task-1');
      expect(result.errorCategory).toBe('lease_expired');
    });
  });

  describe('markFailed', () => {
    it('returns taskId and errorCategory', async () => {
      const result = await policy.markFailed('task-2', 'max_attempts_exceeded');
      expect(result.taskId).toBe('task-2');
      expect(result.errorCategory).toBe('max_attempts_exceeded');
    });
  });
});
