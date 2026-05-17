import { describe, it, expect } from 'vitest';
import {
  evaluateIdleTriggerDecision,
  evaluateIdleTrigger,
  computeJitterMs,
  DEFAULT_IDLE_TRIGGER_CONFIG,
  resolveIdleTriggerConfig,
} from '../index.js';
import type { IdleTriggerInput, IdleTriggerConfig } from '../index.js';

const NOW = '2026-05-17T12:00:00.000Z';
const NOW_MS = new Date(NOW).getTime();

function makeInput(overrides?: Partial<IdleTriggerInput>): IdleTriggerInput {
  return {
    lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
    queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    config: DEFAULT_IDLE_TRIGGER_CONFIG,
    jitterSeed: 'test-seed',
    now: NOW,
    ...overrides,
  };
}

describe('IdleTrigger Decision Model (PRI-143)', () => {
  it('idle duration exceeds threshold with ready tasks → trigger', () => {
    const input = makeInput({
      lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
      queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('trigger');
    expect(result.reason).toBe('idle_threshold_met');
    expect(result.idleForMs).toBe(600_000);
    expect(result.queue.readyCount).toBe(1);
  });

  it('idle duration below threshold → skip with reason=not_idle_enough', () => {
    const input = makeInput({
      lastActivityAt: new Date(NOW_MS - 100_000).toISOString(),
      queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('not_idle_enough');
    expect(result.idleForMs).toBe(100_000);
  });

  it('no ready tasks → skip with reason=no_ready_tasks', () => {
    const input = makeInput({
      lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
      queue: { readyCount: 0, pendingCount: 0, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('no_ready_tasks');
  });

  it('jitter is deterministic with same seed', () => {
    const seed = 'deterministic-seed-123';
    const j1 = computeJitterMs(seed, 30_000);
    const j2 = computeJitterMs(seed, 30_000);
    const j3 = computeJitterMs(seed, 30_000);
    expect(j1).toBe(j2);
    expect(j2).toBe(j3);
    expect(j1).toBeGreaterThanOrEqual(0);
    expect(j1).toBeLessThanOrEqual(30_000);
  });

  it('jitter produces different values for different seeds', () => {
    const j1 = computeJitterMs('seed-a', 30_000);
    const j2 = computeJitterMs('seed-b', 30_000);
    expect(typeof j1).toBe('number');
    expect(typeof j2).toBe('number');
  });

  it('config missing fields → safe defaults via resolveIdleTriggerConfig', () => {
    const resolved = resolveIdleTriggerConfig({ enabled: true });
    expect(resolved.idleThresholdMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
    expect(resolved.jitterMaxMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs);
    expect(resolved.activityCooldownMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs);
    expect(resolved.enabled).toBe(true);

    const emptyResolved = resolveIdleTriggerConfig();
    expect(emptyResolved).toEqual(DEFAULT_IDLE_TRIGGER_CONFIG);
  });

  it('disabled config → skip with reason=disabled', () => {
    const config: IdleTriggerConfig = { ...DEFAULT_IDLE_TRIGGER_CONFIG, enabled: false };
    const input = makeInput({
      config,
      lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
      queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('disabled');
  });

  it('retry_wait pending with no ready tasks → skip with reason=retry_wait_pending', () => {
    const input = makeInput({
      lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
      queue: { readyCount: 0, pendingCount: 2, retryWaitCount: 3 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('retry_wait_pending');
  });

  it('lastActivityAt within activityCooldownMs → skip with reason=not_idle_enough', () => {
    const config: IdleTriggerConfig = {
      ...DEFAULT_IDLE_TRIGGER_CONFIG,
      idleThresholdMs: 10_000,
      activityCooldownMs: 120_000,
    };
    const input = makeInput({
      config,
      lastActivityAt: new Date(NOW_MS - 60_000).toISOString(),
      queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('not_idle_enough');
  });

  it('null lastActivityAt treats idle as infinite → trigger when ready tasks exist', () => {
    const input = makeInput({
      lastActivityAt: null,
      queue: { readyCount: 1, pendingCount: 1, retryWaitCount: 0 },
    });
    const result = evaluateIdleTriggerDecision(input);
    expect(result.decision).toBe('trigger');
    expect(result.idleForMs).toBe(NOW_MS);
  });

  it('evaluateIdleTrigger and evaluateIdleTriggerDecision produce identical results', () => {
    const input = makeInput();
    const r1 = evaluateIdleTrigger(input);
    const r2 = evaluateIdleTriggerDecision(input);
    expect(r1).toEqual(r2);
  });

  it('computeJitterMs with maxMs=0 returns 0', () => {
    expect(computeJitterMs('any-seed', 0)).toBe(0);
  });

  it('result includes jitterMs from seeded jitter', () => {
    const input = makeInput({
      lastActivityAt: new Date(NOW_MS - 600_000).toISOString(),
      jitterSeed: 'jitter-test',
    });
    const result = evaluateIdleTriggerDecision(input);
    const expectedJitter = computeJitterMs('jitter-test', DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs);
    expect(result.jitterMs).toBe(expectedJitter);
  });
});
