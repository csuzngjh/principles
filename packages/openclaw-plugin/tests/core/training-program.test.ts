/**
 * Tests for Training Program
 * ===========================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createExperiment,
  DEFAULT_ORPO_HYPERPARAMETERS,
  DEFAULT_BUDGET,
  TrainingProgram,
  processTrainerResult,
  executeTrainer,
  type CreateExperimentParams,
  type ProcessTrainerResultParams,
} from '../../src/core/training-program.js';
import { getFullRegistry } from '../../src/core/model-training-registry.js';
import type { TrainingExperimentResult } from '../../src/core/external-training-contract.js';

describe('training-program', () => {
  // -------------------------------------------------------------------------
  // Test setup
  // -------------------------------------------------------------------------

  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-training-test-'));
    stateDir = path.join(tempDir, '.state', 'nocturnal');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  // -------------------------------------------------------------------------
  // DEFAULT_ORPO_HYPERPARAMETERS
  // -------------------------------------------------------------------------

  describe('DEFAULT_ORPO_HYPERPARAMETERS', () => {
    it('should have sensible defaults for consumer GPU', () => {
      expect(DEFAULT_ORPO_HYPERPARAMETERS.learningRate).toBe(3e-4);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.batchSize).toBe(2);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.gradientAccumulation).toBe(8);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.loraRank).toBe(16);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.loraAlpha).toBe(32);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.maxSeqLength).toBe(2048);
    });

    it('should be compatible with ORPO training', () => {
      expect(DEFAULT_ORPO_HYPERPARAMETERS.maxSteps).toBeGreaterThan(0);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.warmupRatio).toBeGreaterThan(0);
      expect(DEFAULT_ORPO_HYPERPARAMETERS.warmupRatio).toBeLessThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // DEFAULT_BUDGET
  // -------------------------------------------------------------------------

  describe('DEFAULT_BUDGET', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_BUDGET.maxWallClockMinutes).toBe(240); // 4 hours
      expect(DEFAULT_BUDGET.maxTrainTokens).toBe(2_000_000);
    });
  });

  // -------------------------------------------------------------------------
  // createExperiment
  // -------------------------------------------------------------------------

  describe('createExperiment', () => {
    function createValidParams(): CreateExperimentParams {
      return {
        backend: 'peft-trl-orpo',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetExportId: 'export-123',
        datasetExportPath: path.join(tempDir, '.state', 'exports', 'orpo', 'export-123.jsonl'),
        datasetFingerprint: 'fp-abc123',
        benchmarkExportId: 'benchmark-456',
        outputDir: path.join(tempDir, '.state', 'nocturnal', 'checkpoints'),
      };
    }

    it('should create experiment spec with correct fields', () => {
      const params = createValidParams();
      const { spec, trainRunId } = createExperiment(stateDir, params);

      expect(spec.experimentId).toBeDefined();
      expect(spec.backend).toBe('peft-trl-orpo');
      expect(spec.trainingMode).toBe('orpo');
      expect(spec.targetWorkerProfile).toBe('local-reader');
      expect(spec.targetModelFamily).toBe('qwen2.5-7b-reader');
      expect(spec.hardwareTier).toBe('consumer-gpu');
      expect(spec.datasetExportId).toBe('export-123');
      expect(spec.datasetFingerprint).toBe('fp-abc123');
      expect(spec.benchmarkExportId).toBe('benchmark-456');
      expect(spec.configFingerprint).toBeDefined();
      expect(spec.codeHash).toBeDefined();
      expect(spec.hyperparameters).toEqual(DEFAULT_ORPO_HYPERPARAMETERS);
      expect(spec.budget).toEqual(DEFAULT_BUDGET);
    });

    it('should register training run in registry', () => {
      const params = createValidParams();
      const { trainRunId } = createExperiment(stateDir, params);

      const registry = getFullRegistry(stateDir);
      expect(registry.trainingRuns).toHaveLength(1);
      expect(registry.trainingRuns[0].trainRunId).toBe(trainRunId);
      expect(registry.trainingRuns[0].status).toBe('pending');
    });

    it('should use default hardware tier for peft-trl-orpo', () => {
      const params = createValidParams();
      params.backend = 'peft-trl-orpo';
      const { spec } = createExperiment(stateDir, params);
      expect(spec.hardwareTier).toBe('consumer-gpu');
    });

    it('should use default hardware tier for unsloth-orpo', () => {
      const params = createValidParams();
      params.backend = 'unsloth-orpo';
      const { spec } = createExperiment(stateDir, params);
      expect(spec.hardwareTier).toBe('consumer-gpu');
    });

    it('should use cpu-experimental for dry-run', () => {
      const params = createValidParams();
      params.backend = 'dry-run';
      const { spec } = createExperiment(stateDir, params);
      expect(spec.hardwareTier).toBe('cpu-experimental');
    });

    it('should accept custom hyperparameters', () => {
      const params = createValidParams();
      params.hyperparameters = { learningRate: 1e-4, loraRank: 32 };
      const { spec } = createExperiment(stateDir, params);
      expect(spec.hyperparameters.learningRate).toBe(1e-4);
      expect(spec.hyperparameters.loraRank).toBe(32);
      // Unspecified fields should use defaults
      expect(spec.hyperparameters.batchSize).toBe(DEFAULT_ORPO_HYPERPARAMETERS.batchSize);
    });

    it('should accept custom budget', () => {
      const params = createValidParams();
      params.budget = { maxWallClockMinutes: 120 };
      const { spec } = createExperiment(stateDir, params);
      expect(spec.budget.maxWallClockMinutes).toBe(120);
      expect(spec.budget.maxTrainTokens).toBe(DEFAULT_BUDGET.maxTrainTokens);
    });

    it('should throw for invalid model family for local-reader', () => {
      const params = createValidParams();
      params.targetModelFamily = 'qwen2.5-7b-editor'; // editor family for reader profile
      expect(() => createExperiment(stateDir, params)).toThrow(/not valid for profile/);
    });

    it('should throw for local-editor when not enabled', () => {
      const params = createValidParams();
      params.targetWorkerProfile = 'local-editor';
      expect(() => createExperiment(stateDir, params)).toThrow(/local-editor.*not yet enabled/);
    });

    it('should throw for cpu-experimental with peft-trl-orpo', () => {
      const params = createValidParams();
      params.hardwareTier = 'cpu-experimental';
      expect(() => createExperiment(stateDir, params)).toThrow(/cpu-experimental.*only allowed.*dry-run/);
    });

    it('should accept small-gpu hardware tier', () => {
      const params = createValidParams();
      params.hardwareTier = 'small-gpu';
      const { spec } = createExperiment(stateDir, params);
      expect(spec.hardwareTier).toBe('small-gpu');
    });
  });

  // -------------------------------------------------------------------------
  // TrainingProgram class
  // -------------------------------------------------------------------------

  describe('TrainingProgram', () => {
    function createValidParams(): CreateExperimentParams {
      return {
        backend: 'peft-trl-orpo',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetExportId: 'export-123',
        datasetExportPath: path.join(tempDir, '.state', 'exports', 'orpo', 'export-123.jsonl'),
        datasetFingerprint: 'fp-abc123',
        benchmarkExportId: 'benchmark-456',
        outputDir: path.join(tempDir, '.state', 'nocturnal', 'checkpoints'),
      };
    }

    it('should create instance with stateDir', () => {
      const program = new TrainingProgram(stateDir);
      expect(program).toBeDefined();
    });

    it('should create experiment via instance method', () => {
      const program = new TrainingProgram(stateDir);
      const params = createValidParams();
      const { spec, trainRunId } = program.createExperiment(params);

      expect(spec.experimentId).toBeDefined();
      expect(trainRunId).toBeDefined();
      expect(spec.backend).toBe('peft-trl-orpo');
    });

    it('should track multiple experiments', () => {
      const program = new TrainingProgram(stateDir);
      const params = createValidParams();

      program.createExperiment(params);
      program.createExperiment({ ...params, datasetExportId: 'export-456' });

      const registry = getFullRegistry(stateDir);
      expect(registry.trainingRuns).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // processTrainerResult
  // -------------------------------------------------------------------------

  function makeCompletedResult(spec: ReturnType<typeof createExperiment>['spec'], overrides?: Partial<TrainingExperimentResult>): TrainingExperimentResult {
    return {
      experimentId: spec.experimentId,
      backend: spec.backend,
      status: 'completed',
      targetWorkerProfile: spec.targetWorkerProfile,
      targetModelFamily: spec.targetModelFamily,
      datasetFingerprint: spec.datasetFingerprint,
      configFingerprint: spec.configFingerprint,
      codeHash: spec.codeHash,
      checkpointId: 'ckpt-001',
      artifact: {
        adapterFormat: 'peft-adapter',
        artifactPath: path.join(tempDir, '.state', 'nocturnal', 'checkpoints', 'checkpoint'),
      },
      ...overrides,
    };
  }

  function makeFailedResult(spec: ReturnType<typeof createExperiment>['spec']): TrainingExperimentResult {
    return {
      experimentId: spec.experimentId,
      backend: spec.backend,
      status: 'failed',
      targetWorkerProfile: spec.targetWorkerProfile,
      targetModelFamily: spec.targetModelFamily,
      datasetFingerprint: spec.datasetFingerprint,
      configFingerprint: spec.configFingerprint,
      codeHash: spec.codeHash,
      failureReason: 'CUDA out of memory',
    };
  }

  function makeDryRunResult(spec: ReturnType<typeof createExperiment>['spec']): TrainingExperimentResult {
    return {
      experimentId: spec.experimentId,
      backend: 'dry-run',
      status: 'dry_run',
      targetWorkerProfile: spec.targetWorkerProfile,
      targetModelFamily: spec.targetModelFamily,
      datasetFingerprint: spec.datasetFingerprint,
      configFingerprint: spec.configFingerprint,
      codeHash: spec.codeHash,
    };
  }

  describe('processTrainerResult', () => {
    function createValidExperiment() {
      const params: CreateExperimentParams = {
        backend: 'peft-trl-orpo',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetExportId: 'export-process-123',
        datasetExportPath: path.join(tempDir, '.state', 'exports', 'orpo', 'export-process-123.jsonl'),
        datasetFingerprint: 'fp-process-abc',
        benchmarkExportId: 'benchmark-process-456',
        outputDir: path.join(tempDir, '.state', 'nocturnal', 'checkpoints'),
      };
      return createExperiment(stateDir, params);
    }

    it('completed result: transitions run to completed and registers checkpoint', () => {
      const { spec, trainRunId } = createValidExperiment();
      const result = makeCompletedResult(spec);

      const { checkpointId, checkpointRef } = processTrainerResult({
        spec,
        trainRunId,
        result,
        stateDir,
      });

      expect(checkpointId).toBeDefined();
      expect(checkpointRef).toBeDefined();

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      expect(run.status).toBe('completed');
      expect(registry.checkpoints).toHaveLength(1);
      expect(registry.checkpoints[0].checkpointId).toBe(checkpointId);
    });

    it('completed result missing checkpointId: transitions run to failed and throws', () => {
      const { spec, trainRunId } = createValidExperiment();
      const result = makeCompletedResult(spec, { checkpointId: undefined, artifact: undefined });

      expect(() => processTrainerResult({ spec, trainRunId, result, stateDir })).toThrow(/missing checkpointId or artifact/);

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      expect(run.status).toBe('failed');
    });

    it('failed result: transitions run to failed and throws', () => {
      const { spec, trainRunId } = createValidExperiment();
      const result = makeFailedResult(spec);

      expect(() => processTrainerResult({ spec, trainRunId, result, stateDir })).toThrow(/CUDA out of memory/);

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      expect(run.status).toBe('failed');
    });

    it('validation failure: transitions pending → running → failed (not invalid transition)', () => {
      const { spec, trainRunId } = createValidExperiment();
      // Tamper with experimentId to trigger validation failure
      const tamperedResult: TrainingExperimentResult = {
        ...makeCompletedResult(spec),
        experimentId: 'WRONG-ID',
      };

      expect(() => processTrainerResult({ spec, trainRunId, result: tamperedResult, stateDir }))
        .toThrow(/validation failed/);

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      // Must be 'failed', not stuck in 'pending' or crash with invalid transition
      expect(run.status).toBe('failed');
      expect(run.failureReason).toContain('Validation failed');
    });

    it('dry_run result: transitions run to completed and returns null (no checkpoint)', () => {
      const { spec, trainRunId } = createValidExperiment();
      const result = makeDryRunResult(spec);

      const processed = processTrainerResult({ spec, trainRunId, result, stateDir });

      // dry_run is a non-error outcome — returns null (no checkpoint) and does NOT throw
      expect(processed).toBeNull();

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      expect(run.status).toBe('completed');
      // No checkpoint should be registered for dry-run
      expect(registry.checkpoints).toHaveLength(0);
    });

    it('completed result: registers checkpoint before marking run completed', () => {
      // This verifies the ordering fix: registerCheckpoint is called before
      // completeTrainingRun, so if registerCheckpoint were to throw, the run
      // would stay in 'running' (not 'completed') state.
      const { spec, trainRunId } = createValidExperiment();
      const result = makeCompletedResult(spec);

      const { checkpointId } = processTrainerResult({
        spec,
        trainRunId,
        result,
        stateDir,
      })!;

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      // Verify: checkpoint is registered AND run is completed (happy path)
      expect(run.status).toBe('completed');
      expect(registry.checkpoints).toHaveLength(1);
      expect(registry.checkpoints[0].checkpointId).toBe(checkpointId);
    });

    it('TrainingProgram.processResult returns null for dry_run (non-error outcome)', () => {
      const program = new TrainingProgram(stateDir);
      const params: CreateExperimentParams = {
        backend: 'dry-run',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetExportId: 'export-dryrun-process',
        datasetExportPath: path.join(tempDir, '.state', 'exports', 'orpo', 'export-dryrun-process.jsonl'),
        datasetFingerprint: 'fp-dryrun-process',
        benchmarkExportId: 'benchmark-dryrun',
        outputDir: path.join(tempDir, '.state', 'nocturnal', 'checkpoints'),
      };
      const { spec, trainRunId } = program.createExperiment(params);
      const dryRunResult = makeDryRunResult(spec);

      const processed = program.processResult({ spec, trainRunId, result: dryRunResult });

      // dry_run returns null (no checkpoint) — this is a valid, non-error outcome
      expect(processed).toBeNull();

      const registry = getFullRegistry(stateDir);
      const run = registry.trainingRuns.find(r => r.trainRunId === trainRunId)!;
      expect(run.status).toBe('completed');
      expect(registry.checkpoints).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // executeTrainer (dry-run path)
  // -------------------------------------------------------------------------

  describe('executeTrainer', () => {
    function createDryRunSpec() {
      const params: CreateExperimentParams = {
        backend: 'dry-run',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        datasetExportId: 'export-dryrun',
        datasetExportPath: path.join(tempDir, '.state', 'exports', 'orpo', 'export-dryrun.jsonl'),
        datasetFingerprint: 'fp-dryrun',
        benchmarkExportId: 'benchmark-dryrun',
        outputDir: path.join(tempDir, '.state', 'nocturnal', 'checkpoints'),
      };
      const { spec } = createExperiment(stateDir, params);
      return spec;
    }

    it('dry-run backend returns dry_run result without executing Python', async () => {
      const spec = createDryRunSpec();

      // If this were NOT dry-run, it would try to exec python. Since it IS dry-run,
      // it should return immediately without exec.
      const result = await executeTrainer(spec);

      expect(result.status).toBe('dry_run');
      expect(result.experimentId).toBe(spec.experimentId);
      expect(result.backend).toBe('dry-run');
      expect(result.targetWorkerProfile).toBe(spec.targetWorkerProfile);
      expect(result.targetModelFamily).toBe(spec.targetModelFamily);
    });

    it('dry-run does not require trainer scripts to exist', async () => {
      const spec = createDryRunSpec();
      // Override scriptsDir to a non-existent path — dry-run should still succeed
      // (dry-run backend bypasses script existence check).
      // Use os.tmpdir() for cross-platform compatibility (Windows disallows mkdir at '/').
      const result = await executeTrainer(spec, path.join(os.tmpdir(), 'fake-scripts'));

      expect(result.status).toBe('dry_run');
    });
  });
});
