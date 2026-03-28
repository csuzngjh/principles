/**
 * Nocturnal Benchmark — Scorer Adapters
 * =====================================
 *
 * Phase 4 evaluation interface: ScorerAdapter contract.
 *
 * Two implementations are provided:
 *
 * 1. StructuralScorerAdapter  (baseline / mock evaluator)
 *    - Deterministic structural heuristics only
 *    - Checkpoint-agnostic: ignores checkpointRef; the same sample always
 *      gets the same score regardless of which checkpoint is being evaluated
 *    - Delta from structural scorer alone will be ~0 for runCompare()
 *      (this is correct — structural scorer measures data quality, not checkpoint quality)
 *
 * 2. LocalModelScorerAdapter  (placeholder for real model evaluation)
 *    - Intended for real model inference endpoints
 *    - Accepts checkpointRef and routes to the appropriate checkpoint-specific
 *      model variant, producing genuine behavioral score differences
 *    - Currently a STUB: returns a fixed score with evaluator metadata
 *      indicating the placeholder status
 *    - Replace the stub implementation with real model inference when
 *      the evaluation infrastructure is available
 *
 * IMPORTANT — ScorerAdapter invariant:
 *   Delta in runCompare() must come from the evaluator's real assessment of
 *   the checkpoint's behavioral output. It must NOT come from synthetic
 *   manipulation of the checkpointRef string (no hashing, no string-derived bias).
 *
 *   This means:
 *   - StructuralScorerAdapter: delta ≈ 0 for any two checkpoints (expected)
 *   - LocalModelScorerAdapter (with real model): delta reflects real score differences
 *   - LocalModelScorerAdapter (stub): delta = 0 or stub-delivered differences (ok for scaffolding)
 *
 *   The contract guarantees: if you see a non-zero delta, it came from the
 *   evaluator's actual assessment behavior, not from the benchmark harness.
 */

import type { ORPOSample, ScoredSample, ScorerAdapter, EvalMode } from './types.js';

// ---------------------------------------------------------------------------
// Keyword Extraction (used by StructuralScorerAdapter)
// ---------------------------------------------------------------------------

/**
 * Extract significant keywords from text.
 * Strips common stopwords and returns lowercase words > 3 chars.
 */
function extractKeywords(text: string): Set<string> {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then',
    'once', 'if', 'because', 'until', 'while', 'although', 'though', 'after',
    'before', 'since', 'when', 'where', 'about', 'into', 'through', 'during',
    'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'being', 'having', 'doing', 'their', 'them', 'they', 'your', 'you',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  return new Set(words);
}

/**
 * Compute overlap ratio between two keyword sets.
 */
function keywordOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0.5;
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const word of setA) {
    if (setB.has(word)) overlap++;
  }
  return overlap / Math.sqrt(setA.size * setB.size);
}

/**
 * Check if a decision text contains action-oriented language.
 */
