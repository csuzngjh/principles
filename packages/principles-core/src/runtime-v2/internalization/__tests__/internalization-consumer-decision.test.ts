import { describe, it, expect } from 'vitest';
import {
  computeConsumerDecision,
  DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE,
  DEFAULT_CONSUMER_RUNNER_KINDS,
} from '../internalization-consumer-decision.js';

describe('computeConsumerDecision', () => {
  it('returns shouldConsume=true when auto-consumer enabled and ready tasks exist', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
    });

    expect(result.shouldConsume).toBe(true);
    expect(result.maxTasksPerCycle).toBe(1);
    expect(result.runnerKinds).toEqual(['dreamer']);
    expect(result.reason).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it('returns shouldConsume=false with nextAction when auto-consumer disabled', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 10,
    });

    expect(result.shouldConsume).toBe(false);
    expect(result.maxTasksPerCycle).toBe(0);
    expect(result.runnerKinds).toEqual([]);
    expect(result.reason).toBe('auto_consumer_disabled');
    expect(result.nextAction).toContain('pd runtime internalization run-once');
    expect(result.nextAction).toContain('--runner dreamer');
  });

  it('returns shouldConsume=false with reason when no ready tasks', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 0,
    });

    expect(result.shouldConsume).toBe(false);
    expect(result.maxTasksPerCycle).toBe(1);
    expect(result.runnerKinds).toEqual(['dreamer']);
    expect(result.reason).toBe('no_ready_tasks');
    expect(result.nextAction).toBeUndefined();
  });

  it('respects custom maxTasksPerCycle', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 10,
      maxTasksPerCycle: 3,
    });

    expect(result.shouldConsume).toBe(true);
    expect(result.maxTasksPerCycle).toBe(3);
  });

  it('caps maxTasksPerCycle at readyTaskCount', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 2,
      maxTasksPerCycle: 10,
    });

    expect(result.shouldConsume).toBe(true);
    expect(result.maxTasksPerCycle).toBe(2);
  });

  it('disabled takes precedence over readyTaskCount', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 0,
    });

    expect(result.shouldConsume).toBe(false);
    expect(result.reason).toBe('auto_consumer_disabled');
  });

  it('defaults to DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE', () => {
    expect(DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE).toBe(1);
  });

  it('defaults to dreamer runner kind only', () => {
    expect(DEFAULT_CONSUMER_RUNNER_KINDS).toEqual(['dreamer']);
  });
});

// ── Additional Boundary Condition Tests ───────────────────────────────────────

describe('computeConsumerDecision — boundary conditions', () => {
  it('handles readyTaskCount=1 with maxTasksPerCycle=10 (caps at ready count)', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 1,
      maxTasksPerCycle: 10,
    });

    expect(result.shouldConsume).toBe(true);
    expect(result.maxTasksPerCycle).toBe(1); // capped at readyTaskCount
  });

  it('handles maxTasksPerCycle=0 (preserves explicit 0)', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
      maxTasksPerCycle: 0,
    });

    expect(result.shouldConsume).toBe(true);
    // maxTasksPerCycle=0 is explicitly provided, so it's preserved (not defaulted)
    // Note: ?? operator only defaults for null/undefined, not for 0
    expect(result.maxTasksPerCycle).toBe(0);
  });

  it('negative readyTaskCount produces negative maxTasksPerCycle (known edge case)', () => {
    // Negative count is invalid input. The function does not guard against it:
    // -5 !== 0 bypasses the no_ready_tasks check, so shouldConsume=true.
    // Math.min(1, -5) = -5 → maxTasksPerCycle is negative.
    // This documents the current behavior; callers should validate input.
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: -5,
    });

    expect(result.shouldConsume).toBe(true);
    // maxTasksPerCycle = Math.min(DEFAULT=1, -5) = -5
    expect(result.maxTasksPerCycle).toBe(-5);
    expect(result.runnerKinds).toEqual(['dreamer']);
    // No reason because readyTaskCount !== 0 and autoConsumer is enabled
    expect(result.reason).toBeUndefined();
  });

  it('handles very large readyTaskCount', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 1000000,
      maxTasksPerCycle: 100,
    });

    expect(result.shouldConsume).toBe(true);
    expect(result.maxTasksPerCycle).toBe(100);
  });

  it('handles disabled with zero ready tasks (disabled takes precedence)', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 0,
    });

    expect(result.shouldConsume).toBe(false);
    expect(result.reason).toBe('auto_consumer_disabled');
    expect(result.maxTasksPerCycle).toBe(0);
    expect(result.runnerKinds).toEqual([]);
  });

  it('handles disabled with large ready task count', () => {
    const result = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 1000,
      maxTasksPerCycle: 50,
    });

    expect(result.shouldConsume).toBe(false);
    expect(result.reason).toBe('auto_consumer_disabled');
    expect(result.nextAction).toContain('--runner dreamer');
  });

  it('returns consistent runnerKinds for all valid states', () => {
    // When enabled with tasks
    const withTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
    });
    expect(withTasks.runnerKinds).toEqual(['dreamer']);

    // When enabled but no tasks
    const noTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 0,
    });
    expect(noTasks.runnerKinds).toEqual(['dreamer']);

    // When disabled, runnerKinds is empty
    const disabled = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 5,
    });
    expect(disabled.runnerKinds).toEqual([]);
  });

  it('nextAction is only present when disabled', () => {
    // Enabled with tasks
    const enabledWithTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
    });
    expect(enabledWithTasks.nextAction).toBeUndefined();

    // Enabled without tasks
    const enabledNoTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 0,
    });
    expect(enabledNoTasks.nextAction).toBeUndefined();

    // Disabled
    const disabled = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 5,
    });
    expect(disabled.nextAction).toBeDefined();
    expect(disabled.nextAction).toContain('pd runtime internalization run-once');
  });

  it('reason is present for all non-consuming states', () => {
    // Should consume - no reason
    const shouldConsume = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
    });
    expect(shouldConsume.reason).toBeUndefined();

    // No ready tasks - has reason
    const noTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 0,
    });
    expect(noTasks.reason).toBe('no_ready_tasks');

    // Disabled - has reason
    const disabled = computeConsumerDecision({
      autoConsumerEnabled: false,
      readyTaskCount: 5,
    });
    expect(disabled.reason).toBe('auto_consumer_disabled');
  });

  it('maxTasksPerCycle calculation uses Math.min correctly', () => {
    // When maxTasksPerCycle < readyTaskCount
    const lessThanReady = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 10,
      maxTasksPerCycle: 3,
    });
    expect(lessThanReady.maxTasksPerCycle).toBe(3);

    // When maxTasksPerCycle > readyTaskCount
    const greaterThanReady = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 2,
      maxTasksPerCycle: 10,
    });
    expect(greaterThanReady.maxTasksPerCycle).toBe(2);

    // When maxTasksPerCycle === readyTaskCount
    const equal = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 5,
      maxTasksPerCycle: 5,
    });
    expect(equal.maxTasksPerCycle).toBe(5);
  });
});
