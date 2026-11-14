/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3 — pipeline health metrics.
 *
 * The projection must be honest: derivable values are exact, non-derivable
 * values are `available:false` (never 0), and percentiles come from real
 * samples in the requested window.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPipelineHealthMetrics,
  summarizeLatencies,
  parentTaskIdFromStageTaskId,
  type StageRunSample,
} from '../../../src/server/models/pipeline-health-metrics.js';
import type { TaskRecord } from '@principles/core/runtime';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'taskId' | 'taskKind' | 'status'>): TaskRecord {
  return {
    createdAt: '2026-11-14T11:00:00.000Z',
    updatedAt: '2026-11-14T11:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function run(overrides: Partial<StageRunSample> & Pick<StageRunSample, 'runId' | 'taskId' | 'taskKind'>): StageRunSample {
  return {
    startedAt: '2026-11-14T11:10:00.000Z',
    endedAt: '2026-11-14T11:11:00.000Z',
    executionStatus: 'succeeded',
    errorCategory: null,
    attemptNumber: 0,
    ...overrides,
  };
}

describe('summarizeLatencies', () => {
  it('reports nulls (never zeros) when there are no samples', () => {
    expect(summarizeLatencies([])).toEqual({ sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  });

  it('uses nearest-rank percentiles over real samples', () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const summary = summarizeLatencies(samples);
    expect(summary.sampleCount).toBe(20);
    expect(summary.p50Ms).toBe(100);
    expect(summary.p95Ms).toBe(190);
    expect(summary.p99Ms).toBe(200);
    expect(summary.maxMs).toBe(200);
  });
});

describe('parentTaskIdFromStageTaskId', () => {
  it('derives the parent id from every stage task id shape', () => {
    expect(parentTaskIdFromStageTaskId('diag_rootcause-parent-1')).toBe('parent-1');
    expect(parentTaskIdFromStageTaskId('diag_distiller-parent-1')).toBe('parent-1');
    expect(parentTaskIdFromStageTaskId('diag_router-parent-1')).toBe('parent-1');
    expect(parentTaskIdFromStageTaskId('unrelated-task')).toBeNull();
  });
});

describe('buildPipelineHealthMetrics', () => {
  it('counts queue depths and the oldest waiting parent task', () => {
    const metrics = buildPipelineHealthMetrics({
      nowMs: NOW,
      windowMs: 24 * 60 * 60 * 1000,
      tasks: [
        task({ taskId: 'parent-1', taskKind: 'diagnostician', status: 'pending', createdAt: '2026-11-14T09:00:00.000Z' }),
        task({ taskId: 'parent-2', taskKind: 'diagnostician', status: 'retry_wait', createdAt: '2026-11-14T10:00:00.000Z' }),
        task({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending' }),
        task({ taskId: 'evaluator-1', taskKind: 'evaluator', status: 'retry_wait' }),
        task({ taskId: 'diag_rootcause-parent-1', taskKind: 'diag_rootcause', status: 'leased' }),
      ],
      stageRuns: [],
    });

    expect(metrics.queue.painQueueDepth).toBe(2);
    expect(metrics.queue.readyQueueDepth).toBe(1);
    expect(metrics.queue.retryQueueDepth).toBe(1);
    expect(metrics.queue.leasedCount).toBe(1);
    // oldest is the 09:00 parent, 3 hours before NOW
    expect(metrics.queue.oldestPendingAgeMs).toBe(3 * 60 * 60 * 1000);
    expect(metrics.queue.oldestPendingTaskKind).toBe('diagnostician');
  });

  it('counts only leases that are expired RIGHT NOW', () => {
    const metrics = buildPipelineHealthMetrics({
      nowMs: NOW,
      windowMs: 60 * 60 * 1000,
      tasks: [
        task({ taskId: 'expired', taskKind: 'diag_rootcause', status: 'leased', leaseOwner: 'worker-a', leaseExpiresAt: '2026-11-14T11:59:00.000Z' }),
        task({ taskId: 'fresh', taskKind: 'diag_distiller', status: 'leased', leaseOwner: 'worker-b', leaseExpiresAt: '2026-11-14T12:05:00.000Z' }),
        task({ taskId: 'no-expiry', taskKind: 'diag_router', status: 'leased' }),
      ],
      stageRuns: [],
    });
    expect(metrics.reliability.expiredActiveLeaseCount).toBe(1);
  });

  it('derives per-stage percentiles and the Stage C success rate from runs in the window', () => {
    const metrics = buildPipelineHealthMetrics({
      nowMs: NOW,
      windowMs: 60 * 60 * 1000,
      tasks: [],
      stageRuns: [
        run({ runId: 'r1', taskId: 'diag_router-p1', taskKind: 'diag_router', startedAt: '2026-11-14T11:10:00.000Z', endedAt: '2026-11-14T11:11:00.000Z' }),
        run({ runId: 'r2', taskId: 'diag_router-p2', taskKind: 'diag_router', startedAt: '2026-11-14T11:20:00.000Z', endedAt: '2026-11-14T11:23:00.000Z', executionStatus: 'failed', errorCategory: 'rate_limit' }),
        run({ runId: 'r3', taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause', startedAt: '2026-11-14T11:00:00.000Z', endedAt: '2026-11-14T11:00:30.000Z' }),
        // outside the window — must not influence the numbers
        run({ runId: 'old', taskId: 'diag_rootcause-p0', taskKind: 'diag_rootcause', startedAt: '2026-11-13T11:00:00.000Z', endedAt: '2026-11-13T11:00:10.000Z' }),
      ],
    });

    expect(metrics.stages.a.sampleCount).toBe(1);
    expect(metrics.stages.a.duration.p50Ms).toBe(30_000);
    expect(metrics.stages.c.sampleCount).toBe(2);
    expect(metrics.stages.c.successCount).toBe(1);
    expect(metrics.stages.c.failureCount).toBe(1);
    expect(metrics.stages.c.duration.maxMs).toBe(180_000);
    expect(metrics.reliability.diagnosisSuccessRate).toEqual({ available: true, value: 0.5 });
    expect(metrics.provider.rateLimitCount).toBe(1);
    // 1 failed run out of 3 in-window stage runs (2 router + 1 rootcause).
    expect(metrics.provider.errorRate).toEqual({ available: true, value: 1 / 3 });
  });

  it('computes queue wait from task creation to the first run start', () => {
    const metrics = buildPipelineHealthMetrics({
      nowMs: NOW,
      windowMs: 60 * 60 * 1000,
      tasks: [
        task({ taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause', status: 'succeeded', createdAt: '2026-11-14T11:00:00.000Z' }),
      ],
      stageRuns: [
        run({ runId: 'first', taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause', startedAt: '2026-11-14T11:02:00.000Z', endedAt: '2026-11-14T11:02:30.000Z' }),
        run({ runId: 'retry', taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause', startedAt: '2026-11-14T11:05:00.000Z', endedAt: '2026-11-14T11:05:30.000Z', attemptNumber: 1 }),
      ],
    });
    expect(metrics.queueWait.sampleCount).toBe(1);
    expect(metrics.queueWait.p50Ms).toBe(120_000);
    expect(metrics.reliability.stageRetryCount).toBe(1);
  });

  it('reports non-persisted metrics as available:false instead of 0', () => {
    const metrics = buildPipelineHealthMetrics({ nowMs: NOW, windowMs: 60 * 60 * 1000, tasks: [], stageRuns: [] });
    for (const metric of [
      metrics.reliability.leaseRenewalFailureCount,
      metrics.reliability.leaseRecoveryCount,
      metrics.reliability.staleCommitRejectedCount,
      metrics.tokens.tokensPerPain,
      metrics.stage2.pendingDepth,
      metrics.reliability.diagnosisSuccessRate,
      metrics.provider.errorRate,
    ]) {
      expect(metric.available).toBe(false);
      expect(metric.value).toBeNull();
      expect(typeof metric.reason).toBe('string');
    }
  });

  it('exposes bounded recent executions with parent/stage lineage', () => {
    const metrics = buildPipelineHealthMetrics({
      nowMs: NOW,
      windowMs: 60 * 60 * 1000,
      tasks: [task({ taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause', status: 'succeeded', attemptCount: 2 })],
      stageRuns: [
        run({ runId: 'r1', taskId: 'diag_rootcause-p1', taskKind: 'diag_rootcause' }),
        run({ runId: 'r2', taskId: 'diag_router-p1', taskKind: 'diag_router', startedAt: '2026-11-14T11:30:00.000Z' }),
        run({ runId: 'r3', taskId: 'dreamer-9', taskKind: 'dreamer', startedAt: '2026-11-14T11:40:00.000Z' }),
      ],
    });
    expect(metrics.lineage.available).toBe(true);
    expect(metrics.lineage.recentExecutions).toHaveLength(3);
    const [nonStage, newest, older] = metrics.lineage.recentExecutions;
    // A non-pipeline run has no stage and no derivable parent — null, not a guess.
    expect(nonStage?.stage).toBeNull();
    expect(nonStage?.parentTaskId).toBeNull();
    expect(newest?.taskId).toBe('diag_router-p1');
    expect(newest?.stage).toBe('C');
    expect(newest?.parentTaskId).toBe('p1');
    expect(older?.stage).toBe('A');
    expect(older?.attemptCount).toBe(2);
  });
});
