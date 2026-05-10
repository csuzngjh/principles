/**
 * Cold-start false-positive observability test.
 *
 * OBSERVABILITY GAP: `operator-health-read-model` marks health as "degraded" when
 * `lastSuccessfulChain === null`, but a workspace with zero tasks is NOT degraded —
 * it is simply cold-started. This test asserts that the health snapshot correctly
 * distinguishes cold-start from real degradation, so operators are not misled into
 * thinking a fresh workspace needs remediation.
 *
 * Symptom: `pd runtime health snapshot` returns `overallStatus: "degraded"` with
 * `recommendedActions: ["Run `pd runtime uat --workspace <path> --count 3` to establish baseline."]`
 * on a workspace that has never run any tasks. E2E (UAT) passes 100%, proving
 * the runtime is healthy — the health snapshot produces a FALSE POSITIVE.
 *
 * Expected behavior after fix:
 * - Workspace with 0 tasks → `overallStatus: "healthy"` (cold-start, not degraded)
 * - Workspace with tasks but no successful chain (recent failure) → `overallStatus: "degraded"`
 * - Workspace with tasks and successful chain → `overallStatus: "healthy"`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuditFn = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn(() => true));

vi.mock('../candidate-audit.js', () => ({
  auditCandidateLedgerConsistency: mockAuditFn,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

import { OperatorHealthReadModel } from '../operator-health-read-model.js';
import type { PainChainReadModel } from '../pain-chain-read-model.js';
import type { PruningReadModel } from '../pruning-read-model.js';

const WS = '/fake/workspace';

function okAudit() {
  return { status: 'ok' as const, consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 };
}

function cleanPruning() {
  return {
    totalPrinciples: 0, activeCount: 0, watchCount: 0, reviewCount: 0,
    archiveCandidateCount: 0, orphanDerivedCandidateCount: 0,
    averageAgeDays: 0, generatedAt: '2026-05-03T12:00:00.000Z',
  };
}

function createModel(painChainResult: unknown = null, pruningResult = cleanPruning(), taskCount = 0) {
  const painChain = {
    getLastSuccessfulChain: vi.fn().mockResolvedValue(painChainResult),
    getTotalTaskCount: vi.fn().mockResolvedValue(taskCount),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const pruning = { getHealthSummary: vi.fn().mockReturnValue(pruningResult) };
  const model = new OperatorHealthReadModel({
    workspaceDir: WS,
    painChainReadModel: painChain as unknown as PainChainReadModel,
    pruningReadModel: pruning as unknown as PruningReadModel,
  });
  return { model, painChain, pruning };
}

describe('OperatorHealthReadModel — cold-start vs. real degradation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockAuditFn.mockResolvedValue(okAudit());
    mockExistsSync.mockReturnValue(true);
  });

  it('marks workspace as HEALTHY (not degraded) when zero tasks have ever run — cold-start false positive guard', async () => {
    const { model } = createModel(null, cleanPruning(), 0);

    const snapshot = await model.getSnapshot();
    await model.close();

    expect(snapshot.overallStatus).toBe('healthy');
    expect(snapshot.painChain.lastSuccessfulChain).toBeNull();
    expect(snapshot.recommendedActions).not.toContainEqual(
      expect.stringContaining('uat --workspace')
    );
  });

  it('marks workspace as DEGRADED when tasks exist but no successful chain — real degradation', async () => {
    const { model } = createModel(null, {
      ...cleanPruning(),
      totalPrinciples: 5,
      activeCount: 5,
    }, 5);

    const snapshot = await model.getSnapshot();
    await model.close();

    expect(snapshot.overallStatus).toBe('degraded');
    expect(snapshot.recommendedActions).toContainEqual(
      expect.stringContaining('uat --workspace')
    );
  });

  it('marks workspace as HEALTHY when successful chain exists', async () => {
    const healthyChain = {
      painId: 'pain_001', taskId: 'task_001', runId: 'run_001', artifactId: 'art_001',
      candidateIds: ['c1'], ledgerEntryIds: ['l1'], status: 'succeeded' as const,
      latencyMs: { painToTask: 100 }, failureCategory: null,
      checkedAt: '2026-05-03T12:00:00.000Z', missingLinks: [],
    };
    const { model } = createModel(healthyChain, cleanPruning(), 1);

    const snapshot = await model.getSnapshot();
    await model.close();

    expect(snapshot.overallStatus).toBe('healthy');
    expect(snapshot.painChain.lastSuccessfulChain).not.toBeNull();
  });
});
