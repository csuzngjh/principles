export type {
  ArtificerTargetRuleScore,
  ArtificerTargetRuleResolution,
  TrinityArtificerContext,
  TrinityDreamerCandidate,
  TrinityDreamerOutput,
  PhilosopherRiskAssessment,
  Philosopher6DScores,
  PhilosopherJudgment,
  PhilosopherOutput,
  TrinityTournamentTraceEntry as TournamentTraceEntry,
  RejectedAnalysis,
  ChosenJustification,
  ContrastiveAnalysis,
  TrinityTelemetry,
  TrinityStageFailure,
  TrinityResult,
  TrinityDraftArtifact,
} from '@principles/core/runtime-v2';

import type {
  TrinityDreamerCandidate as TrinityDreamerCandidateType,
  TrinityDreamerOutput as TrinityDreamerOutputType,
} from '@principles/core/runtime-v2';

/** @deprecated Use TrinityDreamerCandidate instead. Alias for backward compatibility. */
export type DreamerCandidate = TrinityDreamerCandidateType;

/** @deprecated Use TrinityDreamerOutput instead. Alias for backward compatibility. */
export type DreamerOutput = TrinityDreamerOutputType;
