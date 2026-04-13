import { describe, it, expect } from 'vitest';
import {
  scoreCandidate,
  checkThresholds,
  rankCandidates,
  runTournament,
  DEFAULT_SCORING_WEIGHTS,
  validateCandidateDiversity,
} from '../../src/core/nocturnal-candidate-scoring.js';
import type { DreamerCandidate, PhilosopherJudgment } from '../../src/core/nocturnal-trinity.js';
import type { ThresholdValues } from '../../src/core/adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<DreamerCandidate> = {}): DreamerCandidate {
  return {
    candidateIndex: 0,
    badDecision: 'Did something wrong without verifying preconditions',
    betterDecision: 'Read the relevant file to understand its structure before making changes',
    rationale: 'Verifying preconditions prevents errors and ensures actions are appropriate',
    confidence: 0.85,
    ...overrides,
  };
}

function makeJudgment(candidateIndex: number, overrides: Partial<PhilosopherJudgment> = {}): PhilosopherJudgment {
  return {
    candidateIndex,
    critique: 'Strong alignment with the principle',
    principleAligned: true,
    score: 0.85,
    rank: 1,
    ...overrides,
  };
}

const DEFAULT_THRESHOLDS: ThresholdValues = {
  schemaCompletenessMin: 0.6,
  principleAlignmentMin: 0.7,
  executabilityMin: 0.65,
  boundednessMin: 0.5,
  confidenceMin: 0.6,
  aggregateMin: 0.65,
};

// ---------------------------------------------------------------------------
// Tests: scoreCandidate
// ---------------------------------------------------------------------------

