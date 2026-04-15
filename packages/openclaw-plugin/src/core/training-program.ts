/**
 * Training Program — Orchestrates External Training Execution and Lineage
 * =========================================================================
 *
 * PURPOSE: Coordinate the training workflow from experiment spec creation
 * through checkpoint registration and eval attachment.
 *
 * ARCHITECTURE:
 *   - TrainingProgram orchestrates the workflow but does NOT execute training itself
 *   - External trainer backends (Python scripts) do the actual training
 *   - Training run, checkpoint, and eval lineage is registered in model-training-registry
 *   - Promotion gate (promotion-gate.ts) controls deployment readiness
 *
 * WORKFLOW:
 *   1. Create experiment spec (TrainingProgram.createExperiment)
 *   2. Execute external trainer (TrainingProgram.executeTrainer)
 *   3. Validate trainer result against spec (validateTrainerResult)
 *   4. Register training run (model-training-registry)
 *   5. Register checkpoint (model-training-registry)
 *   6. Attach eval summary after benchmark (model-training-registry)
 *   7. Promotion gate controls deployment readiness
 *
 * DESIGN CONSTRAINTS:
 *   - ORPO-first: only 'orpo' training mode
 *   - No training inside the plugin runtime
 *   - No direct deployment binding from trainer output
 *   - Trainer backends are fire-and-forget (plugin does not poll trainer)
 *   - All lineage must be traceable through model-training-registry
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  type TrainingExperimentSpec,
  type TrainingExperimentResult,
  type TrainerBackendKind,
  type TrainableWorkerProfile,
  type HardwareTier,
  type TrainingHyperparameters,
  type TrainingBudget,
  validateTrainerResult,
  computeConfigFingerprint,
  computeCodeHash,
  generateExperimentId,
  validateHardwareTier,
  getDefaultHardwareTier,
  isValidModelFamilyForProfile,
  LOCAL_EDITOR_ENABLED,
} from './external-training-contract.js';
import {
  registerTrainingRun,
  startTrainingRun,
  completeTrainingRun,
  failTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  markCheckpointDeployable,
  getCheckpointLineage,
} from './model-training-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path to the external trainer scripts directory.
 */
const TRAINER_SCRIPTS_DIR = 'scripts/nocturnal/trainer';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..', '..');

/**
 * Default hyperparameters for ORPO training.
 * These are conservative defaults for consumer GPU (RTX 4090 24GB).
 */
export const DEFAULT_ORPO_HYPERPARAMETERS: TrainingHyperparameters = {
  learningRate: 3e-4,
  batchSize: 2,
  gradientAccumulation: 8,
  loraRank: 16,
  loraAlpha: 32,
  loraDropout: 0.05,
  warmupRatio: 0.1,
  maxSteps: 1000,
  maxSeqLength: 2048,
};

/**
 * Default budget for training runs.
 */
export const DEFAULT_BUDGET: TrainingBudget = {
  maxWallClockMinutes: 240, // 4 hours
  maxTrainTokens: 2_000_000,
};

// ---------------------------------------------------------------------------
// Experiment Spec Creation
// ---------------------------------------------------------------------------

/**
 * Parameters for creating a training experiment.
 */
export interface CreateExperimentParams {
  /** Target worker profile */
  targetWorkerProfile: TrainableWorkerProfile;

  /** Target model family */
  targetModelFamily: string;

  /** Hardware tier */
  hardwareTier?: HardwareTier;

  /** Backend to use */
  backend: TrainerBackendKind;

  /** Dataset export ID */
  datasetExportId: string;

  /** Dataset export path */
  datasetExportPath: string;

  /** Dataset fingerprint */
  datasetFingerprint: string;

  /** Benchmark export ID */
  benchmarkExportId: string;

  /** Output directory for checkpoints */
  outputDir: string;

  /** Custom hyperparameters (optional) */
  hyperparameters?: Partial<TrainingHyperparameters>;

  /** Custom budget (optional) */
  budget?: Partial<TrainingBudget>;
}

/**
 * Result of creating an experiment.
 */
