import { describe, expect, it } from 'vitest';
import { evaluatePhase3Inputs } from '../../src/service/phase3-input-filter.js';

describe('evaluatePhase3Inputs', () => {
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
        expect.arrayContaining(['invalid_status', 'invalid_started_at']),
        expect.arrayContaining(['invalid_completed_at', 'missing_completed_at']),
      ])
    );
  });
});
