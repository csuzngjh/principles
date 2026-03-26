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
    it('classifies timeout-only outcomes as reference_only (not rejected)', () => {
      const result = evaluatePhase3Inputs(
        [{
          id: 'e5da4f5c',
          status: 'completed',
          resolution: 'auto_completed_timeout',
          completed_at: '2026-03-24T15:29:39.710Z'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      // Timeout-only outcomes go to referenceOnly, NOT rejected
      expect(result.evolution.referenceOnly).toHaveLength(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('e5da4f5c');
      expect(result.evolution.referenceOnly[0].classification).toBe('timeout_only');
      // They should NOT be in rejected
      expect(result.evolution.rejected).toHaveLength(0);
      // Queue is still "ready" because timeout outcomes are valid data
      // (just not positive evidence for capability)
      expect(result.queueTruthReady).toBe(true);
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

    it('rejects multiple timeout-only tasks to referenceOnly', () => {
      const result = evaluatePhase3Inputs(
        [
          { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
          { id: 'timeout-2', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:30:39.710Z' }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );
      // Both go to referenceOnly
      expect(result.evolution.referenceOnly).toHaveLength(2);
      expect(result.evolution.referenceOnly.every(r => r.classification === 'timeout_only')).toBe(true);
      // None in rejected
      expect(result.evolution.rejected).toHaveLength(0);
      // Queue is ready because no invalid data
      expect(result.queueTruthReady).toBe(true);
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
      // Timeout goes to referenceOnly, not rejected
      expect(result.evolution.referenceOnly).toHaveLength(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-1');
      expect(result.evolution.rejected).toHaveLength(0);
      // Queue is ready because all data is valid
      expect(result.queueTruthReady).toBe(true);
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

      // Verify timeout-only outcomes are in referenceOnly (not rejected)
      const referenceOnlyTaskIds = result.evolution.referenceOnly.map(r => r.taskId);
      expect(referenceOnlyTaskIds).toContain('e5da4f5c');
      expect(referenceOnlyTaskIds).toContain('24e30221');
      // All referenceOnly items should have timeout_only classification
      const timeoutOnlyReference = result.evolution.referenceOnly.filter(r =>
        r.classification === 'timeout_only'
      );
      expect(timeoutOnlyReference.length).toBeGreaterThan(0);

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
      // Test task with multiple issues: invalid timestamps (not timeout - that goes to referenceOnly)
      const result = evaluatePhase3Inputs(
        [{
          id: 'multi-issue-task',
          status: 'completed',
          completed_at: 'not-a-timestamp'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      expect(result.evolution.rejected).toHaveLength(1);
      const rejection = result.evolution.rejected[0];
      expect(rejection.reasons).toEqual(
        expect.arrayContaining([
          'invalid_completed_at',
          'missing_completed_at'
        ])
      );
      expect(rejection.reasons.length).toBe(2); // Deduplicated
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Task 2: Three-Lane Phase 3 Input Classification Tests
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Three-Lane Phase 3 Input Classification', () => {
    /**
     * PURPOSE: Prove that Phase 3 inputs support three distinct lanes:
     * - authoritative: Valid Phase 3 inputs (can be used for eligibility)
     * - reference_only: Useful evidence that must NOT be used as positive eligibility input
     * - rejected: Invalid, corrupt, or policy-prohibited input
     */

    it('classifies timeout-only outcomes as reference_only (not rejected)', () => {
      // Timeout-only outcomes are valid completed tasks, but they shouldn't
      // count as positive evidence for capability assessment.
      // They belong in reference_only, NOT rejected.
      const result = evaluatePhase3Inputs(
        [{
          id: 'timeout-task',
          status: 'completed',
          resolution: 'auto_completed_timeout',
          completed_at: '2026-03-24T15:29:39.710Z'
        }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      // CURRENT BEHAVIOR (BUG): timeout_only_outcome is in rejected
      // EXPECTED: timeout_only_outcome should be in referenceOnly
      expect(result.evolution.referenceOnly).toBeDefined();
      expect(result.evolution.referenceOnly.length).toBeGreaterThan(0);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-task');
      expect(result.evolution.referenceOnly[0].classification).toBe('timeout_only');
    });

    it('keeps legacy queue statuses in rejected (not reference_only)', () => {
      // Legacy statuses like 'resolved', 'paused' are truly invalid for Phase 3.
      // They should be in rejected, NOT reference_only.
      const result = evaluatePhase3Inputs(
        [{ id: 'legacy-task', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      // Legacy status should remain in rejected
      expect(result.evolution.rejected.length).toBeGreaterThan(0);
      expect(result.evolution.rejected[0].reasons).toContain('legacy_queue_status');
      
      // Legacy status should NOT be in referenceOnly
      const referenceTaskIds = (result.evolution.referenceOnly || []).map(r => r.taskId);
      expect(referenceTaskIds).not.toContain('legacy-task');
    });

    it('keeps invalid queue rows (null status, missing task ID) in rejected', () => {
      // Corrupt data should always be rejected.
      const result = evaluatePhase3Inputs(
        [
          { id: 'null-status-task', status: null },
          { status: 'pending' } // Missing ID
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      expect(result.evolution.rejected.length).toBe(2);
      const rejectedIds = result.evolution.rejected.map(r => r.taskId);
      expect(rejectedIds).toContain('null-status-task');
      expect(rejectedIds).toContain(null);
    });

    it('classifies unfrozen trust as rejected (not unknown or authoritative)', () => {
      // Unfrozen trust schema means the trust data is not in the expected format.
      // This should be rejected, not treated as unknown=0.
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 85, frozen: false, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      // Trust should be rejected
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
      
      // Trust classification should explicitly show 'rejected'
      expect(result.trust.classification).toBe('rejected');
    });

    it('classifies missing trust score as unknown (not authoritative 0)', () => {
      // Missing trust score should be 'unknown', NOT silently converted to 0.
      // This prevents the system from making decisions based on fake data.
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: null, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      // Trust should show classification as 'unknown'
      expect(result.trust.classification).toBe('unknown');
      expect(result.trust.eligible).toBe(false);
      expect(result.trust.rejectedReasons).toContain('missing_trust_score');
    });

    it('classifies valid frozen trust as authoritative', () => {
      // Only frozen trust with valid score is authoritative.
      const result = evaluatePhase3Inputs(
        [{ id: 'task-1', status: 'pending' }],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      expect(result.trust.classification).toBe('authoritative');
      expect(result.trust.eligible).toBe(true);
      expect(result.trust.rejectedReasons).toHaveLength(0);
    });

    it('separates eligible, referenceOnly, and rejected in evolution results', () => {
      // Test a mix of all three categories
      const result = evaluatePhase3Inputs(
        [
          // Authoritative (eligible)
          { id: 'valid-1', status: 'pending' },
          { id: 'valid-2', status: 'completed', completed_at: '2026-03-24T15:29:39.710Z' },
          // Reference only (timeout-only outcomes)
          { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
          // Rejected (legacy status)
          { id: 'legacy-1', status: 'resolved', started_at: '2026-03-22T03:15:55.012Z' },
          // Rejected (null status)
          { id: 'null-1', status: null }
        ],
        { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
      );

      // Eligible (authoritative)
      expect(result.evolution.eligible.length).toBe(2);
      const eligibleIds = result.evolution.eligible.map(e => e.taskId);
      expect(eligibleIds).toContain('valid-1');
      expect(eligibleIds).toContain('valid-2');

      // Reference only
      expect(result.evolution.referenceOnly.length).toBe(1);
      expect(result.evolution.referenceOnly[0].taskId).toBe('timeout-1');

      // Rejected
      expect(result.evolution.rejected.length).toBe(2);
      const rejectedIds = result.evolution.rejected.map(r => r.taskId);
      expect(rejectedIds).toContain('legacy-1');
      expect(rejectedIds).toContain('null-1');
    });
  });
});
