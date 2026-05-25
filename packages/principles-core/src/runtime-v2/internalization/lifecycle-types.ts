/**
 * Lifecycle read model types — pure interfaces for principle lifecycle evidence.
 * PRI-51: Extracted from the plugin layer.
 *
 * The buildLifecycleReadModel() function remains in the plugin (I/O dependencies).
 * Only type definitions are extracted here for use by PRI-52/53/54 computation modules.
 */
import type { ReplayReport } from '../types/replay-types.js';
import type { ArtifactLineageRecord } from '../types/artifact-lineage.js';
import type { Principle, Rule, Implementation } from '../types/principle-schema.js';

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
  sourceRetired?: boolean;
}

export interface ImplementationLifecycleEvidence {
  implementation: Implementation;
  latestReplayReport: ReplayReport | null;
  replayHistoryCount: number;
  lineageRecords: ArtifactLineageRecord[];
}

export interface RuleLifecycleEvidence {
  rule: Rule;
  implementations: ImplementationLifecycleEvidence[];
  replayEvidence: RuleReplayEvidence;
  liveEvidence: RuleLiveEvidence;
  lineageEvidence: RuleLineageEvidence;
}

export interface PrincipleLifecycleEvidence {
  principle: Principle;
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
