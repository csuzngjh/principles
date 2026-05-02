/**
 * Nocturnal Candidate Scoring — Deterministic Tournament Selection
 * ============================================================
 *
 * PURPOSE: Score Trinity candidates and run deterministic tournament selection
 * to choose the best candidate for artifact generation.
 *
 * DESIGN CONSTRAINTS:
 * - Scoring is deterministic: same inputs → same winner
 * - Tie-break rules are stable and explicit
 * - No randomness in ranking or selection
 * - Winner is always the highest-scoring candidate
 * - Thresholds provide minimum quality gates
 * - Failed threshold candidates are excluded from tournament
 *
 * SCORING COMPONENTS:
 * - schema completeness: candidate has all required fields
 * - principle alignment: candidate aligns with target principle
 * - executability: candidate describes an actionable next step
 * - boundedness: candidate is specific and bounded
 * - confidence/consistency: candidate's internal consistency
 *
 * PHASE 6 ONLY — No real training, no automatic deployment
 */

import type { DreamerCandidate, PhilosopherJudgment } from './nocturnal-trinity-types.js';
import type { ThresholdValues } from './adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Individual scoring dimensions for a candidate.
 */
export interface CandidateScores {
  /** Schema completeness (0-1) */
  schemaCompleteness: number;
  /** Principle alignment (0-1) */
  principleAlignment: number;
  /** Executability (0-1) */
  executability: number;
  /** Boundedness — specificity and constraint (0-1) */
  boundedness: number;
  /** Confidence/consistency (0-1) */
  confidence: number;
  /** Aggregate score (weighted average) */
  aggregate: number;
}

/**
 * Scored candidate with ranking.
 */
export interface ScoredCandidate {
  /** Original candidate index from Dreamer */
  candidateIndex: number;
  /** The Dreamer candidate */
  candidate: DreamerCandidate;
  /** The Philosopher judgment */
  judgment: PhilosopherJudgment;
  /** Individual dimension scores */
  scores: CandidateScores;
  /** Final tournament rank (1 = winner) */
  rank: number;
  /** Whether this candidate passed all thresholds */
  thresholdPassed: boolean;
  /** Which thresholds failed (if any) */
  failedThresholds: string[];
}

/**
 * Result of a tournament selection.
 */
export interface TournamentResult {
  /** Whether tournament produced a winner */
  success: boolean;
  /** The winning candidate (if success === true) */
  winner: ScoredCandidate | null;
  /** All ranked candidates (sorted by rank) */
  rankedCandidates: ScoredCandidate[];
  /** Trace of decisions for debugging/explainability */
  trace: TournamentTraceEntry[];
  /** Why no winner was selected (if success === false) */
  failureReason?: string;
}

/**
 * Single entry in the tournament trace.
 */
export interface TournamentTraceEntry {
  /** Description of this step */
  step: string;
  /** Details about the decision */
  details: string;
}

/**
 * Scoring weights for aggregate calculation.
 */
export interface ScoringWeights {
  schemaCompleteness: number;
  principleAlignment: number;
  executability: number;
  boundedness: number;
  confidence: number;
}

/**
 * Default scoring weights (must sum to 1.0).
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  schemaCompleteness: 0.15,
  principleAlignment: 0.30,
  executability: 0.20,
  boundedness: 0.20,
  confidence: 0.15,
};

/**
 * Result of diversity validation on Dreamer candidates.
 * Soft enforcement: result is informational, never gates the pipeline.
 */
export interface DiversityValidationResult {
  /** Whether candidates passed diversity checks */
  diversityCheckPassed: boolean;
  /** Whether at least 2 distinct risk levels were present */
  riskLevelDiversity: boolean;
  /** Whether no candidate pair exceeded keyword overlap threshold */
  keywordOverlapPassed: boolean;
  /** Highest pairwise keyword overlap score (for telemetry) */
  maxOverlapScore: number;
  /** Human-readable summary of check results */
  details: string;
}

// ---------------------------------------------------------------------------
// Scoring Logic
// ---------------------------------------------------------------------------

/**
 * Score a single Dreamer candidate + Philosopher judgment pair.
 *
 * @param candidate - Dreamer candidate
 * @param judgment - Philosopher judgment
 * @param weights - Scoring weights
 * @returns Individual scores
 */
