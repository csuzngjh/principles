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
 *
 * Migrated from openclaw-plugin/src/core/nocturnal-candidate-scoring.ts.
 * ThresholdValues interface inlined from adaptive-thresholds.ts (plugin-only I/O module).
 * DreamerCandidate renamed to TrinityDreamerCandidate per Core naming convention.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { TrinityDreamerCandidate, PhilosopherJudgment } from './nocturnal-trinity-types.js';
import { TrinityDreamerCandidateSchema, PhilosopherJudgmentSchema } from './nocturnal-trinity-types.js';

// ---------------------------------------------------------------------------
// Inlined Types (from plugin-only modules — pure interfaces only)
// ---------------------------------------------------------------------------

/**
 * Current threshold values.
 * Inlined from openclaw-plugin/src/core/adaptive-thresholds.ts (I/O module).
 */
export const ThresholdValuesSchema = Type.Object({
  schemaCompletenessMin: Type.Number({ minimum: 0, maximum: 1 }),
  principleAlignmentMin: Type.Number({ minimum: 0, maximum: 1 }),
  executabilityMin: Type.Number({ minimum: 0, maximum: 1 }),
  boundednessMin: Type.Number({ minimum: 0, maximum: 1 }),
  confidenceMin: Type.Number({ minimum: 0, maximum: 1 }),
  aggregateMin: Type.Number({ minimum: 0, maximum: 1 }),
});
export type ThresholdValues = Static<typeof ThresholdValuesSchema>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Single entry in the tournament trace (for candidate scoring).
 */
export const CandidateTournamentTraceEntrySchema = Type.Object({
  /** Description of this step */
  step: Type.String({ minLength: 1 }),
  /** Details about the decision */
  details: Type.String({ minLength: 1 }),
});
export type CandidateTournamentTraceEntry = Static<typeof CandidateTournamentTraceEntrySchema>

/**
 * Individual scoring dimensions for a candidate.
 */
export const CandidateScoresSchema = Type.Object({
  /** Schema completeness (0-1) */
  schemaCompleteness: Type.Number({ minimum: 0, maximum: 1 }),
  /** Principle alignment (0-1) */
  principleAlignment: Type.Number({ minimum: 0, maximum: 1 }),
  /** Executability (0-1) */
  executability: Type.Number({ minimum: 0, maximum: 1 }),
  /** Boundedness — specificity and constraint (0-1) */
  boundedness: Type.Number({ minimum: 0, maximum: 1 }),
  /** Confidence/consistency (0-1) */
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  /** Aggregate score (weighted average) */
  aggregate: Type.Number({ minimum: 0, maximum: 1 }),
});
export type CandidateScores = Static<typeof CandidateScoresSchema>

/**
 * Scored candidate with ranking.
 */
export const ScoredCandidateSchema = Type.Object({
  /** Original candidate index from Dreamer */
  candidateIndex: Type.Integer({ minimum: 0 }),
  /** The Dreamer candidate */
  candidate: TrinityDreamerCandidateSchema,
  /** The Philosopher judgment */
  judgment: PhilosopherJudgmentSchema,
  /** Individual dimension scores */
  scores: CandidateScoresSchema,
  /** Final tournament rank (1 = winner) */
  rank: Type.Integer({ minimum: 1 }),
  /** Whether this candidate passed all thresholds */
  thresholdPassed: Type.Boolean(),
  /** Which thresholds failed (if any) */
  failedThresholds: Type.Array(Type.String()),
});
export type ScoredCandidate = Static<typeof ScoredCandidateSchema>

/**
 * Result of a tournament selection (for candidate scoring).
 */
export const CandidateTournamentResultSchema = Type.Object({
  /** Whether tournament produced a winner */
  success: Type.Boolean(),
  /** The winning candidate (if success === true) */
  winner: Type.Union([ScoredCandidateSchema, Type.Null()]),
  /** All ranked candidates (sorted by rank) */
  rankedCandidates: Type.Array(ScoredCandidateSchema),
  /** Trace of decisions for debugging/explainability */
  trace: Type.Array(CandidateTournamentTraceEntrySchema),
  /** Why no winner was selected (if success === false) */
  failureReason: Type.Optional(Type.String()),
});
export type CandidateTournamentResult = Static<typeof CandidateTournamentResultSchema>

// Backward compatibility aliases
/** @deprecated Use CandidateTournamentResult instead. Alias for backward compatibility. */
export type TournamentResult = CandidateTournamentResult;

/** @deprecated Use CandidateTournamentResultSchema instead. Alias for backward compatibility. */
export const TournamentResultSchema = CandidateTournamentResultSchema;

