/**
 * Nocturnal Trinity Shared Types
 *
 * Types shared between nocturnal-trinity.ts and nocturnal-candidate-scoring.ts.
 * Extracted to break circular dependency.
 */

import type { TrinityArtificerContext } from './nocturnal-artificer.js';

// ---------------------------------------------------------------------------
// Dreamer Types
// ---------------------------------------------------------------------------

/**
 * Individual candidate from Dreamer (alternative decision).
 * Each candidate represents an alternative "better decision" approach.
 */
export interface DreamerCandidate {
  /** Unique index for this candidate within the Dreamer output */
  candidateIndex: number;
  /** The bad decision this candidate addresses */
  badDecision: string;
  /** The alternative/better decision */
  betterDecision: string;
  /** Why this alternative is better (brief) */
  rationale: string;
  /** Confidence that this candidate is valid (0-1) */
  confidence: number;
  /** Risk level of this candidate's approach -- LLM-judged per D-02 */
  riskLevel?: "low" | "medium" | "high";
  /** Which strategic perspective this candidate embodies per D-01 */
  strategicPerspective?: "conservative_fix" | "structural_improvement" | "paradigm_shift";
}

export interface DreamerOutput {
  /** Whether Dreamer succeeded */
  valid: boolean;
  /** List of candidate corrections */
  candidates: DreamerCandidate[];
  /** Why Dreamer could not generate (if valid === false) */
  reason?: string;
  /** Timestamp of generation */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Philosopher Types
// ---------------------------------------------------------------------------

export interface PhilosopherRiskAssessment {
  /** Estimated probability that this candidate is a false positive (0-1) */
  falsePositiveEstimate: number;
  /** How complex is this candidate to implement */
  implementationComplexity: 'low' | 'medium' | 'high';
  /** Whether implementing this candidate risks breaking existing functionality */
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
  /** Index of the judged candidate (references DreamerCandidate.candidateIndex) */
  candidateIndex: number;
  /** Principle-grounded critique of this candidate */
  critique: string;
  /** Whether this candidate aligns with the target principle */
  principleAligned: boolean;
  /** Ranking score (higher = better, 0-1) */
  score: number;
  /** Rank among all candidates (1 = best) */
  rank: number;
  /** Per-dimension scores (6D evaluation) — informational, not used for tournament ranking */
  scores?: Philosopher6DScores;
  /** Risk assessment for this candidate — informational, consumed by Scribe (Phase 37) */
  risks?: PhilosopherRiskAssessment;
}

export interface PhilosopherOutput {
  /** Whether Philosopher succeeded */
  valid: boolean;
  /** Judgments for each candidate */
  judgments: PhilosopherJudgment[];
  /** Overall assessment of the candidate set */
  overallAssessment: string;
  /** Why Philosopher could not judge (if valid === false) */
  reason?: string;
  /** Timestamp of generation */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Trinity Result Types
// ---------------------------------------------------------------------------

/**
 * Tournament trace entry for explainability.
 */
export interface TournamentTraceEntry {
  candidateIndex: number;
  reason: string;
}

/**
 * Analysis of a rejected candidate — why it lost the tournament.
 * Informs training signal for "what to avoid".
 */
export interface RejectedAnalysis {
  /** Mental model that led to the rejected candidate */
  whyRejected: string;
  /** Observable caution triggers that were missed or ignored */
  warningSignals: string[];
  /** Correct reasoning path that should have been seen */
  correctiveThinking: string;
}

/**
 * Justification for the chosen candidate — why it won the tournament.
 * Informs training signal for "what to do".
 */
export interface ChosenJustification {
  /** Why this candidate was selected over others */
  whyChosen: string;
  /** 1-3 transferable insights from this decision */
  keyInsights: string[];
  /** When this approach does NOT apply */
  limitations: string[];
}

/**
 * Contrastive analysis: key differences between chosen and rejected paths.
 * Synthesizes the core lesson from the tournament.
 */
export interface ContrastiveAnalysis {
  /** ONE key insight distinguishing chosen from rejected */
  criticalDifference: string;
  /** Pattern: "When X, do Y" */
  decisionTrigger: string;
  /** How to systematically avoid the rejected path */
  preventionStrategy: string;
}

/**
 * Telemetry about Trinity chain execution.
 */
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

/**
 * Validation failure for a Trinity stage.
 */
export interface TrinityStageFailure {
  stage: 'dreamer' | 'philosopher' | 'scribe';
  reason: string;
}

/**
 * Result of Trinity chain execution.
 */
export interface TrinityResult {
  success: boolean;
  artifact?: TrinityDraftArtifact;
  telemetry: TrinityTelemetry;
  failures: TrinityStageFailure[];
  fallbackOccurred: boolean;
  artificerContext?: TrinityArtificerContext;
}

/**
 * Scribe output — final structured artifact draft.
 */
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
