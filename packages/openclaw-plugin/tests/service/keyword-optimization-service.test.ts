import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CorrectionObserverResult } from '@principles/core/runtime-v2';

// Shared mock objects so tests can mutate them after vi.mock runs
const mockLearner = { add: vi.fn(() => null), updateWeight: vi.fn(() => true), remove: vi.fn(() => true), recordFalsePositive: vi.fn(() => true), recordTruePositive: vi.fn(() => true), find: vi.fn(() => undefined), getStore: vi.fn(() => ({ keywords: [] })) };
const mockDb = { listUserTurnsForSession: vi.fn(() => []), listRecentSessions: vi.fn(() => []) };

// Mock the CorrectionCueLearner dependency
vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: { get: vi.fn(() => mockLearner) },
}));

// Mock the trajectory dependency — return shared mock objects so tests can configure them
vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: { get: vi.fn(() => mockDb) },
}));

// Store mutations are Owner-visible audit events; assert them instead of writing files
const mockSystemLog = vi.fn();
vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: (...args: unknown[]) => mockSystemLog(...args) },
}));

import { KeywordOptimizationService } from '../../src/service/keyword-optimization-service.js';

describe('KeywordOptimizationService', () => {
  let service: KeywordOptimizationService;

  beforeEach(() => {
    vi.clearAllMocks();
    KeywordOptimizationService.reset();
    mockLearner.add.mockReturnValue(null);
    mockLearner.updateWeight.mockReturnValue(true);
    mockLearner.remove.mockReturnValue(true);
    mockLearner.recordFalsePositive.mockReturnValue(true);
    mockLearner.find.mockReturnValue(undefined);
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
      mockLearner.find.mockReturnValue({ term: 'existing-term', weight: 0.5, source: 'llm', addedAt: 'x' });
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 0.85, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('existing-term', 0.85);
    });

    it('REMOVE: calls learner.remove() with term', () => {
      mockLearner.find.mockReturnValue({ term: 'old-term', weight: 0.5, source: 'llm', addedAt: 'x' });
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
      mockLearner.find.mockReturnValue({ term: 'another-term', weight: 0.5, source: 'llm', addedAt: 'x' });
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

    it('PRI-812 safety: recordFalsePositive throwing does not block remaining terms (rc-9)', () => {
      mockLearner.recordFalsePositive.mockImplementation((term: string) => {
        if (term === 'bad-term') throw new Error('store flush failed');
      });
      const result: CorrectionObserverResult = {
        updated: false,
        updates: {},
        fpTerms: ['bad-term', 'good-term'],
        fpAnalysisStatus: 'completed',
        summary: 'one term fails, the batch must continue',
      } as any;
      expect(() => service.applyResult(result)).not.toThrow();
      // 两条都被尝试：失败条目只告警，不中断循环
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledTimes(2);
      expect(mockLearner.recordFalsePositive).toHaveBeenCalledWith('good-term');
    });

    it('safety: a throwing store mutation is logged and skipped, batch continues', () => {
      mockLearner.find.mockImplementation((term: string) =>
        term === 'ghost-term' ? { term: 'ghost-term', weight: 0.5, source: 'llm', addedAt: 'x' } : undefined
      );
      mockLearner.remove.mockImplementation(() => {
        throw new Error('keyword not found');
      });
      const result: CorrectionObserverResult = {
        updated: true,
        updates: {
          'ghost-term': { action: 'remove', reasoning: 'stale entry' },
          'other-term': { action: 'add', weight: 0.5, reasoning: 'new pattern' },
        },
        summary: 'first op fails, second still applied',
      } as any;
      expect(() => service.applyResult(result)).not.toThrow();
      expect(mockLearner.remove).toHaveBeenCalledWith('ghost-term');
      expect(mockLearner.add).toHaveBeenCalledWith({ term: 'other-term', weight: 0.5, source: 'llm' });
    });
  });

  describe('updateWeight() clamp behavior', () => {
    it('clamps weight to 0.1-0.9 range via CorrectionCueLearner', () => {
      mockLearner.find.mockReturnValue({ term: 'existing-term', weight: 0.5, source: 'llm', addedAt: 'x' });
      const result: CorrectionObserverResult = {
        updated: true,
        updates: { 'existing-term': { action: 'update', weight: 1.5, reasoning: 'test' } },
      } as any;
      service.applyResult(result);
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('existing-term', 1.5);
    });
  });

  describe('term key resolution (store-identity symmetry)', () => {
    // 生产实况：优化器回吐的 key 带空白/大小写差异，ADD 归一化而 UPDATE/REMOVE
    // 直接用原串，于是天天刷 "Keyword not found"。三者必须走同一条身份规则。
    it('normalizes UPDATE/REMOVE keys with the same trim+lowercase rule as ADD', () => {
      const stored = { term: '搞错了', weight: 0.5, source: 'llm', addedAt: 'x' };
      mockLearner.find.mockReturnValue(stored);
      const result: CorrectionObserverResult = {
        updated: true,
        updates: {
          '  搞错了 ': { action: 'update', weight: 0.7, reasoning: 'r' },
          '搞错了': { action: 'remove', reasoning: 'r' },
        },
      } as any;
      service.applyResult(result);
      expect(mockLearner.find).toHaveBeenCalledWith('搞错了');
      expect(mockLearner.updateWeight).toHaveBeenCalledWith('搞错了', 0.7);
      expect(mockLearner.remove).toHaveBeenCalledWith('搞错了');
    });

    it('skips UPDATE/REMOVE for a term that is not in the store, without calling the learner', () => {
      mockLearner.find.mockReturnValue(undefined);
      const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
      // 直接构造：单例 get() 仍返回 beforeEach 建好的实例，其 logger 不是这里要断言的
      const svc = new KeywordOptimizationService('/tmp/test-state', '/tmp/test-state', logger);
      svc.applyResult({
        updated: true,
        updates: { '优化来优化去': { action: 'remove', reasoning: 'paraphrase' } },
      } as any);
      expect(mockLearner.remove).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('REMOVE skipped for term="优化来优化去": not in store'),
      );
    });

    it('rejects an updates key that is blank or an action word instead of storing it', () => {
      const result: CorrectionObserverResult = {
        updated: true,
        updates: {
          'add': { action: 'remove', reasoning: 'key slot misused' },
          '   ': { action: 'add', weight: 0.5, reasoning: 'no term' },
        },
      } as any;
      service.applyResult(result);
      expect(mockLearner.add).not.toHaveBeenCalled();
      expect(mockLearner.remove).not.toHaveBeenCalled();
    });

    it('refuses to REMOVE a seed term — Owner-authored cues are not learning-reachable', () => {
      mockLearner.find.mockReturnValue({ term: '搞错了', weight: 0.9, source: 'seed', addedAt: 'x' });
      service.applyResult({
        updated: true,
        updates: { '搞错了': { action: 'remove', reasoning: 'llm decided' } },
      } as any);
      expect(mockLearner.remove).not.toHaveBeenCalled();
    });

    it('refuses to REMOVE a user-promoted term too', () => {
      mockLearner.find.mockReturnValue({ term: '又错了', weight: 0.9, source: 'user', addedAt: 'x' });
      service.applyResult({
        updated: true,
        updates: { '又错了': { action: 'remove', reasoning: 'llm decided' } },
      } as any);
      expect(mockLearner.remove).not.toHaveBeenCalled();
    });

    it('refuses to ADD a joined multi-term cue as if it were one term', () => {
      mockLearner.find.mockReturnValue(undefined);
      const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
      const svc = new KeywordOptimizationService('/tmp/test-state', '/tmp/test-state', logger);
      svc.applyResult({
        updated: true,
        updates: { '又错了, 改回去': { action: 'add', weight: 0.6, reasoning: 'r' } },
      } as any);
      expect(mockLearner.add).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('joined cue of several terms, not one learnable term'),
      );
    });

    it('surfaces cap eviction in the mutation audit instead of freezing learning', () => {
      mockLearner.add.mockReturnValue('老的垃圾词');
      service.applyResult({
        updated: true,
        updates: { '新词': { action: 'add', weight: 0.6, reasoning: 'r' } },
      } as any);
      expect(mockSystemLog).toHaveBeenCalledWith(
        '/tmp/test-state',
        'KEYWORD_LEARNING',
        expect.stringContaining('evicted="老的垃圾词" (store at cap)'),
      );
    });

    it('audits every applied mutation to the SYSTEM log (Owner-visible trail)', () => {
      service.applyResult({
        updated: true,
        updates: { '新词': { action: 'add', weight: 0.6, reasoning: 'r' } },
      } as any);
      expect(mockSystemLog).toHaveBeenCalledWith(
        '/tmp/test-state', 'KEYWORD_LEARNING', 'ADD term="新词" weight=0.6',
      );
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

    it('PRI-823: carries the bounded raw excerpt on each hit event (FP counter-evidence)', async () => {
      mockDb.listUserTurnsForSession = vi.fn(() => [
        { id: 1, turnIndex: 0, rawExcerpt: 'User said wrong input', correctionDetected: true, correctionCue: 'wrong', createdAt: '2024-01-01T00:01:00Z' },
        { id: 2, turnIndex: 1, rawExcerpt: '', correctionDetected: true, correctionCue: 'error', createdAt: '2024-01-01T00:02:00Z' },
      ] as any);

      const history = await service.buildTrajectoryHistory(['session-1']);

      expect(history).toHaveLength(2);
      // 每个命中事件自带摘录文本——观察员可逐事件判定误报，而非只看 term
      expect(history[0].userMessage).toBe('User said wrong input');
      // 摘录缺失时回退为空串（不产生 undefined，schema 要求 string）
      expect(history[1].userMessage).toBe('');
    });

    it('does not hand Stage2 verdict prose to the optimizer as a term', async () => {
      mockDb.listUserTurnsForSession = vi.fn(() => [
        { id: 1, turnIndex: 0, rawExcerpt: '你到底改了什么', correctionDetected: true, correctionCue: 'llm:用户质疑改动无据', createdAt: '2024-01-01T00:01:00Z' },
        { id: 2, turnIndex: 1, rawExcerpt: '这里搞错了', correctionDetected: true, correctionCue: '搞错了', createdAt: '2024-01-01T00:02:00Z' },
      ] as any);

      const history = await service.buildTrajectoryHistory(['session-1']);

      // 判词行没有命中词 ⇒ term 必须是空串（渲染成 "(none matched)"），
      // 否则散文会作为"关键词"被优化器原样入库——词库涨满的实际来源。
      expect(history[0].term).toBe('');
      expect(history[1].term).toBe('搞错了');
    });

    it('splits a multi-term cue into one event per term', async () => {
      mockDb.listUserTurnsForSession = vi.fn(() => [
        { id: 1, turnIndex: 0, rawExcerpt: '又错了，改回去', correctionDetected: true, correctionCue: '又错了, 改回去', createdAt: '2024-01-01T00:01:00Z' },
      ] as any);

      const history = await service.buildTrajectoryHistory(['session-1']);

      // Stage1 joins every matched term with ", ". Handing that joined string
      // to the optimizer as one "term" is how a composite that can never match
      // again gets proposed for ADD — the observer must see the real terms.
      expect(history.map((h) => h.term)).toEqual(['又错了', '改回去']);
      expect(history[0]?.userMessage).toBe('又错了，改回去');
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
