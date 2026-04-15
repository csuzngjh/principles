/**
 * Nocturnal Trinity Shared Types
 *
 * Types shared between nocturnal-trinity.ts and nocturnal-candidate-scoring.ts.
 * Extracted to break circular dependency.
 */

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
