import { describe, it, expect } from 'vitest';
import {
  computeConsumerDecision,
  DEFAULT_CONSUMER_MAX_TASKS_PER_CYCLE,
  DEFAULT_CONSUMER_RUNNER_KINDS,
  FULL_CHAIN_CONSUMER_RUNNER_KINDS,
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

// ── Boundary conditions (consolidated in PRI-891: the disabled/large-count/
// Math.min/consolidated-runnerKinds its duplicated the base describe above and
// were removed; the unreachable negative-readyTaskCount characterization was
// retired with it — production counts are non-negative by construction) ──────

describe('computeConsumerDecision — boundary conditions', () => {
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

  it('honors explicit runnerKinds override (full-chain scope)', () => {
    // The auto-consumer service passes FULL_CHAIN_CONSUMER_RUNNER_KINDS when
    // internalization_full_chain is ON; the decision echoes it back so the
    // wake-loop advances dreamer→…→evaluator→rollout_reviewer instead of
    // dreamer-only. rollout_reviewer is included so the approval queue is
    // populated unattended (the human gate is the Console, not a CLI trigger).
    const fullChain = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 3,
      runnerKinds: FULL_CHAIN_CONSUMER_RUNNER_KINDS,
    });
    expect(fullChain.shouldConsume).toBe(true);
    expect(fullChain.runnerKinds).toEqual(FULL_CHAIN_CONSUMER_RUNNER_KINDS);
    expect(fullChain.runnerKinds).toContain('rollout_reviewer');

    // No-ready-tasks path also echoes the override (used in SKIP telemetry).
    const noTasks = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 0,
      runnerKinds: FULL_CHAIN_CONSUMER_RUNNER_KINDS,
    });
    expect(noTasks.runnerKinds).toEqual(FULL_CHAIN_CONSUMER_RUNNER_KINDS);

    // Omitting runnerKinds falls back to dreamer-only (flag-off rollback).
    const defaulted = computeConsumerDecision({
      autoConsumerEnabled: true,
      readyTaskCount: 3,
    });
    expect(defaulted.runnerKinds).toEqual(['dreamer']);
  });
});
