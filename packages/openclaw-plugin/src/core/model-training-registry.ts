/**
 * Model Training Registry — Training Run, Checkpoint, and Eval Summary Lineage
 * =============================================================================
 *
 * PURPOSE: Establish strict auditable lineage from training run → checkpoint → eval
 * so that "deployable" is a controlled state, not a free-text field.
 *
 * ARCHITECTURE:
 *   - Registry file: {stateDir}/.state/nocturnal/training-registry.json
 *   - Three record types in one store: TrainingRun, Checkpoint, EvalSummary
 *   - File locking on all write operations
 *   - Family alignment enforced at every transition
 *
 * LINEAGE CHAIN (enforced):
 *   TrainingRun → Checkpoint → EvalSummary
 *   DatasetFingerprint → TrainingRun → Checkpoint → EvalSummary
 *
 * DEPLOYABILITY RULE:
 *   A Checkpoint can only be marked deployable if:
 *     1. It has an attached EvalSummary
 *     2. The EvalSummary has a verdict of 'pass' or 'compare_only' (not 'fail')
 *     3. The EvalSummary's targetModelFamily matches the Checkpoint's targetModelFamily
 *     4. The Checkpoint's trainRun is in 'completed' status
 *
 * DESIGN CONSTRAINTS:
 *   - No real training invocation (Phase 4 only)
 *   - No checkpoint deploy routing (Phase 5)
 *   - No automatic promotion
 *   - Registry is append-only for runs and checkpoints
 *   - EvalSummary attachment is the only mutable operation on a Checkpoint
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FILE = '.state/nocturnal/training-registry.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Training run status — lifecycle enforced transitions.
 */
export type TrainingRunStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A training run record — tracks one training job.
 */
export interface TrainingRun {
  /** Unique identifier for this training run */
  trainRunId: string;

  /**
   * Experiment ID this run belongs to.
   * Enables lookup by experimentId in addition to trainRunId.
   */
  experimentId: string;

  /** Target model family this run produces checkpoints for */
  targetModelFamily: string;

  /**
   * Fingerprint of the dataset used for this run.
   * Links back to the ORPO export's datasetFingerprint.
   */
  datasetFingerprint: string;

  /**
   * Reference to the ORPO export that provided the training data.
   * Format: {exportId}
   */
  exportId: string;

  /** Number of samples from the export used in this run */
  sampleCount: number;

  /**
   * Fingerprint of the training configuration used.
   * For Phase 4 this is a placeholder (e.g., 'default-v0.1.0').
   * Future: references an actual config artifact.
   */
  configFingerprint: string;

  /** ISO-8601 creation timestamp */
  createdAt: string;

  /** ISO-8601 completion timestamp (set when status becomes completed/failed) */
  completedAt?: string;

  /** Current status */
  status: TrainingRunStatus;

  /** Human-readable reason for failure (if status === 'failed') */
  failureReason?: string;

  /**
   * Checkpoint IDs produced by this run.
   * A run may produce multiple checkpoints (e.g., epoch saves).
   */
  checkpointIds: string[];
}

/**
 * A checkpoint record — a deployable artifact from a training run.
 */
export interface Checkpoint {
  /** Unique identifier for this checkpoint */
  checkpointId: string;

  /** The training run that produced this checkpoint */
  trainRunId: string;

  /** Target model family (must match the TrainingRun's targetModelFamily) */
  targetModelFamily: string;

  /**
   * Path to the checkpoint artifact.
   * In Phase 4 this is a placeholder path.
   * Future: path to adapter weights, config, etc.
   */
  artifactPath: string;

  /** ISO-8601 creation timestamp */
  createdAt: string;

  /**
   * Whether this checkpoint can be routed to a worker.
   * MUST be false until an EvalSummary is attached with verdict 'pass' or 'compare_only'.
   * Cannot be set back to true after false without a new passing eval.
   */
  deployable: boolean;

