/**
 * Lifecycle read model builder — pure computation over datasource interface.
 * PRI-56: Extracted from the plugin layer.
 *
 * 7 pure helper functions + buildLifecycleReadModel(datasource) orchestration.
 * Zero I/O dependencies — all data comes through LifecycleDatasource.
 */
import type { LifecycleDatasource } from './lifecycle-datasource.js';
import type {
  LifecycleClassificationTotals,
  RuleReplayEvidence,
  RuleLiveEvidence,
  RuleLineageEvidence,
  ImplementationLifecycleEvidence,
  RuleLifecycleEvidence,
  PrincipleLifecycleEvidence,
  LifecycleReadModel,
} from './lifecycle-types.js';
import type {
  ReplayReport,
  ClassificationSummary,
  ArtifactLineageRecord,
} from '../types/index.js';
import type { Implementation, Rule } from '../types/principle-schema.js';
import type { ImplementationLifecycleState } from '../types/principle-enums.js';

function toClassificationTotals(summary: ClassificationSummary[]): LifecycleClassificationTotals {
  return summary.reduce<LifecycleClassificationTotals>(
    (totals, entry) => ({
      total: totals.total + entry.total,
      passed: totals.passed + entry.passed,
      failed: totals.failed + entry.failed,
    }),
    { total: 0, passed: 0, failed: 0 },
  );
}

function countByLifecycle(implementations: Implementation[], lifecycleState: ImplementationLifecycleState): number {
  return implementations.filter((implementation) => implementation.lifecycleState === lifecycleState).length;
}

function hasDurablePenalty(implementation: Implementation): boolean {
  if (implementation.lifecycleState === 'disabled' || implementation.lifecycleState === 'archived') {
    return true;
  }

  return typeof implementation.disabledReason === 'string' && implementation.disabledReason.trim().length > 0;
}

function hasRollbackEvidence(implementation: Implementation): boolean {
  return typeof implementation.previousActive === 'string' && implementation.previousActive.length > 0;
}

function createRuleReplayEvidence(reports: { implementationId: string; report: ReplayReport }[]): RuleReplayEvidence {
  return {
    reportCount: reports.length,
    latestReports: reports.map((entry) => entry.report),
    painNegative: toClassificationTotals(reports.map((entry) => entry.report.replayResults.painNegative)),
    successPositive: toClassificationTotals(reports.map((entry) => entry.report.replayResults.successPositive)),
    principleAnchor: toClassificationTotals(reports.map((entry) => entry.report.replayResults.principleAnchor)),
    passingImplementationIds: reports
      .filter((entry) => entry.report.overallDecision === 'pass')
      .map((entry) => entry.implementationId),
    failingImplementationIds: reports
      .filter((entry) => entry.report.overallDecision === 'fail')
      .map((entry) => entry.implementationId),
    needsReviewImplementationIds: reports
      .filter((entry) => entry.report.overallDecision === 'needs-review')
      .map((entry) => entry.implementationId),
  };
}

function createRuleLineageEvidence(records: ArtifactLineageRecord[], sourceRetired = false): RuleLineageEvidence {
  const painIds = new Set<string>();
  const gateBlockIds = new Set<string>();

  for (const record of records) {
    for (const painId of record.sourcePainIds) {
      painIds.add(painId);
    }
    for (const gateBlockId of record.sourceGateBlockIds) {
      gateBlockIds.add(gateBlockId);
    }
  }

  const latestCreatedAt =
    records.length > 0
      ? records
          .map((record) => record.createdAt)
          .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0]
      : undefined;

  return {
    records,
    distinctPainSignalCount: painIds.size,
    distinctGateBlockCount: gateBlockIds.size,
    repeatedErrorSignal: painIds.size + gateBlockIds.size,
    latestCreatedAt,
    sourceRetired,
  };
}

function createRuleLiveEvidence(
  implementations: Implementation[],
  replayEvidence: RuleReplayEvidence,
): RuleLiveEvidence {
  const activeImplementations = implementations.filter((implementation) => implementation.lifecycleState === 'active');

  return {
    activeCount: countByLifecycle(implementations, 'active'),
    candidateCount: countByLifecycle(implementations, 'candidate'),
    disabledCount: countByLifecycle(implementations, 'disabled'),
    archivedCount: countByLifecycle(implementations, 'archived'),
    durablePenaltyCount: implementations.filter((implementation) => hasDurablePenalty(implementation)).length,
    rollbackEvidenceCount: implementations.filter((implementation) => hasRollbackEvidence(implementation)).length,
    hasActiveImplementation: activeImplementations.length > 0,
    hasPassingActiveImplementation: activeImplementations.some((implementation) =>
      replayEvidence.passingImplementationIds.includes(implementation.id),
    ),
  };
}

export function buildLifecycleReadModel(datasource: LifecycleDatasource): LifecycleReadModel {
  const tree = datasource.loadLedger();
  let lineageRecords: ArtifactLineageRecord[] = [];
  let lineageSourceRetired = false;
  try {
    lineageRecords = datasource.listLineageRecords('rule-implementation-candidate');
  } catch (err) {
    if (err instanceof Error && err.name === 'LineageSourceRetiredError') {
      lineageSourceRetired = true;
    } else {
      throw err;
    }
  }

  // Tree entries use ledger types (LedgerPrinciple/LedgerRule) which extend
  // the schema types with extra fields (ruleIds, implementationIds).
  // We cast through unknown to bridge the two type hierarchies.
  const principles = Object.values(tree.principles)
    .map((principle): PrincipleLifecycleEvidence => {
      const principleRuleIds = ((principle as unknown) as Record<string, unknown>).ruleIds as string[] | undefined ?? [];
      const rules = principleRuleIds
        .map((ruleId) => tree.rules[ruleId])
        .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined)
        .map((rawRule): RuleLifecycleEvidence => {
          const rule = rawRule as unknown as Rule;
          const implIds = rawRule.implementationIds;
          const implementations = implIds
            .map((id) => tree.implementations[id])
            .filter((impl): impl is NonNullable<typeof impl> => impl !== undefined)
            .map((impl) => impl as unknown as Implementation);

          const implementationEvidence: ImplementationLifecycleEvidence[] = implementations.map((implementation) => {
            const reports = datasource.listReplayReports(implementation.id);
            const implementationLineage = lineageRecords.filter(
              (record) => record.ruleId === rule.id || record.implementationId === implementation.id,
            );

            return {
              implementation,
              latestReplayReport: reports[0] ?? null,
              replayHistoryCount: reports.length,
              lineageRecords: implementationLineage,
            };
          });

          const replayEvidence = createRuleReplayEvidence(
            implementationEvidence
              .filter((entry) => entry.latestReplayReport !== null)
              .map((entry) => ({
                implementationId: entry.implementation.id,
                report: entry.latestReplayReport as ReplayReport,
              })),
          );
          const ruleLineageRecords = lineageRecords.filter((record) => record.ruleId === rule.id);
          const lineageEvidence = createRuleLineageEvidence(ruleLineageRecords, lineageSourceRetired);
          const liveEvidence = createRuleLiveEvidence(implementations, replayEvidence);

          return {
            rule,
            implementations: implementationEvidence,
            replayEvidence,
            liveEvidence,
            lineageEvidence,
          };
        });

      return {
        principle,
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
      };
    })
    .sort((left, right) => left.principle.id.localeCompare(right.principle.id));

  return {
    generatedAt: new Date().toISOString(),
    principles,
  };
}