export interface CreateExperimentResult {
  /** The experiment specification */
  spec: TrainingExperimentSpec;

  /** The registered training run ID */
  trainRunId: string;
}

/**
 * Create a new training experiment.
 *
 * This creates the experiment spec and registers a training run in the registry.
 *
 * @param stateDir - Workspace state directory
 * @param params - Experiment parameters
 * @returns Created experiment spec and registered training run ID
 *
 * @throws Error if worker profile is not allowed (local-editor not yet enabled)
 * @throws Error if model family is not valid for the worker profile
 * @throws Error if hardware tier is not valid for the backend
 */
export function createExperiment(
  stateDir: string,
  params: CreateExperimentParams
): CreateExperimentResult {
  // --- Validate worker profile ---
  if (params.targetWorkerProfile === 'local-editor' && !LOCAL_EDITOR_ENABLED) {
    throw new Error(
      `Training for 'local-editor' is not yet enabled. ` +
        `Phase 7 first rollout is limited to 'local-reader'. ` +
        `To enable local-editor training, set LOCAL_EDITOR_ENABLED = true ` +
        `in external-training-contract.ts after appropriate review.`
    );
  }

  // --- Validate model family for profile ---
  if (!isValidModelFamilyForProfile(params.targetModelFamily, params.targetWorkerProfile)) {
    throw new Error(
      `Model family '${params.targetModelFamily}' is not valid for profile ` +
        `'${params.targetWorkerProfile}'. ` +
        `Ensure the model family name contains an appropriate keyword.`
    );
  }

  // --- Validate hardware tier ---
  const tier = params.hardwareTier ?? getDefaultHardwareTier(params.backend);
  validateHardwareTier(params.backend, tier);

  // --- Merge hyperparameters ---
  const hyperparameters: TrainingHyperparameters = {
    ...DEFAULT_ORPO_HYPERPARAMETERS,
    ...params.hyperparameters,
  };

  // --- Compute fingerprints ---
  const configFingerprint = computeConfigFingerprint(hyperparameters);
  const codeHash = computeCodeHash();

  // --- Create experiment spec ---
  const spec: TrainingExperimentSpec = {
    experimentId: generateExperimentId(),
    backend: params.backend,
    trainingMode: 'orpo',
    targetWorkerProfile: params.targetWorkerProfile,
    targetModelFamily: params.targetModelFamily,
    hardwareTier: tier,
    datasetExportId: params.datasetExportId,
    datasetExportPath: params.datasetExportPath,
    datasetFingerprint: params.datasetFingerprint,
    benchmarkExportId: params.benchmarkExportId,
    outputDir: params.outputDir,
    configFingerprint,
    codeHash,
    hyperparameters,
    budget: { ...DEFAULT_BUDGET, ...params.budget },
    expectedArtifact: {
      checkpointName: `checkpoint-${params.targetModelFamily}-${Date.now()}`,
      adapterFormat: 'peft-adapter',
    },
  };

  // --- Register training run in registry ---
  const trainRun = registerTrainingRun(stateDir, {
    experimentId: spec.experimentId,
    targetModelFamily: spec.targetModelFamily,
    datasetFingerprint: spec.datasetFingerprint,
    exportId: spec.datasetExportId,
    sampleCount: 0, // Will be updated when result is registered
    configFingerprint: spec.configFingerprint,
  });

  return { spec, trainRunId: trainRun.trainRunId };
}

// ---------------------------------------------------------------------------
// Trainer Execution
// ---------------------------------------------------------------------------

/**
 * Parameters for executing an external trainer.
 */
export interface ExecuteTrainerParams {
  /** The experiment specification */
  spec: TrainingExperimentSpec;

  /** Path to the trainer scripts directory */
  scriptsDir?: string;
}

