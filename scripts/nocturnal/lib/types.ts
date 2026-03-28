/**
 * Nocturnal Benchmark — Shared Types
 * ==================================
 *
 * Type definitions used across all benchmark modules.
 * Mirrors the spec in docs/spec/nocturnal-eval-benchmark.md
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Evaluation Modes
// ---------------------------------------------------------------------------

export type EvalMode = 'prompt_assisted' | 'reduced_prompt';

// ---------------------------------------------------------------------------
// ORPO Sample (read from JSONL export)
// ---------------------------------------------------------------------------

export interface ORPOSample {
  sampleFingerprint: string;
  artifactId: string;
  sessionId: string;
  principleId: string;
  targetModelFamily: string;
  prompt: string;
  chosen: string;
  rejected: string;
  rationale: string;
  datasetMetadata: {
    sampleFingerprint: string;
    artifactPath: string;
    createdAt: string;
    exportedAt: string;
    exportId: string;
    datasetFingerprint: string;
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface SampleScore {
  sampleFingerprint: string;
  score: number;        // 0.0 – 1.0
  justification: string; // brief explanation
  mode: EvalMode;
  scorerVersion: string;
}

export interface BenchmarkMetrics {
  meanScore: number;
  medianScore: number;
  stdDev: number;
  passRate: number;  // fraction scoring above 0.7
  failRate: number;  // fraction scoring below 0.3
}

// ---------------------------------------------------------------------------
// Benchmark Result
// ---------------------------------------------------------------------------

export type BenchmarkVerdict = 'compare_only' | 'pass' | 'fail';

export interface DeltaResult {
  baselineScore: number;
  candidateScore: number;
  delta: number;
  mode: EvalMode;
  improvedCount: number;
  degradedCount: number;
  unchangedCount: number;
}

export interface BenchmarkResult {
  benchmarkId: string;
  createdAt: string;
  targetModelFamily: string;
  mode: EvalMode;

  /** Source export that was evaluated */
  exportId: string;
  datasetFingerprint: string;

  /** How many samples were in the holdout set */
  sampleCount: number;

  /** Baseline checkpoint reference */
  baselineCheckpointId?: string;
  baselineMetrics: BenchmarkMetrics;

  /** Candidate checkpoint reference */
  candidateCheckpointId?: string;
  candidateMetrics: BenchmarkMetrics;

  /** Comparison result */
  delta: DeltaResult;

  /** Overall verdict */
  verdict: BenchmarkVerdict;

  /** Pass threshold */
  passThreshold: number;
}

export interface BenchmarkMeta {
  benchmarkId: string;
  createdAt: string;
  runnerVersion: string;
  mode: EvalMode;
  targetModelFamily: string;
  exportId: string;
  sampleCount: number;
  holdoutFingerprint: string;
  baselineCheckpointId?: string;
  candidateCheckpointId?: string;
  evalsDir: string;
}

// ---------------------------------------------------------------------------
// Export Manifest (from Phase 3)
// ---------------------------------------------------------------------------

export interface ORPOExportManifest {
  exportId: string;
  createdAt: string;
  sampleCount: number;
  targetModelFamily: string;
  datasetFingerprint: string;
  exportPath: string;
  manifestPath: string;
  samples: Array<{
    sampleFingerprint: string;
    artifactId: string;
    sessionId: string;
    principleId: string;
  }>;
}

// ---------------------------------------------------------------------------
// Scorer Adapter Contract
// ---------------------------------------------------------------------------

/**
 * Evaluator metadata returned alongside each score.
 * Allows benchmark consumers to understand where the score came from.
 */
export interface EvaluatorInfo {
  /** e.g. 'structural', 'local-model', 'human' */
  type: string;
  /** Version string for the evaluator implementation */
  version: string;
  /**
   * Checkpoint reference this evaluator used for this specific score.
   * undefined means the evaluator is checkpoint-agnostic (e.g. structural).
   */
  checkpointRef?: string;
}

