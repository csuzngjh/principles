/**
 * pd runtime pruning CLI unit tests — report, explain, review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MockPruningReadModel } = vi.hoisted(() => {
  class MockPruningReadModel {
    getPrincipleSignals() {
      return [
        {
          principleId: 'p_watch',
          status: 'active' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          derivedCandidateIds: [] as string[],
          derivedPainCount: 0,
          matchedCandidateCount: 0,
          recentCandidateCount: 0,
          orphanCandidateCount: 0,
          ageDays: 45,
          riskLevel: 'watch' as const,
          reasons: ['watch: principle older than 30 days with no recent derived pain signals [source: createdAt + derivedFromPainIds]'],
        },
        {
          principleId: 'p_review',
          status: 'active' as const,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          derivedCandidateIds: [] as string[],
          derivedPainCount: 0,
          matchedCandidateCount: 0,
          recentCandidateCount: 0,
          orphanCandidateCount: 0,
          ageDays: 120,
          riskLevel: 'review' as const,
          reasons: ['review: principle older than 90 days with no derived pain signals [source: createdAt + derivedFromPainIds]'],
        },
      ];
    }
    getHealthSummary() {
      return {
        totalPrinciples: 2,
        byStatus: { active: 2 },
        watchCount: 1,
        reviewCount: 1,
        orphanDerivedCandidateCount: 0,
        averageAgeDays: 82,
        generatedAt: '2026-05-02T00:00:00.000Z',
      };
    }
  }
  return { MockPruningReadModel };
}, { validateType: false });

const mockAppendPruningReview = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PruningReadModel: vi.fn().mockImplementation(function () {
    return new MockPruningReadModel();
  }),
  appendPruningReview: mockAppendPruningReview,
}));

import { handlePruningReport, handlePruningExplain, handlePruningReview } from '../../src/commands/runtime-pruning.js';
import { PruningReadModel } from '@principles/core/runtime-v2';

// ── pd runtime pruning report ───────────────────────────────────────────────

describe('pd runtime pruning report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('text output contains read-only note', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReport({ json: false });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('NOTE: This report is read-only. No principles are modified or deleted.')
    );
    consoleSpy.mockRestore();
  });

  it('text output includes watch and review sections', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReport({ json: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Principles flagged WATCH');
    expect(output).toContain('Principles flagged REVIEW');
    expect(output).toContain('p_watch');
    expect(output).toContain('p_review');
    consoleSpy.mockRestore();
  });

  it('--json flag outputs full shape', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReport({ json: true });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output).toHaveProperty('generatedAt');
    expect(output).toHaveProperty('workspace');
    expect(output).toHaveProperty('summary');
    expect(output).toHaveProperty('signals');
    expect(output.summary.watchCount).toBe(1);
    expect(output.summary.reviewCount).toBe(1);
    consoleSpy.mockRestore();
  });

  it('--workspace passes explicit path to PruningReadModel constructor', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReport({ workspace: '/custom/workspace', json: false });
    const calls = (PruningReadModel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[calls.length - 1][0].workspaceDir)).toMatch(/custom.*workspace/);
    consoleSpy.mockRestore();
  });

  it('error-path: propagates errors from PruningReadModel', () => {
    class MockErrorReadModel {
      getPrincipleSignals() { throw new Error('DB query failed'); }
      getHealthSummary() { return {}; }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockErrorReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });
    expect(() => handlePruningReport({ json: false })).toThrow('DB query failed');
  });

  it('healthy-path: no watch or review signals', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    class MockHealthyReadModel {
      getPrincipleSignals() { return []; }
      getHealthSummary() {
        return {
          totalPrinciples: 5,
          byStatus: { active: 5 },
          watchCount: 0,
          reviewCount: 0,
          orphanDerivedCandidateCount: 0,
          averageAgeDays: 10,
          generatedAt: '2026-05-02T00:00:00.000Z',
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockHealthyReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });
    handlePruningReport({ json: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No watch or review signals. System is healthy.');
    expect(output).not.toContain('WATCH');
    consoleSpy.mockRestore();
  });
});

// ── pd runtime pruning explain ───────────────────────────────────────────────

describe('pd runtime pruning explain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explain --json outputs matching signal for p_watch', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningExplain({ principleId: 'p_watch', json: true });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.principleId).toBe('p_watch');
    expect(output.signal).toBeDefined();
    expect(output.workspace).toBeDefined();
    expect(output.generatedAt).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('explain text output includes reason lines and read-only note', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningExplain({ principleId: 'p_watch', json: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('p_watch');
    expect(output).toContain('watch');
    expect(output).toContain('NOTE: This report is read-only.');
    consoleSpy.mockRestore();
  });

  it('explain missing principle exits 1', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningExplain({ principleId: 'nonexistent', json: false });
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('explain passes explicit workspace to PruningReadModel', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningExplain({ principleId: 'p_watch', workspace: '/custom/workspace', json: false });
    const calls = (PruningReadModel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[calls.length - 1][0].workspaceDir)).toMatch(/custom.*workspace/);
    consoleSpy.mockRestore();
  });
});

// ── pd runtime pruning review ───────────────────────────────────────────────

describe('pd runtime pruning review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendPruningReview.mockReset();
    mockAppendPruningReview.mockReturnValue({
      reviewId: 'review-uuid-123',
      principleId: 'p_watch',
      decision: 'keep',
      note: '',
      reviewer: 'operator',
      reviewedAt: '2026-05-02T00:00:00.000Z',
      signalSnapshot: {
        principleId: 'p_watch',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        derivedCandidateIds: [],
        derivedPainCount: 0,
        matchedCandidateCount: 0,
        recentCandidateCount: 0,
        orphanCandidateCount: 0,
        ageDays: 45,
        riskLevel: 'watch',
        reasons: ['watch: principle older than 30 days'],
      },
    });
  });

  it('review --json writes review record and outputs reviewId', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReview({ principleId: 'p_watch', decision: 'keep', json: true });
    expect(mockAppendPruningReview).toHaveBeenCalledTimes(1);
    const callInput = mockAppendPruningReview.mock.calls[0]![1];
    expect(callInput.principleId).toBe('p_watch');
    expect(callInput.decision).toBe('keep');
    expect(callInput.signalSnapshot).toBeDefined();
    expect(callInput.signalSnapshot.principleId).toBe('p_watch');
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.reviewId).toBe('review-uuid-123');
    expect(output.principleId).toBe('p_watch');
    expect(output.decision).toBe('keep');
    expect(output.reviewedAt).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('review text output includes audit-only / no mutation note', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReview({ principleId: 'p_watch', decision: 'keep', note: 'looks fine', json: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('reviewId');
    expect(output).toContain('reviewer');
    expect(output).toContain('NOTE: This audit record does not modify the principle.');
    consoleSpy.mockRestore();
  });

  it('review missing principle exits 1 and does not append', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningReview({ principleId: 'nonexistent', decision: 'keep', json: false });
    expect(mockAppendPruningReview).not.toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('review invalid decision exits 1 and does not append', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    // @ts-expect-error — testing invalid input
    handlePruningReview({ principleId: 'p_watch', decision: 'invalid', json: false });
    expect(mockAppendPruningReview).not.toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('archive-candidate without note exits 1', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningReview({ principleId: 'p_watch', decision: 'archive-candidate', note: undefined, json: false });
    expect(mockAppendPruningReview).not.toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('review passes workspace to PruningReadModel and appendPruningReview', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReview({ principleId: 'p_watch', decision: 'keep', workspace: '/custom/workspace', json: false });
    const modelCalls = (PruningReadModel as ReturnType<typeof vi.fn>).mock.calls;
    expect(modelCalls.length).toBeGreaterThan(0);
    expect(modelCalls[modelCalls.length - 1][0].workspaceDir).toMatch(/custom[\\/]workspace/);
    expect(mockAppendPruningReview).toHaveBeenCalledWith(expect.stringMatching(/custom[\\/]workspace/), expect.any(Object));
    consoleSpy.mockRestore();
  });

  it('review captures signalSnapshot from matching signal', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningReview({ principleId: 'p_watch', decision: 'defer', note: 'deferring', json: true });
    const callInput = mockAppendPruningReview.mock.calls[0]![1];
    expect(callInput.signalSnapshot).toMatchObject({
      principleId: 'p_watch',
      riskLevel: 'watch',
    });
    consoleSpy.mockRestore();
  });
});