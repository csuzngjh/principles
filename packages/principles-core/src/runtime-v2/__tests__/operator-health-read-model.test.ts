/**
 * OperatorHealthReadModel unit tests — core snapshot aggregation logic.
 *
 * Uses DI to inject mock read models and mock audit function.
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

function healthyChain() {
  return {
    painId: 'pain_001', taskId: 'task_001', runId: 'run_001', artifactId: 'art_001',
    candidateIds: ['c1'], ledgerEntryIds: ['l1'], status: 'succeeded' as const,
    latencyMs: { painToTask: 100 }, failureCategory: null,
    checkedAt: '2026-05-03T12:00:00.000Z', missingLinks: [],
  };
}

function okAudit() {
  return { status: 'ok' as const, consumedCount: 2, orphanCandidateCount: 0, missingLedgerCount: 0 };
}

function cleanPruning() {
  return {
    totalPrinciples: 5, activeCount: 5, watchCount: 0, reviewCount: 0,
    archiveCandidateCount: 0, orphanDerivedCandidateCount: 0,
    averageAgeDays: 12, generatedAt: '2026-05-03T12:00:00.000Z',
  };
}

function createModel(taskCount = 0) {
  const painChain = {
    getLastSuccessfulChain: vi.fn(),
    getTotalTaskCount: vi.fn().mockResolvedValue(taskCount),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const pruning = { getHealthSummary: vi.fn() };
  const model = new OperatorHealthReadModel({
    workspaceDir: WS,
    painChainReadModel: painChain as unknown as PainChainReadModel,
    pruningReadModel: pruning as unknown as PruningReadModel,
  });
  return { model, painChain, pruning };
}

describe('OperatorHealthReadModel.getSnapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockAuditFn.mockResolvedValue(okAudit());
    mockExistsSync.mockReturnValue(true);
  });

  it('returns healthy when all checks pass', async () => {
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(healthyChain());
    pruning.getHealthSummary.mockReturnValue(cleanPruning());

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('healthy');
    expect(s.recommendedActions).toEqual([]);
    expect(s.painChain.lastSuccessfulChain).not.toBeNull();
    await model.close();
  });

  it('returns error when state.db missing', async () => {
    mockExistsSync.mockReturnValue(false);
    mockAuditFn.mockResolvedValue({ status: 'error', consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 });
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(undefined);
    pruning.getHealthSummary.mockReturnValue(cleanPruning());

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('error');
    expect(s.recommendedActions).toContain('Initialize workspace with `pd pain record`.');
    await model.close();
  });

  it('returns degraded when candidate audit degraded', async () => {
    mockAuditFn.mockResolvedValue({ status: 'degraded', consumedCount: 3, orphanCandidateCount: 2, missingLedgerCount: 2 });
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(healthyChain());
    pruning.getHealthSummary.mockReturnValue(cleanPruning());

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('degraded');
    expect(s.candidateLedger.auditStatus).toBe('degraded');
    expect(s.recommendedActions).toContain('Run `pd candidate audit --workspace <path> --json` for details.');
    await model.close();
  });

  it('returns degraded and recommends UAT when no chain', async () => {
    const { model, painChain, pruning } = createModel(1);
    painChain.getLastSuccessfulChain.mockResolvedValue(undefined);
    pruning.getHealthSummary.mockReturnValue(cleanPruning());

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('degraded');
    expect(s.painChain.lastSuccessfulChain).toBeNull();
    expect(s.recommendedActions).toContain('Run `pd runtime uat --workspace <path> --count 3` to establish baseline.');
    await model.close();
  });

  it('returns degraded when pruning has watch signals', async () => {
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(healthyChain());
    pruning.getHealthSummary.mockReturnValue({ ...cleanPruning(), watchCount: 3, reviewCount: 1 });

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('degraded');
    expect(s.pruning.watchCount).toBe(3);
    expect(s.recommendedActions).toContain('Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.');
    await model.close();
  });

  it('accumulates multiple recommendedActions', async () => {
    mockAuditFn.mockResolvedValue({ status: 'degraded', consumedCount: 3, orphanCandidateCount: 2, missingLedgerCount: 2 });
    const { model, painChain, pruning } = createModel(1);
    painChain.getLastSuccessfulChain.mockResolvedValue(undefined);
    pruning.getHealthSummary.mockReturnValue({ ...cleanPruning(), watchCount: 2, reviewCount: 0 });

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('degraded');
    expect(s.recommendedActions).toHaveLength(3);
    await model.close();
  });

  it('CANARY-01: high orphanDerivedCandidateCount should flag degraded (observation gap)', async () => {
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(healthyChain());
    pruning.getHealthSummary.mockReturnValue({ ...cleanPruning(), orphanDerivedCandidateCount: 18 });

    const s = await model.getSnapshot();
    expect(s.overallStatus).toBe('degraded');
    expect(s.pruning.orphanDerivedCandidateCount).toBe(18);
    await model.close();
  });

  it('CANARY-03: orphanDerivedCandidateCount reflected in pruning snapshot even when healthy', async () => {
    const { model, painChain, pruning } = createModel();
    painChain.getLastSuccessfulChain.mockResolvedValue(healthyChain());
    pruning.getHealthSummary.mockReturnValue({ ...cleanPruning(), orphanDerivedCandidateCount: 18 });

    const s = await model.getSnapshot();
    expect(s.pruning.orphanDerivedCandidateCount).toBe(18);
    await model.close();
  });
});