/**
 * Result of a single sample evaluation.
 * Returned by ScorerAdapter.score() — not just a raw number.
 */
export interface ScoredSample {
  sampleFingerprint: string;
  score: number;          // 0.0 – 1.0
  justification: string;  // human-readable explanation
  mode: EvalMode;
  evaluator: EvaluatorInfo;
}

/**
 * ScorerAdapter — the core evaluation contract for Phase 4.
 *
 * IMPORTANT: Delta must come from the evaluator's real assessment of the
 * checkpoint's behavioral output, NOT from synthetic manipulation of the
 * checkpointRef string (no hashing, no string-derived bias).
 *
 * Concrete rules:
 * - StructuralScorerAdapter: deterministic, checkpoint-agnostic — same sample
 *   always gets the same score regardless of checkpointRef.
 * - LocalModelScorerAdapter: routes to real model inference per checkpointRef —
 *   different checkpointRefs can produce genuinely different scores.
 * - runCompare() may NOT inject bias itself; it must consume whatever
 *   the adapter returns.
 */
export interface ScorerAdapter {
  /**
   * Score a single ORPO sample.
   *
   * @param sample       The ORPOSample to evaluate
   * @param mode         Evaluation mode (prompt_assisted | reduced_prompt)
   * @param checkpointRef Identifies which checkpoint variant to evaluate against.
   *                      The adapter decides how to use this:
   *                      - StructuralScorerAdapter: ignores it (returns deterministic score)
   *                      - LocalModelScorerAdapter: routes to checkpoint-specific model endpoint
   *                      - Future adapters: use whatever checkpoint-specific mechanism is appropriate
   * @returns ScoredSample with score, justification, and evaluator metadata.
   *          The score MUST reflect the evaluator's real assessment of the sample
   *          under the given checkpoint, not a synthetic bias derived from the
   *          checkpointRef string itself.
   */
  score(sample: ORPOSample, mode: EvalMode, checkpointRef?: string): Promise<ScoredSample>;

  /** Human-readable type identifier, e.g. 'structural' or 'local-model' */
  readonly evaluatorType: string;

  /** Implementation version for traceability */
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Command Options
// ---------------------------------------------------------------------------

export interface CompareOptions {
  exportId: string;
  baselineCheckpointRef: string;
  candidateCheckpointRef: string;
  mode: EvalMode;
  outputDir: string;
  scorerType?: string; // 'structural' | 'local-model' — default: 'structural'
  holdoutRatio?: number; // 0.0–1.0 — default: 0.2
  passThreshold?: number; // default: 0.05
}

export interface RunOptions {
  exportId: string;
  checkpointRef: string;
  mode: EvalMode;
  outputDir: string;
  scorerType?: string;
  holdoutRatio?: number;
}

export interface DeltaOptions {
  baselineResultPath: string;
  candidateResultPath: string;
  outputDir: string;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic benchmark ID from components.
 */
export function computeBenchmarkId(
  exportId: string,
  mode: EvalMode,
  holdoutFingerprint: string
): string {
  const input = `${exportId}|${mode}|${holdoutFingerprint}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Compute a fingerprint of a set of sample fingerprints (for holdout identification).
 */
export function computeHoldoutFingerprint(sampleFingerprints: string[]): string {
  const sorted = [...sampleFingerprints].sort();
  const combined = sorted.join('|');
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
}

/**
 * Compute aggregate metrics from a list of scores.
 */
export function computeMetrics(scores: Array<{ score: number }>): BenchmarkMetrics {
  if (scores.length === 0) {
    return { meanScore: 0, medianScore: 0, stdDev: 0, passRate: 0, failRate: 0 };
  }

  const values = scores.map((s) => s.score).sort((a, b) => a - b);

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const median = values.length % 2 === 0
    ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
    : values[Math.floor(values.length / 2)];
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const passRate = values.filter((v) => v >= 0.7).length / values.length;
  const failRate = values.filter((v) => v < 0.3).length / values.length;

  return { meanScore: mean, medianScore: median, stdDev, passRate, failRate };
}
