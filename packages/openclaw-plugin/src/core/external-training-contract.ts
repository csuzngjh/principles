/**
 * External Training Contract — Normalized Experiment Spec and Result Schema
 * ========================================================================
 *
 * PURPOSE: Define the stable contract between the plugin and external trainer
 * backends. The plugin produces a constrained experiment specification that an
 * external trainer consumes. The trainer returns a normalized result that the
 * plugin can register, evaluate, and gate for rollout.
 *
 * ARCHITECTURE:
 *   - Plugin is responsible for creating the experiment spec
 *   - Plugin is responsible for validating the trainer result
 *   - Plugin is responsible for registering lineage (train run → checkpoint → eval)
 *   - Plugin is responsible for invoking benchmark evaluation
 *   - Plugin is responsible for invoking promotion gate logic
 *   - Plugin is responsible for binding deployment only after gate approval
 *
 * DESIGN CONSTRAINTS:
 *   - ORPO-first: trainingMode must be 'orpo' for production runs
 *   - No real training inside the plugin
 *   - No direct deployment promotion from trainer output
 *   - No direct trainer writes to review/eval/deployment state
 *   - Backend-pluggable: same contract works for all backends
 *
 * CONTRACT GOALS:
 *   - support ORPO training for approved nocturnal exports
 *   - support multiple backend implementations behind one schema
 *   - preserve dataset / config / checkpoint lineage
 *   - remain valid on consumer hardware
 *   - fail closed when inputs are incomplete or inconsistent
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Backend Enum
// ---------------------------------------------------------------------------

/**
 * Allowed backend identifiers.
 *
 * - `peft-trl-orpo`: primary reference implementation using PEFT + TRL ORPO
 * - `unsloth-orpo`: compatible accelerated implementation using Unsloth
 * - `dry-run`: validates paths/spec/environment only, no real training
 */
export type TrainerBackendKind =
  | 'peft-trl-orpo'
  | 'unsloth-orpo'
  | 'dry-run';

/**
 * Hardware tier for training.
 *
 * - `consumer-gpu`: RTX 4090 24GB or equivalent (production target)
 * - `small-gpu`: 8GB-16GB VRAM (compatibility target)
 * - `cpu-experimental`: CPU-only experimental runs (dry-run or tiny models only)
 */
export type HardwareTier =
  | 'consumer-gpu'
  | 'small-gpu'
  | 'cpu-experimental';

/**
 * Worker profiles supported for training.
 *
 * Phase 7 first rollout: `local-reader` only.
 * `local-editor` requires explicit human approval to enable.
 */
export type TrainableWorkerProfile = 'local-reader' | 'local-editor';

/**
 * Training mode — Phase 7 production is ORPO-only.
 */
export type TrainingMode = 'orpo';

// ---------------------------------------------------------------------------
// Experiment Spec
// ---------------------------------------------------------------------------

/**
 * Hyperparameters for ORPO training.
 */
export interface TrainingHyperparameters {
  learningRate: number;
  batchSize: number;
  gradientAccumulation: number;
  loraRank: number;
  loraAlpha: number;
  loraDropout: number;
  warmupRatio: number;
  maxSteps: number;
  maxSeqLength: number;
}

/**
 * Budget constraints for a training experiment.
 */
export interface TrainingBudget {
  maxWallClockMinutes: number;
  maxTrainTokens?: number;
}

/**
 * Expected artifact from a successful training run.
 */
export interface ExpectedArtifact {
  checkpointName: string;
  adapterFormat: 'peft-adapter';
}

/**
 * The experiment specification sent to an external trainer.
 * This defines WHAT to train, not HOW to train (backend-specific).
 */
export interface TrainingExperimentSpec {
  /** Unique identifier for this experiment */
  experimentId: string;

  /** Which backend to use */
  backend: TrainerBackendKind;

  /** Training mode — only 'orpo' is supported in Phase 7 */
  trainingMode: TrainingMode;

  /** Target worker profile for this experiment */
  targetWorkerProfile: TrainableWorkerProfile;

  /** Target model family to train */
  targetModelFamily: string;

  /** Hardware tier for this experiment */
  hardwareTier: HardwareTier;

  /** Reference to the ORPO export providing training data */
  datasetExportId: string;
  datasetExportPath: string;

  /** Fingerprint of the dataset for lineage verification */
  datasetFingerprint: string;

  /** Reference to the benchmark export for eval */
  benchmarkExportId: string;

  /** Output directory for checkpoint artifacts */
  outputDir: string;

  /** Fingerprint of the training configuration */
  configFingerprint: string;

  /** Hash of the training code/contract version */
  codeHash: string;

  /** Training hyperparameters */
  hyperparameters: TrainingHyperparameters;

  /** Budget constraints */
  budget: TrainingBudget;

  /** Expected artifact from training */
  expectedArtifact: ExpectedArtifact;
}

// ---------------------------------------------------------------------------
// Experiment Result
// ---------------------------------------------------------------------------

