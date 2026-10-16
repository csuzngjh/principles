import { describe, it, expect } from 'vitest';
import { CorrectionObserver } from '../correction-observer.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';

describe('CorrectionObserver', () => {
  const mockPayload = {
    parentSessionId: 'session-123',
    workspaceDir: '/test/workspace',
    keywordStoreSummary: {
      totalKeywords: 2,
      terms: [
        { term: 'wrong', weight: 0.5, truePositiveCount: 8, falsePositiveCount: 2 },
        { term: 'error', weight: 0.6, truePositiveCount: 4, falsePositiveCount: 1 },
      ],
    },
    recentMessages: ['help me', 'something is wrong here'],
    trajectoryHistory: [
      { sessionId: 'session-123', timestamp: '2026-05-30T16:00:00Z', term: 'wrong', userMessage: 'this is wrong' },
    ],
  };

  it('correctly builds prompt (role declaration moved to SYSTEM_PROMPT, PRI-633)', () => {
    const prompt = CorrectionObserver.buildPrompt(mockPayload);
    expect(prompt).not.toContain('You are a correction keyword optimizer.');
    expect(CorrectionObserver.SYSTEM_PROMPT).toBe('You are a correction keyword optimizer.');
    expect(prompt).toContain('wrong');
    expect(prompt).toContain('error');
  });

  // 生产实况：词库里 TP/FP 双双为 0 的条目占绝大多数，旧判据
  // 「FP / (TP + FP) > 0.3」对它们恒不成立 ⇒ REMOVE 永不触发，死词只进不出，
  // 200 顶满后学习通道整体冻结。判据必须能用 payload 里真实存在的证据评估。
  it('gives REMOVE a criterion that works without any TP/FP history', () => {
    const prompt = CorrectionObserver.buildPrompt(mockPayload);
    expect(prompt).toContain('TP and FP stay 0 for such a term');
    // 同时要求引用「是否再现」与「是否为整句」这两类可见证据
    expect(prompt).toContain('matches nothing in the trajectory or recent messages');
    expect(prompt).toContain('full user sentence');
    // 并且明确保护仍在命中的词
    expect(prompt).toContain('Do not recommend REMOVE for terms that appear as keywords in trajectory lines');
  });

  it('tells the model that updates keys are terms, not actions', () => {
    const prompt = CorrectionObserver.buildPrompt(mockPayload);
    expect(prompt).toContain('each KEY is the term itself');
    expect(prompt).toContain('"updates": {"<term>"');
  });

  it('renders a keyword-less confirmed correction as an explicit gap', () => {
    const prompt = CorrectionObserver.buildPrompt({
      ...mockPayload,
      trajectoryHistory: [
        { sessionId: 'session-123', timestamp: '2026-05-30T16:00:00Z', term: '', userMessage: '我不清楚你改了什么' },
      ],
    });
    expect(prompt).toContain('keyword="(none matched)"');
    // 散文不再出现在词位上，模型便不会把它当成关键词原样 ADD 回库
    expect(prompt).toContain('Never copy a trajectory keyword="(none matched)" line');
  });

  it('runs successfully with valid output', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: true,
          updates: {
            wrong: {
              action: 'update',
              weight: 0.4,
              reasoning: 'FP rate is low but weight can be adjusted',
            },
          },
          fpTerms: ['error'],
          fpAnalysisStatus: 'completed',
          summary: 'Decreased weight on wrong and noted FP on error',
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    const result = await observer.run(mockPayload);

    expect(result.updated).toBe(true);
    expect(result.updates).toBeDefined();
    expect(result.updates?.wrong?.action).toBe('update');
    expect(result.fpTerms).toEqual(['error']);
    expect(result.fpAnalysisStatus).toBe('completed');
  });

  it('throws error when validation fails', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: 'not-a-boolean',
          summary: 123,
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'CorrectionObserver output validation failed'
    );
  });

  it('throws error when updates record has invalid action', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: true,
          updates: {
            wrong: {
              action: 'invalid-action',
              reasoning: 'test',
            },
          },
          summary: 'Test',
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'updates["wrong"].action must be add|update|remove'
    );
  });

  it('throws error when updates entry has non-string reasoning', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: true,
          updates: {
            wrong: {
              action: 'update',
              reasoning: 42,
            },
          },
          summary: 'Test',
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'updates["wrong"].reasoning must be a string'
    );
  });

  it('throws error when fpTerms contains non-string', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: false,
          fpTerms: [123],
          summary: 'Test',
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'fpTerms[0] must be a string'
    );
  });

  it('throws error when fpAnalysisStatus is invalid', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          updated: false,
          fpAnalysisStatus: 'unknown',
          summary: 'Test',
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'fpAnalysisStatus must be completed|skipped'
    );
  });

  it('throws error when run times out', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onPollRun: (runId) => ({
        runId,
        status: 'running' as const,
        startedAt: new Date().toISOString(),
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter }, { timeoutMs: 50 });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'CorrectionObserver run timed out after 50ms'
    );
  });
});
