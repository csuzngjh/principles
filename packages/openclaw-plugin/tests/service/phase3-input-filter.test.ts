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
});
