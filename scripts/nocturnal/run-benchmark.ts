#!/usr/bin/env node
/**
 * Nocturnal Benchmark Runner
 * ==========================
 *
 * Standalone benchmark runner for nocturnal ORPO evaluation.
 *
 * Usage:
 *   npx ts-node scripts/nocturnal/run-benchmark.ts compare [options]
 *   npx ts-node scripts/nocturnal/run-benchmark.ts run [options]
 *   npx ts-node scripts/nocturnal/run-benchmark.ts delta [options]
 *
 * Examples:
 *   # Compare baseline vs candidate on a holdout set
 *   npx ts-node scripts/nocturnal/run-benchmark.ts compare \
 *     --export-id abc123 \
 *     --baseline checkpoint-baseline-v1 \
 *     --candidate checkpoint-candidate-v2 \
 *     --mode reduced_prompt \
 *     --output-dir .state/nocturnal/evals
 *
 *   # Run a single checkpoint without comparison
 *   npx ts-node scripts/nocturnal/run-benchmark.ts run \
 *     --export-id abc123 \
 *     --checkpoint checkpoint-v1 \
 *     --mode prompt_assisted \
 *     --output-dir .state/nocturnal/evals
 *
 *   # Compare two existing result files
 *   npx ts-node scripts/nocturnal/run-benchmark.ts delta \
 *     --baseline-result .state/nocturnal/evals/benchmark-001-result.json \
 *     --candidate-result .state/nocturnal/evals/benchmark-002-result.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type ORPOSample,
  type EvalMode,
  type BenchmarkResult,
  type BenchmarkMeta,
  type BenchmarkMetrics,
  type CompareOptions,
  type RunOptions,
  type DeltaOptions,
  type ScoredSample,
  computeMetrics,
  computeBenchmarkId,
  computeHoldoutFingerprint,
} from './lib/types.js';
import {
  getScorerAdapter,
} from './lib/scorer.js';
import {
  ensureEvalsDir,
  writeResult,
  writeMeta,
  readResultFromPath,
  computeDelta,
  checkComparability,
} from './lib/result-store.js';
import {
  selectHoldout,
  excludeTrainingSet,
} from './lib/holdout-selector.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNNER_VERSION = '0.1.0';
const DEFAULT_OUTPUT_DIR = '.state/nocturnal/evals';

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  command: string;
  options: Record<string, string>;
} {
  const command = argv[2] || 'compare';
  const options: Record<string, string> = {};

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        options[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      } else {
        options[arg.slice(2)] = argv[i + 1] || '';
        i++;
      }
    }
  }

  return { command, options };
}

// ---------------------------------------------------------------------------
// Export Reader
// ---------------------------------------------------------------------------

/**
 * Read ORPO samples from an export JSONL file.
 */
