import { describe, expect, it } from 'vitest';
import { assessDeprecatedReadiness } from '../../../src/core/principle-internalization/deprecated-readiness.js';
import type {
  PrincipleLifecycleEvidence,
  RuleLifecycleEvidence,
} from '../../../src/core/principle-internalization/lifecycle-read-model.js';

function createRuleEvidence(
  id: string,
  overrides: Partial<RuleLifecycleEvidence> = {},
): RuleLifecycleEvidence {
  return {
    rule: {
      id,
      version: 1,
      name: id,
      description: id,
      type: 'hook',
      triggerCondition: 'tool=delete',
      enforcement: 'block',
      action: 'block unsafe delete',
      principleId: 'P-001',
      status: 'enforced',
      coverageRate: 0,
      falsePositiveRate: 0,
      implementationIds: [`IMPL-${id}`],
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
    },
    implementations: [],
    replayEvidence: {
      reportCount: 1,
      latestReports: [],
      painNegative: { total: 4, passed: 4, failed: 0 },
      successPositive: { total: 4, passed: 4, failed: 0 },
      principleAnchor: { total: 4, passed: 4, failed: 0 },
      passingImplementationIds: [`IMPL-${id}`],
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

describe('deprecated-readiness', () => {
  it('marks a principle ready when stable lower-layer implementations absorb every rule', () => {
    const assessment = assessDeprecatedReadiness(
      createPrincipleEvidence([createRuleEvidence('R-001'), createRuleEvidence('R-002')]),
    );

    expect(assessment.status).toBe('ready');
    expect(assessment.score).toBeGreaterThan(90);
    expect(assessment.blockingReasons).toEqual([]);
    expect(assessment.supportingRuleIds).toEqual(['R-001', 'R-002']);
  });

  it('keeps a principle on watch when coverage is mixed but the lower layer is partially absorbing it', () => {
    const assessment = assessDeprecatedReadiness(
      createPrincipleEvidence([
        createRuleEvidence('R-001'),
        createRuleEvidence('R-002', {
          replayEvidence: {
            reportCount: 1,
            latestReports: [],
            painNegative: { total: 4, passed: 3, failed: 1 },
            successPositive: { total: 4, passed: 4, failed: 0 },
            principleAnchor: { total: 4, passed: 2, failed: 2 },
            passingImplementationIds: [],
            failingImplementationIds: ['IMPL-R-002'],
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
            hasPassingActiveImplementation: false,
          },
          lineageEvidence: {
            records: [],
            distinctPainSignalCount: 1,
            distinctGateBlockCount: 0,
            repeatedErrorSignal: 1,
          },
        }),
      ]),
    );

    expect(assessment.status).toBe('watch');
    expect(assessment.score).toBeGreaterThanOrEqual(55);
    expect(assessment.blockingReasons).toContain('Repeated related errors have not fallen enough yet.');
    expect(assessment.supportingRuleIds).toEqual(['R-001']);
  });

  it('returns not-ready with explicit blocking reasons instead of mutating principle status', () => {
    const assessment = assessDeprecatedReadiness(
      createPrincipleEvidence([
        createRuleEvidence('R-001', {
          replayEvidence: {
            reportCount: 1,
            latestReports: [],
            painNegative: { total: 4, passed: 2, failed: 2 },
            successPositive: { total: 4, passed: 1, failed: 3 },
            principleAnchor: { total: 4, passed: 1, failed: 3 },
            passingImplementationIds: [],
            failingImplementationIds: ['IMPL-R-001'],
            needsReviewImplementationIds: [],
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
            records: [],
            distinctPainSignalCount: 2,
            distinctGateBlockCount: 1,
            repeatedErrorSignal: 3,
          },
        }),
      ]),
    );

    expect(assessment.status).toBe('not-ready');
    expect(assessment.blockingReasons).toContain('No active lower-layer implementation is absorbing the principle.');
    expect(assessment.blockingReasons).toContain('False-positive rate remains too high for deprecation readiness.');
    expect(assessment.blockingReasons).toContain('Repeated related errors have not fallen enough yet.');
    expect(assessment.supportingRuleIds).toEqual([]);
  });
});
