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
  type CreateExperimentParams,
} from '../../src/core/training-program.js';
import { getFullRegistry } from '../../src/core/model-training-registry.js';

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
});
