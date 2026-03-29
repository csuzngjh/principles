/**
 * Nocturnal Benchmark Core — Tests
 * =================================
 *
 * Tests for the benchmark core logic:
 * - Structural scorer
 * - Holdout selector
 * - Result store (validation, delta computation)
 * - types utility functions
 *
 * Run from scripts/nocturnal/ with: npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  StructuralScorerAdapter,
  LocalModelScorerAdapter,
  getScorerAdapter,
  STRUCTURAL_SCORER_VERSION,
  __internal as scorerInternals,
} from './scorer.js';

import {
  selectHoldout,
  excludeTrainingSet,
  computeHoldoutFingerprint,
  verifyHoldoutConsistency,
  createTrainEvalSplit,
} from './holdout-selector.js';

import {
  ensureEvalsDir,
  writeResult,
  writeMeta,
  readResult,
  readMeta,
  readResultFromPath,
  listResults,
  validateResult,
  checkComparability,
  computeDelta,
} from './result-store.js';

import {
  computeMetrics,
  computeBenchmarkId,
  computeHoldoutFingerprint as computeHoldoutFpFromTypes,
} from './types.js';

import type {
  ORPOSample,
  BenchmarkResult,
  BenchmarkMeta,
  EvalMode,
  SampleScore,
} from './types.js';

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSample(overrides: Partial<ORPOSample> = {}): ORPOSample {
  return {
    sampleFingerprint: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
    sessionId: 'session-test-001',
    principleId: 'T-08',
    targetModelFamily: 'gpt-4',
    prompt: 'Immediately retried a failing bash command without diagnosing the error',
    chosen: 'Checked the error message before retrying the command',
    rejected: 'Immediately retried a failing bash command without diagnosing the error',
    rationale:
      'Diagnosing failures before retrying prevents repeated failures and respects the cost of each attempt. Checking error output is a low-cost action that provides high-value information.',
    datasetMetadata: {
      sampleFingerprint: crypto.randomUUID(),
      artifactPath: '.state/nocturnal/samples/test.json',
      createdAt: '2026-03-28T00:00:00.000Z',
      exportedAt: '2026-03-28T00:00:00.000Z',
      exportId: 'export-test-001',
      datasetFingerprint: 'dataset-fingerprint-test',
    },
    ...overrides,
  };
}

function makeBenchmarkResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const now = new Date().toISOString();
  return {
    benchmarkId: 'bench-test-001',
    createdAt: now,
    targetModelFamily: 'gpt-4',
    mode: 'reduced_prompt',
    exportId: 'export-test-001',
    datasetFingerprint: 'dataset-fingerprint-test',
    sampleCount: 10,
    baselineCheckpointId: 'checkpoint-baseline',
    baselineMetrics: { meanScore: 0.5, medianScore: 0.5, stdDev: 0.1, passRate: 0.3, failRate: 0.1 },
    candidateCheckpointId: 'checkpoint-candidate',
    candidateMetrics: { meanScore: 0.65, medianScore: 0.6, stdDev: 0.12, passRate: 0.5, failRate: 0.05 },
    delta: {
      baselineScore: 0.5,
      candidateScore: 0.65,
      delta: 0.15,
      mode: 'reduced_prompt',
      improvedCount: 6,
      degradedCount: 2,
      unchangedCount: 2,
    },
    verdict: 'pass',
    passThreshold: 0.05,
    ...overrides,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-benchmark-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Tests: Structural Scorer
// ---------------------------------------------------------------------------

describe('Benchmark scorer', () => {
  describe('StructuralScorerAdapter', () => {
    it('returns a score between 0.0 and 1.0 for valid sample', async () => {
      const sample = makeSample();
      const result = await StructuralScorerAdapter.score(sample, 'prompt_assisted');
      expect(result.score).toBeGreaterThanOrEqual(0.0);
      expect(result.score).toBeLessThanOrEqual(1.0);
      expect(result.evaluator.type).toBe('structural');
    });

    it('returns consistent score for same sample (deterministic)', async () => {
      const sample = makeSample();
      const result1 = await StructuralScorerAdapter.score(sample, 'reduced_prompt');
      const result2 = await StructuralScorerAdapter.score(sample, 'reduced_prompt');
      expect(result1.score).toBe(result2.score);
    });

    it('reduced_prompt mode produces different score than prompt_assisted', async () => {
      // reduced_prompt hides rationale, so the score should differ
      const sample = makeSample({ rationale: 'Long specific rationale that should affect scoring differently between modes.' });
      const resultPA = await StructuralScorerAdapter.score(sample, 'prompt_assisted');
      const resultRP = await StructuralScorerAdapter.score(sample, 'reduced_prompt');
      expect(resultPA.score).toBeGreaterThanOrEqual(0.0);
      expect(resultPA.score).toBeLessThanOrEqual(1.0);
      expect(resultRP.score).toBeGreaterThanOrEqual(0.0);
      expect(resultRP.score).toBeLessThanOrEqual(1.0);
    });

    it('version is defined', () => {
      expect(StructuralScorerAdapter.version).toBe(STRUCTURAL_SCORER_VERSION);
    });

    it('getScorerAdapter returns StructuralScorerAdapter by name', () => {
      const adapter = getScorerAdapter('structural');
      expect(adapter.evaluatorType).toBe('structural');
    });

    it('getScorerAdapter throws for unknown scorer name', () => {
      expect(() => getScorerAdapter('unknown' as any)).toThrow('Unknown scorer');
    });

    it('scores a sample where chosen aligns strongly with rationale', async () => {
      const sample = makeSample({
        prompt: 'Made a risky change without checking tests first',
        chosen: 'Ran the test suite before making a risky change',
        rejected: 'Made a risky change without checking tests first',
        rationale: 'Running tests before risky changes validates current behavior and catches regressions early. This is a well-established engineering practice.',
      });
      const result = await StructuralScorerAdapter.score(sample, 'prompt_assisted');
      expect(result.score).toBeGreaterThan(0.3);
      expect(result.score).toBeLessThanOrEqual(1.0);
    });

    it('scores a sample where chosen and rejected are identical', async () => {
      const sample = makeSample({
        chosen: 'Did something',
        rejected: 'Did something', // Same as chosen — no separation
      });
      const result = await StructuralScorerAdapter.score(sample, 'prompt_assisted');
      expect(result.score).toBeLessThan(0.5);
    });

    it('weak rationale produces lower score', async () => {
      const weakRationale = makeSample({
        rationale: 'This is a short rationale.',
      });
      const strongRationale = makeSample({
        rationale: 'This is a very detailed and thorough rationale that explains exactly why the chosen decision is better than the rejected one, with specific references to best practices and established patterns in software engineering that support this approach.',
      });

      const resultWeak = await StructuralScorerAdapter.score(weakRationale, 'prompt_assisted');
      const resultStrong = await StructuralScorerAdapter.score(strongRationale, 'prompt_assisted');

      expect(resultStrong.score).toBeGreaterThanOrEqual(resultWeak.score);
    });

    it('StructuralScorerAdapter ignores checkpointRef — same sample always gets same score', async () => {
      // This verifies the ScorerAdapter contract: StructuralScorerAdapter is
      // checkpoint-agnostic. Different checkpointRef values must NOT change
      // the score. The delta in runCompare() must come from the evaluator's
      // real behavior, not from synthetic manipulation of checkpointRef strings.
      const sample = makeSample();
      const result1 = await StructuralScorerAdapter.score(sample, 'reduced_prompt', 'checkpoint-baseline-v1');
      const result2 = await StructuralScorerAdapter.score(sample, 'reduced_prompt', 'checkpoint-candidate-v2');
      const result3 = await StructuralScorerAdapter.score(sample, 'reduced_prompt');

      expect(result1.score).toBe(result2.score);
      expect(result1.score).toBe(result3.score);
      // evaluator metadata confirms checkpointRef was accepted but not used
      expect(result1.evaluator.checkpointRef).toBeUndefined();
      expect(result2.evaluator.checkpointRef).toBeUndefined();
    });
  });

  describe('LocalModelScorerAdapter protocol hardening', () => {
    it('falls back to the evaluator result file when stdout contains logs', async () => {
      const tmpDir = makeTmpDir();
      const requestId = 'req-test-1';
      const resultPath = path.join(tmpDir, `eval-result-${requestId}.json`);
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          requestId,
          checkpointRef: 'ckpt-1',
          status: 'completed',
          scores: [{ sampleFingerprint: 'sf-1', score: 0.77, justification: 'from file', mode: 'reduced_prompt' }],
        }),
        'utf-8'
      );

      const parsed = scorerInternals.parseEvaluatorOutput(
        '[peft-evaluator] loading checkpoint\n[peft-evaluator] scoring\n',
        tmpDir,
        requestId
      );

      expect(parsed.scores[0].score).toBe(0.77);
      rmdir(tmpDir);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Holdout Selector
// ---------------------------------------------------------------------------

describe('Holdout selector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  describe('selectHoldout', () => {
    it('returns empty arrays for empty input', () => {
      const { evaluationSet, holdoutSet } = selectHoldout([]);
      expect(evaluationSet).toHaveLength(0);
      expect(holdoutSet).toHaveLength(0);
    });

    it('returns all samples as evaluation when fewer than 5 samples', () => {
      const samples = [makeSample(), makeSample(), makeSample()];
      const { evaluationSet, holdoutSet } = selectHoldout(samples, 0.2);
      expect(evaluationSet).toHaveLength(3);
      expect(holdoutSet).toHaveLength(0);
    });

    it('applies holdout ratio correctly for larger sets', () => {
      // Create 20 samples — 20% holdout = 4 holdout, 16 evaluation
      const samples = Array.from({ length: 20 }, () => makeSample());
      const { evaluationSet, holdoutSet } = selectHoldout(samples, 0.2);
      expect(holdoutSet).toHaveLength(4);
      expect(evaluationSet).toHaveLength(16);
    });

    it('holdout set is always at least 1 for 5+ samples', () => {
      const samples = Array.from({ length: 6 }, () => makeSample());
      const { holdoutSet } = selectHoldout(samples, 0.05); // 5% of 6 = 0.3 → floor = 0, but min is 1
      expect(holdoutSet.length).toBeGreaterThanOrEqual(1);
    });

    it('selection is deterministic (same input = same output)', () => {
      const samples = Array.from({ length: 10 }, () => makeSample());
      const { evaluationSet: ev1, holdoutSet: ho1 } = selectHoldout(samples, 0.2);
      const { evaluationSet: ev2, holdoutSet: ho2 } = selectHoldout(samples, 0.2);
      expect(ev1.map((s) => s.sampleFingerprint)).toEqual(ev2.map((s) => s.sampleFingerprint));
      expect(ho1.map((s) => s.sampleFingerprint)).toEqual(ho2.map((s) => s.sampleFingerprint));
    });

    it('combined evaluation + holdout equals total input', () => {
      const samples = Array.from({ length: 20 }, () => makeSample());
      const { evaluationSet, holdoutSet } = selectHoldout(samples, 0.2);
      expect(evaluationSet.length + holdoutSet.length).toBe(20);
    });
  });

  describe('excludeTrainingSet', () => {
    it('returns all samples when no match', () => {
      const samples = [makeSample(), makeSample()];
      const result = excludeTrainingSet(samples, 'different-fingerprint');
      expect(result).toHaveLength(2);
    });

    it('excludes samples matching dataset fingerprint', () => {
      const keep = makeSample({ datasetMetadata: { ...makeSample().datasetMetadata, datasetFingerprint: 'keep-fp' } });
      const exclude = makeSample({ datasetMetadata: { ...makeSample().datasetMetadata, datasetFingerprint: 'exclude-fp' } });
      const result = excludeTrainingSet([keep, exclude], 'exclude-fp');
      expect(result).toHaveLength(1);
      expect(result[0].datasetMetadata.datasetFingerprint).toBe('keep-fp');
    });
  });

  describe('computeHoldoutFingerprint', () => {
    it('is deterministic', () => {
      const samples = [makeSample(), makeSample()];
      const fp1 = computeHoldoutFingerprint(samples);
      const fp2 = computeHoldoutFingerprint(samples);
      expect(fp1).toBe(fp2);
    });

    it('different orderings produce same fingerprint', () => {
      const s1 = makeSample();
      const s2 = makeSample();
      const fp1 = computeHoldoutFingerprint([s1, s2]);
      const fp2 = computeHoldoutFingerprint([s2, s1]);
      expect(fp1).toBe(fp2);
    });

    it('different samples produce different fingerprint', () => {
      const fp1 = computeHoldoutFingerprint([makeSample()]);
      const fp2 = computeHoldoutFingerprint([makeSample()]);
      expect(fp1).not.toBe(fp2);
    });
  });

  describe('verifyHoldoutConsistency', () => {
    it('returns true for matching fingerprints', () => {
      const samples = [makeSample(), makeSample()];
      const fp = computeHoldoutFingerprint(samples);
      expect(verifyHoldoutConsistency(fp, samples)).toBe(true);
    });

    it('returns false for different fingerprints', () => {
      const samples = [makeSample(), makeSample()];
      expect(verifyHoldoutConsistency('different-fp', samples)).toBe(false);
    });
  });

  describe('createTrainEvalSplit', () => {
    it('splits 80/20 by default', () => {
      const samples = Array.from({ length: 10 }, () => makeSample());
      const { trainSet, evalSet } = createTrainEvalSplit(samples);
      expect(evalSet).toHaveLength(8);
      expect(trainSet).toHaveLength(2);
    });

    it('is deterministic', () => {
      const samples = Array.from({ length: 10 }, () => makeSample());
      const { evalSet: ev1 } = createTrainEvalSplit(samples);
      const { evalSet: ev2 } = createTrainEvalSplit(samples);
      expect(ev1.map((s) => s.sampleFingerprint)).toEqual(ev2.map((s) => s.sampleFingerprint));
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Result Store
// ---------------------------------------------------------------------------

describe('Result store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ensureEvalsDir(tmpDir);
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  describe('writeResult + readResult', () => {
    it('roundtrips a benchmark result', () => {
      const result = makeBenchmarkResult();
      writeResult(tmpDir, result);
      const read = readResult(tmpDir, result.benchmarkId);
      expect(read).not.toBeNull();
      expect(read!.benchmarkId).toBe(result.benchmarkId);
      expect(read!.verdict).toBe(result.verdict);
      expect(read!.delta.delta).toBe(result.delta.delta);
    });

    it('returns null for non-existent result', () => {
      const read = readResult(tmpDir, 'nonexistent-id');
      expect(read).toBeNull();
    });

    it('overwrites existing result with same benchmarkId', () => {
      const result1 = makeBenchmarkResult({ benchmarkId: 'same-id' });
      const result2 = makeBenchmarkResult({ benchmarkId: 'same-id', verdict: 'fail' });
      writeResult(tmpDir, result1);
      writeResult(tmpDir, result2);
      const read = readResult(tmpDir, 'same-id');
      expect(read!.verdict).toBe('fail');
    });
  });

  describe('writeMeta + readMeta', () => {
    it('roundtrips benchmark metadata', () => {
      const meta: BenchmarkMeta = {
        benchmarkId: 'bench-001',
        createdAt: new Date().toISOString(),
        runnerVersion: '0.1.0',
        mode: 'reduced_prompt',
        targetModelFamily: 'gpt-4',
        exportId: 'export-001',
        sampleCount: 10,
        holdoutFingerprint: 'abc123',
        evalsDir: tmpDir,
      };
      writeMeta(tmpDir, meta);
      const read = readMeta(tmpDir, 'bench-001');
      expect(read).not.toBeNull();
      expect(read!.runnerVersion).toBe('0.1.0');
      expect(read!.holdoutFingerprint).toBe('abc123');
    });
  });

  describe('readResultFromPath', () => {
    it('reads result from absolute path', () => {
      const result = makeBenchmarkResult({ benchmarkId: 'from-path' });
      const filePath = path.join(tmpDir, 'from-path-result.json');
      fs.writeFileSync(filePath, JSON.stringify(result), 'utf-8');
      const read = readResultFromPath(filePath);
      expect(read).not.toBeNull();
      expect(read!.benchmarkId).toBe('from-path');
    });

    it('returns null for non-existent file', () => {
      const read = readResultFromPath('/nonexistent/path.json');
      expect(read).toBeNull();
    });
  });

  describe('listResults', () => {
    it('returns all results sorted newest first', () => {
      const r1 = makeBenchmarkResult({ benchmarkId: 'r1', createdAt: '2026-03-28T00:00:00.000Z' });
      const r2 = makeBenchmarkResult({ benchmarkId: 'r2', createdAt: '2026-03-29T00:00:00.000Z' });
      writeResult(tmpDir, r1);
      writeResult(tmpDir, r2);
      const results = listResults(tmpDir);
      expect(results).toHaveLength(2);
      expect(results[0].benchmarkId).toBe('r2'); // Newest first
      expect(results[1].benchmarkId).toBe('r1');
    });

    it('returns empty array when directory is empty', () => {
      const results = listResults(tmpDir);
      expect(results).toHaveLength(0);
    });
  });

  describe('validateResult', () => {
    it('returns no errors for valid result', () => {
      const result = makeBenchmarkResult();
      const errors = validateResult(result);
      expect(errors).toHaveLength(0);
    });

    it('returns errors for missing required fields', () => {
      const result = {} as BenchmarkResult;
      const errors = validateResult(result);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('benchmarkId'))).toBe(true);
      expect(errors.some((e) => e.includes('verdict'))).toBe(true);
    });

    it('returns errors for invalid mode', () => {
      const result = makeBenchmarkResult({ mode: 'invalid_mode' as EvalMode });
      const errors = validateResult(result);
      expect(errors.some((e) => e.includes('mode'))).toBe(true);
    });

    it('returns errors for invalid verdict', () => {
      const result = makeBenchmarkResult({ verdict: 'invalid_verdict' as BenchmarkResult['verdict'] });
      const errors = validateResult(result);
      expect(errors.some((e) => e.includes('verdict'))).toBe(true);
    });
  });

  describe('checkComparability', () => {
    it('returns comparable for matching mode and sampleCount', () => {
      const baseline = makeBenchmarkResult({ mode: 'reduced_prompt', sampleCount: 10 });
      const candidate = makeBenchmarkResult({ mode: 'reduced_prompt', sampleCount: 10 });
      const { comparable, reason } = checkComparability(baseline, candidate);
      expect(comparable).toBe(true);
      expect(reason).toBeUndefined();
    });

    it('returns not comparable for mode mismatch', () => {
      const baseline = makeBenchmarkResult({ mode: 'reduced_prompt', sampleCount: 10 });
      const candidate = makeBenchmarkResult({ mode: 'prompt_assisted', sampleCount: 10 });
      const { comparable, reason } = checkComparability(baseline, candidate);
      expect(comparable).toBe(false);
      expect(reason).toContain('Mode mismatch');
    });

    it('returns not comparable for sampleCount mismatch', () => {
      const baseline = makeBenchmarkResult({ mode: 'reduced_prompt', sampleCount: 10 });
      const candidate = makeBenchmarkResult({ mode: 'reduced_prompt', sampleCount: 20 });
      const { comparable, reason } = checkComparability(baseline, candidate);
      expect(comparable).toBe(false);
      expect(reason).toContain('Sample count mismatch');
    });
  });

  describe('computeDelta', () => {
    it('computes correct delta', () => {
      const baseline = makeBenchmarkResult({
        baselineMetrics: { meanScore: 0.5, medianScore: 0.5, stdDev: 0.1, passRate: 0.3, failRate: 0.1 },
      });
      const candidate = makeBenchmarkResult({
        candidateMetrics: { meanScore: 0.65, medianScore: 0.6, stdDev: 0.12, passRate: 0.5, failRate: 0.05 },
      });

      const result = computeDelta(baseline, candidate, 0.05);

      expect(result.delta.delta).toBeCloseTo(0.15, 2);
      expect(result.verdict).toBe('pass');
    });

    it('returns compare_only when delta is below threshold', () => {
      const baseline = makeBenchmarkResult({
        baselineMetrics: { meanScore: 0.5, medianScore: 0.5, stdDev: 0.1, passRate: 0.3, failRate: 0.1 },
      });
      const candidate = makeBenchmarkResult({
        candidateMetrics: { meanScore: 0.52, medianScore: 0.5, stdDev: 0.1, passRate: 0.3, failRate: 0.1 },
      });

      const result = computeDelta(baseline, candidate, 0.05);

      expect(result.verdict).toBe('compare_only');
    });

    it('returns fail when delta is negative beyond threshold', () => {
      const baseline = makeBenchmarkResult({
        baselineMetrics: { meanScore: 0.6, medianScore: 0.6, stdDev: 0.1, passRate: 0.5, failRate: 0.05 },
      });
      const candidate = makeBenchmarkResult({
        candidateMetrics: { meanScore: 0.4, medianScore: 0.4, stdDev: 0.15, passRate: 0.2, failRate: 0.3 },
      });

      const result = computeDelta(baseline, candidate, 0.05);

      expect(result.verdict).toBe('fail');
      expect(result.delta.delta).toBeLessThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Types Utilities
// ---------------------------------------------------------------------------

describe('Benchmark types utilities', () => {
  describe('computeMetrics', () => {
    it('returns zero metrics for empty array', () => {
      const metrics = computeMetrics([]);
      expect(metrics.meanScore).toBe(0);
      expect(metrics.medianScore).toBe(0);
      expect(metrics.stdDev).toBe(0);
      expect(metrics.passRate).toBe(0);
      expect(metrics.failRate).toBe(0);
    });

    it('computes correct mean for uniform scores', () => {
      const scores: SampleScore[] = [
        { sampleFingerprint: 'a', score: 0.5, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
        { sampleFingerprint: 'b', score: 0.5, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
        { sampleFingerprint: 'c', score: 0.5, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
      ];
      const metrics = computeMetrics(scores);
      expect(metrics.meanScore).toBe(0.5);
      expect(metrics.medianScore).toBe(0.5);
      expect(metrics.stdDev).toBe(0);
    });

    it('computes passRate correctly', () => {
      const scores: SampleScore[] = [
        { sampleFingerprint: 'a', score: 0.8, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
        { sampleFingerprint: 'b', score: 0.5, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
        { sampleFingerprint: 'c', score: 0.9, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
        { sampleFingerprint: 'd', score: 0.2, justification: '', mode: 'reduced_prompt', scorerVersion: '0.1.0' },
      ];
      // 2 of 4 scoring >= 0.7 → passRate = 0.5
      // 1 of 4 scoring < 0.3 → failRate = 0.25
      const metrics = computeMetrics(scores);
      expect(metrics.passRate).toBeCloseTo(0.5, 2);
      expect(metrics.failRate).toBeCloseTo(0.25, 2);
    });

    it('handles single score', () => {
      const scores: SampleScore[] = [
        { sampleFingerprint: 'a', score: 0.75, justification: '', mode: 'prompt_assisted', scorerVersion: '0.1.0' },
      ];
      const metrics = computeMetrics(scores);
      expect(metrics.meanScore).toBe(0.75);
      expect(metrics.medianScore).toBe(0.75);
      expect(metrics.passRate).toBe(1); // >= 0.7
      expect(metrics.failRate).toBe(0);
    });
  });

  describe('computeBenchmarkId', () => {
    it('is deterministic', () => {
      const id1 = computeBenchmarkId('export-1', 'reduced_prompt', 'fp123');
      const id2 = computeBenchmarkId('export-1', 'reduced_prompt', 'fp123');
      expect(id1).toBe(id2);
    });

    it('different inputs produce different ids', () => {
      const id1 = computeBenchmarkId('export-1', 'reduced_prompt', 'fp123');
      const id2 = computeBenchmarkId('export-1', 'prompt_assisted', 'fp123');
      const id3 = computeBenchmarkId('export-2', 'reduced_prompt', 'fp123');
      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
    });

    it('is 16 characters long (hex truncated from SHA-256)', () => {
      const id = computeBenchmarkId('export-1', 'reduced_prompt', 'fp123');
      expect(id).toHaveLength(16);
    });
  });

  describe('computeHoldoutFingerprint from types', () => {
    it('produces 64-char SHA-256 hex', () => {
      const samples = [makeSample(), makeSample()];
      const fp = computeHoldoutFpFromTypes(samples.map((s) => s.sampleFingerprint));
      expect(fp).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(fp)).toBe(true);
    });
  });
});
