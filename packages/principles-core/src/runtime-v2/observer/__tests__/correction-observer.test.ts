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
        { term: 'wrong', weight: 0.5, hitCount: 10, truePositiveCount: 8, falsePositiveCount: 2 },
        { term: 'error', weight: 0.6, hitCount: 5, truePositiveCount: 4, falsePositiveCount: 1 },
      ],
    },
    recentMessages: ['help me', 'something is wrong here'],
    trajectoryHistory: [
      { sessionId: 'session-123', timestamp: '2026-05-30T16:00:00Z', term: 'wrong', userMessage: 'this is wrong' },
    ],
  };

  it('correctly builds prompt', () => {
    const prompt = CorrectionObserver.buildPrompt(mockPayload);
    expect(prompt).toContain('You are a correction keyword optimizer.');
    expect(prompt).toContain('wrong');
    expect(prompt).toContain('error');
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
          updated: 'not-a-boolean', // Fail validation
          summary: 123,
        },
      }),
    });

    const observer = new CorrectionObserver({ runtimeAdapter: adapter });
    await expect(observer.run(mockPayload)).rejects.toThrow(
      'CorrectionObserver output validation failed'
    );
  });
});