describe('scoreCandidate', () => {
  it('scores a valid candidate correctly', () => {
    const candidate = makeCandidate();
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.schemaCompleteness).toBeGreaterThan(0);
    expect(scores.principleAlignment).toBe(1.0); // principleAligned: true
    expect(scores.executability).toBeGreaterThan(0);
    expect(scores.boundedness).toBeGreaterThan(0);
    expect(scores.confidence).toBeGreaterThan(0);
    expect(scores.aggregate).toBeGreaterThan(0);
  });

  it('penalizes non-principle-aligned candidates', () => {
    const candidate = makeCandidate();
    const judgment = makeJudgment(0, { principleAligned: false, score: 0.4 });
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.principleAlignment).toBeLessThan(0.5);
  });

  it('penalizes missing fields in schema completeness', () => {
    const candidate = makeCandidate({ betterDecision: '' });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.schemaCompleteness).toBeLessThan(1.0);
  });

  it('penalizes generic betterDecision without actionable verbs', () => {
    const candidate = makeCandidate({ betterDecision: 'Do something better' });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.executability).toBeLessThan(1.0);
  });

  it('rewards specific betterDecision with file paths', () => {
    const candidate = makeCandidate({
      betterDecision: 'Read src/main.ts to understand the structure',
    });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.boundedness).toBeGreaterThan(0.5);
  });

  it('does not penalize words that merely contain "it" as a substring', () => {
    const candidate = makeCandidate({
      betterDecision: 'Verify preconditions in config.json before retrying',
      confidence: 0.92,
    });
    const judgment = makeJudgment(0, { score: 0.92, principleAligned: true });
    const scores = scoreCandidate(candidate, judgment);

    // Boundedness should remain 0.7 (0.5 base + 0.2 specific target) because
    // "preconditions" must not trigger the generic word "it" penalty.
    expect(scores.boundedness).toBe(0.7);
  });

  it('uses custom weights when provided', () => {
    const candidate = makeCandidate();
    const judgment = makeJudgment(0);
    const customWeights = { ...DEFAULT_SCORING_WEIGHTS, principleAlignment: 0.5 };
    const scores = scoreCandidate(candidate, judgment, customWeights);

    // With higher weight on principleAlignment, aggregate should be higher for aligned candidates
    expect(scores.aggregate).toBeGreaterThan(0);
  });

  it('does not crash when badDecision is undefined — lowers score instead', () => {
    const candidate = makeCandidate({ badDecision: undefined as unknown as string });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.schemaCompleteness).toBeLessThan(1.0);
    expect(scores.aggregate).toBeGreaterThanOrEqual(0);
  });

  it('does not crash when betterDecision is undefined — lowers score instead', () => {
    const candidate = makeCandidate({ betterDecision: undefined as unknown as string });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.schemaCompleteness).toBeLessThan(1.0);
    expect(scores.aggregate).toBeGreaterThanOrEqual(0);
  });

  it('does not crash when both badDecision and betterDecision are undefined', () => {
    const candidate = makeCandidate({
      badDecision: undefined as unknown as string,
      betterDecision: undefined as unknown as string,
    });
    const judgment = makeJudgment(0);
    const scores = scoreCandidate(candidate, judgment);

    expect(scores.schemaCompleteness).toBeLessThan(1.0);
    expect(scores.aggregate).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkThresholds
// ---------------------------------------------------------------------------

describe('checkThresholds', () => {
  it('passes all thresholds with good scores', () => {
    const scores = {
      schemaCompleteness: 0.9,
      principleAlignment: 0.9,
      executability: 0.9,
      boundedness: 0.9,
      confidence: 0.9,
      aggregate: 0.9,
    };
    const [passed, failed] = checkThresholds(scores, DEFAULT_THRESHOLDS);

    expect(passed).toBe(true);
    expect(failed).toHaveLength(0);
  });

  it('fails when schema completeness is below threshold', () => {
    const scores = {
      schemaCompleteness: 0.3,
      principleAlignment: 0.9,
      executability: 0.9,
      boundedness: 0.9,
      confidence: 0.9,
      aggregate: 0.9,
    };
    const [passed, failed] = checkThresholds(scores, DEFAULT_THRESHOLDS);

    expect(passed).toBe(false);
    // checkThresholds returns formatted strings like "schemaCompleteness (0.3 < 0.6)"
    expect(failed.some(f => f.includes('schemaCompleteness'))).toBe(true);
  });

  it('fails when multiple thresholds are broken', () => {
    const scores = {
      schemaCompleteness: 0.3,
      principleAlignment: 0.3,
      executability: 0.3,
      boundedness: 0.3,
      confidence: 0.3,
      aggregate: 0.3,
    };
    const [passed, failed] = checkThresholds(scores, DEFAULT_THRESHOLDS);

    expect(passed).toBe(false);
    expect(failed.length).toBeGreaterThan(1);
  });

  it('reports all failed thresholds', () => {
    const scores = {
      schemaCompleteness: 0.5,  // < 0.6 → FAIL
      principleAlignment: 0.7,  // >= 0.7 → PASS (at threshold)
      executability: 0.5,       // < 0.65 → FAIL
      boundedness: 0.7,         // >= 0.65 → PASS (above new threshold)
      confidence: 0.5,          // < 0.6 → FAIL
      aggregate: 0.5,           // < 0.65 → FAIL
    };
    const [passed, failed] = checkThresholds(scores, DEFAULT_THRESHOLDS);

    expect(passed).toBe(false);
    // Exactly 4 failures: schemaCompleteness, executability, confidence, aggregate
    expect(failed.length).toBe(4);
    expect(failed.some(f => f.includes('schemaCompleteness'))).toBe(true);
    expect(failed.some(f => f.includes('executability'))).toBe(true);
    expect(failed.some(f => f.includes('confidence'))).toBe(true);
    expect(failed.some(f => f.includes('aggregate'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: rankCandidates
// ---------------------------------------------------------------------------

describe('rankCandidates', () => {
  it('ranks candidates by aggregate score', () => {
    // Use very different confidence levels to ensure clear ranking
    // Candidate 0: low confidence (0.5) - lower aggregate
    // Candidate 1: high confidence (0.9) - higher aggregate
    const candidates = [
      makeCandidate({ candidateIndex: 0, confidence: 0.5, betterDecision: 'Read config.json to understand setup' }),
      makeCandidate({ candidateIndex: 1, confidence: 0.9, betterDecision: 'Read main.ts to understand setup' }),
    ];
    const judgments = [
      makeJudgment(0, { score: 0.5, rank: 1, principleAligned: true }),
      makeJudgment(1, { score: 0.9, rank: 1, principleAligned: true }),
    ];

    const ranked = rankCandidates(candidates, judgments, DEFAULT_THRESHOLDS);

    // Candidate 1 has higher score and should be ranked first
    expect(ranked[0].candidateIndex).toBe(1);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it('excludes candidates that fail thresholds', () => {
    // Candidate 0 has low confidence and fails principle alignment - should fail
    // Candidate 1 has high confidence and passes - should pass
    const candidates = [
      makeCandidate({ candidateIndex: 0, confidence: 0.3, betterDecision: 'Check errors in src/main.ts' }),
      makeCandidate({ candidateIndex: 1, confidence: 0.9, betterDecision: 'Read error logs in error.json' }),
    ];
    const judgments = [
      makeJudgment(0, { score: 0.5, principleAligned: false }),
      makeJudgment(1, { score: 0.9, principleAligned: true }),
    ];

    const ranked = rankCandidates(candidates, judgments, DEFAULT_THRESHOLDS);

    // Candidate 1 passes thresholds (high confidence, principle aligned, has file path)
    expect(ranked[0].thresholdPassed).toBe(true);
    // Candidate 0 fails thresholds (low confidence, not principle aligned)
    expect(ranked[1].thresholdPassed).toBe(false);
  });

  it('uses candidateIndex as stable tie-break', () => {
    // Two candidates with same scoring profile but different indices
    const candidates = [
      makeCandidate({ candidateIndex: 5, betterDecision: 'Read src/index.ts to understand', confidence: 0.8 }),
      makeCandidate({ candidateIndex: 1, betterDecision: 'Read src/index.ts to understand', confidence: 0.8 }),
    ];
    // Both have identical judgments (same score, both aligned)
    const judgments = [
      makeJudgment(1, { score: 0.8, principleAligned: true }),
      makeJudgment(5, { score: 0.8, principleAligned: true }),
    ];

    const ranked = rankCandidates(candidates, judgments, DEFAULT_THRESHOLDS);

    // Lower candidateIndex wins tie
    expect(ranked[0].candidateIndex).toBe(1);
  });

  it('handles empty input gracefully', () => {
    const ranked = rankCandidates([], [], DEFAULT_THRESHOLDS);
    expect(ranked).toHaveLength(0);
  });

  it('skips candidates without matching judgments', () => {
    const candidates = [makeCandidate({ candidateIndex: 0 })];
    const judgments = [makeJudgment(99)]; // No matching judgment

    const ranked = rankCandidates(candidates, judgments, DEFAULT_THRESHOLDS);
    expect(ranked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: runTournament
// ---------------------------------------------------------------------------

describe('runTournament', () => {
  it('selects the highest-scoring threshold-passing candidate', () => {
    // Use actionable verbs and proper file paths to pass boundedness threshold
    const candidates = [
      makeCandidate({ candidateIndex: 0, confidence: 0.7, betterDecision: 'Read config.json to verify settings' }),
      makeCandidate({ candidateIndex: 1, confidence: 0.9, betterDecision: 'Review error.json logs for errors' }),
      makeCandidate({ candidateIndex: 2, confidence: 0.5, betterDecision: 'Check main.ts before proceeding' }),
    ];
    const judgments = [
      makeJudgment(0, { score: 0.7, principleAligned: true }),
      makeJudgment(1, { score: 0.9, principleAligned: true }),
      makeJudgment(2, { score: 0.5, principleAligned: true }),
    ];

    const result = runTournament(candidates, judgments, DEFAULT_THRESHOLDS);

    expect(result.success).toBe(true);
    expect(result.winner).not.toBeNull();
    expect(result.winner!.candidateIndex).toBe(1);
    expect(result.rankedCandidates).toHaveLength(3);
  });

  it('fails when all candidates fail thresholds', () => {
    // Candidates with poor confidence and not principle-aligned should fail
    const candidates = [
      makeCandidate({ candidateIndex: 0, confidence: 0.2, betterDecision: 'Do something in src.ts' }),
      makeCandidate({ candidateIndex: 1, confidence: 0.1, betterDecision: 'Try again with config.json' }),
    ];
    const judgments = [
      makeJudgment(0, { score: 0.3, principleAligned: false }),
      makeJudgment(1, { score: 0.2, principleAligned: false }),
    ];

    const result = runTournament(candidates, judgments, DEFAULT_THRESHOLDS);

    expect(result.success).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.failureReason).toContain('threshold');
  });

  it('provides explainable trace', () => {
    const candidates = [makeCandidate({ candidateIndex: 0, betterDecision: 'Read error.json to check logs' })];
    const judgments = [makeJudgment(0, { score: 0.9, principleAligned: true })];

    const result = runTournament(candidates, judgments, DEFAULT_THRESHOLDS);

    expect(result.trace).toBeDefined();
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.trace[0].step).toBeDefined();
    expect(result.trace[0].details).toBeDefined();
  });

  it('is deterministic — same inputs yield same winner', () => {
    const candidates = [
      makeCandidate({ candidateIndex: 0, confidence: 0.8, betterDecision: 'Read config.json to understand' }),
      makeCandidate({ candidateIndex: 1, confidence: 0.9, betterDecision: 'Review error.json for issues' }),
    ];
    const judgments = [
      makeJudgment(0, { score: 0.8, principleAligned: true }),
      makeJudgment(1, { score: 0.9, principleAligned: true }),
    ];

    const result1 = runTournament(candidates, judgments, DEFAULT_THRESHOLDS);
    const result2 = runTournament(candidates, judgments, DEFAULT_THRESHOLDS);

    expect(result1.winner!.candidateIndex).toBe(result2.winner!.candidateIndex);
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_SCORING_WEIGHTS
// ---------------------------------------------------------------------------

describe('DEFAULT_SCORING_WEIGHTS', () => {
  it('has weights that sum to 1.0', () => {
    const sum = Object.values(DEFAULT_SCORING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it('has all required properties', () => {
    expect(DEFAULT_SCORING_WEIGHTS.schemaCompleteness).toBeDefined();
    expect(DEFAULT_SCORING_WEIGHTS.principleAlignment).toBeDefined();
    expect(DEFAULT_SCORING_WEIGHTS.executability).toBeDefined();
    expect(DEFAULT_SCORING_WEIGHTS.boundedness).toBeDefined();
    expect(DEFAULT_SCORING_WEIGHTS.confidence).toBeDefined();
  });

  it('has values in valid range (0-1)', () => {
    for (const weight of Object.values(DEFAULT_SCORING_WEIGHTS)) {
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: validateCandidateDiversity
// ---------------------------------------------------------------------------

describe('validateCandidateDiversity', () => {
  it('passes when candidates have 2+ distinct risk levels and low keyword overlap', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'Read config.json to verify settings' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'high', betterDecision: 'Refactor the entire authentication module from scratch' }),
    ];
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(true);
    expect(result.riskLevelDiversity).toBe(true);
    expect(result.keywordOverlapPassed).toBe(true);
  });

  it('fails when all candidates have the same risk level', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'Read file A to check settings' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'low', betterDecision: 'Review file completely different approach' }),
      makeCandidate({ candidateIndex: 2, riskLevel: 'low', betterDecision: 'Inspect another unique diagnostic method' }),
    ];
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(false);
    expect(result.riskLevelDiversity).toBe(false);
  });

  it('fails when candidate pair has keyword overlap > 0.8', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'Review the authentication configuration file before making any changes to the system' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'high', betterDecision: 'Review the authentication configuration file before making any changes to the system' }),
    ];
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(false);
    expect(result.keywordOverlapPassed).toBe(false);
    expect(result.maxOverlapScore).toBeGreaterThan(0.8);
  });

  it('passes for single candidate', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low' }),
    ];
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(true);
    expect(result.details).toContain('Single candidate');
  });

  it('passes for empty array', () => {
    const result = validateCandidateDiversity([]);
    expect(result.diversityCheckPassed).toBe(true);
    expect(result.details).toContain('No candidates');
  });

  it('passes when candidates lack riskLevel (graceful degradation)', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, betterDecision: 'Read config.json to verify settings' }),
      makeCandidate({ candidateIndex: 1, betterDecision: 'Refactor the entire authentication module from scratch' }),
    ];
    // No riskLevel on any candidate - should pass (no risk levels to check)
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(true);
    expect(result.riskLevelDiversity).toBe(true);
  });

  it('fails when some candidates have riskLevel but fewer than 2 distinct values', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'medium', betterDecision: 'Read config.json to verify settings' }),
      makeCandidate({ candidateIndex: 1, betterDecision: 'Refactor the entire authentication module from scratch' }),
    ];
    // Only 1 candidate has riskLevel, so only 1 distinct value → fail
    const result = validateCandidateDiversity(candidates);
    expect(result.diversityCheckPassed).toBe(false);
    expect(result.riskLevelDiversity).toBe(false);
  });

  it('uses max(|A|, |B|) as denominator for keyword overlap', () => {
    // Short text A, long text B - overlap should use max as denominator
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'review authentication configuration' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'high', betterDecision: 'review authentication configuration before proceeding with changes to the deployment pipeline infrastructure' }),
    ];
    const result = validateCandidateDiversity(candidates);
    // "review", "authentication", "configuration" overlap in both
    // Set A = {review, authentication, configuration} = 3
    // Set B = {review, authentication, configuration, before, proceeding, with, changes, deployment, pipeline, infrastructure} = 10
    // intersection = 3, max(3, 10) = 10, overlap = 3/10 = 0.3
    expect(result.maxOverlapScore).toBeLessThanOrEqual(0.4);
  });

  it('ignores words <= 3 characters in keyword overlap', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'the and but for' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'high', betterDecision: 'the and but for' }),
    ];
    // All words are <= 3 chars, so no keywords extracted → overlap = 0
    const result = validateCandidateDiversity(candidates);
    expect(result.keywordOverlapPassed).toBe(true);
    expect(result.maxOverlapScore).toBe(0);
  });

  it('never throws on malformed input', () => {
    // Undefined candidates
    expect(() => validateCandidateDiversity(undefined as unknown as DreamerCandidate[])).not.toThrow();
    // Null candidates
    expect(() => validateCandidateDiversity(null as unknown as DreamerCandidate[])).not.toThrow();
    // Candidates with undefined fields
    expect(() => validateCandidateDiversity([
      { candidateIndex: 0 } as DreamerCandidate,
    ])).not.toThrow();
    // Mixed valid and malformed
    expect(() => validateCandidateDiversity([
      makeCandidate({ candidateIndex: 0, riskLevel: 'low' }),
      { candidateIndex: 1 } as DreamerCandidate,
    ])).not.toThrow();
  });

  it('returns correct maxOverlapScore rounded to 2 decimal places', () => {
    const candidates: DreamerCandidate[] = [
      makeCandidate({ candidateIndex: 0, riskLevel: 'low', betterDecision: 'Review configuration settings before deployment' }),
      makeCandidate({ candidateIndex: 1, riskLevel: 'high', betterDecision: 'Review configuration settings before deployment testing' }),
    ];
    const result = validateCandidateDiversity(candidates);
    // Verify the maxOverlapScore is a number with at most 2 decimal places
    const decimalPart = result.maxOverlapScore.toString().split('.')[1];
    if (decimalPart) {
      expect(decimalPart.length).toBeLessThanOrEqual(2);
    }
    expect(typeof result.maxOverlapScore).toBe('number');
  });
});
