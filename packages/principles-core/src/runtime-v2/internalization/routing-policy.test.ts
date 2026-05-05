import { describe, expect, it } from 'vitest';
import { recommendLifecycleRoute } from './routing-policy.js';
import type {
  PrincipleLifecycleEvidence,
  RuleLifecycleEvidence,
} from './lifecycle-types.js';

function createRuleEvidence(id: string, overrides: Partial<RuleLifecycleEvidence> = {}): RuleLifecycleEvidence {
  return {
    rule: {
      id,
      version: 1,
      name: id,
      description: id,
      type: 'hook',
      triggerCondition: 'tool=write',
      enforcement: 'block',
      action: 'block risky write',
      principleId: 'P-001',
      status: 'enforced',
      coverageRate: 0,
      falsePositiveRate: 0,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
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
      text: 'Do the cheapest safe thing first',
      triggerPattern: 'write',
      action: 'prefer cheap safe fixes',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: 'weak_heuristic',
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

describe('recommendLifecycleRoute', () => {
  it('recommends code for deterministic high-risk principles with repeated failures', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence(
        [
          createRuleEvidence('R-001', {
            replayEvidence: {
              reportCount: 2,
              latestReports: [],
              painNegative: { total: 4, passed: 2, failed: 2 },
              successPositive: { total: 2, passed: 2, failed: 0 },
              principleAnchor: { total: 2, passed: 1, failed: 1 },
              passingImplementationIds: [],
              failingImplementationIds: ['IMPL-R-001'],
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
              distinctPainSignalCount: 2,
              distinctGateBlockCount: 1,
              repeatedErrorSignal: 3,
            },
          }),
        ],
        {
          principle: {
            ...createPrincipleEvidence([]).principle,
            priority: 'P0',
            evaluability: 'deterministic',
            ruleIds: ['R-001'],
          },
          summary: {
            replayReportCount: 2,
            activeImplementationCount: 1,
            candidateImplementationCount: 0,
            disabledImplementationCount: 0,
            archivedImplementationCount: 0,
            distinctPainSignalCount: 2,
            distinctGateBlockCount: 1,
            repeatedErrorSignal: 3,
          },
        },
      ),
    );

    expect(recommendation.route).toBe('code');
    expect(recommendation.reasonCodes).toContain('deterministic_or_high_risk');
    expect(recommendation.reasonCodes).toContain('repeated_errors_continue');
    expect(recommendation.nextAction).toContain('manual');
  });

  it('recommends skill when a cheaper non-code path is viable', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence([
        createRuleEvidence('R-001', {
          rule: {
            ...createRuleEvidence('R-001').rule,
            type: 'skill',
            enforcement: 'warn',
          },
          replayEvidence: {
            reportCount: 1,
            latestReports: [],
            painNegative: { total: 3, passed: 2, failed: 1 },
            successPositive: { total: 3, passed: 3, failed: 0 },
            principleAnchor: { total: 1, passed: 1, failed: 0 },
            passingImplementationIds: [],
            failingImplementationIds: [],
            needsReviewImplementationIds: ['IMPL-R-001'],
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
            distinctPainSignalCount: 1,
            distinctGateBlockCount: 0,
            repeatedErrorSignal: 1,
          },
        }),
      ]),
    );

    expect(recommendation.route).toBe('skill');
    expect(recommendation.reasonCodes).toContain('cheapest_viable_skill');
    expect(recommendation.reasonCodes).toContain('no_hard_boundary_required');
  });

  it('recommends defer when evidence is too sparse', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence([createRuleEvidence('R-001')]),
    );

    expect(recommendation.route).toBe('defer');
    expect(recommendation.reasonCodes).toEqual(['sparse_evidence']);
  });

  it('recommends defer when no rules exist', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence([]),
    );

    expect(recommendation.route).toBe('defer');
    expect(recommendation.confidence).toBe(50);
    expect(recommendation.reasonCodes).toContain('insufficient_data');
    expect(recommendation.reasonCodes).toContain('no_material_rules');
  });

  it('recommends defer when principle is already absorbing well', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence(
        [createRuleEvidence('R-001', {
          replayEvidence: {
            reportCount: 2,
            latestReports: [],
            painNegative: { total: 10, passed: 10, failed: 0 },
            successPositive: { total: 5, passed: 5, failed: 0 },
            principleAnchor: { total: 2, passed: 2, failed: 0 },
            passingImplementationIds: ['IMPL-R-001'],
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
        })],
        {
          summary: {
            replayReportCount: 2,
            activeImplementationCount: 1,
            candidateImplementationCount: 0,
            disabledImplementationCount: 0,
            archivedImplementationCount: 0,
            distinctPainSignalCount: 0,
            distinctGateBlockCount: 0,
            repeatedErrorSignal: 0,
          },
        },
      ),
    );

    expect(recommendation.route).toBe('defer');
    expect(recommendation.reasonCodes).toContain('already_absorbing');
  });

  it('applies axiom boost for governance axioms (T-05)', () => {
    const recommendation = recommendLifecycleRoute(
      createPrincipleEvidence(
        [createRuleEvidence('R-001', {
          replayEvidence: {
            reportCount: 2,
            latestReports: [],
            painNegative: { total: 4, passed: 2, failed: 2 },
            successPositive: { total: 2, passed: 2, failed: 0 },
            principleAnchor: { total: 2, passed: 1, failed: 1 },
            passingImplementationIds: [],
            failingImplementationIds: ['IMPL-R-001'],
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
            distinctPainSignalCount: 2,
            distinctGateBlockCount: 1,
            repeatedErrorSignal: 1,
          },
        })],
        {
          principle: {
            ...createPrincipleEvidence([]).principle,
            priority: 'P0',
            evaluability: 'deterministic',
            coreAxiomId: 'T-05',
            ruleIds: ['R-001'],
          },
          summary: {
            replayReportCount: 2,
            activeImplementationCount: 1,
            candidateImplementationCount: 0,
            disabledImplementationCount: 0,
            archivedImplementationCount: 0,
            distinctPainSignalCount: 2,
            distinctGateBlockCount: 1,
            repeatedErrorSignal: 1,
          },
        },
      ),
    );

    expect(recommendation.route).toBe('code');
    expect(recommendation.reasonCodes).toContain('axiom_governance_enforcement');
  });
});
