import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CorrectionObserverResult } from '@principles/core/runtime-v2';

// Shared mock objects so tests can mutate them after vi.mock runs
const mockLearner = { add: vi.fn(), updateWeight: vi.fn(), remove: vi.fn(), recordFalsePositive: vi.fn(), recordTruePositive: vi.fn(), getStore: vi.fn(() => ({ keywords: [] })) };
const mockDb = { listUserTurnsForSession: vi.fn(() => []), listRecentSessions: vi.fn(() => []) };

// Mock the CorrectionCueLearner dependency
vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: { get: vi.fn(() => mockLearner) },
}));

// Mock the trajectory dependency — return shared mock objects so tests can configure them
vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: { get: vi.fn(() => mockDb) },
}));

import { KeywordOptimizationService } from '../../src/service/keyword-optimization-service.js';

describe('KeywordOptimizationService', () => {
  let service: KeywordOptimizationService;

  beforeEach(() => {
    vi.clearAllMocks();
    KeywordOptimizationService.reset();
    service = KeywordOptimizationService.get('/tmp/test-state', '/tmp/test-state', {
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
      expect(mockLearner.add).toHaveBeenCalledWith({ term: 'test-term', weight: 0.6, source: 'llm' });
    });

    it('UPDATE: calls learner.updateWeight() with clamped weight', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 0.85, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('existing-term', 0.85);
    });

    it('REMOVE: calls learner.remove() with term', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'old-term': { action: 'remove', reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      expect(mockLearner.remove).toHaveBeenCalledWith('old-term');
    });

    it('skips when result.updated is false', () => {
      const result: CorrectionObserverResult = { updated: false, updates: {}, summary: '' } as any;
      service.applyResult(result);
      expect(mockLearner.add).not.toHaveBeenCalled();
    });

    it('skips when result.updates is undefined', () => {
      const result: CorrectionObserverResult = { updated: true, updates: undefined as any, summary: '' };
      service.applyResult(result);
      expect(mockLearner.add).not.toHaveBeenCalled();
    });

    // ── PRI-812 C: FP 记录独立于 store mutations（earned-high 降级闭环的入口）──
    // observer 的输出契约允许 "updated=false 但 fpTerms 非空"（只报误报、不建议
    // 增删改）。这正是 earned high 词项唯一的自动反证来源——若被 updated 门吞掉，
    // learned cue 升 high 后永远无法降级。
    it('PRI-812: records FP from an FP-only verdict (updated=false, no updates)', () => {
      const result: CorrectionObserverResult = {
        updated: false,
        updates: {},
        fpTerms: ['learned-term'],
        fpAnalysisStatus: 'completed',
        summary: 'no store mutations, but learned-term keeps firing on non-corrections',
      } as any;
      service.applyResult(result);
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledWith('learned-term');
    });

    it('PRI-812: records FP alongside store mutations (updated=true)', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'another-term': { action: 'update', weight: 0.3, reasoning: 'lower weight' } },
        fpTerms: ['learned-term'],
        fpAnalysisStatus: 'completed',
        summary: 'mixed verdict',
      } as any;
      service.applyResult(result);
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('another-term', 0.3);
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledWith('learned-term');
    });

    it('PRI-812: fpAnalysisStatus=skipped never records FPs (no verdict, no fabricated evidence)', () => {
      const result: CorrectionObserverResult = {
        updated: false,
        updates: {},
        fpTerms: ['learned-term'],
        fpAnalysisStatus: 'skipped',
        summary: 'trajectory empty, no analysis performed',
      } as any;
      service.applyResult(result);
      expect(mockLearner.recordFalsePositive).not.toHaveBeenCalled();
    });

    it('PRI-812: normalizes fpTerms (trim/lowercase/dedupe) before recording', () => {
      const result: CorrectionObserverResult = {
        updated: false,
        updates: {},
        fpTerms: ['  Learned-Term ', 'learned-term', ''],
        fpAnalysisStatus: 'completed',
        summary: 'duplicated fp entries',
      } as any;
      service.applyResult(result);
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledTimes(1);
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledWith('learned-term');
    });
  });

  describe('updateWeight() clamp behavior', () => {
    it('clamps weight to 0.1-0.9 range via CorrectionCueLearner', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 1.5, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('existing-term', 1.5);
    });
  });

  describe('buildTrajectoryHistory()', () => {
    it('returns empty array when no sessions exist', async () => {
      const history = await service.buildTrajectoryHistory([]);
      expect(history).toEqual([]);
    });

    it('filters to correctionDetected=true turns only', async () => {
      mockDb.listUserTurnsForSession = vi.fn(() => [
        { id: 1, turnIndex: 0, correctionDetected: false, correctionCue: null, createdAt: '2024-01-01T00:00:00Z' },
        { id: 2, turnIndex: 1, correctionDetected: true, correctionCue: 'wrong', createdAt: '2024-01-01T00:01:00Z' },
        { id: 3, turnIndex: 2, correctionDetected: true, correctionCue: 'error', createdAt: '2024-01-01T00:02:00Z' },
      ] as any);

      const history = await service.buildTrajectoryHistory(['session-1']);

      expect(history).toHaveLength(2);
      expect(history[0].term).toBe('wrong');
      expect(history[1].term).toBe('error');
    });

    it('caps at 50 events', async () => {
      const manyTurns = Array.from({ length: 60 }, (_, i) => ({
        id: i,
        turnIndex: i,
        correctionDetected: true,
        correctionCue: `term-${i}`,
        createdAt: new Date(i * 1000).toISOString(),
      }));
      mockDb.listUserTurnsForSession = vi.fn(() => manyTurns as any);

      const history = await service.buildTrajectoryHistory(['session-1']);

      expect(history).toHaveLength(50);
    });
  });
});
