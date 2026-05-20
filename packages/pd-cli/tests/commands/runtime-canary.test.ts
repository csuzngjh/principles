import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSchemaCheck,
  mockHealthSnapshot,
  mockHealthClose,
  mockOrphanCandidates,
  mockQueueSnapshot,
  mockQueueClose,
  mockAuditConsistency,
  mockBuildGfiSnapshot,
  mockClassifyGfiHealth,
} = vi.hoisted(() => ({
  mockSchemaCheck: vi.fn(),
  mockHealthSnapshot: vi.fn(),
  mockHealthClose: vi.fn().mockResolvedValue(undefined),
  mockOrphanCandidates: vi.fn(),
  mockQueueSnapshot: vi.fn(),
  mockQueueClose: vi.fn().mockResolvedValue(undefined),
  mockAuditConsistency: vi.fn(),
  mockBuildGfiSnapshot: vi.fn(),
  mockClassifyGfiHealth: vi.fn(),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  SchemaConformanceReadModel: vi.fn().mockImplementation(function () {
    return { check: mockSchemaCheck };
  }),
  OperatorHealthReadModel: vi.fn().mockImplementation(function () {
    return { getSnapshot: mockHealthSnapshot, close: mockHealthClose };
  }),
  PruningReadModel: vi.fn().mockImplementation(function () {
    return { getOrphanDerivedCandidates: mockOrphanCandidates };
  }),
  createInternalizationQueueReadModel: vi.fn().mockResolvedValue({
    readModel: { getSnapshot: mockQueueSnapshot },
    close: mockQueueClose,
  }),
  auditCandidateLedgerConsistency: mockAuditConsistency,
  buildGfiWorkspaceSnapshot: mockBuildGfiSnapshot,
  classifyGfiWorkspaceHealth: mockClassifyGfiHealth,
}));

import { runCanaryChecks } from '../../src/commands/runtime-canary.js';

const WS = '/fake/workspace';

function healthySchemaResult() {
  return {
    overallStatus: 'ok' as const,
    checkedDatabasePath: `${WS}/.pd/state.db`,
    tables: {
      tasks: { exists: true, missingColumns: [] },
      runs: { exists: true, missingColumns: [] },
      artifacts: { exists: true, missingColumns: [] },
      commits: { exists: true, missingColumns: [] },
      principle_candidates: { exists: true, missingColumns: [] },
      pi_artifacts: { exists: true, missingColumns: [] },
    },
    indexes: { missingIndexes: [] },
    migrationsNeeded: [],
    generatedAt: new Date().toISOString(),
  };
}

function healthyHealthSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    workspace: WS,
    painChain: { lastSuccessfulChain: null, failureCategory: null },
    candidateLedger: { auditStatus: 'ok' as const, orphanCandidateCount: 0, missingLedgerCount: 0 },
    pruning: { watchCount: 0, reviewCount: 0, orphanDerivedCandidateCount: 0 },
    gfi: { active: null, staleSessionCount: 0, totalSessionCount: 0, activeSessionCount: 0, generatedAt: new Date().toISOString() },
    overallStatus: 'healthy' as const,
    recommendedActions: [],
  };
}

function healthyQueueSnapshot() {
  return {
    pendingCount: 0, retryWaitCount: 0, countsByTaskKind: {}, countsByChannel: {},
    invalidMetadataCount: 0, sampleInvalidTaskIds: [],
    blockedSummary: { count: 0, samples: [] }, dependencyFailedSummary: { count: 0, samples: [] },
    leaseConflictSummary: { count: 0, samples: [], sampleTaskIds: [] },
    retryWaitPendingSummary: { count: 0, samples: [] },
    unresolvableSummary: { count: 0, samples: [] },
    readyTasks: [], noReadyTasks: null,
  };
}

function healthyGfiSnapshot() {
  return {
    active: null, staleSessionCount: 0, totalSessionCount: 0, activeSessionCount: 0, generatedAt: new Date().toISOString(),
  };
}

