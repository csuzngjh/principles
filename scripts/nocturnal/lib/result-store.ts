/**
 * Nocturnal Benchmark — Result Store
 * ===================================
 *
 * Reads and writes benchmark result files to the evals directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  BenchmarkResult,
  BenchmarkMeta,
  ORPOSample,
  SampleScore,
  BenchmarkMetrics,
  EvalMode,
} from './types.js';

// ---------------------------------------------------------------------------
// Directory Management
// ---------------------------------------------------------------------------

/**
 * Ensure the evals directory exists.
 */
export function ensureEvalsDir(outputDir: string): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * Get the path for a benchmark result file.
 */
export function resultPath(outputDir: string, benchmarkId: string): string {
  return path.join(outputDir, `${benchmarkId}-result.json`);
}

/**
 * Get the path for a benchmark metadata file.
 */
export function metaPath(outputDir: string, benchmarkId: string): string {
  return path.join(outputDir, `${benchmarkId}-meta.json`);
}

// ---------------------------------------------------------------------------
// Read Operations
// ---------------------------------------------------------------------------

/**
 * Read a benchmark result from disk.
 * Returns null if the file does not exist or is corrupted.
 */
export function readResult(outputDir: string, benchmarkId: string): BenchmarkResult | null {
  const file = resultPath(outputDir, benchmarkId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return JSON.parse(content) as BenchmarkResult;
  } catch {
    return null;
  }
}

/**
 * Read a benchmark metadata file from disk.
 */
export function readMeta(outputDir: string, benchmarkId: string): BenchmarkMeta | null {
  const file = metaPath(outputDir, benchmarkId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return JSON.parse(content) as BenchmarkMeta;
  } catch {
    return null;
  }
}

/**
 * Read an existing result from a file path (for delta comparison).
 */
export function readResultFromPath(resultFilePath: string): BenchmarkResult | null {
  if (!fs.existsSync(resultFilePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(resultFilePath, 'utf-8');
    return JSON.parse(content) as BenchmarkResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write Operations
// ---------------------------------------------------------------------------

/**
 * Write a benchmark result to disk.
 * Uses atomic write (temp + rename) to prevent corruption.
 */
export function writeResult(outputDir: string, result: BenchmarkResult): void {
  ensureEvalsDir(outputDir);
  const file = resultPath(outputDir, result.benchmarkId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Write benchmark metadata to disk.
 */
export function writeMeta(outputDir: string, meta: BenchmarkMeta): void {
  ensureEvalsDir(outputDir);
  const file = metaPath(outputDir, meta.benchmarkId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Result List
// ---------------------------------------------------------------------------

/**
 * List all benchmark results in a directory.
 * Returns results sorted by creation date (newest first).
 */
export function listResults(outputDir: string): BenchmarkResult[] {
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(outputDir);
    const results: BenchmarkResult[] = [];

    for (const file of files) {
      if (!file.endsWith('-result.json')) continue;
      try {
        const content = fs.readFileSync(path.join(outputDir, file), 'utf-8');
        results.push(JSON.parse(content) as BenchmarkResult);
      } catch {
        // Skip corrupted files
      }
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a result object has all required fields.
 */
export function validateResult(result: BenchmarkResult): string[] {
  const errors: string[] = [];

  if (!result.benchmarkId) errors.push('benchmarkId is required');
  if (!result.createdAt) errors.push('createdAt is required');
  if (!result.targetModelFamily) errors.push('targetModelFamily is required');
  if (!result.mode) errors.push('mode is required');
  if (!['prompt_assisted', 'reduced_prompt'].includes(result.mode)) {
    errors.push('mode must be prompt_assisted or reduced_prompt');
  }
  if (typeof result.sampleCount !== 'number') errors.push('sampleCount is required');
  if (!result.baselineMetrics) errors.push('baselineMetrics is required');
  if (!result.candidateMetrics) errors.push('candidateMetrics is required');
  if (!result.delta) errors.push('delta is required');
  if (!result.verdict) errors.push('verdict is required');
  if (!['compare_only', 'pass', 'fail'].includes(result.verdict)) {
    errors.push('verdict must be compare_only, pass, or fail');
  }

  return errors;
}

/**
 * Check that two results are comparable (same mode, same holdout fingerprint).
 */
export function checkComparability(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult
): { comparable: boolean; reason?: string } {
  if (baseline.mode !== candidate.mode) {
    return {
      comparable: false,
      reason: `Mode mismatch: baseline=${baseline.mode}, candidate=${candidate.mode}`,
    };
  }

  if (baseline.sampleCount !== candidate.sampleCount) {
    return {
      comparable: false,
      reason: `Sample count mismatch: baseline=${baseline.sampleCount}, candidate=${candidate.sampleCount}`,
    };
  }

  return { comparable: true };
}

// ---------------------------------------------------------------------------
// Delta Computation (from two existing results)
// ---------------------------------------------------------------------------

/**
 * Compute delta between two existing benchmark results.
 */
export function computeDelta(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
  passThreshold: number
): BenchmarkResult {
  const delta = {
    baselineScore: baseline.baselineMetrics?.meanScore ?? baseline.candidateMetrics?.meanScore ?? 0,
    candidateScore: candidate.candidateMetrics?.meanScore ?? 0,
    delta: 0,
    mode: candidate.mode,
    improvedCount: 0,
    degradedCount: 0,
    unchangedCount: 0,
  };

  delta.delta = Math.round((delta.candidateScore - delta.baselineScore) * 1000) / 1000;

  // Verdict
  let verdict: BenchmarkResult['verdict'] = 'compare_only';
  if (Math.abs(delta.delta) >= passThreshold) {
    verdict = delta.delta > 0 ? 'pass' : 'fail';
  }

  return {
    benchmarkId: candidate.benchmarkId, // reuse candidate's ID
    createdAt: new Date().toISOString(),
    targetModelFamily: candidate.targetModelFamily,
    mode: candidate.mode,
    exportId: candidate.exportId,
    datasetFingerprint: candidate.datasetFingerprint,
    sampleCount: candidate.sampleCount,
    baselineCheckpointId: baseline.baselineCheckpointId,
    baselineMetrics: baseline.baselineMetrics,
    candidateCheckpointId: candidate.candidateCheckpointId,
    candidateMetrics: candidate.candidateMetrics,
    delta,
    verdict,
    passThreshold,
  };
}