  /**
   * Reference to the attached EvalSummary (evalId).
   * Required for deployable === true.
   */
  lastEvalSummaryRef?: string;
}

/**
 * An eval summary record — result of benchmarking a checkpoint.
 */
export interface EvalSummary {
  /** Unique identifier for this eval */
  evalId: string;

  /** The checkpoint this eval was run against */
  checkpointId: string;

  /** The benchmark run this eval came from */
  benchmarkId: string;

  /**
   * Target model family — MUST match the checkpoint's targetModelFamily.
   * Enforced at attachEvalSummary() time.
   * This field prevents a gpt-4 checkpoint from being validated by a claude-3 eval.
   */
  targetModelFamily: string;

  /** Evaluation mode: prompt-assisted or reduced-prompt */
  mode: 'prompt_assisted' | 'reduced_prompt';

  /** Baseline score from the benchmark (mean score of baseline checkpoint) */
  baselineScore: number;

  /** Candidate score from the benchmark (mean score of this checkpoint) */
  candidateScore: number;

  /** delta = candidateScore - baselineScore */
  delta: number;

  /** Verdict from the benchmark: pass | fail | compare_only */
  verdict: 'pass' | 'fail' | 'compare_only';

  /** ISO-8601 creation timestamp */
  createdAt: string;
}

/**
 * The complete training registry — all record types in one store.
 */
export interface ModelTrainingRegistry {
  trainingRuns: TrainingRun[];
  checkpoints: Checkpoint[];
  evalSummaries: EvalSummary[];
}

// ---------------------------------------------------------------------------
// Registry Path
// ---------------------------------------------------------------------------

