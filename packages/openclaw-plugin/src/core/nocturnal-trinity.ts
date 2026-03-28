/**
 * Nocturnal Trinity — Three-Stage Reflection Chain
 * ================================================
 *
 * PURPOSE: Upgrade single-reflector nocturnal sample generation to a
 * Dreamer -> Philosopher -> Scribe Trinity chain that produces higher quality
 * decision-point samples through structured multi-stage reflection.
 *
 * TRINITY STAGES:
 *  1. Dreamer   — Generates multiple candidate corrections/alternatives
 *  2. Philosopher — Provides principle-grounded critique and ranking
 *  3. Scribe    — Produces the final structured artifact draft using tournament selection
 *
 * DESIGN CONSTRAINTS:
 *  - All stage I/O is structured JSON contracts (not prose)
 *  - Any malformed stage output fails the entire chain closed
 *  - Single-reflector fallback is preserved via useTrinity flag
 *  - Trinity mode is configurable but defaults to enabled
 *  - Final artifact still passes arbiter + executability validation
 *  - Telemetry records chain mode, stage outcomes, candidate counts
 *  - Tournament selection is deterministic (same inputs → same winner)
 *
 * PHASE 6 ONLY — No real training, no automatic deployment
 */

import { randomUUID } from 'crypto';
import type { NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';
import {
  runTournament,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
  type TournamentTraceEntry,
} from './nocturnal-candidate-scoring.js';
import {
  DEFAULT_THRESHOLDS,
  getEffectiveThresholds,
  type ThresholdValues,
} from './adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Trinity Mode Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for Trinity chain execution.
 */
export interface TrinityConfig {
  /**
   * Whether to use Trinity chain (true) or single-reflector (false).
   * Default: true
   */
  useTrinity: boolean;

  /**
   * Maximum candidates Dreamer should generate.
   * Default: 3
   */
  maxCandidates: number;

  /**
   * Whether to use stub stage outputs (for testing without real model calls).
   * Default: false (uses stub in testing, real calls in production)
   */
  useStubs: boolean;

  /**
   * Scoring weights for tournament selection.
   * Default: DEFAULT_SCORING_WEIGHTS
   */
  scoringWeights?: ScoringWeights;

  /**
   * Threshold values for tournament eligibility.
   * Default: DEFAULT_THRESHOLDS
   */
  thresholds?: ThresholdValues;

  /**
   * State directory for threshold persistence.
   * If provided, thresholds will be loaded from state.
   */
  stateDir?: string;
}

// ---------------------------------------------------------------------------
// Trinity Intermediate Contracts
// ---------------------------------------------------------------------------

/**
 * Dreamer output — multiple candidate corrections.
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

/**
 * Philosopher output — principle-grounded critique and ranking.
 * Philosopher evaluates Dreamer's candidates and ranks them.
 */
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

/**
 * Scribe output — final structured artifact draft.
 * Scribe synthesizes the best candidate into an approved artifact format.
 */
export interface TrinityDraftArtifact {
  /** The selected winning candidate index */
  selectedCandidateIndex: number;
  /** The final badDecision */
  badDecision: string;
  /** The final betterDecision */
  betterDecision: string;
  /** The final rationale */
  rationale: string;
  /** Source session from snapshot */
  sessionId: string;
  /** Target principle ID */
  principleId: string;
  /** Reference to snapshot used */
  sourceSnapshotRef: string;
  /** Chain telemetry */
  telemetry: TrinityTelemetry;
}

export interface TrinityTelemetry {
  /** Whether Trinity or single-reflector was used */
  chainMode: 'trinity' | 'single-reflector';
  /** Whether stub implementations were used (always true in Phase 8) */
  usedStubs: boolean;
  /** Whether each stage passed */
  dreamerPassed: boolean;
  philosopherPassed: boolean;
  scribePassed: boolean;
  /** Number of candidates generated */
  candidateCount: number;
  /** Final selected candidate index */
  selectedCandidateIndex: number;
  /** Stage failure reasons (if any) */
  stageFailures: string[];
  /** Tournament trace for explainability (optional) */
  tournamentTrace?: TournamentTraceEntry[];
  /** Winner aggregate score (optional) */
  winnerAggregateScore?: number;
  /** Whether winner passed all thresholds (optional) */
  winnerThresholdPassed?: boolean;
  /** Number of eligible candidates after threshold check (optional) */
  eligibleCandidateCount?: number;
}

// ---------------------------------------------------------------------------
// Trinity Stage Validation
// ---------------------------------------------------------------------------

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
  /** Whether Trinity chain completed successfully */
  success: boolean;
  /** The final draft artifact (if success) */
  artifact?: TrinityDraftArtifact;
  /** Telemetry about the chain execution */
  telemetry: TrinityTelemetry;
  /** Stage failures (if any) */
  failures: TrinityStageFailure[];
  /** Whether fallback to single-reflector occurred */
  fallbackOccurred: boolean;
}

