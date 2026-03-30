import { describe, expect, it } from 'vitest';
import { evaluatePhase3Inputs } from '../../src/service/phase3-input-filter.js';

describe('evaluatePhase3Inputs', () => {
  it('rejects an empty queue', () => {
    const result = evaluatePhase3Inputs([]);
    expect(result.queueTruthReady).toBe(false);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.eligible).toHaveLength(0);
    expect(result.evolution.rejected).toHaveLength(0);
  });

  it('marks clean queue as phase-3 eligible', () => {
    const result = evaluatePhase3Inputs([
      { id: 'task-1', status: 'pending' },
      { id: 'task-2', status: 'in_progress', started_at: '2026-03-20T10:00:00Z' },
      { id: 'task-3', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
    ]);
    expect(result.queueTruthReady).toBe(true);
    expect(result.phase3ShadowEligible).toBe(true);
    expect(result.evolution.eligible).toHaveLength(3);
    expect(result.evolution.rejected).toHaveLength(0);
  });

  it('rejects dirty queue lifecycle rows', () => {
    const result = evaluatePhase3Inputs([
      { id: 'task-1', status: 'in_progress' },
      { id: 'task-1', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
      { id: 'task-3', status: 'completed' },
    ]);
    expect(result.queueTruthReady).toBe(false);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.rejected.map((entry) => entry.reasons)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['reused_task_id']),
        expect.arrayContaining(['missing_started_at']),
        expect.arrayContaining(['missing_completed_at']),
      ])
    );
  });

  it('rejects invalid statuses and malformed timestamps', () => {
    const result = evaluatePhase3Inputs([
      { id: 'task-1', status: 'paused', started_at: 'not-a-date' },
      { id: 'task-2', status: 'completed', completed_at: 'still-not-a-date' },
    ]);
    expect(result.queueTruthReady).toBe(false);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.rejected.map((entry) => entry.reasons)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['legacy_queue_status', 'invalid_started_at']),
        expect.arrayContaining(['invalid_completed_at', 'missing_completed_at']),
      ])
    );
  });

  describe('Legacy Queue Status Rejection', () => {
    it('rejects legacy resolved status', () => {
      const result = evaluatePhase3Inputs([
        { id: '1afdd4bb', status: 'resolved', started_at: '2026-03-24T15:29:39.710Z', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('legacy_queue_status');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects null status rows', () => {
      const result = evaluatePhase3Inputs([
        { id: '6a7c7c48', status: null, started_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_status');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects paused and cancelled statuses', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-1', status: 'paused' },
        { id: 'task-2', status: 'cancelled' },
      ]);
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.evolution.rejected.map((r) => r.reasons)).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['legacy_queue_status']),
          expect.arrayContaining(['legacy_queue_status']),
        ])
      );
    });

    it('detects reused task IDs', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-1', status: 'pending' },
        { id: 'task-1', status: 'completed', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.evolution.rejected[0].reasons).toContain('reused_task_id');
      expect(result.evolution.rejected[1].reasons).toContain('reused_task_id');
    });

    it('rejects in_progress without started_at', () => {
      const result = evaluatePhase3Inputs([{ id: 'task-1', status: 'in_progress' }]);
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_started_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects completed without completed_at', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-1', status: 'completed', started_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_completed_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects malformed timestamps', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-1', status: 'in_progress', started_at: 'not-a-timestamp' },
      ]);
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('invalid_started_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('handles mixed valid and invalid entries', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'resolved' },
        { id: 'task-3', status: 'in_progress', started_at: '2026-03-24T15:29:39.710Z' },
        { id: 'task-4', status: null },
      ]);
      expect(result.evolution.eligible).toHaveLength(2);
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.queueTruthReady).toBe(false);
    });
  });

  describe('Timeout-Only Outcome Filtering', () => {
    it('classifies timeout-only as reference_only', () => {
      const result = evaluatePhase3Inputs([
        { id: 'e5da4f5c', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.referenceOnly).toHaveLength(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('e5da4f5c');
      expect(result.evolution.referenceOnly[0].classification).toBe('timeout_only');
      expect(result.evolution.rejected).toHaveLength(0);
      expect(result.queueTruthReady).toBe(true);
    });

    it('allows tasks with successful completion markers', () => {
      const result = evaluatePhase3Inputs([
        { id: 'task-success', status: 'completed', resolution: 'marker_detected', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.eligible).toHaveLength(1);
      expect(result.evolution.rejected).toHaveLength(0);
    });

    it('puts multiple timeout-only tasks in referenceOnly', () => {
      const result = evaluatePhase3Inputs([
        { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
        { id: 'timeout-2', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:30:39.710Z' },
      ]);
      expect(result.evolution.referenceOnly).toHaveLength(2);
      expect(result.evolution.referenceOnly.every((r) => r.classification === 'timeout_only')).toBe(true);
      expect(result.evolution.rejected).toHaveLength(0);
      expect(result.queueTruthReady).toBe(true);
    });

    it('allows mix of timeout-only and valid tasks', () => {
      const result = evaluatePhase3Inputs([
        { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
        { id: 'valid-1', status: 'completed', completed_at: '2026-03-24T15:30:39.710Z' },
      ]);
      expect(result.evolution.eligible).toHaveLength(1);
      expect(result.evolution.eligible[0].taskId).toBe('valid-1');
      expect(result.evolution.referenceOnly).toHaveLength(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-1');
      expect(result.evolution.rejected).toHaveLength(0);
      expect(result.queueTruthReady).toBe(true);
    });
  });

  describe('Production Sample Integration', () => {
    it('handles production sample correctly', () => {
      const productionQueue = [
        { id: '1afdd4bb', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z', completed_at: '2026-03-22T03:25:00.000Z' },
        { id: '1a04aebb', status: 'resolved', started_at: '2026-03-22T02:45:55.013Z', completed_at: '2026-03-22T03:25:00.000Z' },
        { id: '91947ddb', status: 'resolved', started_at: '2026-03-22T03:00:55.012Z', completed_at: '2026-03-22T03:25:00.000Z' },
        { id: '6a7c7c48', started_at: '2026-03-23T08:26:52.048Z' },
        { id: 'e5da4f5c', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
        { id: '24e30221', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.730Z' },
        { id: '6ed5ab6f', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T16:14:35.445Z' },
        { id: '639f1649', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T16:14:35.469Z' },
        { id: 'f5209b52', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T16:29:35.443Z' },
        { id: '66b07203', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T16:59:35.446Z' },
        { id: 'd3541820', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T16:59:35.464Z' },
        { id: 'e3c1eb25', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T17:44:35.447Z' },
        { id: 'bc7ecd62', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T17:44:35.466Z' },
        { id: '36f252fa', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.746Z' },
        { id: 'a0c34b4c', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T18:29:35.450Z' },
        { id: '51e19e00', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T18:29:35.465Z' },
        { id: '4169edd5', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T18:59:35.452Z' },
        { id: '283cf3c1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T19:14:35.452Z' },
        { id: '563b3d9b', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T21:59:35.460Z' },
        { id: '148593a6', status: 'completed', resolution: 'marker_detected', completed_at: '2026-03-25T00:45:55.328Z' },
        { id: '4832c7cf', status: 'completed', resolution: 'marker_detected', completed_at: '2026-03-25T21:20:27.839Z' },
      ];
      const result = evaluatePhase3Inputs(productionQueue);
      const rejectedTaskIds = result.evolution.rejected.map((r) => r.taskId);
      expect(rejectedTaskIds).toContain('1afdd4bb');
      expect(rejectedTaskIds).toContain('1a04aebb');
      expect(rejectedTaskIds).toContain('91947ddb');
      expect(rejectedTaskIds).toContain('6a7c7c48');
      const referenceOnlyTaskIds = result.evolution.referenceOnly.map((r) => r.taskId);
      expect(referenceOnlyTaskIds).toContain('e5da4f5c');
      expect(referenceOnlyTaskIds).toContain('24e30221');
      const eligibleTaskIds = result.evolution.eligible.map((e) => e.taskId);
      expect(eligibleTaskIds).toContain('148593a6');
      expect(eligibleTaskIds).toContain('4832c7cf');
      expect(result.queueTruthReady).toBe(false);
      expect(result.phase3ShadowEligible).toBe(false);
    });

    it('accumulates multiple rejection reasons', () => {
      const result = evaluatePhase3Inputs([
        { id: 'multi-issue-task', status: 'completed', completed_at: 'not-a-timestamp' },
      ]);
      expect(result.evolution.rejected).toHaveLength(1);
      const rejection = result.evolution.rejected[0];
      expect(rejection.reasons).toEqual(
        expect.arrayContaining(['invalid_completed_at', 'missing_completed_at'])
      );
      expect(rejection.reasons.length).toBe(2);
    });
  });

  describe('Three-Lane Phase 3 Input Classification', () => {
    it('classifies timeout-only outcomes as reference_only', () => {
      const result = evaluatePhase3Inputs([
        { id: 'timeout-task', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);
      expect(result.evolution.referenceOnly).toBeDefined();
      expect(result.evolution.referenceOnly.length).toBeGreaterThan(0);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-task');
      expect(result.evolution.referenceOnly[0].classification).toBe('timeout_only');
    });

    it('keeps legacy queue statuses in rejected', () => {
      const result = evaluatePhase3Inputs([
        { id: 'legacy-task', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z' },
      ]);
      expect(result.evolution.rejected.length).toBeGreaterThan(0);
      expect(result.evolution.rejected[0].reasons).toContain('legacy_queue_status');
      const referenceTaskIds = result.evolution.referenceOnly.map((r) => r.taskId);
      expect(referenceTaskIds).not.toContain('legacy-task');
    });

    it('keeps invalid queue rows in rejected', () => {
      const result = evaluatePhase3Inputs([
        { id: 'null-status-task', status: null },
        { status: 'pending' },
      ]);
      expect(result.evolution.rejected.length).toBe(2);
      const rejectedIds = result.evolution.rejected.map((r) => r.taskId);
      expect(rejectedIds).toContain('null-status-task');
      expect(rejectedIds).toContain(null);
    });

    it('separates eligible, referenceOnly, and rejected', () => {
      const result = evaluatePhase3Inputs([
        { id: 'valid-1', status: 'pending' },
        { id: 'valid-2', status: 'completed', completed_at: '2026-03-24T15:29:39.710Z' },
        { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
        { id: 'legacy-1', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z' },
        { id: 'null-1', status: null },
      ]);
      expect(result.evolution.eligible.length).toBe(2);
      const eligibleIds = result.evolution.eligible.map((e) => e.taskId);
      expect(eligibleIds).toContain('valid-1');
      expect(eligibleIds).toContain('valid-2');
      expect(result.evolution.referenceOnly.length).toBe(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-1');
      expect(result.evolution.rejected.length).toBe(2);
      const rejectedIds = result.evolution.rejected.map((r) => r.taskId);
      expect(rejectedIds).toContain('legacy-1');
      expect(rejectedIds).toContain('null-1');
    });
  });
});