export function scoreCandidate(
  candidate: DreamerCandidate,
  judgment: PhilosopherJudgment,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): CandidateScores {
  // Schema completeness: all required fields present and non-empty
  let schemaCompleteness = 1.0;
  if (!candidate.badDecision || candidate.badDecision.trim().length === 0) schemaCompleteness -= 0.2;
  if (!candidate.betterDecision || candidate.betterDecision.trim().length === 0) schemaCompleteness -= 0.2;
  if (!candidate.rationale || candidate.rationale.trim().length === 0) schemaCompleteness -= 0.2;
  if (typeof candidate.confidence !== 'number' || candidate.confidence < 0 || candidate.confidence > 1) schemaCompleteness -= 0.2;
  if (candidate.badDecision && candidate.betterDecision && candidate.badDecision.trim() === candidate.betterDecision.trim()) schemaCompleteness -= 0.2;
  schemaCompleteness = Math.max(0, schemaCompleteness);

  // Principle alignment: from Philosopher judgment
  const principleAlignment = judgment.principleAligned ? 1.0 : 0.3;

  // Executability: betterDecision contains actionable verb
  const actionableVerbs = ['read', 'check', 'verify', 'edit', 'write', 'search', 'grep', 'review', 'analyze', 'diagnose', 'debug', 'inspect', 'examine', 'test'];
  const hasActionableVerb = candidate.betterDecision
    ? actionableVerbs.some((v) =>
        candidate.betterDecision.toLowerCase().includes(v)
      )
    : false;
  const executability = hasActionableVerb ? 1.0 : 0.4;

  // Boundedness: specific and constrained
  let boundedness = 0.5;
  // Specific: mentions specific targets (files, tools, etc.)
  const betterDecisionStr = candidate.betterDecision ?? '';
  const hasSpecificTarget = /[a-zA-Z0-9_.]+\.(ts|js|json|md|yml|yaml|sh|py|go|rs)/.test(betterDecisionStr);
  if (hasSpecificTarget) boundedness += 0.2;
  // Not too generic
  const genericPatterns = [
    /\bsomething\b/i,
    /\bsomething else\b/i,
    /\bit\b/i,
    /\bthe thing\b/i,
  ];
  const isGeneric = genericPatterns.some((pattern) => pattern.test(betterDecisionStr));
  if (isGeneric) boundedness -= 0.3;
  // Not too long (如果 multi-step vagueness)
  if (betterDecisionStr.length > 200) boundedness -= 0.1;
  boundedness = Math.max(0, Math.min(1, boundedness));

  // Confidence: from Dreamer's confidence, adjusted by consistency
  const baseConfidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0.5;
  // Slight consistency check: Philosopher score should correlate with confidence
  const consistency = 1.0 - Math.abs(baseConfidence - judgment.score);
  const confidence = baseConfidence * 0.7 + consistency * 0.3;

  // Calculate aggregate
  const aggregate =
    schemaCompleteness * weights.schemaCompleteness +
    principleAlignment * weights.principleAlignment +
    executability * weights.executability +
    boundedness * weights.boundedness +
    confidence * weights.confidence;

  return {
    schemaCompleteness: Math.round(schemaCompleteness * 100) / 100,
    principleAlignment: Math.round(principleAlignment * 100) / 100,
    executability: Math.round(executability * 100) / 100,
    boundedness: Math.round(boundedness * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    aggregate: Math.round(aggregate * 100) / 100,
  };
}

/**
 * Check if candidate passes minimum thresholds.
 *
 * @param scores - Candidate scores
 * @param thresholds - Minimum threshold values
 * @returns Tuple of [passed, failedThresholdNames]
 */
export function checkThresholds(
  scores: CandidateScores,
  thresholds: ThresholdValues
): [boolean, string[]] {
  const failedThresholds: string[] = [];

  if (scores.schemaCompleteness < thresholds.schemaCompletenessMin) {
    failedThresholds.push(`schemaCompleteness (${scores.schemaCompleteness} < ${thresholds.schemaCompletenessMin})`);
  }
  if (scores.principleAlignment < thresholds.principleAlignmentMin) {
    failedThresholds.push(`principleAlignment (${scores.principleAlignment} < ${thresholds.principleAlignmentMin})`);
  }
  if (scores.executability < thresholds.executabilityMin) {
    failedThresholds.push(`executability (${scores.executability} < ${thresholds.executabilityMin})`);
  }
  if (scores.boundedness < thresholds.boundednessMin) {
    failedThresholds.push(`boundedness (${scores.boundedness} < ${thresholds.boundednessMin})`);
  }
  if (scores.confidence < thresholds.confidenceMin) {
    failedThresholds.push(`confidence (${scores.confidence} < ${thresholds.confidenceMin})`);
  }
  if (scores.aggregate < thresholds.aggregateMin) {
    failedThresholds.push(`aggregate (${scores.aggregate} < ${thresholds.aggregateMin})`);
  }

  return [failedThresholds.length === 0, failedThresholds];
}

/**
 * Validate that Dreamer candidates are strategically diverse.
 *
 * DIVER-03: Checks risk level diversity (Set.size >= 2 when candidates >= 2)
 * and keyword overlap similarity (reject if intersection / max(|A|, |B|) > 0.8
 * for words > 3 chars per D-05).
 *
 * This is SOFT enforcement: returns a result, never throws.
 * Pipeline continues regardless of diversityCheckPassed value.
 *
 * @param candidates - Dreamer candidates to validate
 * @returns DiversityValidationResult with pass/fail details
 */
export function validateCandidateDiversity(
  candidates: DreamerCandidate[],
): DiversityValidationResult {
  // Edge cases: empty, null, or single candidate always passes
  if (!candidates || candidates.length <= 1) {
    return {
      diversityCheckPassed: true,
      riskLevelDiversity: true,
      keywordOverlapPassed: true,
      maxOverlapScore: 0,
      details: candidates?.length === 1
        ? 'Single candidate — diversity check not applicable'
        : 'No candidates to validate',
    };
  }

  // Check 1: Risk level diversity (D-05)
  const riskLevels = new Set(
    candidates
      .map(c => c.riskLevel)
      .filter((r): r is "low" | "medium" | "high" => typeof r === 'string')
  );
  // If NO candidates have riskLevel, skip risk diversity check (graceful degradation)
  const riskLevelDiversity = riskLevels.size === 0 || riskLevels.size >= 2;

  // Check 2: Keyword overlap (D-05: intersection / max(|A|, |B|) for words > 3 chars)
  let maxOverlapScore = 0;
  let keywordOverlapPassed = true;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
       
      const overlap = computeKeywordOverlap(
        candidates[i].betterDecision ?? '',
        candidates[j].betterDecision ?? '',
      );
      if (overlap > maxOverlapScore) {
        maxOverlapScore = overlap;
      }
      if (overlap > 0.8) {
        keywordOverlapPassed = false;
      }
    }
  }

  const diversityCheckPassed = riskLevelDiversity && keywordOverlapPassed;

  // Build details string
  const parts: string[] = [];
  if (!riskLevelDiversity) {
    parts.push(`Risk levels not diverse (found: ${[...riskLevels].join(', ') || 'none'})`);
  }
  if (!keywordOverlapPassed) {
    parts.push(`Keyword overlap too high (max: ${maxOverlapScore.toFixed(2)})`);
  }

  return {
    diversityCheckPassed,
    riskLevelDiversity,
    keywordOverlapPassed,
    maxOverlapScore: Math.round(maxOverlapScore * 100) / 100,
    details: diversityCheckPassed
      ? 'Diversity check passed'
      : parts.join('; '),
  };
}

