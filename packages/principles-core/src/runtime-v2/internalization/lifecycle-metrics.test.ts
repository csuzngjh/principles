/**
 * Unit tests for lifecycle metrics — PRI-52
 */
import { describe, it, expect } from 'vitest';
import type { RuleLifecycleEvidence, PrincipleLifecycleEvidence } from './lifecycle-types.js';
import { computeRuleMetrics, computePrincipleAdherence } from './lifecycle-metrics.js';

// Helper builders — provide ALL required schema fields
function makeRuleEvidence(overrides: Partial<RuleLifecycleEvidence>): RuleLifecycleEvidence {
  const defaultRule = {
    id: 'rule-1', name: 'Test Rule', description: 'Test rule description', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '',
  };
  return {
    rule: overrides.rule ? { ...defaultRule, ...overrides.rule } : defaultRule,
    implementations: [],
    replayEvidence: { reportCount: 0, latestReports: [], painNegative: { total: 0, passed: 0, failed: 0 }, successPositive: { total: 0, passed: 0, failed: 0 }, principleAnchor: { total: 0, passed: 0, failed: 0 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
    liveEvidence: { activeCount: 0, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: false, hasPassingActiveImplementation: false },
    lineageEvidence: { records: [], distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal: 0 },
    ...overrides,
  };
}

function makePrincipleEvidence(rules: RuleLifecycleEvidence[], repeatedErrorSignal = 0): PrincipleLifecycleEvidence {
  const defaultPrinciple = { id: 'p1', name: 'Test Principle', text: 'Test principle', triggerPattern: 'test', action: 'test', status: 'active' as const, priority: 'P1' as const, scope: 'general' as const, evaluability: 'deterministic' as const, valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [] as string[], ruleIds: rules.map((r) => r.rule.id), conflictsWithPrincipleIds: [] as string[], version: 1, createdAt: '', updatedAt: '' };
  return {
    principle: defaultPrinciple,
    rules,
    summary: { replayReportCount: 0, activeImplementationCount: 0, candidateImplementationCount: 0, disabledImplementationCount: 0, archivedImplementationCount: 0, distinctPainSignalCount: 0, distinctGateBlockCount: 0, repeatedErrorSignal },
  };
}

// ===== computeRuleMetrics tests =====

describe('computeRuleMetrics', () => {
  it('returns zeros for empty replay data (total=0)', () => {
    const rule = makeRuleEvidence({
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
    });
    const result = computeRuleMetrics(rule);
    expect(result.painNegativeHitRate).toBe(0);
    expect(result.principleAnchorPassRate).toBe(0);
    expect(result.replayFalsePositiveRate).toBe(0);
  });

  it('returns 100 for all-passed metrics', () => {
    const rule = makeRuleEvidence({
      replayEvidence: {
        reportCount: 1,
        latestReports: [],
        painNegative: { total: 10, passed: 10, failed: 0 },
        successPositive: { total: 10, passed: 10, failed: 0 },
        principleAnchor: { total: 10, passed: 10, failed: 0 },
        passingImplementationIds: [],
        failingImplementationIds: [],
        needsReviewImplementationIds: [],
      },
    });
    const result = computeRuleMetrics(rule);
    expect(result.painNegativeHitRate).toBe(100);
    expect(result.principleAnchorPassRate).toBe(100);
    expect(result.replayFalsePositiveRate).toBe(0);
  });

  it('caps livePenaltyRate at 15', () => {
    const rule = makeRuleEvidence({
      liveEvidence: { durablePenaltyCount: 10, rollbackEvidenceCount: 10, activeCount: 0, candidateCount: 0, disabledCount: 0, archivedCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: false },
    });
    const result = computeRuleMetrics(rule);
    // 10*5 + 10*3 = 80, capped at 15
    expect(result.livePenaltyRate).toBe(15);
  });

  it('computes implementation stability score with active + passing implementations', () => {
    const rule = makeRuleEvidence({
      liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: true },
      replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 0, passed: 0, failed: 0 }, successPositive: { total: 0, passed: 0, failed: 0 }, principleAnchor: { total: 0, passed: 0, failed: 0 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
    });
    const result = computeRuleMetrics(rule);
    // 35 (active) + 30 (passing active) + 15 (replay report) + 10 (clean bonus) = 90
    expect(result.implementationStabilityScore).toBe(90);
  });

  it('deducts durable penalties from stability score', () => {
    const rule = makeRuleEvidence({
      liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 3, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: true },
      replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 0, passed: 0, failed: 0 }, successPositive: { total: 0, passed: 0, failed: 0 }, principleAnchor: { total: 0, passed: 0, failed: 0 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
    });
    const result = computeRuleMetrics(rule);
    // 35 (active) + 30 (passing active) + 15 (replay report) - 3*12 = 44
    // Clean bonus NOT applied because durablePenaltyCount > 0
    expect(result.implementationStabilityScore).toBe(44);
  });

  it('clamps coverageRate components to 0-100', () => {
    const rule = makeRuleEvidence({
      replayEvidence: {
        reportCount: 0,
        latestReports: [],
        painNegative: { total: 100, passed: 100, failed: 0 },
        successPositive: { total: 100, passed: 0, failed: 100 },
        principleAnchor: { total: 100, passed: 100, failed: 0 },
        passingImplementationIds: [],
        failingImplementationIds: [],
        needsReviewImplementationIds: [],
      },
      liveEvidence: { durablePenaltyCount: 0, rollbackEvidenceCount: 0, activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: false },
    });
    const result = computeRuleMetrics(rule);
    // stability = 35 (active) + 10 (clean bonus) = 45
    // coverage = 100*0.5 + 100*0.3 + 45*0.2 = 50+30+9 = 89
    expect(result.coverageRate).toBe(89);
    expect(result.falsePositiveRate).toBe(100);
  });

  it('handles NaN/Infinity in replay data by returning 0', () => {
    const rule = makeRuleEvidence({
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
    });
    const result = computeRuleMetrics(rule);
    expect(result.painNegativeHitRate).toBe(0);
    expect(result.principleAnchorPassRate).toBe(0);
    expect(result.replayFalsePositiveRate).toBe(0);
  });
});

