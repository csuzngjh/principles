/**
 * Tests for External Training Contract
 * ====================================
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type TrainingExperimentSpec,
  type TrainingExperimentResult,
  type TrainerBackendKind,
  type TrainableWorkerProfile,
  type HardwareTier,
  validateTrainerResult,
  computeConfigFingerprint,
  computeDatasetFingerprint,
  computeCodeHash,
  generateExperimentId,
  validateHardwareTier,
  getDefaultHardwareTier,
  isValidModelFamilyForProfile,
  LOCAL_EDITOR_ENABLED,
} from '../../src/core/external-training-contract.js';

describe('external-training-contract', () => {
  // -------------------------------------------------------------------------
  // TrainerBackendKind
  // -------------------------------------------------------------------------

  describe('TrainerBackendKind', () => {
    it('should accept peft-trl-orpo', () => {
      const backend: TrainerBackendKind = 'peft-trl-orpo';
      expect(backend).toBe('peft-trl-orpo');
    });

    it('should accept unsloth-orpo', () => {
      const backend: TrainerBackendKind = 'unsloth-orpo';
      expect(backend).toBe('unsloth-orpo');
    });

    it('should accept dry-run', () => {
      const backend: TrainerBackendKind = 'dry-run';
      expect(backend).toBe('dry-run');
    });
  });

  // -------------------------------------------------------------------------
  // HardwareTier
  // -------------------------------------------------------------------------

  describe('HardwareTier', () => {
    it('should accept consumer-gpu', () => {
      const tier: HardwareTier = 'consumer-gpu';
      expect(tier).toBe('consumer-gpu');
    });

    it('should accept small-gpu', () => {
      const tier: HardwareTier = 'small-gpu';
      expect(tier).toBe('small-gpu');
    });

    it('should accept cpu-experimental', () => {
      const tier: HardwareTier = 'cpu-experimental';
      expect(tier).toBe('cpu-experimental');
    });
  });

  // -------------------------------------------------------------------------
  // computeConfigFingerprint
  // -------------------------------------------------------------------------

  describe('computeConfigFingerprint', () => {
    it('should produce consistent fingerprint for same config', () => {
      const config = { learningRate: 3e-4, loraRank: 16 };
      const fp1 = computeConfigFingerprint(config);
      const fp2 = computeConfigFingerprint(config);
      expect(fp1).toBe(fp2);
    });

    it('should produce same fingerprint regardless of key order', () => {
      const config1 = { learningRate: 3e-4, loraRank: 16 };
      const config2 = { loraRank: 16, learningRate: 3e-4 };
      expect(computeConfigFingerprint(config1)).toBe(computeConfigFingerprint(config2));
    });

    it('should produce different fingerprint for different config', () => {
      const config1 = { learningRate: 3e-4, loraRank: 16 };
      const config2 = { learningRate: 1e-4, loraRank: 16 };
      expect(computeConfigFingerprint(config1)).not.toBe(computeConfigFingerprint(config2));
    });

    it('should produce 16-character hex fingerprint', () => {
      const fp = computeConfigFingerprint({ learningRate: 3e-4 });
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // computeDatasetFingerprint
  // -------------------------------------------------------------------------

  describe('computeDatasetFingerprint', () => {
    it('should produce consistent fingerprint for same inputs', () => {
      const fp1 = computeDatasetFingerprint('/path/to/export.jsonl', 100);
      const fp2 = computeDatasetFingerprint('/path/to/export.jsonl', 100);
      expect(fp1).toBe(fp2);
    });

    it('should produce different fingerprint for different path', () => {
      const fp1 = computeDatasetFingerprint('/path/to/export1.jsonl', 100);
      const fp2 = computeDatasetFingerprint('/path/to/export2.jsonl', 100);
      expect(fp1).not.toBe(fp2);
    });

    it('should produce different fingerprint for different sample count', () => {
      const fp1 = computeDatasetFingerprint('/path/to/export.jsonl', 100);
      const fp2 = computeDatasetFingerprint('/path/to/export.jsonl', 200);
      expect(fp1).not.toBe(fp2);
    });

    it('should produce 16-character hex fingerprint', () => {
      const fp = computeDatasetFingerprint('/path/export.jsonl', 50);
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // computeCodeHash
  // -------------------------------------------------------------------------

  describe('computeCodeHash', () => {
    it('should produce consistent hash for same contract version', () => {
      const hash1 = computeCodeHash();
      const hash2 = computeCodeHash();
      expect(hash1).toBe(hash2);
    });

    it('should produce 16-character hex hash', () => {
      const hash = computeCodeHash();
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // generateExperimentId
  // -------------------------------------------------------------------------

  describe('generateExperimentId', () => {
    it('should produce unique IDs', () => {
      const id1 = generateExperimentId();
      const id2 = generateExperimentId();
      expect(id1).not.toBe(id2);
    });

    it('should produce valid UUID format', () => {
      const id = generateExperimentId();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // validateHardwareTier
  // -------------------------------------------------------------------------

  describe('validateHardwareTier', () => {
    it('should allow consumer-gpu with peft-trl-orpo', () => {
      expect(() => validateHardwareTier('peft-trl-orpo', 'consumer-gpu')).not.toThrow();
    });

    it('should allow small-gpu with unsloth-orpo', () => {
      expect(() => validateHardwareTier('unsloth-orpo', 'small-gpu')).not.toThrow();
    });

    it('should allow cpu-experimental with dry-run', () => {
      expect(() => validateHardwareTier('dry-run', 'cpu-experimental')).not.toThrow();
    });

    it('should throw for cpu-experimental with peft-trl-orpo', () => {
      expect(() => validateHardwareTier('peft-trl-orpo', 'cpu-experimental')).toThrow(
        /cpu-experimental.*only allowed for.*dry-run/
      );
    });

    it('should throw for cpu-experimental with unsloth-orpo', () => {
      expect(() => validateHardwareTier('unsloth-orpo', 'cpu-experimental')).toThrow(
        /cpu-experimental.*only allowed for.*dry-run/
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultHardwareTier
  // -------------------------------------------------------------------------

  describe('getDefaultHardwareTier', () => {
    it('should return consumer-gpu for peft-trl-orpo', () => {
      expect(getDefaultHardwareTier('peft-trl-orpo')).toBe('consumer-gpu');
    });

    it('should return consumer-gpu for unsloth-orpo', () => {
      expect(getDefaultHardwareTier('unsloth-orpo')).toBe('consumer-gpu');
    });

    it('should return cpu-experimental for dry-run', () => {
      expect(getDefaultHardwareTier('dry-run')).toBe('cpu-experimental');
    });
  });

  // -------------------------------------------------------------------------
  // isValidModelFamilyForProfile
  // -------------------------------------------------------------------------

  describe('isValidModelFamilyForProfile', () => {
    describe('for local-reader', () => {
      it('should accept reader-family names', () => {
        expect(isValidModelFamilyForProfile('qwen2.5-7b-reader', 'local-reader')).toBe(true);
        expect(isValidModelFamilyForProfile('claude-haiku-3', 'local-reader')).toBe(true);
        expect(isValidModelFamilyForProfile('phi-mini-reader', 'local-reader')).toBe(true);
      });

      it('should reject editor-family names', () => {
        expect(isValidModelFamilyForProfile('qwen2.5-7b-editor', 'local-reader')).toBe(false);
        expect(isValidModelFamilyForProfile('claude-sonnet-4', 'local-reader')).toBe(false);
      });

      it('should be case-insensitive', () => {
        expect(isValidModelFamilyForProfile('Qwen-Reader', 'local-reader')).toBe(true);
        expect(isValidModelFamilyForProfile('CLAUDE-HAIKU', 'local-reader')).toBe(true);
      });
    });

    describe('for local-editor', () => {
      it('should accept editor-family names', () => {
        expect(isValidModelFamilyForProfile('qwen2.5-7b-editor', 'local-editor')).toBe(true);
        expect(isValidModelFamilyForProfile('claude-sonnet-4', 'local-editor')).toBe(true);
        expect(isValidModelFamilyForProfile('gpt-4o-mini-code', 'local-editor')).toBe(true);
      });

      it('should reject reader-family names', () => {
        expect(isValidModelFamilyForProfile('qwen2.5-7b-reader', 'local-editor')).toBe(false);
        expect(isValidModelFamilyForProfile('claude-haiku-3', 'local-editor')).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // LOCAL_EDITOR_ENABLED
  // -------------------------------------------------------------------------

  describe('LOCAL_EDITOR_ENABLED', () => {
    it('should be false in Phase 7', () => {
      expect(LOCAL_EDITOR_ENABLED).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // validateTrainerResult
  // -------------------------------------------------------------------------

  describe('validateTrainerResult', () => {
    // Helper to create a valid spec and result pair
    function createValidSpec(): TrainingExperimentSpec {
      return {
        experimentId: 'exp-123',
        backend: 'peft-trl-orpo',
        trainingMode: 'orpo',
        targetWorkerProfile: 'local-reader',
        targetModelFamily: 'qwen2.5-7b-reader',
        hardwareTier: 'consumer-gpu',
        datasetExportId: 'export-456',
        datasetExportPath: '.state/exports/orpo/export-456.jsonl',
        datasetFingerprint: 'fp-dataset-abc',
        benchmarkExportId: 'benchmark-789',
        outputDir: '.state/nocturnal/checkpoints',
        configFingerprint: 'fp-config-xyz',
        codeHash: 'fp-code-123',
        hyperparameters: {
          learningRate: 3e-4,
          batchSize: 2,
          gradientAccumulation: 8,
          loraRank: 16,
          loraAlpha: 32,
          loraDropout: 0.05,
          warmupRatio: 0.1,
          maxSteps: 1000,
          maxSeqLength: 2048,
        },
        budget: {
          maxWallClockMinutes: 240,
        },
        expectedArtifact: {
          checkpointName: 'checkpoint-qwen2.5-7b-reader-123',
          adapterFormat: 'peft-adapter',
        },
      };
    }

    function createValidResult(spec: TrainingExperimentSpec): TrainingExperimentResult {
      return {
        experimentId: spec.experimentId,
        backend: spec.backend,
        status: 'completed',
        trainRunId: 'run-001',
        checkpointId: 'ckpt-001',
        checkpointRef: 'ckpt-ref-001',
        targetWorkerProfile: spec.targetWorkerProfile,
        targetModelFamily: spec.targetModelFamily,
        datasetFingerprint: spec.datasetFingerprint,
        configFingerprint: spec.configFingerprint,
        codeHash: spec.codeHash,
        metrics: {
          wallClockMinutes: 120,
          finalLoss: 0.15,
          tokensSeen: 1_500_000,
        },
        artifact: {
          adapterFormat: 'peft-adapter',
          artifactPath: '.state/nocturnal/checkpoints/ckpt-001',
        },
        createdAt: new Date().toISOString(),
      };
    }

    it('should pass for matching spec and result', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should fail when experimentId does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.experimentId = 'wrong-experiment';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('experimentId');
    });

    it('should fail when backend does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.backend = 'unsloth-orpo';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('backend');
    });

    it('should fail when targetWorkerProfile does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.targetWorkerProfile = 'local-editor';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('targetWorkerProfile');
    });

    it('should fail when targetModelFamily does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.targetModelFamily = 'different-family';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('targetModelFamily');
    });

    it('should fail when datasetFingerprint does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.datasetFingerprint = 'wrong-fingerprint';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('datasetFingerprint');
      expect(validation.errors[0].reason).toContain('Dataset fingerprint mismatch');
    });

    it('should fail when configFingerprint does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.configFingerprint = 'wrong-config-fp';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('configFingerprint');
    });

    it('should fail when codeHash does not match', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.codeHash = 'wrong-code-hash';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('codeHash');
    });

    it('should fail when dry-run produces an artifact', () => {
      const spec = createValidSpec();
      spec.backend = 'dry-run';
      const result: TrainingExperimentResult = {
        ...createValidResult(spec),
        backend: 'dry-run',
        status: 'completed',
        artifact: {
          adapterFormat: 'peft-adapter',
          artifactPath: '.state/nocturnal/checkpoints/fake',
        },
      };
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0].field).toBe('artifact');
      expect(validation.errors[0].reason).toContain('Dry-run backend must not produce');
    });

    it('should pass dry-run without artifact', () => {
      const spec = createValidSpec();
      spec.backend = 'dry-run';
      const result: TrainingExperimentResult = {
        ...createValidResult(spec),
        backend: 'dry-run',
        status: 'dry_run',
        artifact: undefined,
      };
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(true);
    });

    it('should collect all errors (not just first)', () => {
      const spec = createValidSpec();
      const result = createValidResult(spec);
      result.datasetFingerprint = 'wrong1';
      result.configFingerprint = 'wrong2';
      result.codeHash = 'wrong3';
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('should pass for failed result with failureReason', () => {
      const spec = createValidSpec();
      const result: TrainingExperimentResult = {
        ...createValidResult(spec),
        status: 'failed',
        artifact: undefined,
        failureReason: 'GPU out of memory',
      };
      const validation = validateTrainerResult(spec, result);
      expect(validation.valid).toBe(true);
    });
  });
});