/**
 * Compute keyword overlap between two strings.
 * Algorithm: intersection / max(|A|, |B|) for words > 3 chars (per D-05).
 * Returns value between 0 and 1.
 */
function computeKeywordOverlap(textA: string, textB: string): number {
   
  const wordsA = extractKeywords(textA);
   
  const wordsB = extractKeywords(textB);

  if (wordsA.length === 0 && wordsB.length === 0) return 0;
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const denominator = Math.max(setA.size, setB.size);
  return denominator === 0 ? 0 : intersection / denominator;
}

/**
 * Extract keywords from text: words > 3 characters, lowercased.
 */
function extractKeywords(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 3);
}

/**
 * Score and rank all candidates deterministically.
 *
 * @param candidates - Dreamer candidates
 * @param judgments - Philosopher judgments (aligned by candidateIndex)
 * @param thresholds - Minimum thresholds
 * @param weights - Scoring weights
 * @returns All scored and ranked candidates
 */
 
 
export function rankCandidates(
  candidates: DreamerCandidate[],
  judgments: PhilosopherJudgment[],
  thresholds: ThresholdValues,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoredCandidate[] {
  const trace: TournamentTraceEntry[] = [];

  trace.push({
    step: 'Input Validation',
    details: `Received ${candidates.length} candidates and ${judgments.length} judgments`,
  });

  // Pre-index judgments for O(1) lookup
  const judgmentMap = new Map(judgments.map((j) => [j.candidateIndex, j]));

  // Score each candidate
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const judgment = judgmentMap.get(candidate.candidateIndex);
    if (!judgment) {
      trace.push({
        step: `Candidate ${candidate.candidateIndex}`,
        details: 'Skipped - no matching judgment found',
      });
      continue;
    }

    const scores = scoreCandidate(candidate, judgment, weights);
    const [passed, failed] = checkThresholds(scores, thresholds);

    scored.push({
      candidateIndex: candidate.candidateIndex,
      candidate,
      judgment,
      scores,
      rank: 0, // Will be set after sorting
      thresholdPassed: passed,
      failedThresholds: failed,
    });

    trace.push({
      step: `Candidate ${candidate.candidateIndex} Scored`,
      details: `aggregate=${scores.aggregate.toFixed(2)}, thresholdPassed=${passed}`,
    });
  }

  // Sort by: thresholdPassed DESC, aggregate DESC, candidateIndex ASC (for stability)
  scored.sort((a, b) => {
    // Threshold-passed candidates come first
    if (a.thresholdPassed !== b.thresholdPassed) {
      return a.thresholdPassed ? -1 : 1;
    }
    // Higher aggregate score wins
    if (a.scores.aggregate !== b.scores.aggregate) {
      return b.scores.aggregate - a.scores.aggregate;
    }
    // Lower candidateIndex wins ties (stability)
    return a.candidateIndex - b.candidateIndex;
  });

  // Assign ranks
  let currentRank = 1;
  let currentAggregate = -1;
  for (let i = 0; i < scored.length; i++) {
    const candidate = scored[i];
    if (candidate.scores.aggregate !== currentAggregate) {
      currentRank = i + 1;
      currentAggregate = candidate.scores.aggregate;
    }
    candidate.rank = currentRank;
  }

  trace.push({
    step: 'Ranking Complete',
    details: `Final order: ${scored.map((c) => `C${c.candidateIndex}(rank=${c.rank},agg=${c.scores.aggregate.toFixed(2)})`).join(', ')}`,
  });

  return scored;
}

