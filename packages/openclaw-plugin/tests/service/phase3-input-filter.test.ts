import { describe, expect, it } from 'vitest';
import { evaluatePhase3Inputs } from '../../src/service/phase3-input-filter.js';

describe('evaluatePhase3Inputs', () => {
  it('rejects an empty queue even when trust input is otherwise ready', () => {
    const result = evaluatePhase3Inputs([], {
      score: 85,
      frozen: true,
      lastUpdated: '2026-03-20T10:00:00Z',
    });

    expect(result.queueTruthReady).toBe(false);
    expect(result.trustInputReady).toBe(true);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.eligible).toHaveLength(0);
    expect(result.evolution.rejected).toHaveLength(0);
  });

  it('marks clean queue and frozen trust inputs as phase-3 eligible', () => {
    const result = evaluatePhase3Inputs(
      [
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'in_progress', started_at: '2026-03-20T10:00:00Z' },
        { id: 'task-3', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
      ],
      { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
    );

    expect(result.queueTruthReady).toBe(true);
    expect(result.trustInputReady).toBe(true);
    expect(result.phase3ShadowEligible).toBe(true);
    expect(result.evolution.eligible).toHaveLength(3);
    expect(result.evolution.rejected).toHaveLength(0);
    expect(result.trust.rejectedReasons).toHaveLength(0);
  });

  it('rejects dirty queue lifecycle rows and unfrozen trust inputs', () => {
    const result = evaluatePhase3Inputs(
      [
        { id: 'task-1', status: 'in_progress' },
        { id: 'task-1', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
        { id: 'task-3', status: 'completed' },
      ],
      { score: null, frozen: false, lastUpdated: '2026-03-20T10:00:00Z' }
    );

    expect(result.queueTruthReady).toBe(false);
    expect(result.trustInputReady).toBe(false);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.rejected.map((entry) => entry.reasons)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['reused_task_id']),
        expect.arrayContaining(['missing_started_at']),
        expect.arrayContaining(['missing_completed_at']),
      ])
    );
    expect(result.trust.rejectedReasons).toEqual(
      expect.arrayContaining([
        'legacy_or_unfrozen_trust_schema',
        'missing_trust_score',
      ])
    );
  });

  it('rejects invalid statuses and malformed lifecycle timestamps', () => {
    const result = evaluatePhase3Inputs(
      [
        { id: 'task-1', status: 'paused', started_at: 'not-a-date' },
        { id: 'task-2', status: 'completed', completed_at: 'still-not-a-date' },
      ],
      { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
    );

    expect(result.queueTruthReady).toBe(false);
    expect(result.phase3ShadowEligible).toBe(false);
    expect(result.evolution.rejected.map((entry) => entry.reasons)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['legacy_queue_status', 'invalid_started_at']),
        expect.arrayContaining(['invalid_completed_at', 'missing_completed_at']),
      ])
    );
  });

  // Task 1: Legacy Queue Status Rejection Tests
  describe('Legacy Queue Status Rejection', () => {
    it('rejects legacy resolved status from production sample', () => {
      const result = evaluatePhase3Inputs(
        [{ id: '1afdd4bb', status: 'resolved', started_at: '2026-03-24T15:29:39.710Z', completed_at: '2026-03-24T15:29:39.710Z' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('legacy_queue_status');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects null status rows', () => {
      const result = evaluatePhase3Inputs(
        [{ id: '6a7c7c48', status: null, started_at: '2026-03-24T15:29:39.710Z' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_status');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects invalid status values like paused and cancelled', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'task-1', status: 'paused' },
          { id: 'task-2', status: 'cancelled' }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.evolution.rejected.map(r => r.reasons)).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['legacy_queue_status']),
          expect.arrayContaining(['legacy_queue_status'])
        ])
      );
    });

    it('detects reused task IDs', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'task-1', status: 'pending' },
          { id: 'task-1', status: 'completed', completed_at: '2026-03-24T15:29:39.710Z' }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.evolution.rejected[0].reasons).toContain('reused_task_id');
      expect(result.evolution.rejected[1].reasons).toContain('reused_task_id');
    });

    it('rejects in_progress tasks without started_at timestamp', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'in_progress' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_started_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects completed tasks without completed_at timestamp', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'completed', started_at: '2026-03-24T15:29:39.710Z' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('missing_completed_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('rejects malformed timestamps', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'in_progress', started_at: 'not-a-timestamp' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('invalid_started_at');
      expect(result.queueTruthReady).toBe(false);
    });

    it('handles mixed valid and invalid queue entries', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'task-1', status: 'pending' },
          { id: 'task-2', status: 'resolved' },
          { id: 'task-3', status: 'in_progress', started_at: '2026-03-24T15:29:39.710Z' },
          { id: 'task-4', status: null }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.eligible).toHaveLength(2); // task-1 and task-3
      expect(result.evolution.rejected).toHaveLength(2); // task-2 and task-4
      expect(result.queueTruthReady).toBe(false); // Not all entries are valid
    });
  });

  // Task 3: Timeout-Only Outcome Filtering Tests
  describe('Timeout-Only Outcome Filtering', () => {
    it('rejects tasks with only timeout outcomes', () => {
      const result = evaluatePhase3Inputs(
        [{
          id: 'e5da4f5c',
          status: 'completed',
          resolution: 'auto_completed_timeout',
          completed_at: '2026-03-24T15:29:39.710Z'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].reasons).toContain('timeout_only_outcome');
      expect(result.queueTruthReady).toBe(false);
    });

    it('allows tasks with mixed outcomes (timeout + success)', () => {
      const result = evaluatePhase3Inputs(
        [{
          id: 'task-mixed',
          status: 'completed',
          completed_at: '2026-03-24T15:29:39.710Z'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.eligible).toHaveLength(1);
      expect(result.evolution.rejected).toHaveLength(0);
      expect(result.queueTruthReady).toBe(true);
    });

    it('allows tasks with successful completion markers', () => {
      const result = evaluatePhase3Inputs(
        [{
          id: 'task-success',
          status: 'completed',
          resolution: 'marker_detected',
          completed_at: '2026-03-24T15:29:39.710Z'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.eligible).toHaveLength(1);
      expect(result.evolution.rejected).toHaveLength(0);
    });

    it('rejects multiple timeout-only tasks correctly', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
          { id: 'timeout-2', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:30:39.710Z' }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.rejected).toHaveLength(2);
      expect(result.evolution.rejected.every(r => r.reasons.includes('timeout_only_outcome'))).toBe(true);
      expect(result.queueTruthReady).toBe(false);
    });

    it('allows mix of timeout-only and valid tasks', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
          { id: 'valid-1', status: 'completed', completed_at: '2026-03-24T15:30:39.710Z' }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.evolution.eligible).toHaveLength(1);
      expect(result.evolution.eligible[0].taskId).toBe('valid-1');
      expect(result.evolution.rejected).toHaveLength(1);
      expect(result.evolution.rejected[0].taskId).toBe('timeout-1');
      expect(result.queueTruthReady).toBe(false);
    });
  });

  // Task 6: Trust Input Validation Tests
  describe('Trust Input Validation', () => {
    it('accepts frozen trust with valid score', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(true);
      expect(result.trust.rejectedReasons).toHaveLength(0);
    });

    it('rejects unfrozen trust schema', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 85, frozen: false, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
    });

    it('rejects null frozen value', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 85, frozen: null, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
    });

    it('rejects missing trust score', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: null, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('missing_trust_score');
    });

    it('rejects NaN trust score', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: NaN, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('missing_trust_score');
    });

    it('rejects Infinity trust score', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: Infinity, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('missing_trust_score');
    });

    it('accepts zero trust score', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 0, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(true);
      expect(result.trust.rejectedReasons).toHaveLength(0);
    });

    it('handles both unfrozen and missing score as rejection reasons', () => {
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: null, frozen: false, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toEqual(
        expect.arrayContaining([
          'legacy_or_unfrozen_trust_schema',
          'missing_trust_score'
        ])
      );
    });
  });

  // Task 5: Production Sample Integration Test
  describe('Production Sample Integration', () => {
    it('handles production sample from spicy_evolver_souls correctly', () => {
      // Production context:
      // - Queue contains 3 legacy 'resolved' status rows (1afdd4bb, 1a04aebb, 91947ddb)
      // - Queue contains 1 null status row (6a7c7c48)
      // - Queue contains many timeout-only outcomes (resolution: 'auto_completed_timeout')
      // - Trust schema is NOT frozen (frozen: false)
      const productionQueue = [
        // Legacy resolved status rows (should be rejected)
        { id: '1afdd4bb', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z', completed_at: '2026-03-22T03:25:00.000Z' },
        { id: '1a04aebb', status: 'resolved', started_at: '2026-03-22T02:45:55.013Z', completed_at: '2026-03-22T03:25:00.000Z' },
        { id: '91947ddb', status: 'resolved', started_at: '2026-03-22T03:00:55.012Z', completed_at: '2026-03-22T03:25:00.000Z' },
        // Null status row (should be rejected)
        { id: '6a7c7c48', started_at: '2026-03-23T08:26:52.048Z' },
        // Timeout-only outcomes (should be excluded from positive evidence)
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
        // Valid completions with marker_detected (should be eligible)
        { id: '148593a6', status: 'completed', resolution: 'marker_detected', completed_at: '2026-03-25T00:45:55.328Z' },
        { id: '4832c7cf', status: 'completed', resolution: 'marker_detected', completed_at: '2026-03-25T21:20:27.839Z' },
      ];

      const productionTrust = {
        score: 200,
        frozen: false, // UNFROZEN - should be rejected
        lastUpdated: '2026-03-24T05:44:25.254Z'
      };

      const result = evaluatePhase3Inputs(productionQueue, productionTrust);

      // Verify legacy status rejections
      const rejectedTaskIds = result.evolution.rejected.map(r => r.taskId);
      expect(rejectedTaskIds).toContain('1afdd4bb'); // resolved status
      expect(rejectedTaskIds).toContain('1a04aebb'); // resolved status
      expect(rejectedTaskIds).toContain('91947ddb'); // resolved status

      // Verify null/missing status rejection
      expect(rejectedTaskIds).toContain('6a7c7c48');
      const missingStatusReject = result.evolution.rejected.find(r => r.taskId === '6a7c7c48');
      // Task 6a7c7c48 has no status field (undefined), so it gets 'invalid_status'
      expect(missingStatusReject?.reasons).toContain('invalid_status');

      // Verify timeout-only outcome exclusions
      const timeoutOnlyRejected = result.evolution.rejected.filter(r =>
        r.reasons.includes('timeout_only_outcome')
      );
      expect(timeoutOnlyRejected.length).toBeGreaterThan(0);
      expect(timeoutOnlyRejected.map(r => r.taskId)).toContain('e5da4f5c');
      expect(timeoutOnlyRejected.map(r => r.taskId)).toContain('24e30221');

      // Verify trust rejection
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');

      // Verify valid samples are eligible
      const eligibleTaskIds = result.evolution.eligible.map(e => e.taskId);
      expect(eligibleTaskIds).toContain('148593a6');
      expect(eligibleTaskIds).toContain('4832c7cf');

      // Verify overall eligibility is FALSE (queue has rejections + trust not ready)
      expect(result.queueTruthReady).toBe(false);
      expect(result.trustInputReady).toBe(false);
      expect(result.phase3ShadowEligible).toBe(false);
    });

    it('correctly accumulates multiple rejection reasons for single task', () => {
      // Test task with multiple issues: timeout + invalid timestamps
      const result = evaluatePhase3Inputs(
        [{
          id: 'multi-issue-task',
          status: 'completed',
          resolution: 'auto_completed_timeout',
          completed_at: 'not-a-timestamp'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      expect(result.evolution.rejected).toHaveLength(1);
      const rejection = result.evolution.rejected[0];
      expect(rejection.reasons).toEqual(
        expect.arrayContaining([
          'timeout_only_outcome',
          'invalid_completed_at',
          'missing_completed_at'
        ])
      );
      expect(rejection.reasons.length).toBe(3); // Deduplicated
    });
  });
});
