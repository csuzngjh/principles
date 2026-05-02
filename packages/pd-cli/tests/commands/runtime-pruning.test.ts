/**
 * pd runtime pruning report — CLI unit tests.
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

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PruningReadModel: vi.fn().mockImplementation(function () {
    return new MockPruningReadModel();
  }),
}));

import { handlePruningReport } from '../../src/commands/runtime-pruning.js';
import { PruningReadModel } from '@principles/core/runtime-v2';

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

  it('explain --json outputs matching signal for p_watch', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handlePruningExplain } = await import('../../src/commands/runtime-pruning.js');
    handlePruningExplain({ principleId: 'p_watch', json: true });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.principleId).toBe('p_watch');
    expect(output.signal).toBeDefined();
    expect(output.workspace).toBeDefined();
    expect(output.generatedAt).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('explain text output includes reason lines and read-only note', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handlePruningExplain } = await import('../../src/commands/runtime-pruning.js');
    handlePruningExplain({ principleId: 'p_watch', json: false });
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('p_watch');
    expect(output).toContain('watch');
    expect(output).toContain('NOTE: This report is read-only.');
    consoleSpy.mockRestore();
  });

  it('explain missing principle exits 1', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code: number) => never);
    const { handlePruningExplain } = await import('../../src/commands/runtime-pruning.js');
    handlePruningExplain({ principleId: 'nonexistent', json: false });
    expect(processSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    processSpy.mockRestore();
  });

  it('explain passes explicit workspace to PruningReadModel', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handlePruningExplain } = await import('../../src/commands/runtime-pruning.js');
    handlePruningExplain({ principleId: 'p_watch', workspace: '/custom/workspace', json: false });
    const calls = (PruningReadModel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[calls.length - 1][0].workspaceDir)).toMatch(/custom.*workspace/);
    consoleSpy.mockRestore();
  });
});
