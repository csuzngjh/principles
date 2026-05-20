/**
 * pd runtime pruning CLI unit tests — report, explain, review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Never = never;

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
    getOrphanDerivedCandidates() {
      return { candidates: [], dbReadable: true };
    }
  }
  return { MockPruningReadModel };
}, { validateType: false });

const mockAppendPruningReview = vi.hoisted(() => vi.fn());
const mockListPruningReviews = vi.hoisted(() => vi.fn());
const mockBuildMaskedPrincipleSet = vi.hoisted(() => vi.fn());
const mockRemoveOrphanReferencesFromLedger = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PruningReadModel: vi.fn().mockImplementation(function () {
    return new MockPruningReadModel();
  }),
  createRemediationResult: vi.fn((input) => ({
    mode: input.mode,
    status: input.status ?? (input.mode === 'dry_run'
      ? (input.actions?.length > 0 ? 'would_change' : 'no_op')
      : (input.repairedCount > 0 ? 'changed' : 'no_op')),
    safeToConfirm: input.safeToConfirm ?? false,
    repairedCount: input.repairedCount ?? 0,
    skippedCount: input.skippedCount ?? 0,
    actions: input.actions ?? [],
    warnings: input.warnings ?? [],
    ...(input.includeLegacyDryRun ? { dryRun: input.mode === 'dry_run' } : {}),
  })),
  remediationAction: vi.fn((input) => input),
  appendPruningReview: mockAppendPruningReview,
  listPruningReviews: mockListPruningReviews,
  buildMaskedPrincipleSet: mockBuildMaskedPrincipleSet,
  removeOrphanReferencesFromLedger: mockRemoveOrphanReferencesFromLedger,
}));

import { handlePruningReport, handlePruningExplain, handlePruningReview, handlePruningRollback, handlePruningOrphans } from '../../src/commands/runtime-pruning.js';
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

// ── pd runtime pruning rollback ───────────────────────────────────────────────

describe('pd runtime pruning rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendPruningReview.mockReset();
    mockAppendPruningReview.mockReturnValue({
      reviewId: 'rollback-uuid-456',
      principleId: 'p_watch',
      decision: 'keep',
      note: 'Rollback: restore principle injection',
      reviewer: 'operator',
      reviewedAt: '2026-05-04T00:00:00.000Z',
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
    mockListPruningReviews.mockReset();
    mockBuildMaskedPrincipleSet.mockReset();
  });

  it('rollback --json writes keep record and outputs reviewId', () => {
    mockListPruningReviews.mockReturnValueOnce([
      {
        reviewId: 'rv-1',
        principleId: 'p_watch',
        decision: 'archive-candidate',
        note: 'pruning candidate',
        reviewer: 'operator',
        reviewedAt: '2026-05-01T00:00:00.000Z',
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
      },
    ]);
    mockBuildMaskedPrincipleSet.mockReturnValueOnce(new Set(['p_watch']));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningRollback({ principleId: 'p_watch', json: true });
    expect(mockAppendPruningReview).toHaveBeenCalledTimes(1);
    const callInput = mockAppendPruningReview.mock.calls[0]![1];
    expect(callInput.principleId).toBe('p_watch');
    expect(callInput.decision).toBe('keep');
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.reviewId).toBe('rollback-uuid-456');
    expect(output.decision).toBe('keep');
    consoleSpy.mockRestore();
  });

  it('rollback exits 1 when no reviews found', () => {
    mockListPruningReviews.mockReturnValueOnce([]);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningRollback({ principleId: 'nonexistent', json: false });
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('rollback exits 1 when principle is not currently masked', () => {
    mockListPruningReviews.mockReturnValueOnce([
      {
        reviewId: 'rv-1',
        principleId: 'p_watch',
        decision: 'keep',
        note: 'looks fine',
        reviewer: 'operator',
        reviewedAt: '2026-05-01T00:00:00.000Z',
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
          reasons: [],
        },
      },
    ]);
    mockBuildMaskedPrincipleSet.mockReturnValueOnce(new Set());

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningRollback({ principleId: 'p_watch', json: false });
    expect(processSpy).toHaveBeenCalledWith(1);
    expect(mockAppendPruningReview).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('rollback succeeds even when principle is not in pruning signals (degraded signalSnapshot)', () => {
    // p_orphan has a review + mask but no live signal in MockPruningReadModel
    mockListPruningReviews.mockReturnValueOnce([
      {
        reviewId: 'rv-1',
        principleId: 'p_orphan',
        decision: 'archive-candidate',
        note: 'pruning candidate',
        reviewer: 'operator',
        reviewedAt: '2026-05-01T00:00:00.000Z',
        signalSnapshot: {
          principleId: 'p_orphan',
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
          reasons: [],
        },
      },
    ]);
    mockBuildMaskedPrincipleSet.mockReturnValueOnce(new Set(['p_orphan']));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningRollback({ principleId: 'p_orphan', json: true });
    expect(mockAppendPruningReview).toHaveBeenCalledTimes(1);
    const callInput = mockAppendPruningReview.mock.calls[0]![1];
    // signal is undefined (p_orphan not in MockPruningReadModel) — real appendPruningReview applies fallback
    expect(callInput.principleId).toBe('p_orphan');
    expect(callInput.decision).toBe('keep');
    expect(callInput.signalSnapshot).toBeUndefined();
    consoleSpy.mockRestore();
  });
});

// ── pd runtime pruning orphans ───────────────────────────────────────────────

describe('pd runtime pruning orphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveOrphanReferencesFromLedger.mockReset();
  });

  it('dry-run outputs orphan list with count (JSON)', () => {
    class MockOrphanReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_orphan1', principleId: 'p1', reason: 'candidate not found in state.db', sourceRef: 'derivedFromPainIds', status: 'active' },
            { candidateId: 'c_orphan2', principleId: 'p1', reason: 'candidate not found in state.db', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: true,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockOrphanReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: true, dryRun: true, confirm: false });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.mode).toBe('dry_run');
    expect(output.status).toBe('would_change');
    expect(output.safeToConfirm).toBe(true);
    expect(output.orphanDerivedCandidateCount).toBe(2);
    expect(output.dryRun).toBe(true);
    expect(output.dbReadable).toBe(true);
    expect(output.candidates).toHaveLength(2);
    expect(output.candidates[0].candidateId).toBe('c_orphan1');
    consoleSpy.mockRestore();
  });

  it('default is dry-run (no modifications)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: true });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.mode).toBe('dry_run');
    expect(output.status).toBe('no_op');
    expect(output.dryRun).toBe(true);
    expect(mockRemoveOrphanReferencesFromLedger).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('--confirm removes orphan IDs from ledger derivedFromPainIds', () => {
    mockRemoveOrphanReferencesFromLedger.mockReturnValue([
      { principleId: 'p1', removedIds: ['c_orphan1'] },
    ]);

    class MockOrphanReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_orphan1', principleId: 'p1', reason: 'candidate not found in state.db', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: true,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockOrphanReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: true, confirm: true });
    expect(mockRemoveOrphanReferencesFromLedger).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.mode).toBe('confirm');
    expect(output.status).toBe('changed');
    expect(output.repairedCount).toBe(1);
    expect(output.dryRun).toBe(false);
    expect(output.dbReadable).toBe(true);
    expect(output.removedFromPrinciples).toHaveLength(1);
    expect(output.removedFromPrinciples[0].principleId).toBe('p1');
    expect(output.removedFromPrinciples[0].removedIds).toContain('c_orphan1');
    consoleSpy.mockRestore();
  });

  it('--confirm does not touch non-orphan candidates', () => {
    mockRemoveOrphanReferencesFromLedger.mockReturnValue([]);

    class MockOrphanReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_orphan1', principleId: 'p2', reason: 'candidate not found in state.db', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: true,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockOrphanReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: true, confirm: true });
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.removedFromPrinciples).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('dry-run text output includes note about no modifications', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: false, dryRun: true, confirm: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('dryRun: true');
    expect(output).toContain('No orphan derived candidates found.');
    consoleSpy.mockRestore();
  });

  it('--confirm REFUSED when DB is unreadable, does not call saveLedger', () => {
    class MockDegradedReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_maybe_orphan', principleId: 'p1', reason: 'candidate not verifiable: state.db unreadable', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: false,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockDegradedReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningOrphans({ json: false, confirm: true });
    expect(processSpy).toHaveBeenCalledWith(1);
    expect(mockRemoveOrphanReferencesFromLedger).not.toHaveBeenCalled();
    const errOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('REFUSED');
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('--confirm REFUSED when DB is unreadable (JSON mode)', () => {
    class MockDegradedReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_maybe_orphan', principleId: 'p1', reason: 'candidate not verifiable: state.db unreadable', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: false,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockDegradedReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    handlePruningOrphans({ json: true, confirm: true });
    expect(processSpy).toHaveBeenCalledWith(1);
    expect(mockRemoveOrphanReferencesFromLedger).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('refused');
    expect(output.safeToConfirm).toBe(false);
    expect(output.dbReadable).toBe(false);
    expect(output.dryRun).toBe(false); // operation was refused, not a dry-run
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('dry-run shows degraded warning when DB is unreadable', () => {
    class MockDegradedReadModel {
      getOrphanDerivedCandidates() {
        return {
          candidates: [
            { candidateId: 'c_maybe_orphan', principleId: 'p1', reason: 'candidate not verifiable: state.db unreadable', sourceRef: 'derivedFromPainIds', status: 'active' },
          ],
          dbReadable: false,
        };
      }
    }
    (PruningReadModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return new MockDegradedReadModel() as unknown as InstanceType<typeof PruningReadModel>;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    handlePruningOrphans({ json: false, dryRun: true, confirm: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('dbReadable: false');
    expect(output).toContain('not verifiable');
    expect(output).toContain('--confirm will be refused');
    consoleSpy.mockRestore();
  });
});