/**
 * Training metrics recorded by the backend.
 */
export interface TrainingMetrics {
  wallClockMinutes: number;
  finalLoss?: number;
  tokensSeen?: number;
}

/**
 * Artifact produced by a successful training run.
 */
export interface TrainingArtifact {
  adapterFormat: 'peft-adapter';
  artifactPath: string;
}

/**
 * Status of a training experiment.
 */
export type ExperimentStatus = 'completed' | 'failed' | 'dry_run';

/**
 * The result returned by an external trainer after execution.
 * This defines the output contract — all backends must return the same shape.
 */
export interface TrainingExperimentResult {
  /** Experiment ID (must match the spec's experimentId) */
  experimentId: string;

  /** Which backend was used */
  backend: TrainerBackendKind;

  /** Final status of the experiment */
  status: ExperimentStatus;

  /** Registered training run ID (plugin-side) */
  trainRunId?: string;

  /** Registered checkpoint ID (plugin-side) */
  checkpointId?: string;

  /** Checkpoint reference string (for lineage) */
  checkpointRef?: string;

  /** Target worker profile */
  targetWorkerProfile: TrainableWorkerProfile;

  /** Target model family */
  targetModelFamily: string;

  /** Dataset fingerprint (for lineage verification) */
  datasetFingerprint: string;

  /** Config fingerprint (for lineage verification) */
  configFingerprint: string;

  /** Code hash (for lineage verification) */
  codeHash: string;

  /** Training metrics */
  metrics?: TrainingMetrics;

  /** Produced artifact (only if status === 'completed') */
  artifact?: TrainingArtifact;

  /** Failure reason (only if status === 'failed') */
  failureReason?: string;

