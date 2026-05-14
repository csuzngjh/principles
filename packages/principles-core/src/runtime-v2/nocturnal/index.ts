// nocturnal-trinity-types
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
} from './nocturnal-trinity-types.js';

export {
  ArtificerTargetRuleScoreSchema,
  ArtificerTargetRuleResolutionSchema,
  TrinityArtificerContextSchema,
  TrinityDreamerCandidateSchema,
  TrinityDreamerOutputSchema,
  PhilosopherRiskAssessmentSchema,
  Philosopher6DScoresSchema,
  PhilosopherJudgmentSchema,
  PhilosopherOutputSchema,
  TournamentTraceEntrySchema as TrinityTournamentTraceEntrySchema,
  RejectedAnalysisSchema,
  ChosenJustificationSchema,
  ContrastiveAnalysisSchema,
  TrinityTelemetrySchema,
  TrinityStageFailureSchema,
  TrinityResultSchema,
  TrinityDraftArtifactSchema,
} from './nocturnal-trinity-types.js';

// Candidate scoring (migrated from openclaw-plugin)
export type {
  ThresholdValues,
  CandidateScores,
  ScoredCandidate,
  CandidateTournamentResult,
  TournamentResult, // backward compatibility alias
  CandidateTournamentTraceEntry,
  TournamentTraceEntry, // backward compatibility alias
  ScoringWeights,
  DiversityValidationResult,
  RankCandidatesOptions,
  RunTournamentOptions,
} from './candidate-scoring.js';

export {
  DEFAULT_SCORING_WEIGHTS,
  scoreCandidate,
  checkThresholds,
  validateCandidateDiversity,
  rankCandidates,
  runTournament,
  ThresholdValuesSchema,
  CandidateScoresSchema,
  ScoredCandidateSchema,
  CandidateTournamentResultSchema,
  TournamentResultSchema, // backward compatibility alias
  CandidateTournamentTraceEntrySchema,
  TournamentTraceEntrySchema, // backward compatibility alias
  ScoringWeightsSchema,
  DiversityValidationResultSchema,
} from './candidate-scoring.js';

// Snapshot contract (migrated from openclaw-plugin)
export type {
  NocturnalAssistantTurn,
  NocturnalUserTurn,
  NocturnalToolCall,
  NocturnalPainEvent,
  NocturnalGateBlock,
  NocturnalUserCorrection,
  NocturnalSessionSnapshot,
  NocturnalSnapshotContractResult,
} from './snapshot-contract.js';

export {
  validateNocturnalSnapshotIngress,
  NocturnalAssistantTurnSchema,
  NocturnalUserTurnSchema,
  NocturnalToolCallSchema,
  NocturnalPainEventSchema,
  NocturnalGateBlockSchema,
  NocturnalUserCorrectionSchema,
  NocturnalSessionSnapshotSchema,
  NocturnalSnapshotContractResultSchema,
} from './snapshot-contract.js';
