/**
 * Unit tests for lifecycle read model builder — PRI-56
 */
import { describe, it, expect } from 'vitest';
import type { LifecycleDatasource } from './lifecycle-datasource.js';
import { buildLifecycleReadModel } from './lifecycle-read-model.js';
import type { LedgerTreeStore, LedgerPrinciple, LedgerRule, Implementation } from '../../principle-tree-ledger.js';
import type { ReplayReport, ClassificationSummary, ArtifactLineageRecord } from '../types/index.js';

function makeClassificationSummary(overrides: Partial<ClassificationSummary> = {}): ClassificationSummary {
  return { total: 0, passed: 0, failed: 0, details: [], ...overrides };
}

function makeReplayReport(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    overallDecision: 'pass',
    replayResults: {
      painNegative: makeClassificationSummary(),
      successPositive: makeClassificationSummary(),
      principleAnchor: makeClassificationSummary(),
    },
    blockers: [],
    evidenceSummary: { evidenceStatus: 'empty', totalSamples: 0, classifiedCounts: { painNegative: 0, successPositive: 0, principleAnchor: 0 } },
    generatedAt: '2026-01-01T00:00:00Z',
    implementationId: 'impl-1',
    sampleFingerprints: [],
    ...overrides,
  };
}

function makeLineageRecord(overrides: Partial<ArtifactLineageRecord> = {}): ArtifactLineageRecord {
  return {
    artifactKind: 'rule-implementation-candidate',
    artifactId: 'art-1',
    principleId: 'p1',
    ruleId: null,
    sessionId: 's1',
    sourceSnapshotRef: 'snap-1',
    sourcePainIds: [],
    sourceGateBlockIds: [],
    storagePath: '/tmp/test',
    implementationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDatasource(overrides: Partial<LifecycleDatasource> = {}): LifecycleDatasource {
  const emptyTree: LedgerTreeStore = {
    principles: {},
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-01-01T00:00:00Z',
  };
  return {
    loadLedger: () => emptyTree,
    listReplayReports: () => [],
    listLineageRecords: (_kind: 'behavioral-sample' | 'rule-implementation-candidate') => [],
    ...overrides,
  };
}

describe('buildLifecycleReadModel', () => {
  it('returns empty read model when ledger has no principles', () => {
    const datasource = makeDatasource();
    const result = buildLifecycleReadModel(datasource);
    expect(result.principles).toHaveLength(0);
    expect(result.generatedAt).toBeTruthy();
  });

  it('returns principles with empty rules when ledger has principles but no rules', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: [], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    expect(result.principles).toHaveLength(1);
    const [p] = result.principles;
    expect(p).toBeDefined();
    expect(p?.principle.id).toBe('p1');
    expect(p?.rules).toHaveLength(0);
    expect(p?.summary.activeImplementationCount).toBe(0);
  });

  it('builds replay/lineage/live evidence for rules with implementations', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-1'],
    };
    const implementation: Implementation = {
      id: 'impl-1', ruleId: 'r1', type: 'hook', lifecycleState: 'active',
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: { 'impl-1': implementation },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(p).toBeDefined();
    expect(r).toBeDefined();
    expect(r?.implementations).toHaveLength(1);
    expect(r?.liveEvidence.activeCount).toBe(1);
    expect(r?.liveEvidence.hasActiveImplementation).toBe(true);
    expect(r?.replayEvidence.reportCount).toBe(0);
    expect(r?.lineageEvidence.distinctPainSignalCount).toBe(0);
  });

  it('computes passing/failing implementation IDs from replay reports', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-pass', 'impl-fail'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-pass': { id: 'impl-pass', ruleId: 'r1', lifecycleState: 'active' },
        'impl-fail': { id: 'impl-fail', ruleId: 'r1', lifecycleState: 'active' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({
      loadLedger: () => tree,
      listReplayReports: (implId: string) => {
        if (implId === 'impl-pass') return [makeReplayReport({ overallDecision: 'pass', implementationId: implId })];
        if (implId === 'impl-fail') return [makeReplayReport({ overallDecision: 'fail', implementationId: implId })];
        return [];
      },
    });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(p).toBeDefined();
    expect(r).toBeDefined();
    expect(r?.replayEvidence.passingImplementationIds).toEqual(['impl-pass']);
    expect(r?.replayEvidence.failingImplementationIds).toEqual(['impl-fail']);
    expect(r?.replayEvidence.reportCount).toBe(2);
  });

  it('computes distinctPainSignalCount and repeatedErrorSignal from lineage records', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: [],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {},
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const lineageRecords = [
      makeLineageRecord({ ruleId: 'r1', sourcePainIds: ['pain-a', 'pain-b'], sourceGateBlockIds: ['gate-1'] }),
      makeLineageRecord({ ruleId: 'r1', sourcePainIds: ['pain-a'], sourceGateBlockIds: ['gate-2'] }),
    ];
    const datasource = makeDatasource({
      loadLedger: () => tree,
      listLineageRecords: (_kind: 'behavioral-sample' | 'rule-implementation-candidate') => lineageRecords,
    });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(p).toBeDefined();
    expect(r).toBeDefined();
    expect(r?.lineageEvidence.distinctPainSignalCount).toBe(2);
    expect(r?.lineageEvidence.distinctGateBlockCount).toBe(2);
    expect(r?.lineageEvidence.repeatedErrorSignal).toBe(4);
    expect(r?.lineageEvidence.records).toHaveLength(2);
    expect(r?.lineageEvidence.latestCreatedAt).toBeTruthy();
  });

  it('sorts principles by id', () => {
    const makePrinciple = (id: string): LedgerPrinciple => ({
      id, version: 1, text: `Principle ${id}`, triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: [], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    });

    const tree: LedgerTreeStore = {
      principles: { z1: makePrinciple('z1'), a1: makePrinciple('a1'), m1: makePrinciple('m1') },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    expect(result.principles.map((p) => p.principle.id)).toEqual(['a1', 'm1', 'z1']);
  });

  it('aggregates summary counts across multiple rules', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1', 'r2'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule1: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['i1'],
    };
    const rule2: LedgerRule = {
      id: 'r2', principleId: 'p1', ruleIds: [], implementationIds: ['i2'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule1, r2: rule2 },
      implementations: {
        i1: { id: 'i1', ruleId: 'r1', lifecycleState: 'active' },
        i2: { id: 'i2', ruleId: 'r2', lifecycleState: 'disabled' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    expect(p).toBeDefined();
    expect(p?.summary.activeImplementationCount).toBe(1);
    expect(p?.summary.disabledImplementationCount).toBe(1);
  });

  it('computes durablePenaltyCount from disabled/archived implementations and disabledReason', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-disabled', 'impl-archived', 'impl-reason'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-disabled': { id: 'impl-disabled', ruleId: 'r1', lifecycleState: 'disabled' },
        'impl-archived': { id: 'impl-archived', ruleId: 'r1', lifecycleState: 'archived' },
        'impl-reason': { id: 'impl-reason', ruleId: 'r1', lifecycleState: 'active', disabledReason: 'broken' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(r).toBeDefined();
    expect(r?.liveEvidence.durablePenaltyCount).toBe(3);
  });

  it('computes rollbackEvidenceCount from previousActive', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-rollback'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-rollback': { id: 'impl-rollback', ruleId: 'r1', lifecycleState: 'active', previousActive: 'impl-old' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({ loadLedger: () => tree });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(r).toBeDefined();
    expect(r?.liveEvidence.rollbackEvidenceCount).toBe(1);
    expect(r?.liveEvidence.hasRollbackEvidence).toBeUndefined();
  });

  it('sets hasPassingActiveImplementation based on passing report on active impl', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-active'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-active': { id: 'impl-active', ruleId: 'r1', lifecycleState: 'active' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({
      loadLedger: () => tree,
      listReplayReports: (implId: string) => {
        if (implId === 'impl-active') {
          return [makeReplayReport({ implementationId: implId, overallDecision: 'pass' })];
        }
        return [];
      },
    });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(r?.liveEvidence.hasPassingActiveImplementation).toBe(true);
  });

  it('hasPassingActiveImplementation is false when active impl has fail report', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-active'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-active': { id: 'impl-active', ruleId: 'r1', lifecycleState: 'active' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({
      loadLedger: () => tree,
      listReplayReports: (implId: string) => {
        if (implId === 'impl-active') {
          return [makeReplayReport({ implementationId: implId, overallDecision: 'fail' })];
        }
        return [];
      },
    });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(r?.liveEvidence.hasPassingActiveImplementation).toBe(false);
  });

  it('computes needsReviewImplementationIds from needs-review replay reports', () => {
    const principle: LedgerPrinciple = {
      id: 'p1', version: 1, text: 'Test', triggerPattern: 'test', action: 'test',
      status: 'active', priority: 'P1', scope: 'general', evaluability: 'deterministic',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
      derivedFromPainIds: [], ruleIds: ['r1'], conflictsWithPrincipleIds: [],
      createdAt: '', updatedAt: '',
    };
    const rule: LedgerRule = {
      id: 'r1', principleId: 'p1', ruleIds: [], implementationIds: ['impl-review'],
    };
    const tree: LedgerTreeStore = {
      principles: { p1: principle },
      rules: { r1: rule },
      implementations: {
        'impl-review': { id: 'impl-review', ruleId: 'r1', lifecycleState: 'active' },
      },
      metrics: {},
      lastUpdated: '2026-01-01T00:00:00Z',
    };

    const datasource = makeDatasource({
      loadLedger: () => tree,
      listReplayReports: (implId: string) => {
        if (implId === 'impl-review') {
          return [makeReplayReport({ implementationId: implId, overallDecision: 'needs-review' })];
        }
        return [];
      },
    });
    const result = buildLifecycleReadModel(datasource);

    const [p] = result.principles;
    const [r] = p?.rules ?? [];
    expect(r).toBeDefined();
    expect(r?.replayEvidence.needsReviewImplementationIds).toEqual(['impl-review']);
    expect(r?.replayEvidence.reportCount).toBe(1);
  });
});
