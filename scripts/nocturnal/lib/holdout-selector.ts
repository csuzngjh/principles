/**
 * Nocturnal Benchmark — Holdout Selector
 * =======================================
 *
 * Selects a holdout subset from an exported ORPO dataset.
 *
 * HOLDING STRATEGY (Phase 4):
 * - Default: 20% holdout, 80% evaluation
 * - Selection is deterministic based on fingerprint sorting
 * - This ensures reproducible splits across runs
 *
 * NOTE: In Phase 4 there is no real training, so the "holdout" concept
 * is theoretical. The runner still enforces the split to maintain
 * compatibility with future real training integration.
 */

import * as crypto from 'crypto';
import type { ORPOSample } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HOLDOUT_RATIO = 0.2;

/**
 * Compute a deterministic split of samples into evaluation and holdout sets.
 *
 * The split is deterministic so that:
 * - The same benchmark run on the same export always evaluates the same samples
 * - Comparison between baseline and candidate uses the same holdout set
 *
 * @param samples All ORPOSamples from an export
 * @param holdoutRatio Fraction to hold out (default: 0.2)
 * @returns Two arrays: [evaluationSet, holdoutSet]
 */
export function selectHoldout(
  samples: ORPOSample[],
  holdoutRatio: number = DEFAULT_HOLDOUT_RATIO
): { evaluationSet: ORPOSample[]; holdoutSet: ORPOSample[] } {
  if (samples.length === 0) {
    return { evaluationSet: [], holdoutSet: [] };
  }

  if (samples.length < 5) {
    // Too few samples — use all for evaluation, none for holdout
    return { evaluationSet: samples, holdoutSet: [] };
  }

  // Sort by sampleFingerprint for deterministic ordering
  const sorted = [...samples].sort((a, b) =>
    a.sampleFingerprint.localeCompare(b.sampleFingerprint)
  );

  // Take the first N as holdout (deterministic: based on sorted order)
  const holdoutCount = Math.max(1, Math.floor(sorted.length * holdoutRatio));
  const holdoutSet = sorted.slice(0, holdoutCount);
  const evaluationSet = sorted.slice(holdoutCount);

  return { evaluationSet, holdoutSet };
}

/**
 * Compute a fingerprint of the holdout set for run identification.
 * This is stored in BenchmarkMeta so we can verify the holdout was the same.
 */
export function computeHoldoutFingerprint(samples: ORPOSample[]): string {
  const fingerprints = samples.map((s) => s.sampleFingerprint).sort();
  const combined = fingerprints.join('|');
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
}

/**
 * Verify that a result's holdout fingerprint matches the current holdout set.
 * Used to ensure we're comparing apples-to-apples.
 */
export function verifyHoldoutConsistency(
  storedFingerprint: string,
  currentSamples: ORPOSample[]
): boolean {
  const currentFingerprint = computeHoldoutFingerprint(currentSamples);
  return currentFingerprint === storedFingerprint;
}

/**
 * Exclude samples from a specific training dataset from the evaluation set.
 * Used when we want to hold out the training set itself from evaluation.
 *
 * @param samples All samples
 * @param excludeDatasetFingerprint Samples from this dataset are excluded
 * @returns Filtered samples (those NOT from the excluded dataset)
 */
export function excludeTrainingSet(
  samples: ORPOSample[],
  excludeDatasetFingerprint: string
): ORPOSample[] {
  return samples.filter(
    (s) => s.datasetMetadata.datasetFingerprint !== excludeDatasetFingerprint
  );
}

/**
 * Create a deterministic train/eval split for a single dataset.
 * Used when building a benchmark from scratch.
 */
export function createTrainEvalSplit(
  samples: ORPOSample[],
  evalRatio: number = 0.8
): { trainSet: ORPOSample[]; evalSet: ORPOSample[] } {
  const sorted = [...samples].sort((a, b) =>
    a.sampleFingerprint.localeCompare(b.sampleFingerprint)
  );

  const evalCount = Math.max(1, Math.floor(sorted.length * evalRatio));
  const evalSet = sorted.slice(0, evalCount);
  const trainSet = sorted.slice(evalCount);

  return { trainSet, evalSet };
}