// ---------------------------------------------------------------------------
// Internal Types for Trinity Execution
// ---------------------------------------------------------------------------

/**
 * Enriched candidate after Philosopher judgment.
 */
interface EnrichedCandidate extends DreamerCandidate {
  judgment: PhilosopherJudgment;
}

// ---------------------------------------------------------------------------
// Stub Stage Implementations (Phase 2 — no real subagent calls)
// ---------------------------------------------------------------------------

/**
 * STUB DREAMER — generates synthetic candidates for testing.
 *
 * In production, this would call the actual Dreamer subagent.
 * The stub generates plausible candidates based on snapshot signals.
 */
function invokeStubDreamer(
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  maxCandidates: number
): DreamerOutput {
  const hasFailures = snapshot.stats.failureCount > 0;
  const hasPain = snapshot.stats.totalPainEvents > 0;
  const hasGateBlocks = snapshot.stats.totalGateBlocks > 0;

  const candidates: DreamerCandidate[] = [];

  // Generate candidates based on available signals
  // NOTE: betterDecision includes file paths to pass boundedness threshold
  if (hasGateBlocks) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Proceeded with a tool call despite receiving a gate block, bypassing the safety check',
      betterDecision: 'Read docs/gateblocks.md and verify the authorization requirements in config.json before retrying',
      rationale: 'Respecting gate blocks prevents unintended system modifications',
      confidence: 0.95,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Retried the same operation immediately after gate block without understanding why',
        betterDecision: 'Check the reason in src/gatekeeper.ts and address the root cause before proceeding',
        rationale: 'Understanding why a gate blocked prevents repeated blocks',
        confidence: 0.85,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Modified the target of the blocked operation to bypass the check',
        betterDecision: 'Request human authorization in docs/auth.md for the intended operation',
        rationale: 'Proper authorization ensures accountability and prevents unintended changes',
        confidence: 0.75,
      });
    }
  } else if (hasPain) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Continued executing operations without pausing to address accumulated pain signals',
      betterDecision: 'Check pain signals in logs/pain.json and identify the root cause before proceeding',
      rationale: 'Pain signals indicate accumulated friction or error conditions',
      confidence: 0.90,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Ignored warning pain events and proceeded with high-risk operations',
        betterDecision: 'Review the source code in src/pain-detector.ts and resolve friction points',
        rationale: 'Addressing friction reduces error rates and improves outcomes',
        confidence: 0.80,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Retried failing operations without analyzing why they caused pain',
        betterDecision: 'Analyze the pain pattern using logs/errors.json and adjust the approach before retrying',
        rationale: 'Pattern analysis prevents recurring pain from the same source',
        confidence: 0.70,
      });
    }
  } else if (hasFailures) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Retried a failing operation without diagnosing the root cause',
      betterDecision: 'Check the error message in logs/failure.json and verify preconditions in config.json before retrying',
      rationale: 'Diagnosing failures before retry prevents repeated failures',
      confidence: 0.92,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Continued to the next operation after a failure without addressing it',
        betterDecision: 'Analyze the failure using docs/debugging.md and verify the fix before continuing',
        rationale: 'Unaddressed failures compound and cause larger issues',
        confidence: 0.85,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Assumed the failure was transient and retried without investigation',
        betterDecision: 'Verify the failure is resolved by checking src/validator.ts before retrying',
        rationale: 'Verification prevents cascading failures from unresolved issues',
        confidence: 0.78,
      });
    }
  } else {
    // No signal available - cannot generate meaningful candidates
    // Return empty candidates array to trigger invalid output
    // (Real Dreamer would also fail with no signal)
    return {
      valid: false,
      candidates: [],
      reason: 'No signal available for candidate generation (failureCount=0, painEvents=0, gateBlocks=0)',
      generatedAt: new Date().toISOString(),
    };
  }

  // Ensure we don't exceed maxCandidates
  const limitedCandidates = candidates.slice(0, Math.min(candidates.length, maxCandidates));

  return {
    valid: limitedCandidates.length > 0,
    candidates: limitedCandidates,
    generatedAt: new Date().toISOString(),
    reason: limitedCandidates.length === 0 ? 'No signal available for candidate generation' : undefined,
  };
}

