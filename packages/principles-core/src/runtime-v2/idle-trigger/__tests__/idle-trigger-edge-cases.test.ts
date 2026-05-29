import { describe, it, expect } from 'vitest';
import { evaluateIdleTrigger, DEFAULT_IDLE_TRIGGER_CONFIG } from '../index.js';
import type { IdleTriggerInput } from '../index.js';

const NOW = '2026-05-17T12:00:00.000Z';
const NOW_MS = new Date(NOW).getTime();

function makeInput(overrides?: Partial<IdleTriggerInput>): IdleTriggerInput {
  return {
    lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
    queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    config: { ...DEFAULT_IDLE_TRIGGER_CONFIG },
    jitterSeed: 'test-seed',
    now: NOW,
    ...overrides,
  };
}

describe('evaluateIdleTrigger edge cases', () => {
  describe('queue state variations', () => {
    it('readyCount > 0 + retryWaitCount > 0 triggers (retry_wait_pending only applies when readyCount=0)', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
        queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 5 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
      expect(result.reason).toBe('idle_threshold_met');
    });

    it('readyCount > 0 + retryWaitCount === 0 triggers idle_threshold_met', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
        queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
      expect(result.reason).toBe('idle_threshold_met');
    });

    it('readyCount = 0 + retryWaitCount > 0 returns skip retry_wait_pending', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
        queue: { readyCount: 0, pendingCount: 5, retryWaitCount: 3 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('retry_wait_pending');
    });

    it('readyCount = 0 + retryWaitCount = 0 returns skip no_ready_tasks', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
        queue: { readyCount: 0, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('no_ready_tasks');
    });

    it('large readyCount still triggers correctly', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
        queue: { readyCount: 100, pendingCount: 200, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
      expect(result.queue.readyCount).toBe(100);
    });
  });

  describe('idle duration edge cases', () => {
    it('idleForMs exactly at idleThresholdMs boundary triggers', () => {
      const { idleThresholdMs } = DEFAULT_IDLE_TRIGGER_CONFIG;
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - idleThresholdMs).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
    });

    it('idleForMs just below idleThresholdMs returns skip not_idle_enough', () => {
      const { idleThresholdMs } = DEFAULT_IDLE_TRIGGER_CONFIG;
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - idleThresholdMs + 1).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });

    it('very long idle duration still triggers', () => {
      const input = makeInput({
        lastActivityAt: new Date(NOW_MS - 86_400_000).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
      expect(result.idleForMs).toBe(86_400_000);
    });

    it('idleForMs = 0 (just now) returns skip not_idle_enough', () => {
      const input = makeInput({
        lastActivityAt: NOW,
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });
  });

  describe('activityCooldown boundary conditions', () => {
    it('idleForMs exactly at activityCooldownMs returns skip not_idle_enough', () => {
      const { activityCooldownMs } = DEFAULT_IDLE_TRIGGER_CONFIG;
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG },
        lastActivityAt: new Date(NOW_MS - activityCooldownMs).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });

    it('idleForMs slightly above activityCooldownMs but below idleThresholdMs returns skip not_idle_enough', () => {
      const activityCooldownMs = 60_000;
      const idleThresholdMs = 300_000;
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, activityCooldownMs, idleThresholdMs },
        lastActivityAt: new Date(NOW_MS - activityCooldownMs - 1).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });
  });

  describe('lastActivityAt variations', () => {
    it('lastActivityAt undefined with no ready tasks returns skip no_ready_tasks', () => {
      const input = makeInput({
        lastActivityAt: undefined,
        queue: { readyCount: 0, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('no_ready_tasks');
    });

    it('lastActivityAt very old date triggers correctly', () => {
      const input = makeInput({
        lastActivityAt: '2020-01-01T00:00:00.000Z',
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
    });

    it('lastActivityAt future date (edge case) returns large idleForMs but still triggers', () => {
      const futureTime = new Date(NOW_MS + 1000).toISOString();
      const input = makeInput({
        lastActivityAt: futureTime,
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });
  });

  describe('config edge cases', () => {
    it('idleThresholdMs = 0 triggers when idleForMs exceeds activityCooldownMs', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, idleThresholdMs: 0 },
        lastActivityAt: new Date(NOW_MS - 120000).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
    });

    it('activityCooldownMs = 0 has no effect on idle threshold check', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, activityCooldownMs: 0, idleThresholdMs: 1000 },
        lastActivityAt: new Date(NOW_MS - 500).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });

    it('very large idleThresholdMs returns skip not_idle_enough', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, idleThresholdMs: 86400000 },
        lastActivityAt: new Date(NOW_MS - 600000).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('not_idle_enough');
    });

    it('jitterMaxMs = 0 results in jitterMs = 0', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, jitterMaxMs: 0 },
        lastActivityAt: new Date(NOW_MS - 600000).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.jitterMs).toBe(0);
    });
  });

  describe('nextEligibleAt calculations', () => {
    it('trigger decision includes correct nextEligibleAt timestamp', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, idleThresholdMs: 300000, jitterMaxMs: 30000 },
        lastActivityAt: new Date(NOW_MS - 600000).toISOString(),
        queue: { readyCount: 1, pendingCount: 0, retryWaitCount: 0 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('trigger');
      expect(result.nextEligibleAt).toBeTruthy();
      expect(new Date(result.nextEligibleAt).getTime()).toBeGreaterThan(NOW_MS);
    });

    it('retry_wait_pending decision includes nextEligibleAt in future', () => {
      const input = makeInput({
        queue: { readyCount: 0, pendingCount: 0, retryWaitCount: 5 },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.decision).toBe('skip');
      expect(result.reason).toBe('retry_wait_pending');
      expect(new Date(result.nextEligibleAt).getTime()).toBeGreaterThan(NOW_MS);
    });

    it('disabled returns nextEligibleAt = now', () => {
      const input = makeInput({
        config: { ...DEFAULT_IDLE_TRIGGER_CONFIG, enabled: false },
      });
      const result = evaluateIdleTrigger(input);
      expect(result.nextEligibleAt).toBe(NOW);
    });
  });
});
