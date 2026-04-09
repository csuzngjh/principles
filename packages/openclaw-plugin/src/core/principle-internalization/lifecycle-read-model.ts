import { loadLedger, type LedgerPrinciple, type LedgerRule } from '../principle-tree-ledger.js';
import { listArtifactLineageRecords, type ArtifactLineageRecord } from '../nocturnal-artifact-lineage.js';
import { ReplayEngine, type ClassificationSummary, type ReplayReport } from '../replay-engine.js';
import type { Implementation, ImplementationLifecycleState } from '../../types/principle-tree-schema.js';

export interface LifecycleClassificationTotals {
  total: number;
  passed: number;
  failed: number;
}

export interface RuleReplayEvidence {
  reportCount: number;
  latestReports: ReplayReport[];
  painNegative: LifecycleClassificationTotals;
  successPositive: LifecycleClassificationTotals;
  principleAnchor: LifecycleClassificationTotals;
  passingImplementationIds: string[];
  failingImplementationIds: string[];
  needsReviewImplementationIds: string[];
}

export interface RuleLiveEvidence {
  activeCount: number;
  candidateCount: number;
  disabledCount: number;
  archivedCount: number;
  durablePenaltyCount: number;
  rollbackEvidenceCount: number;
  hasActiveImplementation: boolean;
  hasPassingActiveImplementation: boolean;
}

export interface RuleLineageEvidence {
  records: ArtifactLineageRecord[];
  distinctPainSignalCount: number;
  distinctGateBlockCount: number;
  repeatedErrorSignal: number;
  latestCreatedAt?: string;
}

export interface ImplementationLifecycleEvidence {
  implementation: Implementation;
  latestReplayReport: ReplayReport | null;
  replayHistoryCount: number;
  lineageRecords: ArtifactLineageRecord[];
}

export interface RuleLifecycleEvidence {
  rule: LedgerRule;
  implementations: ImplementationLifecycleEvidence[];
  replayEvidence: RuleReplayEvidence;
  liveEvidence: RuleLiveEvidence;
  lineageEvidence: RuleLineageEvidence;
}

export interface PrincipleLifecycleEvidence {
  principle: LedgerPrinciple;
  rules: RuleLifecycleEvidence[];
  summary: {
    replayReportCount: number;
    activeImplementationCount: number;
    candidateImplementationCount: number;
    disabledImplementationCount: number;
    archivedImplementationCount: number;
    distinctPainSignalCount: number;
    distinctGateBlockCount: number;
    repeatedErrorSignal: number;
  };
}

export interface LifecycleReadModel {
  generatedAt: string;
  principles: PrincipleLifecycleEvidence[];
}

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

function createRuleLineageEvidence(records: ArtifactLineageRecord[]): RuleLineageEvidence {
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

export function buildLifecycleReadModel(workspaceDir: string, stateDir: string): LifecycleReadModel {
  const ledger = loadLedger(stateDir);
  const replayEngine = new ReplayEngine(workspaceDir, stateDir);
  const lineageRecords = listArtifactLineageRecords(workspaceDir, 'rule-implementation-candidate');

  const principles = Object.values(ledger.tree.principles)
    .map((principle): PrincipleLifecycleEvidence => {
      const rules = principle.ruleIds
        .map((ruleId) => ledger.tree.rules[ruleId])
        .filter((rule): rule is LedgerRule => rule !== undefined)
        .map((rule): RuleLifecycleEvidence => {
          const implementations = rule.implementationIds
            .map((implementationId) => ledger.tree.implementations[implementationId])
            .filter((implementation): implementation is Implementation => implementation !== undefined);

          const implementationEvidence: ImplementationLifecycleEvidence[] = implementations.map((implementation) => {
            const reports = replayEngine.listReports(implementation.id);
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
          const lineageEvidence = createRuleLineageEvidence(ruleLineageRecords);
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