// ===== computePrincipleAdherence tests =====

describe('computePrincipleAdherence', () => {
  it('returns insufficientData=true for empty rules', () => {
    const principle = makePrincipleEvidence([]);
    const result = computePrincipleAdherence(principle);
    expect(result.insufficientData).toBe(true);
    expect(result.adherenceRate).toBe(0);
    expect(result.stableRuleIds).toEqual([]);
    expect(result.unstableRuleIds).toEqual([]);
  });

  it('computes adherence with single rule', () => {
    const rule = makeRuleEvidence({
      replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 10, passed: 10, failed: 0 }, successPositive: { total: 10, passed: 10, failed: 0 }, principleAnchor: { total: 10, passed: 10, failed: 0 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
      liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: true },
    });
    const principle = makePrincipleEvidence([rule]);
    const result = computePrincipleAdherence(principle);
    expect(result.stableRuleIds).toContain('rule-1');
    expect(result.unstableRuleIds).not.toContain('rule-1');
  });

  it('classifies stable vs unstable rules correctly', () => {
    const stableRule = makeRuleEvidence({
      rule: { id: 'stable', name: 'Stable', description: 'test', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
      replayEvidence: { reportCount: 1, latestReports: [], painNegative: { total: 10, passed: 8, failed: 2 }, successPositive: { total: 10, passed: 9, failed: 1 }, principleAnchor: { total: 10, passed: 8, failed: 2 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
      liveEvidence: { activeCount: 1, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: true, hasPassingActiveImplementation: true },
    });
    const unstableRule = makeRuleEvidence({
      rule: { id: 'unstable', name: 'Unstable', description: 'test', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
      replayEvidence: { reportCount: 0, latestReports: [], painNegative: { total: 10, passed: 3, failed: 7 }, successPositive: { total: 10, passed: 2, failed: 8 }, principleAnchor: { total: 10, passed: 2, failed: 8 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
      liveEvidence: { activeCount: 0, candidateCount: 1, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 2, rollbackEvidenceCount: 1, hasActiveImplementation: false, hasPassingActiveImplementation: false },
    });
    const principle = makePrincipleEvidence([stableRule, unstableRule]);
    const result = computePrincipleAdherence(principle);
    expect(result.stableRuleIds).toContain('stable');
    expect(result.unstableRuleIds).toContain('unstable');
    expect(result.unstableRuleIds).not.toContain('stable');
    expect(result.stableRuleIds).not.toContain('unstable');
  });

  it('uses precomputedRuleMetrics when provided', () => {
    const rule = makeRuleEvidence({
      rule: { id: 'precomputed-rule', name: 'Rule', description: 'test', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
      replayEvidence: { reportCount: 0, latestReports: [], painNegative: { total: 0, passed: 0, failed: 0 }, successPositive: { total: 0, passed: 0, failed: 0 }, principleAnchor: { total: 0, passed: 0, failed: 0 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
      liveEvidence: { activeCount: 0, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: false, hasPassingActiveImplementation: false },
    });
    const principle = makePrincipleEvidence([rule]);
    const precomputed = { 'precomputed-rule': { coverageRate: 85, falsePositiveRate: 10, painNegativeHitRate: 90, principleAnchorPassRate: 80, implementationStabilityScore: 50, replayFalsePositiveRate: 5, livePenaltyRate: 0 } };
    const result = computePrincipleAdherence(principle, precomputed);
    expect(result.averageRuleCoverage).toBe(85);
  });

  it('handles zero rules (insufficientData)', () => {
    const principle = makePrincipleEvidence([], 5);
    const result = computePrincipleAdherence(principle);
    expect(result.insufficientData).toBe(true);
    expect(result.repeatedErrorSignal).toBe(5);
  });

  it('clamps repeatedErrorReductionScore to 0-100', () => {
    const rule = makeRuleEvidence({
      rule: { id: 'bad-rule', name: 'Bad', description: 'test', type: 'hook' as const, triggerCondition: 'test', enforcement: 'log' as const, action: 'test', principleId: 'p1', status: 'implemented' as const, coverageRate: 0, falsePositiveRate: 0, version: 1, createdAt: '', updatedAt: '' },
      replayEvidence: { reportCount: 0, latestReports: [], painNegative: { total: 10, passed: 0, failed: 10 }, successPositive: { total: 10, passed: 0, failed: 10 }, principleAnchor: { total: 10, passed: 0, failed: 10 }, passingImplementationIds: [], failingImplementationIds: [], needsReviewImplementationIds: [] },
      liveEvidence: { activeCount: 0, candidateCount: 0, disabledCount: 0, archivedCount: 0, durablePenaltyCount: 0, rollbackEvidenceCount: 0, hasActiveImplementation: false, hasPassingActiveImplementation: false },
    });
    const principle = makePrincipleEvidence([rule], 10);
    const result = computePrincipleAdherence(principle);
    // repeatedErrorPressure = signal*10 + unstableCount*12 + avgFP*0.4
    // = 10*10 + 1*12 + 100*0.4 = 100+12+40 = 152
    // repeatedErrorReductionScore = clampRate(100-152) = clampRate(-52) = 0
    expect(result.repeatedErrorReductionScore).toBe(0);
  });
});