/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1 — execution timing contract.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXECUTION_TIMING,
  deriveHeartbeatIntervalMs,
  resolveExecutionTiming,
} from '../execution-timing.js';

describe('resolveExecutionTiming', () => {
  it('uses documented defaults when nothing is provided', () => {
    expect(resolveExecutionTiming()).toEqual(DEFAULT_EXECUTION_TIMING);
    expect(DEFAULT_EXECUTION_TIMING.stageTimeoutMs).toBe(300_000);
    expect(DEFAULT_EXECUTION_TIMING.leaseTtlMs).toBe(120_000);
    expect(DEFAULT_EXECUTION_TIMING.heartbeatIntervalMs).toBeLessThan(DEFAULT_EXECUTION_TIMING.leaseTtlMs);
  });

  it('never derives a heartbeat cadence at or above the lease TTL', () => {
    const timing = resolveExecutionTiming({ leaseTtlMs: 10_000, heartbeatIntervalMs: 60_000 });
    expect(timing.heartbeatIntervalMs).toBeLessThan(timing.leaseTtlMs);
    expect(timing.heartbeatIntervalMs).toBe(5_000);
  });

  it('keeps the parent budget at least one stage long', () => {
    const timing = resolveExecutionTiming({ stageTimeoutMs: 900_000, parentBudgetMs: 60_000 });
    expect(timing.parentBudgetMs).toBe(900_000);
  });

  it('honours an explicit parent budget above the stage timeout', () => {
    const timing = resolveExecutionTiming({ stageTimeoutMs: 600_000, parentBudgetMs: 2_400_000 });
    expect(timing.parentBudgetMs).toBe(2_400_000);
  });

  it('does not let a stage timeout silently become the lease TTL', () => {
    // The legacy defect: stage timeout == lease TTL meant a stage crossing its
    // own deadline was also crossing its lease.
    const timing = resolveExecutionTiming({ stageTimeoutMs: 60_000 });
    expect(timing.leaseTtlMs).not.toBe(timing.stageTimeoutMs);
    expect(timing.heartbeatIntervalMs).toBeLessThan(timing.leaseTtlMs);
  });

  it('falls back to defaults for non-positive or non-finite values', () => {
    const timing = resolveExecutionTiming({
      stageTimeoutMs: Number.NaN,
      parentBudgetMs: -1,
      leaseTtlMs: 0,
      heartbeatIntervalMs: Number.POSITIVE_INFINITY,
    });
    expect(timing).toEqual(DEFAULT_EXECUTION_TIMING);
  });
});

describe('deriveHeartbeatIntervalMs', () => {
  it('is a third of the TTL, clamped to [10ms, 60s]', () => {
    expect(deriveHeartbeatIntervalMs(120_000)).toBe(40_000);
    expect(deriveHeartbeatIntervalMs(900)).toBe(300);
    expect(deriveHeartbeatIntervalMs(900_000)).toBe(60_000);
  });
});
