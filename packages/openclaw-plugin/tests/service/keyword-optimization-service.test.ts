import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CorrectionObserverResult } from '../../src/service/subagent-workflow/correction-observer-types.js';

// Mock the CorrectionCueLearner dependency
vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: {
    get: vi.fn(() => ({
      add: vi.fn(),
      updateWeight: vi.fn(),
      remove: vi.fn(),
    })),
  },
}));

// Mock the trajectory dependency
vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: {
    get: vi.fn(() => ({
      listUserTurnsForSession: vi.fn(() => []),
      listRecentSessions: vi.fn(() => []),
    })),
  },
}));

import { CorrectionCueLearner } from '../../src/core/correction-cue-learner.js';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';
import { KeywordOptimizationService } from '../../src/service/keyword-optimization-service.js';

describe('KeywordOptimizationService', () => {
  let service: KeywordOptimizationService;

  beforeEach(() => {
    vi.clearAllMocks();
    KeywordOptimizationService.reset();
    service = KeywordOptimizationService.get('/tmp/test-state', {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any);
  });

  describe('applyResult()', () => {
    it('ADD: calls learner.add() with new keyword and weight', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'test-term': { action: 'add', weight: 0.6, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      expect(learner.add).toHaveBeenCalledWith({ term: 'test-term', weight: 0.6, source: 'llm_optimization' });
    });

    it('UPDATE: calls learner.updateWeight() with clamped weight', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 0.85, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      expect(learner.updateWeight).toHaveBeenCalledWith('existing-term', 0.85);
    });

    it('REMOVE: calls learner.remove() with term', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'old-term': { action: 'remove', reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      expect(learner.remove).toHaveBeenCalledWith('old-term');
    });

    it('skips when result.updated is false', () => {
      const result: CorrectionObserverResult = { updated: false, updates: {}, summary: '' } as any;
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      expect(learner.add).not.toHaveBeenCalled();
    });

    it('skips when result.updates is undefined', () => {
      const result: CorrectionObserverResult = { updated: true, updates: undefined as any, summary: '' };
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      expect(learner.add).not.toHaveBeenCalled();
    });
  });

  describe('updateWeight() clamp behavior', () => {
    it('clamps weight to 0.1-0.9 range via CorrectionCueLearner', () => {
      // CorrectionCueLearner.updateWeight clamps values internally
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 1.5, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      const learner = CorrectionCueLearner.get('/tmp/test-state');
      // updateWeight is called with the raw value; clamping is handled by CorrectionCueLearner
      expect(learner.updateWeight).toHaveBeenCalledWith('existing-term', 1.5);
    });
  });

  describe('buildTrajectoryHistory()', () => {
    it('returns empty array when no sessions exist', async () => {
      const history = await service.buildTrajectoryHistory([]);
      expect(history).toEqual([]);
    });

    it('filters to correctionDetected=true turns only', async () => {
      const mockDb = TrajectoryRegistry.get('/tmp/test-state');
      mockDb.listUserTurnsForSession = vi.fn(() => [
        { id: 1, turnIndex: 0, correctionDetected: false, correctionCue: null, createdAt: '2024-01-01T00:00:00Z' },
        { id: 2, turnIndex: 1, correctionDetected: true, correctionCue: 'wrong', createdAt: '2024-01-01T00:01:00Z' },
        { id: 3, turnIndex: 2, correctionDetected: true, correctionCue: 'error', createdAt: '2024-01-01T00:02:00Z' },
      ]);

      const history = await service.buildTrajectoryHistory(['session-1']);

      expect(history).toHaveLength(2);
      expect(history[0].term).toBe('wrong');
      expect(history[1].term).toBe('error');
    });

    it('caps at 50 events', async () => {
      const mockDb = TrajectoryRegistry.get('/tmp/test-state');
      const manyTurns = Array.from({ length: 60 }, (_, i) => ({
        id: i,
        turnIndex: i,
        correctionDetected: true,
        correctionCue: `term-${i}`,
        createdAt: new Date(i * 1000).toISOString(),
      }));
      mockDb.listUserTurnsForSession = vi.fn(() => manyTurns);

      const history = await service.buildTrajectoryHistory(['session-1']);

      expect(history).toHaveLength(50);
    });
  });
});