function getRegistryPath(stateDir: string): string {
  return path.join(stateDir, REGISTRY_FILE);
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(stateDir: string): void {
  const registryPath = getRegistryPath(stateDir);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

/**
 * Read the registry from disk. Returns empty registry if missing.
 */
function readRegistry(stateDir: string): ModelTrainingRegistry {
  const registryPath = getRegistryPath(stateDir);
  if (!fs.existsSync(registryPath)) {
    return { trainingRuns: [], checkpoints: [], evalSummaries: [] };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as ModelTrainingRegistry;
  } catch (err) {
    console.warn(`[model-training-registry] Registry corrupted at ${registryPath}, recovering with empty state: ${String(err)}`);
    return { trainingRuns: [], checkpoints: [], evalSummaries: [] };
  }
}

/**
 * Write the registry to disk atomically.
 * Caller must hold the registry lock.
 */
function writeRegistry(stateDir: string, registry: ModelTrainingRegistry): void {
  ensureRegistryDir(stateDir);
  const registryPath = getRegistryPath(stateDir);
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Execute a read-modify-write under an exclusive file lock.
 */
function withRegistryLock<T>(
  stateDir: string,
  // eslint-disable-next-line no-unused-vars -- parameter type annotation requires name
  fn: (_: ModelTrainingRegistry) => T
): T {
  const registryPath = getRegistryPath(stateDir);
  return withLock(registryPath, () => {
    const registry = readRegistry(stateDir);
    return fn(registry);
  });
}

// ---------------------------------------------------------------------------
// Training Run Operations
// ---------------------------------------------------------------------------

/**
 * Valid training run status transitions.
 * pending → running → completed | failed
 * (no backward transitions)
 */
const VALID_RUN_TRANSITIONS: Record<TrainingRunStatus, TrainingRunStatus[]> = {
  pending: ['running'],
  running: ['completed', 'failed'],
  completed: [],  // terminal
  failed: [],     // terminal
};

/**
 * Register a new training run.
 *
 * @param stateDir - Workspace state directory
 * @param params - Run parameters
 * @returns The registered TrainingRun
 */
export function registerTrainingRun(
  stateDir: string,
  params: {
    experimentId: string;
    targetModelFamily: string;
    datasetFingerprint: string;
    exportId: string;
    sampleCount: number;
    configFingerprint: string;
  }
): TrainingRun {
  return withRegistryLock(stateDir, (registry) => {
    const now = new Date().toISOString();
    const trainRunId = crypto.randomUUID();

    const run: TrainingRun = {
      trainRunId,
      experimentId: params.experimentId,
      targetModelFamily: params.targetModelFamily,
      datasetFingerprint: params.datasetFingerprint,
      exportId: params.exportId,
      sampleCount: params.sampleCount,
      configFingerprint: params.configFingerprint,
      createdAt: now,
      status: 'pending',
      checkpointIds: [],
    };

    registry.trainingRuns.push(run);
    writeRegistry(stateDir, registry);
    return run;
  });
}

/**
 * Update a training run's status.
 *
 * @throws Error if run not found or transition is invalid
 */
// eslint-disable-next-line @typescript-eslint/max-params -- Reason: status update requires state + runId + status - refactoring would break API
export function updateTrainingRunStatus(
  stateDir: string,
  trainRunId: string,
  newStatus: TrainingRunStatus,
  failureReason?: string
): TrainingRun {
  return withRegistryLock(stateDir, (registry) => {
    const idx = registry.trainingRuns.findIndex((r) => r.trainRunId === trainRunId);
    if (idx === -1) {
      throw new Error(`Training run not found: ${trainRunId}`);
    }

    const run = registry.trainingRuns[idx];
    const allowed = VALID_RUN_TRANSITIONS[run.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition for training run ${trainRunId}: ${run.status} → ${newStatus}. ` +
          `Allowed transitions from ${run.status}: ${allowed.join(', ') || 'none'}`
      );
    }

    registry.trainingRuns[idx] = {
      ...run,
      status: newStatus,
      completedAt: newStatus === 'completed' || newStatus === 'failed'
        ? new Date().toISOString()
        : undefined,
      failureReason: newStatus === 'failed' ? failureReason : undefined,
    };

    writeRegistry(stateDir, registry);
    return registry.trainingRuns[idx];
  });
}

/**
 * Complete a training run (convenience wrapper).
 */
export function completeTrainingRun(stateDir: string, trainRunId: string): TrainingRun {
  return updateTrainingRunStatus(stateDir, trainRunId, 'completed');
}

/**
 * Fail a training run (convenience wrapper).
 */
export function failTrainingRun(
  stateDir: string,
  trainRunId: string,
  reason: string
): TrainingRun {
  return updateTrainingRunStatus(stateDir, trainRunId, 'failed', reason);
}

/**
 * Start a training run (convenience wrapper).
 */
export function startTrainingRun(stateDir: string, trainRunId: string): TrainingRun {
  return updateTrainingRunStatus(stateDir, trainRunId, 'running');
}

/**
 * Get a training run by ID.
 */
export function getTrainingRun(
  stateDir: string,
  trainRunId: string
): TrainingRun | null {
  const registry = readRegistry(stateDir);
  return registry.trainingRuns.find((r) => r.trainRunId === trainRunId) ?? null;
}

/**
 * List all training runs, optionally filtered by status or family.
 */
export function listTrainingRuns(
  stateDir: string,
  filter?: {
    status?: TrainingRunStatus;
    targetModelFamily?: string;
  }
): TrainingRun[] {
  const registry = readRegistry(stateDir);
  let runs = registry.trainingRuns;

  if (filter?.status) {
    runs = runs.filter((r) => r.status === filter.status);
  }
  if (filter?.targetModelFamily) {
    runs = runs.filter((r) => r.targetModelFamily === filter.targetModelFamily);
  }

  return runs.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

// ---------------------------------------------------------------------------
// Checkpoint Operations
// ---------------------------------------------------------------------------

/**
 * Register a checkpoint produced by a training run.
 *
 * @throws Error if the training run is not found
 * @throws Error if the targetModelFamily does not match the run's family
 */
export function registerCheckpoint(
  stateDir: string,
  params: {
    trainRunId: string;
    targetModelFamily: string;
    artifactPath: string;
  }
): Checkpoint {
  return withRegistryLock(stateDir, (registry) => {
    // Verify the training run exists
    const run = registry.trainingRuns.find((r) => r.trainRunId === params.trainRunId);
    if (!run) {
      throw new Error(`Training run not found: ${params.trainRunId}`);
    }

    // Verify family alignment
    if (run.targetModelFamily !== params.targetModelFamily) {
      throw new Error(
        `Target model family mismatch: checkpoint family "${params.targetModelFamily}" ` +
          `does not match training run family "${run.targetModelFamily}"`
      );
    }

    const now = new Date().toISOString();
    const checkpointId = crypto.randomUUID();

    const checkpoint: Checkpoint = {
      checkpointId,
      trainRunId: params.trainRunId,
      targetModelFamily: params.targetModelFamily,
      artifactPath: params.artifactPath,
      createdAt: now,
      deployable: false, // Always starts as false
    };

    registry.checkpoints.push(checkpoint);

    // Update the training run's checkpoint IDs
    const runIdx = registry.trainingRuns.findIndex((r) => r.trainRunId === params.trainRunId);
    registry.trainingRuns[runIdx] = {
      ...run,
      checkpointIds: [...run.checkpointIds, checkpointId],
    };

    writeRegistry(stateDir, registry);
    return checkpoint;
  });
}

/**
 * Get a checkpoint by ID.
 */
export function getCheckpoint(
  stateDir: string,
  checkpointId: string
): Checkpoint | null {
  const registry = readRegistry(stateDir);
  return registry.checkpoints.find((c) => c.checkpointId === checkpointId) ?? null;
}

/**
 * List all checkpoints, optionally filtered.
 */
export function listCheckpoints(
  stateDir: string,
  filter?: {
    trainRunId?: string;
    targetModelFamily?: string;
    deployable?: boolean;
  }
): Checkpoint[] {
  const registry = readRegistry(stateDir);
  let {checkpoints} = registry;

  if (filter?.trainRunId) {
    checkpoints = checkpoints.filter((c) => c.trainRunId === filter.trainRunId);
  }
  if (filter?.targetModelFamily) {
    checkpoints = checkpoints.filter((c) => c.targetModelFamily === filter.targetModelFamily);
  }
  if (filter?.deployable !== undefined) {
    checkpoints = checkpoints.filter((c) => c.deployable === filter.deployable);
  }

  return checkpoints.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * List all deployable checkpoints for a target model family.
 */
export function listDeployableCheckpoints(
  stateDir: string,
  targetModelFamily: string
): Checkpoint[] {
  return listCheckpoints(stateDir, {
    targetModelFamily,
    deployable: true,
  });
}

// ---------------------------------------------------------------------------
// Eval Summary Operations
// ---------------------------------------------------------------------------

/**
 * Attach an eval summary to a checkpoint.
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - The checkpoint to attach to
 * @param summary - The eval summary to attach
 *
 * @throws Error if checkpoint not found
 * @throws Error if targetModelFamily mismatch between summary and checkpoint
 */
export function attachEvalSummary(
  stateDir: string,
  checkpointId: string,
  summary: Omit<EvalSummary, 'createdAt'>
): EvalSummary {
  return withRegistryLock(stateDir, (registry) => {
    const checkpointIdx = registry.checkpoints.findIndex(
      (c) => c.checkpointId === checkpointId
    );
    if (checkpointIdx === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const checkpoint = registry.checkpoints[checkpointIdx];

    // FAMILY ALIGNMENT — enforced fail-closed:
    // An eval for a gpt-4 checkpoint cannot be attached to a claude-3 checkpoint
    // (and vice versa), even if the eval verdict is 'pass'.
    if (summary.targetModelFamily !== checkpoint.targetModelFamily) {
      throw new Error(
        `Family mismatch: eval targets "${summary.targetModelFamily}" ` +
          `but checkpoint "${checkpointId}" is "${checkpoint.targetModelFamily}". ` +
          `EvalSummary.targetModelFamily must match the checkpoint's targetModelFamily.`
      );
    }

    const evalSummary: EvalSummary = {
      ...summary,
      createdAt: new Date().toISOString(),
    };

    registry.evalSummaries.push(evalSummary);

    // Update the checkpoint's lastEvalSummaryRef
    registry.checkpoints[checkpointIdx] = {
      ...checkpoint,
      lastEvalSummaryRef: evalSummary.evalId,
    };

    writeRegistry(stateDir, registry);
    return evalSummary;
  });
}

/**
 * Get an eval summary by ID.
 */
export function getEvalSummary(
  stateDir: string,
  evalId: string
): EvalSummary | null {
  const registry = readRegistry(stateDir);
  return registry.evalSummaries.find((e) => e.evalId === evalId) ?? null;
}

/**
 * List eval summaries, optionally filtered.
 */
export function listEvalSummaries(
  stateDir: string,
  filter?: {
    checkpointId?: string;
    benchmarkId?: string;
    verdict?: EvalSummary['verdict'];
    targetModelFamily?: string;
  }
): EvalSummary[] {
  const registry = readRegistry(stateDir);
  let evals = registry.evalSummaries;

  if (filter?.checkpointId) {
    evals = evals.filter((e) => e.checkpointId === filter.checkpointId);
  }
  if (filter?.benchmarkId) {
    evals = evals.filter((e) => e.benchmarkId === filter.benchmarkId);
  }
  if (filter?.verdict) {
    evals = evals.filter((e) => e.verdict === filter.verdict);
  }
  if (filter?.targetModelFamily) {
    evals = evals.filter((e) => e.targetModelFamily === filter.targetModelFamily);
  }

  return evals.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

// ---------------------------------------------------------------------------
// Deployability — Core Gating Logic
// ---------------------------------------------------------------------------

/**
 * MARK the deployability status of a checkpoint.
 *
 * DEPLOYABILITY RULE (fail-closed):
 *   A checkpoint can only be marked deployable if ALL of:
 *     1. It has an attached EvalSummary (lastEvalSummaryRef is set)
 *     2. The attached EvalSummary has verdict 'pass' or 'compare_only' (not 'fail')
 *     3. The EvalSummary's targetModelFamily matches the Checkpoint's targetModelFamily
 *        NOTE: This is enforced at attachEvalSummary() time (see attachEvalSummary).
 *        If a mismatched-family eval is attached, attachEvalSummary throws before
 *        the registry is modified, so no eval with wrong family can ever reach here.
 *     4. The parent TrainingRun is in 'completed' status
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - The checkpoint to mark
 * @param deployable - true to mark as deployable; false to revoke
 *
 * @throws Error if checkpoint not found
 * @throws Error if preconditions for deployable=true are not met
 */
export function markCheckpointDeployable(
  stateDir: string,
  checkpointId: string,
  deployable: boolean
): Checkpoint {
  return withRegistryLock(stateDir, (registry) => {
    const idx = registry.checkpoints.findIndex((c) => c.checkpointId === checkpointId);
    if (idx === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const checkpoint = registry.checkpoints[idx];

    if (deployable) {
      // FAIL-CLOSED: Verify all preconditions

      // 1. Must have an attached eval summary
      if (!checkpoint.lastEvalSummaryRef) {
        throw new Error(
          `Cannot mark checkpoint ${checkpointId} as deployable: ` +
            `no eval summary attached. Attach an EvalSummary first.`
        );
      }

      // 2. Find the eval summary
      const evalSummary = registry.evalSummaries.find(
        (e) => e.evalId === checkpoint.lastEvalSummaryRef
      );
      if (!evalSummary) {
        throw new Error(
          `Cannot mark checkpoint ${checkpointId} as deployable: ` +
            `eval summary "${checkpoint.lastEvalSummaryRef}" not found`
        );
      }

      // 3. Verdict must be 'pass' or 'compare_only' (not 'fail')
      if (evalSummary.verdict === 'fail') {
        throw new Error(
          `Cannot mark checkpoint ${checkpointId} as deployable: ` +
            `eval verdict is '${evalSummary.verdict}' (evalId: ${evalSummary.evalId}). ` +
            `Only 'pass' or 'compare_only' verdicts allow deployment.`
        );
      }

      // 4. Parent training run must be completed
      const run = registry.trainingRuns.find((r) => r.trainRunId === checkpoint.trainRunId);
      if (!run) {
        throw new Error(
          `Cannot mark checkpoint ${checkpointId} as deployable: ` +
            `parent training run "${checkpoint.trainRunId}" not found`
        );
      }
      if (run.status !== 'completed') {
        throw new Error(
          `Cannot mark checkpoint ${checkpointId} as deployable: ` +
            `parent training run is in '${run.status}' status (must be 'completed')`
        );
      }
    }

    // Apply the update (both marking deployable and revoking deployability)
    registry.checkpoints[idx] = {
      ...checkpoint,
      deployable,
      // If revoking deployability, also clear the eval ref
      lastEvalSummaryRef: deployable ? checkpoint.lastEvalSummaryRef : undefined,
    };

    writeRegistry(stateDir, registry);
    return registry.checkpoints[idx];
  });
}

/**
 * Convenience: check if a checkpoint is deployable.
 */
export function isCheckpointDeployable(
  stateDir: string,
  checkpointId: string
): boolean {
  const checkpoint = getCheckpoint(stateDir, checkpointId);
  return checkpoint?.deployable ?? false;
}

// ---------------------------------------------------------------------------
// Registry-Level Queries
// ---------------------------------------------------------------------------

/**
 * Get the full lineage chain for a checkpoint.
 * Returns: { run, checkpoint, eval? } or null if not found.
 */
export function getCheckpointLineage(
  stateDir: string,
  checkpointId: string
): {
  run: TrainingRun;
  checkpoint: Checkpoint;
  eval: EvalSummary | null;
} | null {
  const registry = readRegistry(stateDir);
  const checkpoint = registry.checkpoints.find((c) => c.checkpointId === checkpointId);
  if (!checkpoint) return null;

  const run = registry.trainingRuns.find((r) => r.trainRunId === checkpoint.trainRunId);
  if (!run) return null;

  const eval_ = checkpoint.lastEvalSummaryRef
    ? registry.evalSummaries.find((e) => e.evalId === checkpoint.lastEvalSummaryRef) ?? null
    : null;

  return { run, checkpoint, eval: eval_ ?? null };
}

/**
 * Get the complete registry (for debugging/admin purposes).
 */
export function getFullRegistry(stateDir: string): ModelTrainingRegistry {
  return readRegistry(stateDir);
}

/**
 * Compute stats for the training registry.
 */
export function getTrainingRegistryStats(
  stateDir: string
): {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  pendingRuns: number;
  runningRuns: number;
  totalCheckpoints: number;
  deployableCheckpoints: number;
  totalEvals: number;
  passingEvals: number;
  failingEvals: number;
} {
  const registry = readRegistry(stateDir);

  const runs = registry.trainingRuns;
  const {checkpoints} = registry;
  const evals = registry.evalSummaries;

  return {
    totalRuns: runs.length,
    completedRuns: runs.filter((r) => r.status === 'completed').length,
    failedRuns: runs.filter((r) => r.status === 'failed').length,
    pendingRuns: runs.filter((r) => r.status === 'pending').length,
    runningRuns: runs.filter((r) => r.status === 'running').length,
    totalCheckpoints: checkpoints.length,
    deployableCheckpoints: checkpoints.filter((c) => c.deployable).length,
    totalEvals: evals.length,
    passingEvals: evals.filter((e) => e.verdict === 'pass' || e.verdict === 'compare_only').length,
    failingEvals: evals.filter((e) => e.verdict === 'fail').length,
  };
}