  /** ISO-8601 creation timestamp */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Validation Errors
// ---------------------------------------------------------------------------

/**
 * Validation error for trainer result verification.
 */
export interface ValidationError {
  field: string;
  expected: string;
  actual: string;
  reason: string;
}

/**
 * Result of validating a trainer result against the experiment spec.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Contract Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a trainer result matches the experiment spec.
 *
 * FAILS CLOSED on any mismatch — a checkpoint with invalid lineage must not
 * be registered or promoted.
 *
 * Validation rules:
 * 1. experimentId must match
 * 2. backend must match
 * 3. targetWorkerProfile must match
 * 4. targetModelFamily must match
 * 5. datasetFingerprint must match
 * 6. configFingerprint must match
 * 7. codeHash must match
 * 8. dry-run must not produce a deployable checkpoint
 *
 * @param spec - The original experiment spec
 * @param result - The trainer result to validate
 * @returns ValidationResult indicating pass/fail and any errors
 */
        // eslint-disable-next-line complexity -- complexity 11, slightly over threshold
export function validateTrainerResult(
  spec: TrainingExperimentSpec,
  result: TrainingExperimentResult
): ValidationResult {
  const errors: ValidationError[] = [];

  // Rule 1: experimentId must match
  if (spec.experimentId !== result.experimentId) {
    errors.push({
      field: 'experimentId',
      expected: spec.experimentId,
      actual: result.experimentId,
      reason: 'Trainer result experimentId does not match the experiment spec',
    });
  }

  // Rule 2: backend must match
  if (spec.backend !== result.backend) {
    errors.push({
      field: 'backend',
      expected: spec.backend,
      actual: result.backend,
      reason: 'Trainer result backend does not match the experiment spec',
    });
  }

  // Rule 3: targetWorkerProfile must match
  if (spec.targetWorkerProfile !== result.targetWorkerProfile) {
    errors.push({
      field: 'targetWorkerProfile',
      expected: spec.targetWorkerProfile,
      actual: result.targetWorkerProfile,
      reason: 'Trainer result targetWorkerProfile does not match the experiment spec',
    });
  }

  // Rule 4: targetModelFamily must match
  if (spec.targetModelFamily !== result.targetModelFamily) {
    errors.push({
      field: 'targetModelFamily',
      expected: spec.targetModelFamily,
      actual: result.targetModelFamily,
      reason: 'Trainer result targetModelFamily does not match the experiment spec',
    });
  }

  // Rule 5: datasetFingerprint must match
  if (spec.datasetFingerprint !== result.datasetFingerprint) {
    errors.push({
      field: 'datasetFingerprint',
      expected: spec.datasetFingerprint,
      actual: result.datasetFingerprint,
      reason: 'Dataset fingerprint mismatch — possible dataset tampering or wrong export used',
    });
  }

  // Rule 6: configFingerprint must match
  if (spec.configFingerprint !== result.configFingerprint) {
    errors.push({
      field: 'configFingerprint',
      expected: spec.configFingerprint,
      actual: result.configFingerprint,
      reason: 'Config fingerprint mismatch — training config may have changed since spec was created',
    });
  }

  // Rule 7: codeHash must match
  if (spec.codeHash !== result.codeHash) {
    errors.push({
      field: 'codeHash',
      expected: spec.codeHash,
      actual: result.codeHash,
      reason: 'Code hash mismatch — training code or contract version may have changed',
    });
  }

  // Rule 8: dry-run must not produce a deployable checkpoint
  if (spec.backend === 'dry-run') {
    if (result.status === 'completed' && result.artifact) {
      errors.push({
        field: 'artifact',
        expected: 'no artifact for dry-run',
        actual: 'artifact present',
        reason: 'Dry-run backend must not produce a deployable checkpoint',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Spec Creation Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fingerprint for a configuration object.
 * Used for configFingerprint in the experiment spec.
 */
export function computeConfigFingerprint(config: Partial<TrainingHyperparameters>): string {
  const normalized = JSON.stringify(config, Object.keys(config).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Generate a fingerprint for a dataset export.
 * Used for datasetFingerprint in the experiment spec.
 *
 * Combines file content hash with sampleCount to detect:
 * - Content changes (file modified/replaced)
 * - Sample count changes (different export)
 *
 * If the file cannot be read, falls back to path+count hash (legacy behavior).
 */
export function computeDatasetFingerprint(exportPath: string, sampleCount: number): string {
   
  let contentHash: string;
  try {
    const content = fs.readFileSync(exportPath, 'utf-8');
    contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  } catch {
    // Fallback: include path in hash so different paths still differ
    // (even if files don't exist during spec creation)
    const fallbackContent = `${exportPath}:${sampleCount}`;
    return crypto.createHash('sha256').update(fallbackContent).digest('hex').slice(0, 16);
  }
  // Combine content hash with sample count for additional safety
  const combined = `${contentHash}:${sampleCount}`;
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

/**
 * Generate a code hash for the training contract version.
 * Used for codeHash in the experiment spec.
 *
 * Hashes the actual contract source file content so any change to the
 * contract produces a different hash, ensuring lineage integrity.
 *
 * Falls back to version string + timestamp if source cannot be read.
 */
export function computeCodeHash(): string {
  try {
    // Hash the actual contract source file content using ESM-safe resolution
    const sourcePath = fileURLToPath(import.meta.url);
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    // Include only the relevant contract definitions (first 500 lines)
    // to avoid hash changes from comments/timestamps
    const relevantContent = sourceContent.split('\n').slice(0, 500).join('\n');
    return crypto.createHash('sha256').update(relevantContent).digest('hex').slice(0, 16);
  } catch {
    // Fallback if source cannot be read (should not happen in normal operation)
    // Use a deterministic version string — NOT Date.now() — so the hash is stable
    const fallback = 'nocturnal-phase7-v1:deterministic-fallback';
    return crypto.createHash('sha256').update(fallback).digest('hex').slice(0, 16);
  }
}

/**
 * Generate a new experiment ID.
 */
export function generateExperimentId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Hardware Tier Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a hardware tier is appropriate for the backend.
 *
 * @param backend - The backend being used
 * @param tier - The hardware tier
 * @throws Error if the combination is not supported
 */
export function validateHardwareTier(backend: TrainerBackendKind, tier: HardwareTier): void {
  // cpu-experimental is only allowed for dry-run
  if (tier === 'cpu-experimental' && backend !== 'dry-run') {
    throw new Error(
      `Hardware tier 'cpu-experimental' is only allowed for 'dry-run' backend. ` +
        `For real training on GPU, use 'consumer-gpu' or 'small-gpu'.`
    );
  }
}

/**
 * Get the default hardware tier for a backend.
 */
export function getDefaultHardwareTier(backend: TrainerBackendKind): HardwareTier {
  if (backend === 'dry-run') {
    return 'cpu-experimental';
  }
  return 'consumer-gpu';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Valid model family patterns for local-reader profile.
 * Used for family validation in the training contract.
 */
export const READER_FAMILY_PATTERNS = [
  'reader', 'read', 'claude-haiku', 'qwen-lite', 'phi-mini',
  'gpt-4o-mini', 'gpt-4o-nano',
];

/**
 * Valid model family patterns for local-editor profile.
 * Used for family validation in the training contract.
 */
export const EDITOR_FAMILY_PATTERNS = [
  'editor', 'edit', 'code', 'claude-sonnet', 'gpt-4o-mini',
];

/**
 * Check if a model family is valid for a worker profile.
 */
export function isValidModelFamilyForProfile(
  family: string,
  profile: TrainableWorkerProfile
): boolean {
  const lower = family.toLowerCase();
  if (profile === 'local-reader') {
    return READER_FAMILY_PATTERNS.some((p) => lower.includes(p));
  }
  if (profile === 'local-editor') {
    return EDITOR_FAMILY_PATTERNS.some((p) => lower.includes(p));
  }
  return false;
}

/**
 * Phase 7 first rollout is limited to local-reader.
 * This flag controls whether local-editor is allowed.
 */
export const LOCAL_EDITOR_ENABLED = false;