function readExportSamples(exportPath: string): ORPOSample[] {
  if (!fs.existsSync(exportPath)) {
    throw new Error(`Export file not found: ${exportPath}`);
  }

  const content = fs.readFileSync(exportPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const samples: ORPOSample[] = [];

  for (const line of lines) {
    try {
      samples.push(JSON.parse(line) as ORPOSample);
    } catch {
      // Skip malformed lines
    }
  }

  if (samples.length === 0) {
    throw new Error(`No valid samples found in export: ${exportPath}`);
  }

  return samples;
}

/**
 * Read export metadata from the manifest file.
 */
function readExportManifest(manifestPath: string): {
  exportId: string;
  datasetFingerprint: string;
  targetModelFamily: string;
} {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const content = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(content);
  return {
    exportId: manifest.exportId,
    datasetFingerprint: manifest.datasetFingerprint,
    targetModelFamily: manifest.targetModelFamily,
  };
}

// ---------------------------------------------------------------------------
// Core Benchmark Logic
// ---------------------------------------------------------------------------

/**
 * Run the ScorerAdapter on a set of samples.
 *
 * @param checkpointRef Checkpoint reference passed to the adapter.
 *                      The adapter decides how to use it:
 *                      - StructuralScorerAdapter: ignores it (deterministic)
 *                      - LocalModelScorerAdapter: routes to checkpoint-specific model
 *
 * IMPORTANT: The scorer is responsible for producing genuine checkpoint-aware
 * scores. The runner does NOT inject any bias — it only passes checkpointRef
 * and records whatever the adapter returns.
 */
async function runScoring(
  samples: ORPOSample[],
  mode: EvalMode,
  scorerType: string,
  checkpointRef?: string,
  onProgress?: (done: number, total: number) => void
): Promise<ScoredSample[]> {
  const adapter = getScorerAdapter(scorerType);
  const scores: ScoredSample[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    try {
      const scored = await adapter.score(sample, mode, checkpointRef);
      scores.push(scored);
    } catch (err) {
      // Fail-safe: assign 0.0 to samples that throw
      scores.push({
        sampleFingerprint: sample.sampleFingerprint,
        score: 0.0,
        justification: `[${adapter.evaluatorType}:${mode}:${checkpointRef ?? 'no-ref'}] scoring failed: ${String(err)}`,
        mode,
        evaluator: {
          type: adapter.evaluatorType,
          version: adapter.version,
          checkpointRef,
        },
      });
    }

    if (onProgress) {
      onProgress(i + 1, samples.length);
    }
  }

  return scores;
}

/**
 * Run a single checkpoint on the evaluation set.
 */
async function runSingle(
  samples: ORPOSample[],
  mode: EvalMode,
  scorerType: string,
  checkpointRef: string,
  exportId: string,
  datasetFingerprint: string,
  targetModelFamily: string,
  outputDir: string,
  holdoutRatio: number,
  passThreshold: number
): Promise<BenchmarkResult> {
  // Select holdout
  const { evaluationSet, holdoutSet } = selectHoldout(samples, holdoutRatio);

  if (evaluationSet.length === 0) {
    throw new Error(
      `Holdout selection resulted in empty evaluation set. ` +
      `Need at least 1 sample, got ${samples.length}. ` +
      `Adjust --holdout-ratio or provide more samples.`
    );
  }

  const holdoutFingerprint = computeHoldoutFingerprint(holdoutSet);
  const benchmarkId = computeBenchmarkId(exportId, mode, holdoutFingerprint);

  // Ensure output directory exists
  ensureEvalsDir(outputDir);

  // Score evaluation set
  console.error(`[benchmark] Scoring ${evaluationSet.length} samples (mode: ${mode})...`);
  const scores = await runScoring(evaluationSet, mode, scorerType, checkpointRef);

  // Compute metrics
  const metrics = computeMetrics(scores);

  // Determine verdict
  let verdict: BenchmarkResult['verdict'] = 'compare_only';

  // Build result (single-run mode: both baseline and candidate point to same checkpoint)
  const result: BenchmarkResult = {
    benchmarkId,
    createdAt: new Date().toISOString(),
    targetModelFamily,
    mode,
    exportId,
    datasetFingerprint,
    sampleCount: evaluationSet.length,
    baselineCheckpointId: checkpointRef,
    baselineMetrics: metrics,
    candidateCheckpointId: checkpointRef,
    candidateMetrics: metrics,
    delta: {
      baselineScore: metrics.meanScore,
      candidateScore: metrics.meanScore,
      delta: 0,
      mode,
      improvedCount: 0,
      degradedCount: 0,
      unchangedCount: evaluationSet.length,
    },
    verdict,
    passThreshold,
  };

  // Write result
  writeResult(outputDir, result);

  // Write metadata
  const meta: BenchmarkMeta = {
    benchmarkId,
    createdAt: result.createdAt,
    runnerVersion: RUNNER_VERSION,
    mode,
    targetModelFamily,
    exportId,
    sampleCount: evaluationSet.length,
    holdoutFingerprint,
    baselineCheckpointId: checkpointRef,
    candidateCheckpointId: checkpointRef,
    evalsDir: outputDir,
  };
  writeMeta(outputDir, meta);

  console.error(`[benchmark] Result written: ${benchmarkId}`);
  console.error(`[benchmark] Metrics: mean=${metrics.meanScore.toFixed(3)}, ` +
    `median=${metrics.medianScore.toFixed(3)}, stdDev=${metrics.stdDev.toFixed(3)}`);

  return result;
}

/**
 * Compare baseline vs candidate checkpoints.
 */
async function runCompare(
  samples: ORPOSample[],
  mode: EvalMode,
  scorerType: string,
  baselineRef: string,
  candidateRef: string,
  exportId: string,
  datasetFingerprint: string,
  targetModelFamily: string,
  outputDir: string,
  holdoutRatio: number,
  passThreshold: number
): Promise<BenchmarkResult> {
  // Select holdout
  const { evaluationSet, holdoutSet } = selectHoldout(samples, holdoutRatio);

  if (evaluationSet.length === 0) {
    throw new Error(
      `Holdout selection resulted in empty evaluation set. ` +
      `Need at least 1 sample, got ${samples.length}.`
    );
  }

  const holdoutFingerprint = computeHoldoutFingerprint(holdoutSet);
  const benchmarkId = computeBenchmarkId(exportId, mode, holdoutFingerprint);

  ensureEvalsDir(outputDir);

  // Score evaluation set (same set for both baseline and candidate)
  console.error(`[benchmark] Scoring ${evaluationSet.length} samples for baseline (${baselineRef})...`);
  const baselineScores = await runScoring(evaluationSet, mode, scorerType, baselineRef);
  const baselineMetrics = computeMetrics(baselineScores);

  console.error(`[benchmark] Scoring ${evaluationSet.length} samples for candidate (${candidateRef})...`);
  const candidateScores = await runScoring(evaluationSet, mode, scorerType, candidateRef);
  const candidateMetrics = computeMetrics(candidateScores);

  // Compute delta per sample
  const scoreMap = new Map<string, { baseline: number; candidate: number }>();
  for (const s of baselineScores) {
    scoreMap.set(s.sampleFingerprint, { baseline: s.score, candidate: 0 });
  }
  for (const s of candidateScores) {
    const entry = scoreMap.get(s.sampleFingerprint);
    if (entry) entry.candidate = s.score;
  }

  let improvedCount = 0;
  let degradedCount = 0;
  let unchangedCount = 0;

  for (const [, { baseline, candidate }] of scoreMap) {
    if (candidate > baseline) improvedCount++;
    else if (candidate < baseline) degradedCount++;
    else unchangedCount++;
  }

  const delta = {
    baselineScore: Math.round(baselineMetrics.meanScore * 1000) / 1000,
    candidateScore: Math.round(candidateMetrics.meanScore * 1000) / 1000,
    delta: Math.round((candidateMetrics.meanScore - baselineMetrics.meanScore) * 1000) / 1000,
    mode,
    improvedCount,
    degradedCount,
    unchangedCount,
  };

  // Determine verdict
  let verdict: BenchmarkResult['verdict'] = 'compare_only';
  if (Math.abs(delta.delta) >= passThreshold) {
    verdict = delta.delta > 0 ? 'pass' : 'fail';
  }

  const result: BenchmarkResult = {
    benchmarkId,
    createdAt: new Date().toISOString(),
    targetModelFamily,
    mode,
    exportId,
    datasetFingerprint,
    sampleCount: evaluationSet.length,
    baselineCheckpointId: baselineRef,
    baselineMetrics,
    candidateCheckpointId: candidateRef,
    candidateMetrics,
    delta,
    verdict,
    passThreshold,
  };

  writeResult(outputDir, result);

  const meta: BenchmarkMeta = {
    benchmarkId,
    createdAt: result.createdAt,
    runnerVersion: RUNNER_VERSION,
    mode,
    targetModelFamily,
    exportId,
    sampleCount: evaluationSet.length,
    holdoutFingerprint,
    baselineCheckpointId: baselineRef,
    candidateCheckpointId: candidateRef,
    evalsDir: outputDir,
  };
  writeMeta(outputDir, meta);

  console.error(`[benchmark] Result written: ${benchmarkId}`);
  console.error(`[benchmark] Delta: ${delta.delta >= 0 ? '+' : ''}${delta.delta.toFixed(3)} ` +
    `(${baselineMetrics.meanScore.toFixed(3)} → ${candidateMetrics.meanScore.toFixed(3)})`);
  console.error(`[benchmark] Verdict: ${verdict}`);

  return result;
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

async function handleCompare(opts: Record<string, string>): Promise<void> {
  const {
    'export-id': exportId,
    baseline,
    candidate,
    mode = 'reduced_prompt',
    'output-dir': outputDir = DEFAULT_OUTPUT_DIR,
    scorer = 'structural',
    'holdout-ratio': holdoutRatioStr = '0.2',
    'pass-threshold': passThresholdStr = '0.05',
  } = opts;

  // Validate required args
  if (!exportId) {
    throw new Error('--export-id is required');
  }
  if (!baseline) {
    throw new Error('--baseline is required');
  }
  if (!candidate) {
    throw new Error('--candidate is required');
  }

  const mode_: EvalMode = mode === 'prompt_assisted' ? 'prompt_assisted' : 'reduced_prompt';
  const holdoutRatio = parseFloat(holdoutRatioStr);
  const passThreshold = parseFloat(passThresholdStr);

  if (holdoutRatio <= 0 || holdoutRatio >= 1) {
    throw new Error('--holdout-ratio must be between 0 and 1');
  }

  // Resolve export path
  const exportsDir = path.join(process.cwd(), '.state', 'exports', 'orpo');
  const exportPath = path.join(exportsDir, `${exportId}.jsonl`);
  const manifestPath = path.join(exportsDir, `${exportId}-manifest.json`);

  console.error(`[benchmark] Reading export: ${exportPath}`);
  const samples = readExportSamples(exportPath);
  const manifest = readExportManifest(manifestPath);

  console.error(`[benchmark] Loaded ${samples.length} samples from export ${exportId}`);

  // Exclude training set if datasetFingerprint is provided (not in Phase 4 but for future)
  const evalSamples = excludeTrainingSet(samples, manifest.datasetFingerprint);
  if (evalSamples.length < samples.length) {
    console.error(`[benchmark] Excluded ${samples.length - evalSamples.length} training samples from evaluation`);
  }

  const result = await runCompare(
    evalSamples,
    mode_,
    scorer,
    baseline,
    candidate,
    exportId,
    manifest.datasetFingerprint,
    manifest.targetModelFamily,
    outputDir,
    holdoutRatio,
    passThreshold
  );

  // Output result JSON to stdout
  process.stdout.write(JSON.stringify(result, null, 2));
}

async function handleRun(opts: Record<string, string>): Promise<void> {
  const {
    'export-id': exportId,
    checkpoint,
    mode = 'reduced_prompt',
    'output-dir': outputDir = DEFAULT_OUTPUT_DIR,
    scorer = 'structural',
    'holdout-ratio': holdoutRatioStr = '0.2',
    'pass-threshold': passThresholdStr = '0.05',
  } = opts;

  if (!exportId) {
    throw new Error('--export-id is required');
  }
  if (!checkpoint) {
    throw new Error('--checkpoint is required');
  }

  const mode_: EvalMode = mode === 'prompt_assisted' ? 'prompt_assisted' : 'reduced_prompt';
  const holdoutRatio = parseFloat(holdoutRatioStr);
  const passThreshold = parseFloat(passThresholdStr);

  const exportsDir = path.join(process.cwd(), '.state', 'exports', 'orpo');
  const exportPath = path.join(exportsDir, `${exportId}.jsonl`);
  const manifestPath = path.join(exportsDir, `${exportId}-manifest.json`);

  console.error(`[benchmark] Reading export: ${exportPath}`);
  const samples = readExportSamples(exportPath);
  const manifest = readExportManifest(manifestPath);

  console.error(`[benchmark] Loaded ${samples.length} samples from export ${exportId}`);

  const evalSamples = excludeTrainingSet(samples, manifest.datasetFingerprint);

  const result = await runSingle(
    evalSamples,
    mode_,
    scorer,
    checkpoint,
    exportId,
    manifest.datasetFingerprint,
    manifest.targetModelFamily,
    outputDir,
    holdoutRatio,
    passThreshold
  );

  process.stdout.write(JSON.stringify(result, null, 2));
}

async function handleDelta(opts: Record<string, string>): Promise<void> {
  const {
    'baseline-result': baselinePath,
    'candidate-result': candidatePath,
    'output-dir': outputDir = DEFAULT_OUTPUT_DIR,
    'pass-threshold': passThresholdStr = '0.05',
  } = opts;

  if (!baselinePath) {
    throw new Error('--baseline-result is required');
  }
  if (!candidatePath) {
    throw new Error('--candidate-result is required');
  }

  const passThreshold = parseFloat(passThresholdStr);

  const baseline = readResultFromPath(baselinePath);
  const candidate = readResultFromPath(candidatePath);

  if (!baseline) {
    throw new Error(`Baseline result not found: ${baselinePath}`);
  }
  if (!candidate) {
    throw new Error(`Candidate result not found: ${candidatePath}`);
  }

  const comp = checkComparability(baseline, candidate);
  if (!comp.comparable) {
    throw new Error(`Results not comparable: ${comp.reason}`);
  }

  const result = computeDelta(baseline, candidate, passThreshold);

  ensureEvalsDir(outputDir);
  writeResult(outputDir, result);

  console.error(`[benchmark] Delta result written: ${result.benchmarkId}`);
  console.error(`[benchmark] Delta: ${result.delta.delta >= 0 ? '+' : ''}${result.delta.delta.toFixed(3)}`);
  console.error(`[benchmark] Verdict: ${result.verdict}`);

  process.stdout.write(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv);

  try {
    switch (command) {
      case 'compare':
        await handleCompare(options);
        break;
      case 'run':
        await handleRun(options);
        break;
      case 'delta':
        await handleDelta(options);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage:');
        console.error('  run-benchmark.ts compare --export-id <id> --baseline <ref> --candidate <ref> [options]');
        console.error('  run-benchmark.ts run --export-id <id> --checkpoint <ref> [options]');
        console.error('  run-benchmark.ts delta --baseline-result <path> --candidate-result <path> [options]');
        process.exit(1);
    }
  } catch (err) {
    console.error(`[benchmark] ERROR: ${String(err)}`);
    process.exit(1);
  }
}

main();
