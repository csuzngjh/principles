import type {
  ArtificerTargetRuleScore,
  ArtificerTargetRuleResolution,
  TrinityArtificerContext,
  TrinityDreamerCandidate,
  TrinityDreamerOutput,
  PhilosopherRiskAssessment,
  Philosopher6DScores,
  PhilosopherJudgment,
  PhilosopherOutput,
  TournamentTraceEntry,
  RejectedAnalysis,
  ChosenJustification,
  ContrastiveAnalysis,
  TrinityTelemetry,
  TrinityStageFailure,
  TrinityResult,
  TrinityDraftArtifact,
} from '@principles/core/runtime-v2';

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
  TournamentTraceEntry,
  RejectedAnalysis,
  ChosenJustification,
  ContrastiveAnalysis,
  TrinityTelemetry,
  TrinityStageFailure,
  TrinityResult,
  TrinityDraftArtifact,
} from '@principles/core/runtime-v2';

/** @deprecated Use TrinityDreamerCandidate instead. Alias for backward compatibility. */
export type DreamerCandidate = TrinityDreamerCandidate;

/** @deprecated Use TrinityDreamerOutput instead. Alias for backward compatibility. */
export type DreamerOutput = TrinityDreamerOutput;
