/**
 * pd runtime pruning report — CLI unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MOCK_SIGNALS = [
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

const MOCK_SUMMARY = {
  totalPrinciples: 2,
  byStatus: { active: 2 },
  watchCount: 1,
  reviewCount: 1,
  orphanDerivedCandidateCount: 0,
  averageAgeDays: 82,
  generatedAt: '2026-05-02T00:00:00.000Z',
};

class MockPruningReadModel {
  getPrincipleSignals() { return MOCK_SIGNALS; }
  getHealthSummary() { return MOCK_SUMMARY; }
}

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  PruningReadModel: vi.fn(() => new MockPruningReadModel()),
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
});