/**
 * Unit tests for deprecated readiness — PRI-53
 */
import { describe, it, expect } from 'vitest';
import type { RuleLifecycleEvidence, PrincipleLifecycleEvidence } from './lifecycle-types.js';
import { assessDeprecatedReadiness } from './deprecated-readiness.js';

function makeRuleEvidence(overrides: Partial<RuleLifecycleEvidence>): RuleLifecycleEvidence {
  const defaultRule = {
    id: 'rule-1', name: 'Test Rule', description: 'Test', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '',
  };
  return {
    rule: overrides.rule ? { ...defaultRule, ...overrides.rule } : defaultRule,
    implementations: [],
    replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 4, passed: 4, failed: 0 }, successPositive: { total: 4, passed: 4, failed: 0 }, principleAnchor: { total: 4, passed: 4, failed: 0 }, passingImplementationIds: ['impl-1'], failingImplementationIds: [], needsReviewImplementationIds: [] },
    liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: true },
    lineageEvidence: { records: [], distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal: 0 },
    ...overrides,
  };
}

function makePrincipleEvidence(rules: RuleLifecycleEvidence[]): PrincipleLifecycleEvidence {
  const defaultPrinciple = { id: 'p1', name: 'Test', text: 'Test', triggerPattern: 'test', action: 'test', status: 'active' as const, priority: 'P1' as const, scope: 'general' as const, evaluability: 'deterministic' as const, valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [] as string[], ruleIds: rules.map((r) => r.rule.id), conflictsWithPrincipleIds: [] as string[], version: 1, createdAt: '', updatedAt: '' };
  return {
    principle: defaultPrinciple,
    rules,
    summary: { replayReportCount: rules.reduce((s, r) => s + r.replayEvidence.reportCount, 0), activeImplementationCount: rules.reduce((s, r) => s + r.liveEvidence.activeCount, 0), candidateImplementationCount: 0, disabledImplementationCount: 0, archivedImplementationCount: 0, distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal: rules.reduce((s, r) => s + r.lineageEvidence.repeatedErrorSignal, 0) },
  };
}

describe('assessDeprecatedReadiness', () => {
  it('marks ready when stable implementations absorb every rule', () => {
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([makeRuleEvidence({}), makeRuleEvidence({ rule: { id: 'rule-2', name: 'R2', description: '', type: 'hook', triggerCondition: '', enforcement: 'log', action: '', principleId: 'p1', status: 'implemented', coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' } })]),
    );
    expect(assessment.status).toBe('ready');
    expect(assessment.score).toBeGreaterThan(90);
    expect(assessment.blockingReasons).toEqual([]);
    expect(assessment.supportingRuleIds).toHaveLength(2);
  });

  it('keeps on watch when coverage is mixed', () => {
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([
        makeRuleEvidence({}),
        makeRuleEvidence({
          rule: { id: 'unstable', name: 'U', description: '', type: 'hook', triggerCondition: '', enforcement: 'log', action: '', principleId: 'p1', status: 'implemented', coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
          replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 4, passed: 3, failed: 1 }, successPositive: { total: 4, passed: 4, failed: 0 }, principleAnchor: { total: 4, passed: 2, failed: 2 }, passingImplementationIds: [], failingImplementationIds: ['impl-u'], needsReviewImplementationIds: [] },
          liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: false },
          lineageEvidence: { records: [], distinctPainSignalCount: 1, distinctGateBlockCount: 0, repeatedErrorSignal: 1 },
        }),
      ]),
    );
    expect(assessment.status).toBe('watch');
    expect(assessment.score).toBeGreaterThanOrEqual(55);
    expect(assessment.blockingReasons).toContain('Repeated related errors have not fallen enough yet.');
  });

  it('returns not-ready with blocking reasons', () => {
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([
        makeRuleEvidence({
          rule: { id: 'bad', name: 'B', description: '', type: 'hook', triggerCondition: '', enforcement: 'log', action: '', principleId: 'p1', status: 'implemented', coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
          replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 4, passed: 2, failed: 2 }, successPositive: { total: 4, passed: 1, failed: 3 }, principleAnchor: { total: 4, passed: 1, failed: 3 }, passingImplementationIds: [], failingImplementationIds: ['impl-b'], needsReviewImplementationIds: [] },
          liveEvidence: { activeCount: 0, candidateCount: 0, disabledCount: 1, archivedCount: 0, durablePenaltyCount: 1, rollbackEvidenceCount: 1, hasActiveImplementation: false, hasPassingActiveImplementation: false },
          lineageEvidence: { records: [], distinctPainSignalCount: 2, distinctGateBlockCount: 1, repeatedErrorSignal: 3 },
        }),
      ]),
    );
    expect(assessment.status).toBe('not-ready');
    expect(assessment.blockingReasons).toContain('No active lower-layer implementation is absorbing the principle.');
    expect(assessment.blockingReasons).toContain('False-positive rate remains too high for deprecation readiness.');
    expect(assessment.blockingReasons).toContain('Repeated related errors have not fallen enough yet.');
  });
});
