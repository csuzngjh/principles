/**
 * Nocturnal Trinity Shared Types
 *
 * Types shared between trinity components and candidate scoring.
 * Extracted to break circular dependency.
 */

import { Type, type Static } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Artificer Context Types (inlined from nocturnal-artificer.ts)
// ---------------------------------------------------------------------------

export const ArtificerTargetRuleScoreSchema = Type.Object({
  ruleId: Type.String({ minLength: 1 }),
  score: Type.Number(),
  matchedSignals: Type.Array(Type.String()),
});
export type ArtificerTargetRuleScore = Static<typeof ArtificerTargetRuleScoreSchema>

export const ArtificerTargetRuleResolutionSchema = Type.Union([
  Type.Object({
    status: Type.Literal('selected'),
    ruleId: Type.String({ minLength: 1 }),
    reason: Type.Union([Type.Literal('single-rule'), Type.Literal('evidence-winner')]),
    scores: Type.Array(ArtificerTargetRuleScoreSchema),
  }),
  Type.Object({
    status: Type.Literal('skip'),
    reason: Type.Union([
      Type.Literal('principle-not-found'),
      Type.Literal('no-rules'),
      Type.Literal('ambiguous-target-rule'),
      Type.Literal('no-deterministic-signal'),
    ]),
    scores: Type.Array(ArtificerTargetRuleScoreSchema),
  }),
]);
export type ArtificerTargetRuleResolution = Static<typeof ArtificerTargetRuleResolutionSchema>;

export const TrinityArtificerContextSchema = Type.Object({
  principleId: Type.String({ minLength: 1 }),
  resolution: ArtificerTargetRuleResolutionSchema,
  eligible: Type.Boolean(),
});
export type TrinityArtificerContext = Static<typeof TrinityArtificerContextSchema>

// ---------------------------------------------------------------------------
// Dreamer Types
// ---------------------------------------------------------------------------

export const TrinityDreamerCandidateSchema = Type.Object({
  candidateIndex: Type.Integer({ minimum: 0 }),
  badDecision: Type.String({ minLength: 1 }),
  betterDecision: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  riskLevel: Type.Optional(Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
  ])),
  strategicPerspective: Type.Optional(Type.Union([
    Type.Literal('conservative_fix'),
    Type.Literal('structural_improvement'),
    Type.Literal('paradigm_shift'),
  ])),
});
export type TrinityDreamerCandidate = Static<typeof TrinityDreamerCandidateSchema>

export const TrinityDreamerOutputSchema = Type.Object({
  valid: Type.Boolean(),
  candidates: Type.Array(TrinityDreamerCandidateSchema),
  reason: Type.Optional(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});
export type TrinityDreamerOutput = Static<typeof TrinityDreamerOutputSchema>

// ---------------------------------------------------------------------------
// Philosopher Types
// ---------------------------------------------------------------------------

export const PhilosopherRiskAssessmentSchema = Type.Object({
  falsePositiveEstimate: Type.Number({ minimum: 0, maximum: 1 }),
  implementationComplexity: Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
  ]),
  breakingChangeRisk: Type.Boolean(),
});
export type PhilosopherRiskAssessment = Static<typeof PhilosopherRiskAssessmentSchema>

export const Philosopher6DScoresSchema = Type.Object({
  principleAlignment: Type.Number({ minimum: 0, maximum: 1 }),
  specificity: Type.Number({ minimum: 0, maximum: 1 }),
  actionability: Type.Number({ minimum: 0, maximum: 1 }),
  executability: Type.Number({ minimum: 0, maximum: 1 }),
  safetyImpact: Type.Number({ minimum: 0, maximum: 1 }),
  uxImpact: Type.Number({ minimum: 0, maximum: 1 }),
});
export type Philosopher6DScores = Static<typeof Philosopher6DScoresSchema>

export const PhilosopherJudgmentSchema = Type.Object({
  candidateIndex: Type.Integer({ minimum: 0 }),
  critique: Type.String({ minLength: 1 }),
  principleAligned: Type.Boolean(),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  rank: Type.Integer({ minimum: 1 }),
  scores: Type.Optional(Philosopher6DScoresSchema),
  risks: Type.Optional(PhilosopherRiskAssessmentSchema),
});
export type PhilosopherJudgment = Static<typeof PhilosopherJudgmentSchema>

export const PhilosopherOutputSchema = Type.Object({
  valid: Type.Boolean(),
  judgments: Type.Array(PhilosopherJudgmentSchema),
  overallAssessment: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});
export type PhilosopherOutput = Static<typeof PhilosopherOutputSchema>