/**
 * Run tournament selection to choose the best candidate.
 *
 * @param candidates - Dreamer candidates
 * @param judgments - Philosopher judgments
 * @param thresholds - Minimum thresholds
 * @param weights - Scoring weights
 * @returns Tournament result with winner
 */
 
 
export function runTournament(
  candidates: DreamerCandidate[],
  judgments: PhilosopherJudgment[],
  thresholds: ThresholdValues,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): TournamentResult {
  const trace: TournamentTraceEntry[] = [];

  if (candidates.length === 0 || judgments.length === 0) {
    return {
      success: false,
      winner: null,
      rankedCandidates: [],
      trace: [{ step: 'Validation', details: 'No candidates or judgments provided' }],
      failureReason: 'No candidates or judgments provided',
    };
  }

  trace.push({
    step: 'Tournament Start',
    details: `${candidates.length} candidates in tournament`,
  });

  // Rank candidates
  const ranked = rankCandidates(candidates, judgments, thresholds, weights);

  trace.push({
    step: 'Threshold Check',
    details: `${ranked.filter((c) => c.thresholdPassed).length} candidates passed thresholds`,
  });

  // Filter to threshold-passed candidates for winner determination
  const eligible = ranked.filter((c) => c.thresholdPassed);

  if (eligible.length === 0) {
    trace.push({
      step: 'No Winner',
      details: 'All candidates failed threshold check',
    });
    return {
      success: false,
      winner: null,
      rankedCandidates: ranked,
      trace,
      failureReason: 'All candidates failed threshold check',
    };
  }

  // Winner is rank 1
  const [winner] = eligible;

  trace.push({
    step: 'Winner Selected',
    details: `Candidate ${winner.candidateIndex} wins with aggregate score ${winner.scores.aggregate.toFixed(2)}`,
  });

  return {
    success: true,
    winner,
    rankedCandidates: ranked,
    trace,
  };
}
