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
