/**
 * Model Training Registry — Tests
 * ===============================
 *
 * Tests for the training run, checkpoint, and eval summary registry.
 * Follows the same patterns as other core domain tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerTrainingRun,
  completeTrainingRun,
  failTrainingRun,
  startTrainingRun,
  updateTrainingRunStatus,
  getTrainingRun,
  listTrainingRuns,
  registerCheckpoint,
  getCheckpoint,
  listCheckpoints,
  listDeployableCheckpoints,
  attachEvalSummary,
  getEvalSummary,
  listEvalSummaries,
  markCheckpointDeployable,
  isCheckpointDeployable,
  getCheckpointLineage,
  getFullRegistry,
  getTrainingRegistryStats,
} from '../../src/core/model-training-registry.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-training-registry-test-'));
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
// Tests: Training Run Registration
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry registerTrainingRun', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('registers a new training run', () => {
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc123',
      exportId: 'export-001',
      sampleCount: 42,
      configFingerprint: 'config-default-v0.1',
    });

    expect(run.trainRunId).toBeDefined();
    expect(run.targetModelFamily).toBe('gpt-4');
    expect(run.datasetFingerprint).toBe('sha256-abc123');
    expect(run.exportId).toBe('export-001');
    expect(run.sampleCount).toBe(42);
    expect(run.configFingerprint).toBe('config-default-v0.1');
    expect(run.status).toBe('pending');
    expect(run.checkpointIds).toEqual([]);
    expect(run.createdAt).toBeDefined();
  });

  it('persists the run to disk', () => {
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-3',
      datasetFingerprint: 'sha256-def456',
      exportId: 'export-002',
      sampleCount: 30,
      configFingerprint: 'config-v1',
    });

    const retrieved = getTrainingRun(tmpDir, run.trainRunId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.trainRunId).toBe(run.trainRunId);
    expect(retrieved!.targetModelFamily).toBe('claude-3');
  });

  it('generates unique trainRunIds', () => {
    const run1 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'e1',
      sampleCount: 10,
      configFingerprint: 'c1',
    });
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-def',
      exportId: 'e2',
      sampleCount: 20,
      configFingerprint: 'c2',
    });
    expect(run1.trainRunId).not.toBe(run2.trainRunId);
  });
});

// ---------------------------------------------------------------------------
// Tests: Training Run Status Transitions
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry run status transitions', () => {
  let tmpDir: string;
  let runId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    runId = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 10,
      configFingerprint: 'cfg-1',
    }).trainRunId;
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('starts as pending', () => {
    const run = getTrainingRun(tmpDir, runId)!;
    expect(run.status).toBe('pending');
  });

  it('can transition pending → running', () => {
    const run = startTrainingRun(tmpDir, runId);
    expect(run.status).toBe('running');
  });

  it('can transition running → completed', () => {
    startTrainingRun(tmpDir, runId);
    const run = completeTrainingRun(tmpDir, runId);
    expect(run.status).toBe('completed');
    expect(run.completedAt).toBeDefined();
  });

  it('can transition running → failed', () => {
    startTrainingRun(tmpDir, runId);
    const run = failTrainingRun(tmpDir, runId, 'Out of memory');
    expect(run.status).toBe('failed');
    expect(run.failureReason).toBe('Out of memory');
    expect(run.completedAt).toBeDefined();
  });

  it('cannot transition pending → completed directly', () => {
    expect(() => completeTrainingRun(tmpDir, runId)).toThrow('Invalid status transition');
  });

  it('cannot transition pending → failed directly', () => {
    expect(() => failTrainingRun(tmpDir, runId, 'reason')).toThrow('Invalid status transition');
  });

  it('cannot transition completed → anything', () => {
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);
    expect(() => startTrainingRun(tmpDir, runId)).toThrow('Invalid status transition');
    expect(() => failTrainingRun(tmpDir, runId, 'reason')).toThrow('Invalid status transition');
  });

  it('listTrainingRuns filters by status', () => {
    // BeforeEach already created runId as pending
    // Create run2 (also pending by default)
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-def',
      exportId: 'exp-2',
      sampleCount: 10,
      configFingerprint: 'cfg-1',
    });
    // Start the first run (runId) — now runId is running, run2 is still pending
    startTrainingRun(tmpDir, runId);

    const pending = listTrainingRuns(tmpDir, { status: 'pending' });
    const running = listTrainingRuns(tmpDir, { status: 'running' });
    const completed = listTrainingRuns(tmpDir, { status: 'completed' });

    // runId was started → running; run2 was NOT started → pending
    expect(running.map((r) => r.trainRunId)).toContain(runId);
    expect(pending.map((r) => r.trainRunId)).toContain(run2.trainRunId);
    expect(completed).toHaveLength(0);
  });

  it('listTrainingRuns filters by targetModelFamily', () => {
    // Register gpt-4 and claude-3 runs using the tmpDir from beforeEach
    const gpt4Run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-a',
      exportId: 'e1',
      sampleCount: 10,
      configFingerprint: 'c1',
    });
    registerTrainingRun(tmpDir, {
      targetModelFamily: 'claude-3',
      datasetFingerprint: 'sha256-b',
      exportId: 'e2',
      sampleCount: 10,
      configFingerprint: 'c1',
    });

    const gpt4Runs = listTrainingRuns(tmpDir, { targetModelFamily: 'gpt-4' });
    const claudeRuns = listTrainingRuns(tmpDir, { targetModelFamily: 'claude-3' });

    // beforeEach created 1 gpt-4 (runId) + this test created 1 more = 2 gpt-4 total
    expect(gpt4Runs.map((r) => r.trainRunId)).toContain(gpt4Run.trainRunId);
    expect(gpt4Runs).toHaveLength(2);
    expect(claudeRuns).toHaveLength(1);
    expect(claudeRuns[0].targetModelFamily).toBe('claude-3');
  });
});

// ---------------------------------------------------------------------------
// Tests: Checkpoint Registration
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry registerCheckpoint', () => {
  let tmpDir: string;
  let runId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    runId = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    }).trainRunId;
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('registers a checkpoint for a training run', () => {
    const checkpoint = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/path/to/checkpoint-001.safetensors',
    });

    expect(checkpoint.checkpointId).toBeDefined();
    expect(checkpoint.trainRunId).toBe(runId);
    expect(checkpoint.targetModelFamily).toBe('gpt-4');
    expect(checkpoint.artifactPath).toBe('/path/to/checkpoint-001.safetensors');
    expect(checkpoint.deployable).toBe(false);
    expect(checkpoint.lastEvalSummaryRef).toBeUndefined();
  });

  it('adds the checkpoint to the training run', () => {
    const ck1 = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck1.safetensors',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck2.safetensors',
    });

    const run = getTrainingRun(tmpDir, runId)!;
    expect(run.checkpointIds).toContain(ck1.checkpointId);
    expect(run.checkpointIds).toContain(ck2.checkpointId);
    expect(run.checkpointIds).toHaveLength(2);
  });

  it('throws if training run not found', () => {
    expect(() =>
      registerCheckpoint(tmpDir, {
        trainRunId: 'nonexistent-run',
        targetModelFamily: 'gpt-4',
        artifactPath: '/ck.safetensors',
      })
    ).toThrow('Training run not found');
  });

  it('throws if targetModelFamily does not match the training run', () => {
    expect(() =>
      registerCheckpoint(tmpDir, {
        trainRunId: runId,
        targetModelFamily: 'claude-3', // Does not match run's gpt-4
        artifactPath: '/ck.safetensors',
      })
    ).toThrow('Target model family mismatch');
  });

  it('checkpoint starts as non-deployable', () => {
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });
    expect(ck.deployable).toBe(false);
  });

  it('getCheckpointLineage returns run, checkpoint, and eval', () => {
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });

    const lineage = getCheckpointLineage(tmpDir, ck.checkpointId);
    expect(lineage).not.toBeNull();
    expect(lineage!.run.trainRunId).toBe(runId);
    expect(lineage!.checkpoint.checkpointId).toBe(ck.checkpointId);
    expect(lineage!.eval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Eval Summary Attachment
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry attachEvalSummary', () => {
  let tmpDir: string;
  let runId: string;
  let checkpointId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    });
    runId = run.trainRunId;
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });
    checkpointId = ck.checkpointId;
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('attaches an eval summary to a checkpoint', () => {
    const evalSummary = attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-001',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-001',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.65,
      delta: 0.15,
      verdict: 'pass',
    });

    expect(evalSummary.evalId).toBe('eval-001');
    expect(evalSummary.checkpointId).toBe(checkpointId);
    expect(evalSummary.verdict).toBe('pass');
    expect(evalSummary.createdAt).toBeDefined();
  });

  it('updates the checkpoint lastEvalSummaryRef', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-002',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-002',
      mode: 'prompt_assisted',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });

    const ck = getCheckpoint(tmpDir, checkpointId);
    expect(ck!.lastEvalSummaryRef).toBe('eval-002');
  });

  it('can retrieve the attached eval summary', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-003',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-003',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.6,
      delta: 0.1,
      verdict: 'pass',
    });

    const eval_ = getEvalSummary(tmpDir, 'eval-003');
    expect(eval_).not.toBeNull();
    expect(eval_!.checkpointId).toBe(checkpointId);
  });

  it('listEvalSummaries filters by checkpointId', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-ck1',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-1',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.6,
      delta: 0.1,
      verdict: 'pass',
    });

    const evals = listEvalSummaries(tmpDir, { checkpointId });
    expect(evals.map((e) => e.evalId)).toContain('eval-ck1');
  });

  it('throws if eval targetModelFamily does not match checkpoint family', () => {
    expect(() =>
      attachEvalSummary(tmpDir, checkpointId, {
        evalId: 'eval-wrong-family',
        checkpointId,
        targetModelFamily: 'claude-3', // Does not match checkpoint's gpt-4
        benchmarkId: 'bench-family',
        mode: 'reduced_prompt',
        baselineScore: 0.5,
        candidateScore: 0.6,
        delta: 0.1,
        verdict: 'pass',
      })
    ).toThrow('Family mismatch');
  });
});

// ---------------------------------------------------------------------------
// Tests: Deployability Gating
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry deployability gating', () => {
  let tmpDir: string;
  let runId: string;
  let checkpointId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    });
    runId = run.trainRunId;
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });
    checkpointId = ck.checkpointId;
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('cannot mark deployable without eval summary', () => {
    expect(() => markCheckpointDeployable(tmpDir, checkpointId, true)).toThrow(
      'no eval summary attached'
    );
  });

  it('cannot mark deployable with failed eval', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-fail',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-fail',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.3,
      delta: -0.2,
      verdict: 'fail',
    });

    expect(() => markCheckpointDeployable(tmpDir, checkpointId, true)).toThrow(
      "verdict is 'fail'"
    );
  });

  it('can mark deployable with passing eval and completed run', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-pass',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-pass',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.65,
      delta: 0.15,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);

    const ck = markCheckpointDeployable(tmpDir, checkpointId, true);
    expect(ck.deployable).toBe(true);
    expect(ck.lastEvalSummaryRef).toBe('eval-pass');
  });

  it('can mark deployable with compare_only eval and completed run', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-compare',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-compare',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.52,
      delta: 0.02,
      verdict: 'compare_only',
    });
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);

    const ck = markCheckpointDeployable(tmpDir, checkpointId, true);
    expect(ck.deployable).toBe(true);
  });

  it('cannot mark deployable if training run is not completed', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-pending',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-pending',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    // Run is still 'pending', not completed
    expect(() => markCheckpointDeployable(tmpDir, checkpointId, true)).toThrow(
      "training run is in 'pending' status"
    );
  });

  it('cannot mark deployable if training run is failed', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-failed-run',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-failed-run',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, runId);
    failTrainingRun(tmpDir, runId, 'CUDA out of memory');

    expect(() => markCheckpointDeployable(tmpDir, checkpointId, true)).toThrow(
      "training run is in 'failed' status"
    );
  });

  it('can revoke deployability by marking false', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-revoke',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-revoke',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);

    markCheckpointDeployable(tmpDir, checkpointId, true);
    expect(isCheckpointDeployable(tmpDir, checkpointId)).toBe(true);

    const ck = markCheckpointDeployable(tmpDir, checkpointId, false);
    expect(ck.deployable).toBe(false);
    expect(isCheckpointDeployable(tmpDir, checkpointId)).toBe(false);
  });

  it('isCheckpointDeployable returns false for nonexistent checkpoint', () => {
    expect(isCheckpointDeployable(tmpDir, 'nonexistent-id')).toBe(false);
  });

  it('listDeployableCheckpoints returns only deployable checkpoints', () => {
    // Create another run and checkpoint
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-def',
      exportId: 'exp-2',
      sampleCount: 30,
      configFingerprint: 'cfg-v2',
    });
    const ck2 = registerCheckpoint(tmpDir, {
      trainRunId: run2.trainRunId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck2.safetensors',
    });

    // Make ck1 deployable
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-d1',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-d1',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);
    markCheckpointDeployable(tmpDir, checkpointId, true);

    // ck2 is not deployable
    const deployable = listDeployableCheckpoints(tmpDir, 'gpt-4');
    expect(deployable).toHaveLength(1);
    expect(deployable[0].checkpointId).toBe(checkpointId);
  });
});

// ---------------------------------------------------------------------------
// Tests: Lineage Tracing
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry lineage tracing', () => {
  let tmpDir: string;
  let runId: string;
  let checkpointId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-full',
      exportId: 'exp-full',
      sampleCount: 100,
      configFingerprint: 'cfg-final',
    });
    runId = run.trainRunId;
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: runId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/final.safetensors',
    });
    checkpointId = ck.checkpointId;
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('getCheckpointLineage returns full chain', () => {
    attachEvalSummary(tmpDir, checkpointId, {
      evalId: 'eval-full',
      checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-full',
      mode: 'reduced_prompt',
      baselineScore: 0.4,
      candidateScore: 0.6,
      delta: 0.2,
      verdict: 'pass',
    });
    startTrainingRun(tmpDir, runId);
    completeTrainingRun(tmpDir, runId);
    markCheckpointDeployable(tmpDir, checkpointId, true);

    const lineage = getCheckpointLineage(tmpDir, checkpointId)!;
    expect(lineage.run.trainRunId).toBe(runId);
    expect(lineage.run.status).toBe('completed');
    expect(lineage.checkpoint.checkpointId).toBe(checkpointId);
    expect(lineage.checkpoint.deployable).toBe(true);
    expect(lineage.eval).not.toBeNull();
    expect(lineage.eval!.verdict).toBe('pass');
    expect(lineage.eval!.delta).toBe(0.2);
  });

  it('getCheckpointLineage returns eval: null if no eval attached', () => {
    const lineage = getCheckpointLineage(tmpDir, checkpointId)!;
    expect(lineage.run).not.toBeNull();
    expect(lineage.checkpoint).not.toBeNull();
    expect(lineage.eval).toBeNull();
  });

  it('getCheckpointLineage returns null for nonexistent checkpoint', () => {
    expect(getCheckpointLineage(tmpDir, 'nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Stats
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry stats', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns zero stats for empty registry', () => {
    const stats = getTrainingRegistryStats(tmpDir);
    expect(stats.totalRuns).toBe(0);
    expect(stats.totalCheckpoints).toBe(0);
    expect(stats.totalEvals).toBe(0);
    expect(stats.deployableCheckpoints).toBe(0);
  });

  it('counts runs in each status', () => {
    const run1 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-a',
      exportId: 'e1',
      sampleCount: 10,
      configFingerprint: 'c1',
    });
    const run2 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-b',
      exportId: 'e2',
      sampleCount: 10,
      configFingerprint: 'c1',
    });
    const run3 = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-c',
      exportId: 'e3',
      sampleCount: 10,
      configFingerprint: 'c1',
    });

    startTrainingRun(tmpDir, run1.trainRunId);
    startTrainingRun(tmpDir, run2.trainRunId);
    completeTrainingRun(tmpDir, run1.trainRunId);
    failTrainingRun(tmpDir, run2.trainRunId, 'err');

    const stats = getTrainingRegistryStats(tmpDir);
    expect(stats.totalRuns).toBe(3);
    expect(stats.pendingRuns).toBe(1);
    expect(stats.runningRuns).toBe(0);
    expect(stats.completedRuns).toBe(1);
    expect(stats.failedRuns).toBe(1);
  });

  it('counts passing vs failing evals', () => {
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    });
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: run.trainRunId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });

    attachEvalSummary(tmpDir, ck.checkpointId, {
      evalId: 'pass-eval',
      checkpointId: ck.checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-1',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });
    attachEvalSummary(tmpDir, ck.checkpointId, {
      evalId: 'fail-eval',
      checkpointId: ck.checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-2',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.3,
      delta: -0.2,
      verdict: 'fail',
    });

    const stats = getTrainingRegistryStats(tmpDir);
    expect(stats.totalEvals).toBe(2);
    expect(stats.passingEvals).toBe(1);
    expect(stats.failingEvals).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Registry Persistence
// ---------------------------------------------------------------------------

describe('ModelTrainingRegistry persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('getFullRegistry returns all record types', () => {
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    });
    const ck = registerCheckpoint(tmpDir, {
      trainRunId: run.trainRunId,
      targetModelFamily: 'gpt-4',
      artifactPath: '/ck.safetensors',
    });
    attachEvalSummary(tmpDir, ck.checkpointId, {
      evalId: 'eval-1',
      checkpointId: ck.checkpointId,
      targetModelFamily: 'gpt-4',
      benchmarkId: 'bench-1',
      mode: 'reduced_prompt',
      baselineScore: 0.5,
      candidateScore: 0.7,
      delta: 0.2,
      verdict: 'pass',
    });

    const registry = getFullRegistry(tmpDir);
    expect(registry.trainingRuns).toHaveLength(1);
    expect(registry.checkpoints).toHaveLength(1);
    expect(registry.evalSummaries).toHaveLength(1);
  });

  it('registry persists across module re-invocations', () => {
    // This test verifies the registry is written to disk
    const run = registerTrainingRun(tmpDir, {
      targetModelFamily: 'gpt-4',
      datasetFingerprint: 'sha256-abc',
      exportId: 'exp-1',
      sampleCount: 50,
      configFingerprint: 'cfg-v1',
    });

    // Simulate re-invocation by reading from disk directly
    const registryPath = path.join(tmpDir, '.state', 'nocturnal', 'training-registry.json');
    expect(fs.existsSync(registryPath)).toBe(true);

    const rawContent = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.trainingRuns).toHaveLength(1);
    expect(parsed.trainingRuns[0].trainRunId).toBe(run.trainRunId);
  });
});
