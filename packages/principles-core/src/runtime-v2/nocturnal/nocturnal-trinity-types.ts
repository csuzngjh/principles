/**
 * Nocturnal Trinity Shared Types
 *
 * Types shared between nocturnal-trinity.ts and nocturnal-candidate-scoring.ts.
 * Extracted to break circular dependency.
 *
 * Migrated from openclaw-plugin/src/core/nocturnal-trinity-types.ts.
 * TrinityArtificerContext and its dependencies inlined from nocturnal-artificer.ts
 * to keep this module free of plugin I/O imports.
 */

// ---------------------------------------------------------------------------
// Artificer Context Types (inlined from nocturnal-artificer.ts)
// ---------------------------------------------------------------------------

export interface ArtificerTargetRuleScore {
  ruleId: string;
  score: number;
  matchedSignals: string[];
}

export type ArtificerTargetRuleResolution =
  | {
      status: 'selected';
      ruleId: string;
      reason: 'single-rule' | 'evidence-winner';
      scores: ArtificerTargetRuleScore[];
    }
  | {
      status: 'skip';
      reason:
        | 'principle-not-found'
        | 'no-rules'
        | 'ambiguous-target-rule'
        | 'no-deterministic-signal';
      scores: ArtificerTargetRuleScore[];
    };

export interface TrinityArtificerContext {
  principleId: string;
  resolution: ArtificerTargetRuleResolution;
  eligible: boolean;
}

// ---------------------------------------------------------------------------
// Dreamer Types
// ---------------------------------------------------------------------------

export interface TrinityDreamerCandidate {
  candidateIndex: number;
  badDecision: string;
  betterDecision: string;
  rationale: string;
  confidence: number;
  riskLevel?: "low" | "medium" | "high";
  strategicPerspective?: "conservative_fix" | "structural_improvement" | "paradigm_shift";
}

export interface TrinityDreamerOutput {
  valid: boolean;
  candidates: TrinityDreamerCandidate[];
  reason?: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Philosopher Types
// ---------------------------------------------------------------------------

export interface PhilosopherRiskAssessment {
  falsePositiveEstimate: number;
  implementationComplexity: 'low' | 'medium' | 'high';
  breakingChangeRisk: boolean;
}

export interface Philosopher6DScores {
  principleAlignment: number;
  specificity: number;
  actionability: number;
  executability: number;
  safetyImpact: number;
  uxImpact: number;
}

export interface PhilosopherJudgment {
  candidateIndex: number;
  critique: string;
  principleAligned: boolean;
  score: number;
  rank: number;
  scores?: Philosopher6DScores;
  risks?: PhilosopherRiskAssessment;
}

export interface PhilosopherOutput {
  valid: boolean;
  judgments: PhilosopherJudgment[];
  overallAssessment: string;
  reason?: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Trinity Result Types
// ---------------------------------------------------------------------------

export interface TournamentTraceEntry {
  candidateIndex: number;
  reason: string;
}

export interface RejectedAnalysis {
  whyRejected: string;
  warningSignals: string[];
  correctiveThinking: string;
}

export interface ChosenJustification {
  whyChosen: string;
  keyInsights: string[];
  limitations: string[];
}

export interface ContrastiveAnalysis {
  criticalDifference: string;
  decisionTrigger: string;
  preventionStrategy: string;
}

export interface TrinityTelemetry {
  chainMode: 'trinity' | 'single-reflector';
  usedStubs: boolean;
  dreamerPassed: boolean;
  philosopherPassed: boolean;
  scribePassed: boolean;
  candidateCount: number;
  selectedCandidateIndex: number;
  stageFailures: string[];
  tournamentTrace?: TournamentTraceEntry[];
  winnerAggregateScore?: number;
  winnerThresholdPassed?: boolean;
  eligibleCandidateCount?: number;
  diversityCheckPassed?: boolean;
  candidateRiskLevels?: string[];
  philosopher6D?: {
    avgScores: {
      principleAlignment: number;
      specificity: number;
      actionability: number;
      executability: number;
      safetyImpact: number;
      uxImpact: number;
    };
    highRiskCount: number;
  };
}

export interface TrinityStageFailure {
  stage: 'dreamer' | 'philosopher' | 'scribe';
  reason: string;
}

export interface TrinityResult {
  success: boolean;
  artifact?: TrinityDraftArtifact;
  telemetry: TrinityTelemetry;
  failures: TrinityStageFailure[];
  fallbackOccurred: boolean;
  artificerContext?: TrinityArtificerContext;
}

export interface TrinityDraftArtifact {
  selectedCandidateIndex: number;
  badDecision: string;
  betterDecision: string;
  rationale: string;
  sessionId: string;
  principleId: string;
  sourceSnapshotRef: string;
  telemetry: TrinityTelemetry;
  thinkingModelDelta?: number;
  planningRatioGain?: number;
  artificerContext?: TrinityArtificerContext;
  contrastiveAnalysis?: ContrastiveAnalysis;
  rejectedAnalysis?: RejectedAnalysis;
  chosenJustification?: ChosenJustification;
}