/**
 * Execute an external trainer backend.
 *
 * This function:
 * 1. Validates the trainer script exists
 * 2. Serializes the experiment spec to JSON
 * 3. Invokes the Python backend
 * 4. Returns the trainer's parsed result
 *
 * The trainer protocol:
 * - stdout: MUST contain only the machine-readable JSON result (TrainingExperimentResult)
 * - stderr: Contains training progress logs (ignored by plugin)
 * - result file: Written to output dir as backup if stdout parsing fails
 *
 * NOTE: This is a fire-and-forget execution. The plugin does not poll
 * the trainer. For Phase 7, trainer execution is assumed to be synchronous
 * or to complete before this function returns.
 *
 * @param spec - The experiment specification
 * @param scriptsDir - Override for the scripts directory
 * @returns The trainer's result as parsed JSON object
 *
 * @throws Error if the trainer script is not found
 * @throws Error if trainer execution fails
 * @throws Error if result cannot be parsed
 */
export async function executeTrainer(
  spec: TrainingExperimentSpec,
  scriptsDir?: string
): Promise<TrainingExperimentResult> {
  const baseDir = scriptsDir ?? path.join(REPO_ROOT, TRAINER_SCRIPTS_DIR);

  // Map backend to script name
  const scriptMap: Record<TrainerBackendKind, string> = {
    'peft-trl-orpo': 'main.py',
    'unsloth-orpo': 'main.py',
    'dry-run': 'main.py',
  };

  const scriptName = scriptMap[spec.backend];
  const scriptPath = path.join(baseDir, scriptName);

  // Check if script exists (for dry-run, we allow missing scripts in development)
  if (spec.backend !== 'dry-run' && !fs.existsSync(scriptPath)) {
    throw new Error(
      `Trainer script not found: ${scriptPath}. ` +
        `Ensure the external trainer backends are installed at ${baseDir}.`
    );
  }

  // Serialize spec to JSON for passing to trainer
  const specPath = path.join(baseDir, `experiment-${spec.experimentId}.json`);
  const specJson = JSON.stringify(spec, null, 2);

  // Write spec to file for trainer to read
  const specDir = path.dirname(specPath);
  if (!fs.existsSync(specDir)) {
    fs.mkdirSync(specDir, { recursive: true });
  }
  fs.writeFileSync(specPath, specJson, 'utf-8');

  // Result file path (written by trainer to output dir)
  const resultFilePath = path.join(spec.outputDir, `result-${spec.experimentId}.json`);

  try {
    if (spec.backend === 'dry-run') {
      // For dry-run, simulate a successful dry-run result
      // No actual Python script execution needed - dry-run just validates spec
      return {
        experimentId: spec.experimentId,
        backend: 'dry-run',
        status: 'dry_run' as const,
        targetWorkerProfile: spec.targetWorkerProfile,
        targetModelFamily: spec.targetModelFamily,
        datasetFingerprint: spec.datasetFingerprint,
        configFingerprint: spec.configFingerprint,
        codeHash: spec.codeHash,
        createdAt: new Date().toISOString(),
      };
    }

    // Execute the Python trainer using spawn (streaming).
    const { spawn } = await import('child_process');
    // - stdout is collected into a fixed-size buffer (1MB max) to prevent OOM from training logs
    // - stderr is piped directly to parent stderr so it never accumulates in memory
    // - Non-zero exit codes are handled with clear error messages
    const timeoutMs = (spec.budget.maxWallClockMinutes * 60 * 1000) + 30000;
    const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
    const MAX_STDOUT_BUFFER = 1 * 1024 * 1024; // 1MB cap

    const trainerResult = await new Promise<
      TrainingExperimentResult
    >((resolve, reject) => {
      const proc = spawn(pythonExecutable, [scriptPath, '--spec', specPath, '--output-dir', spec.outputDir]);

      // Collect stdout with size cap to prevent OOM from huge log output
      const stdoutChunks: Buffer[] = [];
      let stdoutSize = 0;

      proc.stdout.on('data', (chunk: Buffer) => {
        const remaining = MAX_STDOUT_BUFFER - stdoutSize;
        if (remaining > 0) {
          stdoutChunks.push(chunk.slice(0, remaining));
          stdoutSize += Math.min(chunk.length, remaining);
        }
      });

      // Pipe stderr directly — training logs must NOT accumulate in memory
      proc.stderr.pipe(process.stderr);

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Trainer timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref(); // Don't keep process alive for timeout

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          const trimmed = stdout.trim();
          if (trimmed) {
            try {
              resolve(JSON.parse(trimmed) as TrainingExperimentResult);
              return;
            } catch {
              // fall through to result file
            }
          }
          // Fallback: try result file
          if (fs.existsSync(resultFilePath)) {
            try {
              const content = fs.readFileSync(resultFilePath, 'utf-8');
              resolve(JSON.parse(content) as TrainingExperimentResult);
              return;
            } catch {
              // fall through to error
            }
          }
          reject(
            new Error(
              `Trainer stdout was not valid JSON and result file also invalid. ` +
                `result file: ${resultFilePath}`
            )
          );
        } else {
          // Non-zero exit — try result file as last resort
          if (fs.existsSync(resultFilePath)) {
            try {
              const content = fs.readFileSync(resultFilePath, 'utf-8');
              resolve(JSON.parse(content) as TrainingExperimentResult);
            } catch {
              reject(new Error(`Trainer exited with code ${code} and result file was invalid: ${resultFilePath}`));
            }
          } else {
            reject(new Error(`Trainer exited with code ${code} and no result file found at: ${resultFilePath}`));
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Trainer spawn failed: ${err.message}`));
      });
    });

    return trainerResult;
  } finally {
    // Clean up spec file after execution
    if (fs.existsSync(specPath)) {
      fs.unlinkSync(specPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Result Processing
// ---------------------------------------------------------------------------

/**
 * Parameters for processing a trainer result.
 */
export interface ProcessTrainerResultParams {
  /** The original experiment specification */
  spec: TrainingExperimentSpec;

  /** The training run ID from registry */
  trainRunId: string;

  /** The trainer's result (parsed) */
  result: TrainingExperimentResult;

  /** Workspace state directory */
  stateDir: string;
}

/**
 * Process a trainer result:
 * 1. Validate result against spec
 * 2. Register checkpoint in training registry
 * 3. Return checkpoint for eval attachment
 *
 * @param params - Processing parameters
 * @returns The registered checkpoint, or null for dry_run (no checkpoint produced)
 *
 * @throws Error if validation fails
 * @throws Error if checkpoint registration fails
 */
export function processTrainerResult(
  params: ProcessTrainerResultParams
): { checkpointId: string; checkpointRef: string } | null {
  const { spec, trainRunId, result, stateDir } = params;

  // --- Handle dry_run BEFORE validation (it has no checkpoint and should not be validated) ---
  if (result.status === 'dry_run') {
    // Dry-run: mark completed (no checkpoint expected) and return null.
    // This is a supported non-error outcome — upper layers distinguish it from
    // completed (which has a checkpoint) by checking the return value.
    startTrainingRun(stateDir, trainRunId);
    completeTrainingRun(stateDir, trainRunId);
    return null;
  }

  // --- Transition pending -> running first ---
  // Must happen before any validation or failure path so that
  // failTrainingRun has a valid transition (running → failed).
  startTrainingRun(stateDir, trainRunId);

  // --- Validate result against spec (fail-closed) ---
  const validation = validateTrainerResult(spec, result);
  if (!validation.valid) {
    const errorMessages = validation.errors
      .map((e) => `  - ${e.field}: ${e.reason} (expected: ${e.expected}, got: ${e.actual})`)
      .join('\n');

    // Fail the training run in registry (running → failed is valid)
    failTrainingRun(stateDir, trainRunId, `Validation failed:\n${errorMessages}`);

    throw new Error(
      `Trainer result validation failed (${validation.errors.length} errors):\n${errorMessages}\n` +
        `The trainer result does not match the experiment spec. ` +
        `This checkpoint will not be registered.`
    );
  }

  // --- Update training run status ---
  // Already transitioned to 'running' above

  if (result.status === 'failed') {
    failTrainingRun(stateDir, trainRunId, result.failureReason ?? 'Unknown failure');
    throw new Error(`Training failed: ${result.failureReason}`);
  }

  // result.status === 'completed' (or any other non-failed/dry_run) — proceed to checkpoint
  if (!result.checkpointId || !result.artifact) {
    // Mark run failed since it didn't produce a checkpoint (run is in 'running' state)
    failTrainingRun(stateDir, trainRunId, 'Trainer result is marked completed but missing checkpointId or artifact');
    throw new Error(
      `Trainer result is marked 'completed' but missing checkpointId or artifact.`
    );
  }

  // --- Register checkpoint BEFORE marking run completed ---
  // Ordering matters: if registerCheckpoint throws, run stays in 'running' state
  // (not 'completed'), making the failure visible in registry audits.
  const checkpoint = registerCheckpoint(stateDir, {
    trainRunId,
    targetModelFamily: spec.targetModelFamily,
    artifactPath: result.artifact.artifactPath,
  });

  // Checkpoint registered successfully — now mark run completed
  completeTrainingRun(stateDir, trainRunId);

  return {
    checkpointId: checkpoint.checkpointId,
    checkpointRef: result.checkpointRef ?? checkpoint.checkpointId,
  };
}

// ---------------------------------------------------------------------------
// Training Program Orchestration
// ---------------------------------------------------------------------------

/**
 * The TrainingProgram class orchestrates the complete training workflow.
 *
 * Usage:
 * ```typescript
 * const program = new TrainingProgram(stateDir);
 *
 * // Create experiment
 * const { spec, trainRunId } = program.createExperiment({
 *   backend: 'peft-trl-orpo',
 *   targetWorkerProfile: 'local-reader',
 *   targetModelFamily: 'qwen2.5-7b-reader',
 *   datasetExportId: 'export-123',
 *   datasetExportPath: '.state/exports/orpo/export-123.jsonl',
 *   datasetFingerprint: 'abc123',
 *   benchmarkExportId: 'benchmark-456',
 *   outputDir: '.state/nocturnal/checkpoints',
 * });
 *
 * // Execute trainer (external)
 * const trainerOutput = await executeTrainer(spec);
 *
 * // Process result
 * const { checkpointId } = program.processResult({
 *   spec,
 *   trainRunId,
 *   result: JSON.parse(trainerOutput),
 * });
 *
 * // Attach eval (after benchmark runs)
 * program.attachEval(checkpointId, evalSummary);
 * ```
 */
export class TrainingProgram {
   
  constructor(private readonly stateDir: string) {}
   

  /**
   * Create a new training experiment.
   */
  createExperiment(params: CreateExperimentParams): CreateExperimentResult {
    return createExperiment(this.stateDir, params);
  }

  /**
   * Process a trainer result and register the checkpoint.
   * Returns null for dry_run (no checkpoint produced).
   */
  processResult(params: {
    spec: TrainingExperimentSpec;
    trainRunId: string;
    result: TrainingExperimentResult;
  }): { checkpointId: string; checkpointRef: string } | null {
    return processTrainerResult({
      ...params,
      stateDir: this.stateDir,
    });
  }

  /**
   * Attach an eval summary to a checkpoint and mark it deployable if eval passes.
   *
   * @param checkpointId - The checkpoint to attach eval to
   * @param evalSummary - The eval summary (from benchmark run)
   * @returns The updated checkpoint
   */
  attachEvalAndMarkDeployable(
    checkpointId: string,
    evalSummary: {
      evalId: string;
      checkpointId: string;
      benchmarkId: string;
      targetModelFamily: string;
      mode: 'prompt_assisted' | 'reduced_prompt';
      baselineScore: number;
      candidateScore: number;
      delta: number;
      verdict: 'pass' | 'fail' | 'compare_only';
    }
  ): void {
    // Attach eval summary
    attachEvalSummary(this.stateDir, checkpointId, evalSummary);

    // Mark deployable if verdict is pass or compare_only
    if (evalSummary.verdict === 'pass' || evalSummary.verdict === 'compare_only') {
      markCheckpointDeployable(this.stateDir, checkpointId, true);
    }
  }

  /**
   * Get checkpoint lineage for audit.
   */
  getCheckpointLineage(checkpointId: string) {
    return getCheckpointLineage(this.stateDir, checkpointId);
  }
}