/** @deprecated Use CandidateTournamentTraceEntry instead. Alias for backward compatibility. */
export type TournamentTraceEntry = CandidateTournamentTraceEntry;

/** @deprecated Use CandidateTournamentTraceEntrySchema instead. Alias for backward compatibility. */
export const TournamentTraceEntrySchema = CandidateTournamentTraceEntrySchema;

/**
 * Scoring weights for aggregate calculation.
 */
export const ScoringWeightsSchema = Type.Object({
  schemaCompleteness: Type.Number({ minimum: 0, maximum: 1 }),
  principleAlignment: Type.Number({ minimum: 0, maximum: 1 }),
  executability: Type.Number({ minimum: 0, maximum: 1 }),
  boundedness: Type.Number({ minimum: 0, maximum: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});
export type ScoringWeights = Static<typeof ScoringWeightsSchema>

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
export const DiversityValidationResultSchema = Type.Object({
  /** Whether candidates passed diversity checks */
  diversityCheckPassed: Type.Boolean(),
  /** Whether at least 2 distinct risk levels were present */
  riskLevelDiversity: Type.Boolean(),
  /** Whether no candidate pair exceeded keyword overlap threshold */
  keywordOverlapPassed: Type.Boolean(),
  /** Highest pairwise keyword overlap score (for telemetry) */
  maxOverlapScore: Type.Number({ minimum: 0, maximum: 1 }),
  /** Human-readable summary of check results */
  details: Type.String({ minLength: 1 }),
});
export type DiversityValidationResult = Static<typeof DiversityValidationResultSchema>

// ---------------------------------------------------------------------------
// Helper functions (must be defined before use)
// ---------------------------------------------------------------------------

function extractKeywords(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 3);
}

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
  candidate: TrinityDreamerCandidate,
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
  // Not too long
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
  candidates: TrinityDreamerCandidate[],
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

      const candidateI = candidates[i];
      const candidateJ = candidates[j];
      if (!candidateI || !candidateJ) continue;

      const overlap = computeKeywordOverlap(
        candidateI.betterDecision ?? '',
        candidateJ.betterDecision ?? '',
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



export interface RankCandidatesOptions {
  candidates: TrinityDreamerCandidate[];
  judgments: PhilosopherJudgment[];
  thresholds: ThresholdValues;
  weights?: ScoringWeights;
}

export interface RunTournamentOptions {
  candidates: TrinityDreamerCandidate[];
  judgments: PhilosopherJudgment[];
  thresholds: ThresholdValues;
  weights?: ScoringWeights;
}

/**
 * Score and rank all candidates deterministically.
 *
 * @param options - Ranking options
 * @returns All scored and ranked candidates
 */
export function rankCandidates(
  options: RankCandidatesOptions,
): ScoredCandidate[] {
  const { candidates, judgments, thresholds, weights = DEFAULT_SCORING_WEIGHTS } = options;
  const trace: CandidateTournamentTraceEntry[] = [];

  trace.push({
    step: 'Input Validation',
    details: `Received ${candidates.length} candidates and ${judgments.length} judgments`,
  });

  // Pre-index judgments to avoid O(N) per-candidate lookup
  const judgmentMap = new Map<number, PhilosopherJudgment>();
  for (const j of judgments) {
    if (judgmentMap.has(j.candidateIndex)) {
      trace.push({
        step: 'Input Validation',
        details: `Duplicate candidateIndex ${j.candidateIndex} in judgments — last wins`,
      });
    }
    judgmentMap.set(j.candidateIndex, j);
  }

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

  // Assign ranks (standard competition ranking: 1,1,3 for ties)
  let currentRank = 1;
  let lastThresholdPassed: boolean | null = null;
  let lastAggregate: number | null = null;
  for (let i = 0; i < scored.length; i++) {
    const candidate = scored[i];
    if (!candidate) continue;
    if (
      candidate.thresholdPassed !== lastThresholdPassed ||
      candidate.scores.aggregate !== lastAggregate
    ) {
      currentRank = i + 1;
      lastThresholdPassed = candidate.thresholdPassed;
      lastAggregate = candidate.scores.aggregate;
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
 * @param options - Tournament options
 * @returns Tournament result with winner
 */
export function runTournament(
  options: RunTournamentOptions,
): CandidateTournamentResult {
  const { candidates, judgments, thresholds, weights = DEFAULT_SCORING_WEIGHTS } = options;
  const trace: CandidateTournamentTraceEntry[] = [];

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
  const ranked = rankCandidates({ candidates, judgments, thresholds, weights });

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

  const winner = eligible[0] ?? null;

  if (!winner) {
    return {
      success: false,
      winner: null,
      rankedCandidates: ranked,
      trace,
    };
  }

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