describe('runCanaryChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSchemaCheck.mockReturnValue(healthySchemaResult());
    mockHealthSnapshot.mockResolvedValue(healthyHealthSnapshot());
    mockHealthClose.mockResolvedValue(undefined);
    mockOrphanCandidates.mockReturnValue({ candidates: [], dbReadable: true });
    mockQueueSnapshot.mockResolvedValue(healthyQueueSnapshot());
    mockQueueClose.mockResolvedValue(undefined);
    mockAuditConsistency.mockResolvedValue({ status: 'ok', consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 });
    mockBuildGfiSnapshot.mockReturnValue(healthyGfiSnapshot());
    mockClassifyGfiHealth.mockReturnValue({ status: 'healthy', reason: '0 active, 0 stale sessions', staleGfiDegradedThreshold: 40 });
  });

  it('returns healthy when all checks are healthy', async () => {
    const result = await runCanaryChecks(WS);

    expect(result.overallStatus).toBe('healthy');
    expect(result.checks.length).toBeGreaterThanOrEqual(5);
    expect(result.checks.every(c => c.status === 'healthy')).toBe(true);
  });

  it('returns degraded when a single check is degraded', async () => {
    mockSchemaCheck.mockReturnValue({
      ...healthySchemaResult(),
      overallStatus: 'degraded',
      migrationsNeeded: ['add_trigger_pattern'],
    });

    const result = await runCanaryChecks(WS);

    expect(result.overallStatus).toBe('degraded');
    const schemaCheck = result.checks.find(c => c.name === 'schema_conformance');
    expect(schemaCheck?.status).toBe('degraded');
  });

  it('continues other checks when one throws', async () => {
    mockAuditConsistency.mockRejectedValue(new Error('DB error'));

    const result = await runCanaryChecks(WS);

    expect(result.overallStatus).not.toBe('healthy');
    const auditCheck = result.checks.find(c => c.name === 'candidate_audit');
    expect(auditCheck?.status).toBe('error');
    expect(auditCheck?.error).toBeTruthy();
    const schemaCheck = result.checks.find(c => c.name === 'schema_conformance');
    expect(schemaCheck?.status).toBe('healthy');
  });

  it('produces stable JSON-serializable output', async () => {
    const result = await runCanaryChecks(WS);

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    expect(parsed.overallStatus).toBe('healthy');
    expect(parsed.checks).toBeInstanceOf(Array);
    expect(parsed.recommendedNextActions).toBeInstanceOf(Array);
    expect(parsed.generatedAt).toBeTruthy();
  });

  it('includes recommendedNextActions for schema mismatch', async () => {
    mockSchemaCheck.mockReturnValue({
      ...healthySchemaResult(),
      overallStatus: 'degraded',
      migrationsNeeded: ['add_trigger_pattern'],
    });

    const result = await runCanaryChecks(WS);

    expect(result.recommendedNextActions.length).toBeGreaterThan(0);
    expect(result.recommendedNextActions.some(a => a.includes('migrate schema'))).toBe(true);
  });

  it('includes recommendedNextActions for pruning orphans', async () => {
    mockOrphanCandidates.mockReturnValue({
      candidates: [{ candidateId: 'c1', principleId: 'p1', reason: 'not found' }],
      dbReadable: true,
    });

    const result = await runCanaryChecks(WS);

    expect(result.overallStatus).toBe('degraded');
    expect(result.recommendedNextActions.some(a => a.includes('pruning orphans') || a.includes('dry-run'))).toBe(true);
  });

  it('uses createInternalizationQueueReadModel with readonly: true (no RuntimeStateManager)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(require.resolve('../../src/commands/runtime-canary.ts'), 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createInternalizationQueueReadModel');
    expect(src).toMatch(/createInternalizationQueueReadModel\(\{[^}]*readonly:\s*true/);
  });

  it('calls queue close once on healthy path', async () => {
    await runCanaryChecks(WS);
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });

  it('includes nextReadyTaskKind and nextReadyTaskId in top-level internalizationQueueSummary when queue has ready tasks', async () => {
    mockQueueSnapshot.mockResolvedValue({
      pendingCount: 2,
      retryWaitCount: 1,
      countsByTaskKind: { dreamer: 3 },
      countsByChannel: {},
      invalidMetadataCount: 0,
      sampleInvalidTaskIds: [],
      blockedSummary: { count: 0, samples: [] },
      dependencyFailedSummary: { count: 0, samples: [] },
      leaseConflictSummary: { count: 0, samples: [], sampleTaskIds: [] },
      retryWaitPendingSummary: { count: 0, samples: [] },
      unresolvableSummary: { count: 0, samples: [] },
      readyTasks: [
        { taskId: 'task-abc-123', taskKind: 'dreamer', channel: 'pi' },
        { taskId: 'task-def-456', taskKind: 'philosopher', channel: 'pi' },
      ],
      noReadyTasks: null,
    });

    const result = await runCanaryChecks(WS);

    expect(result.internalizationQueueSummary).toBeDefined();
    expect(result.internalizationQueueSummary?.readyCount).toBe(2);
    expect(result.internalizationQueueSummary?.retryWaitCount).toBe(1);
    expect(result.internalizationQueueSummary?.pendingCount).toBe(2);
    expect(result.internalizationQueueSummary?.nextReadyTaskKind).toBe('dreamer');
    expect(result.internalizationQueueSummary?.nextReadyTaskId).toBe('task-abc-123');
  });

  it('includes noReadyReason in internalizationQueueSummary when no ready tasks exist', async () => {
    mockQueueSnapshot.mockResolvedValue({
      pendingCount: 0,
      retryWaitCount: 0,
      countsByTaskKind: {},
      countsByChannel: {},
      invalidMetadataCount: 5,
      sampleInvalidTaskIds: ['bad-1', 'bad-2'],
      blockedSummary: { count: 0, samples: [] },
      dependencyFailedSummary: { count: 0, samples: [] },
      leaseConflictSummary: { count: 0, samples: [], sampleTaskIds: [] },
      retryWaitPendingSummary: { count: 0, samples: [] },
      unresolvableSummary: { count: 0, samples: [] },
      readyTasks: [],
      noReadyTasks: { reason: 'all_hydration_failed', inspectedCount: 5 },
    });

    const result = await runCanaryChecks(WS);

    expect(result.internalizationQueueSummary).toBeDefined();
    expect(result.internalizationQueueSummary?.readyCount).toBe(0);
    expect(result.internalizationQueueSummary?.retryWaitCount).toBe(0);
    expect(result.internalizationQueueSummary?.pendingCount).toBe(0);
    expect(result.internalizationQueueSummary?.nextReadyTaskKind).toBeNull();
    expect(result.internalizationQueueSummary?.nextReadyTaskId).toBeNull();
    expect(result.internalizationQueueSummary?.noReadyReason).toBe('all_hydration_failed');
  });
});