/**
 * STUB PHILOSOPHER — ranks candidates based on simple heuristics.
 *
 * In production, this would call the actual Philosopher subagent.
 * The stub applies principle alignment heuristics.
 */
function invokeStubPhilosopher(
  dreamerOutput: DreamerOutput,
  principleId: string
): PhilosopherOutput {
  if (!dreamerOutput.valid || dreamerOutput.candidates.length === 0) {
    return {
      valid: false,
      judgments: [],
      overallAssessment: '',
      reason: 'No candidates to judge',
      generatedAt: new Date().toISOString(),
    };
  }

  // Simple heuristic scoring based on candidate structure
  const judgments: PhilosopherJudgment[] = dreamerOutput.candidates.map((candidate) => {
    let principleAligned = true;
    let score = candidate.confidence;

    // Heuristic: longer rationales tend to be more principled
    if (candidate.rationale.length < 30) {
      score *= 0.8;
      principleAligned = false;
    }

    // Heuristic: betterDecision should be actionable (contain verbs)
    const actionableVerbs = ['read', 'check', 'verify', 'edit', 'write', 'search', 'review', 'analyze'];
    const hasActionable = actionableVerbs.some((v) => candidate.betterDecision.toLowerCase().includes(v));
    if (!hasActionable) {
      score *= 0.85;
      principleAligned = false;
    }

    // Heuristic: badDecision should be specific (not generic)
    const genericPatterns = ['something went wrong', 'it did not work', 'mistake was made'];
    const isGeneric = genericPatterns.some((p) => candidate.badDecision.toLowerCase().includes(p));
    if (isGeneric) {
      score *= 0.75;
      principleAligned = false;
    }

    return {
      candidateIndex: candidate.candidateIndex,
      critique: `Candidate ${candidate.candidateIndex} scored ${score.toFixed(2)}. ${
        principleAligned
          ? 'Principle-aligned with specific actionable alternative.'
          : 'May need refinement for principle alignment.'
      }`,
      principleAligned,
      score: Math.min(1, Math.max(0, score)),
      rank: 0, // Will be set after sorting
    };
  });

  // Sort by score descending and assign ranks
  judgments.sort((a, b) => b.score - a.score);
  judgments.forEach((j, idx) => {
    j.rank = idx + 1;
  });

  const topJudgment = judgments[0];

  return {
    valid: true,
    judgments,
    overallAssessment: `Best candidate is #${topJudgment.candidateIndex} with score ${topJudgment.score.toFixed(2)}. ${topJudgment.principleAligned ? 'Well-aligned with principle.' : 'Alignment could be improved.'}`,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * STUB SCRIBE — synthesizes best candidate into final artifact using tournament selection.
 *
 * In production, this would call the actual Scribe subagent.
 * The stub uses tournament selection (scoring + thresholds) to pick the winner.
 */
function invokeStubScribe(
  dreamerOutput: DreamerOutput,
  philosopherOutput: PhilosopherOutput,
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  telemetry: TrinityTelemetry,
  config: TrinityConfig
): TrinityDraftArtifact | null {
  if (!dreamerOutput.valid || !philosopherOutput.valid) {
    return null;
  }

  // Get thresholds (from config or state, or defaults)
  const thresholds = config.thresholds ?? (config.stateDir ? getEffectiveThresholds(config.stateDir) : { ...DEFAULT_THRESHOLDS });
  const weights = config.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;

  // Run tournament selection
  const tournamentResult = runTournament(
    dreamerOutput.candidates,
    philosopherOutput.judgments,
    thresholds,
    weights
  );

  if (!tournamentResult.success || !tournamentResult.winner) {
    // Tournament failed — no eligible candidate
    return null;
  }

  const winner = tournamentResult.winner;

  // Update telemetry with tournament info
  const updatedTelemetry: TrinityTelemetry = {
    ...telemetry,
    tournamentTrace: tournamentResult.trace,
    winnerAggregateScore: winner.scores.aggregate,
    winnerThresholdPassed: winner.thresholdPassed,
    eligibleCandidateCount: tournamentResult.rankedCandidates.filter((c) => c.thresholdPassed).length,
  };

  return {
    selectedCandidateIndex: winner.candidateIndex,
    badDecision: winner.candidate.badDecision,
    betterDecision: winner.candidate.betterDecision,
    rationale: winner.candidate.rationale,
    sessionId: snapshot.sessionId,
    principleId,
    sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
    telemetry: updatedTelemetry,
  };
}

// ---------------------------------------------------------------------------
// Trinity Chain Execution
// ---------------------------------------------------------------------------

export interface RunTrinityOptions {
  /** Snapshot to generate candidates from */
  snapshot: NocturnalSessionSnapshot;
  /** Target principle ID */
  principleId: string;
  /** Trinity configuration */
  config: TrinityConfig;
}

/**
 * Execute the Trinity chain: Dreamer -> Philosopher -> Scribe.
 *
 * @param options - Trinity execution options
 * @returns TrinityResult with final artifact or failure info
 */
export function runTrinity(options: RunTrinityOptions): TrinityResult {
  const { snapshot, principleId, config } = options;

  // Fail-fast: real LLM-based Trinity stages are not yet implemented.
  // If useStubs is explicitly false, the caller expects real model calls which don't exist.
  if (!config.useStubs) {
    const errorMsg = '[Trinity] Not Implemented: useStubs=false but real LLM-based Trinity stages are not yet implemented. Set useStubs=true to use stub implementations, or implement invokeDreamer/invokePhilosopher/invokeScribe first.';
    const failures: TrinityStageFailure[] = [{ stage: 'dreamer', reason: errorMsg }];
    const telemetry: TrinityTelemetry = {
      chainMode: 'trinity',
      usedStubs: false,  // No stub was called — we failed before invoking anything
      dreamerPassed: false,
      philosopherPassed: false,
      scribePassed: false,
      candidateCount: 0,
      selectedCandidateIndex: -1,
      stageFailures: [`Configuration: ${errorMsg}`],
    };
    console.error(`[Trinity] ERROR: ${errorMsg}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  const telemetry: TrinityTelemetry = {
    chainMode: 'trinity',
    usedStubs: true,
    dreamerPassed: false,
    philosopherPassed: false,
    scribePassed: false,
    candidateCount: 0,
    selectedCandidateIndex: -1,
    stageFailures: [],
  };

  const failures: TrinityStageFailure[] = [];

  // Step 1: Dreamer — generate candidates (stub)
  const dreamerOutput = invokeStubDreamer(snapshot, principleId, config.maxCandidates);

  if (!dreamerOutput.valid || dreamerOutput.candidates.length === 0) {
    failures.push({
      stage: 'dreamer',
      reason: dreamerOutput.reason ?? 'No valid candidates generated',
    });
    telemetry.stageFailures.push(`Dreamer: ${dreamerOutput.reason ?? 'failed'}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.dreamerPassed = true;
  telemetry.candidateCount = dreamerOutput.candidates.length;

  // Step 2: Philosopher — rank candidates (stub)
  const philosopherOutput = invokeStubPhilosopher(dreamerOutput, principleId);

  if (!philosopherOutput.valid || philosopherOutput.judgments.length === 0) {
    failures.push({
      stage: 'philosopher',
      reason: philosopherOutput.reason ?? 'No judgments produced',
    });
    telemetry.stageFailures.push(`Philosopher: ${philosopherOutput.reason ?? 'failed'}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.philosopherPassed = true;

  // Step 3: Scribe — produce final artifact using tournament selection (stub)
  const draftArtifact = invokeStubScribe(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config);

  if (!draftArtifact) {
    failures.push({
      stage: 'scribe',
      reason: 'Failed to synthesize artifact from candidates',
    });
    telemetry.stageFailures.push('Scribe: synthesis failed');
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.scribePassed = true;
  telemetry.selectedCandidateIndex = draftArtifact.selectedCandidateIndex;

  // Propagate tournament info from artifact.telemetry to result telemetry
  // invokeStubScribe creates updatedTelemetry but only embeds it in the artifact,
  // so we need to copy those fields back to the top-level telemetry
  if (draftArtifact.telemetry) {
    telemetry.tournamentTrace = draftArtifact.telemetry.tournamentTrace;
    telemetry.winnerAggregateScore = draftArtifact.telemetry.winnerAggregateScore;
    telemetry.winnerThresholdPassed = draftArtifact.telemetry.winnerThresholdPassed;
    telemetry.eligibleCandidateCount = draftArtifact.telemetry.eligibleCandidateCount;
  }

  return {
    success: true,
    artifact: draftArtifact,
    telemetry,
    failures: [],
    fallbackOccurred: false,
  };
}

// ---------------------------------------------------------------------------
// Trinity Validation (for Arbiter integration)
// ---------------------------------------------------------------------------

/**
 * Validate that a Trinity draft artifact can pass final arbiter validation.
 * This checks the draft against the same rules as single-reflector artifacts.
 */
export interface DraftValidationResult {
  valid: boolean;
  failures: string[];
}

/**
 * Validate a TrinityDraftArtifact before passing to arbiter.
 */
export function validateDraftArtifact(draft: TrinityDraftArtifact): DraftValidationResult {
  const failures: string[] = [];

  if (!draft.badDecision || draft.badDecision.trim().length === 0) {
    failures.push('badDecision is required and non-empty');
  }

  if (!draft.betterDecision || draft.betterDecision.trim().length === 0) {
    failures.push('betterDecision is required and non-empty');
  }

  if (!draft.rationale || draft.rationale.trim().length < 20) {
    failures.push('rationale must be at least 20 characters');
  }

  if (!draft.principleId || draft.principleId.trim().length === 0) {
    failures.push('principleId is required');
  }

  if (!draft.sessionId || draft.sessionId.trim().length === 0) {
    failures.push('sessionId is required');
  }

  // badDecision should not be identical to betterDecision
  if (
    typeof draft.badDecision === 'string' &&
    typeof draft.betterDecision === 'string' &&
    draft.badDecision.trim().length > 0 &&
    draft.betterDecision.trim().length > 0 &&
    draft.badDecision.trim() === draft.betterDecision.trim()
  ) {
    failures.push('badDecision and betterDecision cannot be identical');
  }

  return {
    valid: failures.length === 0,
    failures,
  };
}

/**
 * Convert a TrinityDraftArtifact to a NocturnalArtifact-compatible structure.
 */
export function draftToArtifact(draft: TrinityDraftArtifact): {
  artifactId: string;
  sessionId: string;
  principleId: string;
  sourceSnapshotRef: string;
  badDecision: string;
  betterDecision: string;
  rationale: string;
  createdAt: string;
} {
  return {
    artifactId: randomUUID(),
    sessionId: draft.sessionId,
    principleId: draft.principleId,
    sourceSnapshotRef: draft.sourceSnapshotRef,
    badDecision: draft.badDecision,
    betterDecision: draft.betterDecision,
    rationale: draft.rationale,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_TRINITY_CONFIG: TrinityConfig = {
  useTrinity: true,
  maxCandidates: 3,
  useStubs: true,  // Stubs are the only implemented option; real LLM calls are TODO
};
