import { describe, expect, it } from 'vitest';
import {
  computePrincipleAdherence,
  computeRuleMetrics,
} from '../../../src/core/principle-internalization/lifecycle-metrics.js';
import type {
  PrincipleLifecycleEvidence,
  RuleLifecycleEvidence,
} from '../../../src/core/principle-internalization/lifecycle-read-model.js';
import type { ReplayReport } from '../../../src/core/replay-engine.js';
import type { ArtifactLineageRecord } from '../../../src/core/nocturnal-artifact-lineage.js';

function createReplayReport(
  implementationId: string,
  overrides: Partial<ReplayReport> = {},
): ReplayReport {
  return {
    implementationId,
    generatedAt: '2026-04-08T00:00:00.000Z',
    overallDecision: 'pass',
    blockers: [],
    sampleFingerprints: [],
    replayResults: {
      painNegative: { total: 0, passed: 0, failed: 0, details: [] },
      successPositive: { total: 0, passed: 0, failed: 0, details: [] },
      principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
    },
    ...overrides,
  };
}

function createLineageRecord(overrides: Partial<ArtifactLineageRecord> = {}): ArtifactLineageRecord {
  return {
    artifactKind: 'rule-implementation-candidate',
    artifactId: 'artifact-1',
    principleId: 'P-001',
    ruleId: 'R-001',
    sessionId: 'session-1',
    sourceSnapshotRef: 'snapshot-1',
    sourcePainIds: [],
    sourceGateBlockIds: [],
    storagePath: '.state/principles/implementations/IMPL-001',
    implementationId: 'IMPL-001',
    createdAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function createRuleEvidence(overrides: Partial<RuleLifecycleEvidence> = {}): RuleLifecycleEvidence {
  return {
    rule: {
      id: 'R-001',
      version: 1,
      name: 'Protect deletes',
      description: 'Require safe delete handling',
      type: 'hook',
      triggerCondition: 'tool=delete',
      enforcement: 'block',
      action: 'block destructive delete',
      principleId: 'P-001',
      status: 'enforced',
      coverageRate: 0,
      falsePositiveRate: 0,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      implementationIds: ['IMPL-001'],
    },
    implementations: [],
    replayEvidence: {
      reportCount: 0,
      latestReports: [],
      painNegative: { total: 0, passed: 0, failed: 0 },
      successPositive: { total: 0, passed: 0, failed: 0 },
      principleAnchor: { total: 0, passed: 0, failed: 0 },
      passingImplementationIds: [],
      failingImplementationIds: [],
      needsReviewImplementationIds: [],
    },
    liveEvidence: {
      activeCount: 0,
      candidateCount: 0,
      disabledCount: 0,
      archivedCount: 0,
      durablePenaltyCount: 0,
      rollbackEvidenceCount: 0,
      hasActiveImplementation: false,
      hasPassingActiveImplementation: false,
    },
    lineageEvidence: {
      records: [],
      distinctPainSignalCount: 0,
      distinctGateBlockCount: 0,
      repeatedErrorSignal: 0,
    },
    ...overrides,
  };
}

function createPrincipleEvidence(
  rules: RuleLifecycleEvidence[],
  overrides: Partial<PrincipleLifecycleEvidence> = {},
): PrincipleLifecycleEvidence {
  return {
    principle: {
      id: 'P-001',
      version: 1,
      text: 'Write before delete',
      triggerPattern: 'delete',
      action: 'write replacement first',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: 'deterministic',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: [],
      ruleIds: rules.map((rule) => rule.rule.id),
      conflictsWithPrincipleIds: [],
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
    },
    rules,
    summary: {
      replayReportCount: rules.reduce((sum, rule) => sum + rule.replayEvidence.reportCount, 0),
      activeImplementationCount: rules.reduce((sum, rule) => sum + rule.liveEvidence.activeCount, 0),
      candidateImplementationCount: rules.reduce((sum, rule) => sum + rule.liveEvidence.candidateCount, 0),
      disabledImplementationCount: rules.reduce((sum, rule) => sum + rule.liveEvidence.disabledCount, 0),
      archivedImplementationCount: rules.reduce((sum, rule) => sum + rule.liveEvidence.archivedCount, 0),
      distinctPainSignalCount: rules.reduce((sum, rule) => sum + rule.lineageEvidence.distinctPainSignalCount, 0),
      distinctGateBlockCount: rules.reduce((sum, rule) => sum + rule.lineageEvidence.distinctGateBlockCount, 0),
      repeatedErrorSignal: rules.reduce((sum, rule) => sum + rule.lineageEvidence.repeatedErrorSignal, 0),
    },
    ...overrides,
  };
}

describe('lifecycle-metrics', () => {
  it('keeps sparse evidence bounded at zero instead of inferring coverage from implementation existence', () => {
    const metrics = computeRuleMetrics(createRuleEvidence());

    expect(metrics.coverageRate).toBe(0);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.implementationStabilityScore).toBe(0);
  });

  it('computes strong rule coverage from replay hits, anchor passes, and stable active implementations', () => {
    const report = createReplayReport('IMPL-001', {
      replayResults: {
        painNegative: { total: 4, passed: 4, failed: 0, details: [] },
        successPositive: { total: 3, passed: 3, failed: 0, details: [] },
        principleAnchor: { total: 2, passed: 2, failed: 0, details: [] },
      },
    });
    const metrics = computeRuleMetrics(
      createRuleEvidence({
        implementations: [
          {
            implementation: {
              id: 'IMPL-001',
              ruleId: 'R-001',
              type: 'code',
              path: 'impl/entry.js',
              version: 'v1',
              coversCondition: 'delete safety',
              coveragePercentage: 100,
              lifecycleState: 'active',
              createdAt: '2026-04-08T00:00:00.000Z',
              updatedAt: '2026-04-08T00:00:00.000Z',
            },
            latestReplayReport: report,
            replayHistoryCount: 1,
            lineageRecords: [],
          },
        ],
        replayEvidence: {
          reportCount: 1,
          latestReports: [report],
          painNegative: { total: 4, passed: 4, failed: 0 },
          successPositive: { total: 3, passed: 3, failed: 0 },
          principleAnchor: { total: 2, passed: 2, failed: 0 },
          passingImplementationIds: ['IMPL-001'],
          failingImplementationIds: [],
          needsReviewImplementationIds: [],
        },
        liveEvidence: {
          activeCount: 1,
          candidateCount: 0,
          disabledCount: 0,
          archivedCount: 0,
          durablePenaltyCount: 0,
          rollbackEvidenceCount: 0,
          hasActiveImplementation: true,
          hasPassingActiveImplementation: true,
        },
      }),
    );

    expect(metrics.coverageRate).toBe(98);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.implementationStabilityScore).toBe(90);
  });

  it('grounds false-positive rate in success-positive replay failures and only adds a coarse live penalty', () => {
    const report = createReplayReport('IMPL-001', {
      overallDecision: 'needs-review',
      replayResults: {
        painNegative: { total: 2, passed: 2, failed: 0, details: [] },
        successPositive: { total: 4, passed: 1, failed: 3, details: [] },
        principleAnchor: { total: 2, passed: 2, failed: 0, details: [] },
      },
    });
    const metrics = computeRuleMetrics(
      createRuleEvidence({
        replayEvidence: {
          reportCount: 1,
          latestReports: [report],
          painNegative: { total: 2, passed: 2, failed: 0 },
          successPositive: { total: 4, passed: 1, failed: 3 },
          principleAnchor: { total: 2, passed: 2, failed: 0 },
          passingImplementationIds: [],
          failingImplementationIds: [],
          needsReviewImplementationIds: ['IMPL-001'],
        },
        liveEvidence: {
          activeCount: 1,
          candidateCount: 0,
          disabledCount: 1,
          archivedCount: 0,
          durablePenaltyCount: 1,
          rollbackEvidenceCount: 0,
          hasActiveImplementation: true,
          hasPassingActiveImplementation: false,
        },
      }),
    );

    expect(metrics.replayFalsePositiveRate).toBe(75);
    expect(metrics.livePenaltyRate).toBe(5);
    expect(metrics.falsePositiveRate).toBe(80);
  });

  it('penalizes rollback and repeated errors when computing principle adherence', () => {
    const stableRule = createRuleEvidence({
      rule: {
        ...createRuleEvidence().rule,
        id: 'R-001',
      },
      replayEvidence: {
        reportCount: 1,
        latestReports: [createReplayReport('IMPL-001')],
        painNegative: { total: 3, passed: 3, failed: 0 },
        successPositive: { total: 2, passed: 2, failed: 0 },
        principleAnchor: { total: 2, passed: 2, failed: 0 },
        passingImplementationIds: ['IMPL-001'],
        failingImplementationIds: [],
        needsReviewImplementationIds: [],
      },
      liveEvidence: {
        activeCount: 1,
        candidateCount: 0,
        disabledCount: 0,
        archivedCount: 0,
        durablePenaltyCount: 0,
        rollbackEvidenceCount: 0,
        hasActiveImplementation: true,
        hasPassingActiveImplementation: true,
      },
    });
    const unstableRule = createRuleEvidence({
      rule: {
        ...createRuleEvidence().rule,
        id: 'R-002',
        implementationIds: ['IMPL-002'],
      },
      implementations: [
        {
          implementation: {
            id: 'IMPL-002',
            ruleId: 'R-002',
            type: 'code',
            path: 'impl/rollback.js',
            version: 'v2',
            coversCondition: 'delete safety',
            coveragePercentage: 70,
            lifecycleState: 'disabled',
            previousActive: 'IMPL-001',
            disabledReason: 'Rollback after false positive spike',
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z',
          },
          latestReplayReport: createReplayReport('IMPL-002', {
            overallDecision: 'needs-review',
            replayResults: {
              painNegative: { total: 2, passed: 1, failed: 1, details: [] },
              successPositive: { total: 2, passed: 1, failed: 1, details: [] },
              principleAnchor: { total: 2, passed: 1, failed: 1, details: [] },
            },
          }),
          replayHistoryCount: 1,
          lineageRecords: [createLineageRecord({ sourcePainIds: ['pain-1', 'pain-2'] })],
        },
      ],
      replayEvidence: {
        reportCount: 1,
        latestReports: [
          createReplayReport('IMPL-002', {
            overallDecision: 'needs-review',
            replayResults: {
              painNegative: { total: 2, passed: 1, failed: 1, details: [] },
              successPositive: { total: 2, passed: 1, failed: 1, details: [] },
              principleAnchor: { total: 2, passed: 1, failed: 1, details: [] },
            },
          }),
        ],
        painNegative: { total: 2, passed: 1, failed: 1 },
        successPositive: { total: 2, passed: 1, failed: 1 },
        principleAnchor: { total: 2, passed: 1, failed: 1 },
        passingImplementationIds: [],
        failingImplementationIds: [],
        needsReviewImplementationIds: ['IMPL-002'],
      },
      liveEvidence: {
        activeCount: 0,
        candidateCount: 0,
        disabledCount: 1,
        archivedCount: 0,
        durablePenaltyCount: 1,
        rollbackEvidenceCount: 1,
        hasActiveImplementation: false,
        hasPassingActiveImplementation: false,
      },
      lineageEvidence: {
        records: [createLineageRecord({ ruleId: 'R-002', implementationId: 'IMPL-002', sourcePainIds: ['pain-1', 'pain-2'] })],
        distinctPainSignalCount: 2,
        distinctGateBlockCount: 0,
        repeatedErrorSignal: 2,
        latestCreatedAt: '2026-04-08T00:00:00.000Z',
      },
    });

    const adherence = computePrincipleAdherence(createPrincipleEvidence([stableRule, unstableRule]));

    expect(adherence.averageRuleCoverage).toBe(69);
    expect(adherence.repeatedErrorReductionScore).toBe(56.4);
    expect(adherence.adherenceRate).toBe(65.22);
    expect(adherence.stableRuleIds).toEqual(['R-001']);
    expect(adherence.unstableRuleIds).toEqual(['R-002']);
  });
});
