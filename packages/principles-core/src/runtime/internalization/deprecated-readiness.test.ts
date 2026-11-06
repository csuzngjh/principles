/**
 * Unit tests for deprecated readiness — PRI-53
 */
import { describe, it, expect } from 'vitest';
import type { RuleLifecycleEvidence, PrincipleLifecycleEvidence } from './lifecycle-types.js';
import type { RuleMetricResult, PrincipleAdherenceResult } from './lifecycle-metrics.js';
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

function makePrincipleEvidence(rules: RuleLifecycleEvidence[], overrides?: Partial<PrincipleLifecycleEvidence>): PrincipleLifecycleEvidence {
  const defaultPrinciple = { id: 'p1', name: 'Test', text: 'Test', triggerPattern: 'test', action: 'test', status: 'active' as const, priority: 'P1' as const, scope: 'general' as const, evaluability: 'deterministic' as const, valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [] as string[], ruleIds: rules.map((r) => r.rule.id), conflictsWithPrincipleIds: [] as string[], version: 1, createdAt: '', updatedAt: '' };
  return {
    principle: defaultPrinciple,
    rules,
    summary: { replayReportCount: rules.reduce((s, r) => s + r.replayEvidence.reportCount, 0), activeImplementationCount: rules.reduce((s, r) => s + r.liveEvidence.activeCount, 0), candidateImplementationCount: 0, disabledImplementationCount: 0, archivedImplementationCount: 0, distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal: rules.reduce((s, r) => s + r.lineageEvidence.repeatedErrorSignal, 0) },
    ...overrides,
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

  // Issue 3a: empty rules array → not-ready + "No material rules..."
  it('returns not-ready with empty rules array', () => {
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([], {
        summary: { replayReportCount: 0, activeImplementationCount: 0, candidateImplementationCount: 0, disabledImplementationCount: 0, archivedImplementationCount: 0, distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal: 0 },
      }),
    );
    expect(assessment.status).toBe('not-ready');
    expect(assessment.blockingReasons).toContain('No material rules are attached to this principle yet.');
    expect(assessment.supportingRuleIds).toEqual([]);
    expect(assessment.score).toBe(15); // averageFalsePositiveRate=0 → (100-0)*0.15 = 15
  });

  // Issue 3b: extreme false positive rate via precomputed adherence
  it('returns low score when false positive rate is extreme', () => {
    const precomputedAdherence: PrincipleAdherenceResult = {
      insufficientData: false,
      adherenceRate: 0,
      averageRuleCoverage: 0,
      averageFalsePositiveRate: 100,
      repeatedErrorReductionScore: 0,
      repeatedErrorSignal: 0,
      stableRuleIds: [],
      unstableRuleIds: ['rule-bad'],
    };
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([
        makeRuleEvidence({
          rule: { id: 'rule-bad', name: 'Bad', description: '', type: 'hook', triggerCondition: '', enforcement: 'log', action: '', principleId: 'p1', status: 'implemented', coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
        }),
      ]),
      undefined, // no precomputedRuleMetrics
      precomputedAdherence,
    );
    // score = 0*0.45 + 0*0.25 + (100-100)*0.15 + 0*0.15 = 0
    expect(assessment.score).toBe(0);
    expect(assessment.status).toBe('not-ready');
    expect(assessment.blockingReasons).toContain('Rule coverage is not yet stable enough to absorb the principle.');
    expect(assessment.blockingReasons).toContain('False-positive rate remains too high for deprecation readiness.');
  });

  // Issue 3c: precomputedRuleMetrics bypasses internal compute
  it('uses precomputedRuleMetrics when provided (skips internal compute)', () => {
    const precomputedMetrics: Record<string, RuleMetricResult> = {
      'rule-1': {
        coverageRate: 100,
        falsePositiveRate: 5,
        painNegativeHitRate: 100,
        principleAnchorPassRate: 100,
        implementationStabilityScore: 90,
        replayFalsePositiveRate: 5,
        livePenaltyRate: 0,
      },
    };
    const precomputedAdherence: PrincipleAdherenceResult = {
      insufficientData: false,
      adherenceRate: 100,
      averageRuleCoverage: 100,
      averageFalsePositiveRate: 5,
      repeatedErrorReductionScore: 100,
      repeatedErrorSignal: 0,
      stableRuleIds: ['rule-1'],
      unstableRuleIds: [],
    };
    const assessment = assessDeprecatedReadiness(
      makePrincipleEvidence([makeRuleEvidence({})]),
      precomputedMetrics,
      precomputedAdherence,
    );
    // Score = 100*0.45 + 100*0.25 + (100-5)*0.15 + 100*0.15 = 45+25+14.25+15 = 99.25
    expect(assessment.status).toBe('ready');
    expect(assessment.score).toBeCloseTo(99.25);
  });
});