function hasActionLanguage(text: string): boolean {
  const ACTION_PATTERNS = [
    /\b(check|verify|validate|test|read|inspect|examine|look|see|find|search|query|analyze|review)\b/i,
    /\b(before|after|when|if|while|unless|until)\b/i,
    /\b(use|apply|implement|add|remove|change|update|fix|repair|correct)\b/i,
    /\b(error|failure|fail|exception|issue|problem|bug|mistake|wrong)\b/i,
  ];
  return ACTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Check if the rationale provides concrete justification.
 */
function rationaleStrength(rationale: string): number {
  if (!rationale || rationale.length < 20) return 0.0;
  if (rationale.length < 50) return 0.3;
  if (rationale.length < 100) return 0.6;
  return 0.8;
}

/**
 * Check if chosen and rejected are meaningfully different.
 */
function decisionSeparation(chosen: string, rejected: string): number {
  const chosenWords = extractKeywords(chosen);
  const rejectedWords = extractKeywords(rejected);

  if (chosenWords.size === 0 && rejectedWords.size === 0) return 0.5;

  const overlap = keywordOverlap(chosenWords, rejectedWords);
  // High overlap = low separation
  return 1.0 - overlap;
}

/**
 * Build a human-readable justification string.
 */
function buildJustification(
  mode: EvalMode,
  chosenRationaleOverlap: number,
  rejectedPenalty: number,
  separation: number,
  rStrength: number,
  finalScore: number
): string {
  const parts: string[] = [];

  parts.push(
    chosenRationaleOverlap >= 0.5
      ? 'chosen aligns with rationale'
      : 'chosen weakly aligned with rationale'
  );

  if (rejectedPenalty > 0.2) {
    parts.push('rejected contradicts rationale');
  }

  parts.push(
    separation >= 0.6
      ? 'decisions are well-separated'
      : 'decisions overlap significantly'
  );

  const scoreBand = finalScore >= 0.7 ? 'high' : finalScore >= 0.4 ? 'medium' : 'low';

  return `[structural:${mode}] ${parts.join('; ')} (${scoreBand} score: ${finalScore.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// StructuralScorerAdapter
// ---------------------------------------------------------------------------

/**
 * StructuralScorerAdapter — checkpoint-agnostic baseline / mock evaluator.
 *
 * Scores based purely on structural heuristics (keyword alignment, decision
 * separation, rationale strength). The checkpointRef parameter is accepted
 * for interface compatibility but has NO effect on the score — the same
 * sample always receives the same score regardless of which checkpoint is
 * being evaluated.
 *
 * This is the correct behavior for a structural evaluator: it measures the
 * intrinsic quality of the training data (chosen/rejected/rationale
 * alignment), not the quality of any particular checkpoint.
 *
 * runCompare() with StructuralScorerAdapter alone: delta ≈ 0 for any
 * baseline/candidate pair. This is expected and is NOT a bug.
 */
export const STRUCTURAL_SCORER_VERSION = '1.0.0';

export const StructuralScorerAdapter: ScorerAdapter = {
  evaluatorType: 'structural',
  version: STRUCTURAL_SCORER_VERSION,

  async score(
    sample: ORPOSample,
    mode: EvalMode,
    _checkpointRef?: string
  ): Promise<ScoredSample> {
    // NOTE: _checkpointRef is intentionally ignored.
    //       Structural scorer is checkpoint-agnostic — same sample, same score.
    const rationaleKW = extractKeywords(sample.rationale);
    const chosenKW = extractKeywords(sample.chosen);
    const rejectedKW = extractKeywords(sample.rejected);

    // 1. Chosen alignment with rationale (0.0–1.0)
    const chosenRationaleOverlap = keywordOverlap(chosenKW, rationaleKW);

    // 2. Rejected contradiction with rationale (0.0–1.0)
    const rejectedRationaleOverlap = keywordOverlap(rejectedKW, rationaleKW);
    const rejectedPenalty = rejectedRationaleOverlap * (1 - chosenRationaleOverlap);

    // 3. Decision separation (0.0–1.0)
    const separation = decisionSeparation(sample.chosen, sample.rejected);

    // 4. Rationale strength (0.0–1.0)
    const rStrength = rationaleStrength(sample.rationale);

    // 5. Action language in chosen (bonus 0.0–0.1)
    const actionBonus = hasActionLanguage(sample.chosen) ? 0.1 : 0.0;

    // Combine scores
    const baseScore = (chosenRationaleOverlap * 0.35) +
      (separation * 0.25) +
      (rStrength * 0.25) +
      actionBonus -
      (rejectedPenalty * 0.15);

    // In reduced_prompt mode, rationale is not available to the worker
    let finalScore: number;
    if (mode === 'reduced_prompt') {
      const rationaleDependency = chosenRationaleOverlap * rStrength;
      finalScore = baseScore * (1 - rationaleDependency * 0.4);
    } else {
      finalScore = baseScore;
    }

    // Clamp to 0.0–1.0 — NO checkpoint bias applied
    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    const justification = buildJustification(
      mode,
      chosenRationaleOverlap,
      rejectedPenalty,
      separation,
      rStrength,
      finalScore
    );

    return {
      sampleFingerprint: sample.sampleFingerprint,
      score: Math.round(finalScore * 1000) / 1000,
      justification,
      mode,
      evaluator: {
        type: 'structural',
        version: STRUCTURAL_SCORER_VERSION,
        checkpointRef: undefined, // structural scorer is checkpoint-agnostic
      },
    };
  },
};

// ---------------------------------------------------------------------------
// LocalModelScorerAdapter
// ---------------------------------------------------------------------------

/**
 * LocalModelScorerAdapter — placeholder for real model-based evaluation.
 *
 * This adapter is the entry point for checkpoint-aware evaluation using a
 * real model. The checkpointRef is used to route to the appropriate
 * checkpoint-specific model variant.
 *
 * CURRENT IMPLEMENTATION: STUB
 * The stub returns a fixed score so the adapter contract is exercised in
 * the benchmark pipeline without requiring actual model inference.
 * Replace the stub body with real model inference when the evaluation
 * infrastructure is available.
 *
 * REQUIRED: Real implementation must call the actual model endpoint for
 * the specified checkpointRef and return the model's genuine assessment.
 * The score must reflect real model behavior, NOT synthetic bias.
 */
export const LOCAL_MODEL_SCORER_VERSION = '0.1.0-stub';

/**
 * STUB IMPLEMENTATION — replace with real model inference.
 *
 * This stub exists to establish the ScorerAdapter contract in the pipeline.
 * It does NOT produce meaningful checkpoint-specific scores.
 */
async function stubModelScore(
  _sample: ORPOSample,
  _mode: EvalMode,
  checkpointRef: string
): Promise<number> {
  // TODO (when real model inference is available):
  // 1. Resolve checkpointRef to model endpoint / variant config
  // 2. Construct prompt from sample (chosen/rejected/rationale)
  // 3. Call model endpoint for each sample
  // 4. Return model's genuine score (0.0–1.0)
  //
  // The stub below returns 0.5 so that runCompare() with two different
  // checkpointRefs still shows the contract works, but produces no
  // meaningful delta until real inference is plugged in.
  void _sample;
  void _mode;
  void checkpointRef;
  return 0.5;
}

export const LocalModelScorerAdapter: ScorerAdapter = {
  evaluatorType: 'local-model',
  version: LOCAL_MODEL_SCORER_VERSION,

  async score(
    sample: ORPOSample,
    mode: EvalMode,
    checkpointRef?: string
  ): Promise<ScoredSample> {
    const rawScore = await stubModelScore(sample, mode, checkpointRef ?? 'unknown');
    const score = Math.round(Math.max(0.0, Math.min(1.0, rawScore)) * 1000) / 1000;

    return {
      sampleFingerprint: sample.sampleFingerprint,
      score,
      justification: `[local-model:${mode}:${checkpointRef ?? 'no-ref'}] stub score: ${score.toFixed(3)} — replace with real model inference`,
      mode,
      evaluator: {
        type: 'local-model',
        version: LOCAL_MODEL_SCORER_VERSION,
        checkpointRef,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Scorer Adapter Registry
// ---------------------------------------------------------------------------

export const STRUCTURAL_SCORER_TYPE = 'structural' as const;
export const LOCAL_MODEL_SCORER_TYPE = 'local-model' as const;
export type RegisteredScorerType = typeof STRUCTURAL_SCORER_TYPE | typeof LOCAL_MODEL_SCORER_TYPE;

/**
 * Get a ScorerAdapter by name.
 *
 * Available scorers:
 * - 'structural': StructuralScorerAdapter (checkpoint-agnostic, deterministic)
 * - 'local-model': LocalModelScorerAdapter (checkpoint-aware, stub — replace with real model)
 */
export function getScorerAdapter(name: string): ScorerAdapter {
  switch (name) {
    case STRUCTURAL_SCORER_TYPE:
      return StructuralScorerAdapter;
    case LOCAL_MODEL_SCORER_TYPE:
      return LocalModelScorerAdapter;
    default:
      throw new Error(
        `Unknown scorer type: "${name}". Available: ${STRUCTURAL_SCORER_TYPE}, ${LOCAL_MODEL_SCORER_TYPE}`
      );
  }
}