// ---------------------------------------------------------------------------
// Trinity Result Types
// ---------------------------------------------------------------------------

export const TournamentTraceEntrySchema = Type.Object({
  candidateIndex: Type.Integer({ minimum: 0 }),
  reason: Type.String({ minLength: 1 }),
});
export type TournamentTraceEntry = Static<typeof TournamentTraceEntrySchema>

export const RejectedAnalysisSchema = Type.Object({
  whyRejected: Type.String({ minLength: 1 }),
  warningSignals: Type.Array(Type.String()),
  correctiveThinking: Type.String({ minLength: 1 }),
});
export type RejectedAnalysis = Static<typeof RejectedAnalysisSchema>

export const ChosenJustificationSchema = Type.Object({
  whyChosen: Type.String({ minLength: 1 }),
  keyInsights: Type.Array(Type.String()),
  limitations: Type.Array(Type.String()),
});
export type ChosenJustification = Static<typeof ChosenJustificationSchema>

export const ContrastiveAnalysisSchema = Type.Object({
  criticalDifference: Type.String({ minLength: 1 }),
  decisionTrigger: Type.String({ minLength: 1 }),
  preventionStrategy: Type.String({ minLength: 1 }),
});
export type ContrastiveAnalysis = Static<typeof ContrastiveAnalysisSchema>

export const TrinityTelemetrySchema = Type.Object({
  chainMode: Type.Union([Type.Literal('trinity'), Type.Literal('single-reflector')]),
  usedStubs: Type.Boolean(),
  dreamerPassed: Type.Boolean(),
  philosopherPassed: Type.Boolean(),
  scribePassed: Type.Boolean(),
  candidateCount: Type.Integer({ minimum: 0 }),
  selectedCandidateIndex: Type.Integer({ minimum: 0 }),
  stageFailures: Type.Array(Type.String()),
  tournamentTrace: Type.Optional(Type.Array(TournamentTraceEntrySchema)),
  winnerAggregateScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  winnerThresholdPassed: Type.Optional(Type.Boolean()),
  eligibleCandidateCount: Type.Optional(Type.Integer({ minimum: 0 })),
  diversityCheckPassed: Type.Optional(Type.Boolean()),
  candidateRiskLevels: Type.Optional(Type.Array(Type.String())),
  philosopher6D: Type.Optional(Type.Object({
    avgScores: Type.Object({
      principleAlignment: Type.Number({ minimum: 0, maximum: 1 }),
      specificity: Type.Number({ minimum: 0, maximum: 1 }),
      actionability: Type.Number({ minimum: 0, maximum: 1 }),
      executability: Type.Number({ minimum: 0, maximum: 1 }),
      safetyImpact: Type.Number({ minimum: 0, maximum: 1 }),
      uxImpact: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    highRiskCount: Type.Integer({ minimum: 0 }),
  })),
});
export type TrinityTelemetry = Static<typeof TrinityTelemetrySchema>

export const TrinityStageFailureSchema = Type.Object({
  stage: Type.Union([
    Type.Literal('dreamer'),
    Type.Literal('philosopher'),
    Type.Literal('scribe'),
  ]),
  reason: Type.String({ minLength: 1 }),
});
export type TrinityStageFailure = Static<typeof TrinityStageFailureSchema>

export const TrinityDraftArtifactSchema = Type.Object({
  selectedCandidateIndex: Type.Integer({ minimum: 0 }),
  badDecision: Type.String({ minLength: 1 }),
  betterDecision: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  principleId: Type.String({ minLength: 1 }),
  sourceSnapshotRef: Type.String({ minLength: 1 }),
  telemetry: TrinityTelemetrySchema,
  thinkingModelDelta: Type.Optional(Type.Number()),
  planningRatioGain: Type.Optional(Type.Number()),
  artificerContext: Type.Optional(TrinityArtificerContextSchema),
  contrastiveAnalysis: Type.Optional(ContrastiveAnalysisSchema),
  rejectedAnalysis: Type.Optional(RejectedAnalysisSchema),
  chosenJustification: Type.Optional(ChosenJustificationSchema),
});
export type TrinityDraftArtifact = Static<typeof TrinityDraftArtifactSchema>

export const TrinityResultSchema = Type.Object({
  success: Type.Boolean(),
  artifact: Type.Optional(TrinityDraftArtifactSchema),
  telemetry: TrinityTelemetrySchema,
  failures: Type.Array(TrinityStageFailureSchema),
  fallbackOccurred: Type.Boolean(),
  artificerContext: Type.Optional(TrinityArtificerContextSchema),
});
export type TrinityResult = Static<typeof TrinityResultSchema>
