/**
 * CLI surface for diagnostician execution.
 *
 * Per D-02: Library function exports, no bin scripts, no CLI framework dependency.
 * External code (e.g., OpenClaw plugin) imports and calls these functions.
 *
 * Per D-03: status() returns TaskRecord key fields only (taskId, status, attemptCount, maxAttempts, lastError).
 * No Run history.
 */
import type { RuntimeStateManager, CandidateRecord } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { RunnerResult } from '../runner/runner-result.js';
import type { TaskRecord } from '../task-status.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import { StalledDiagnosticianTaskReadModel } from '../stalled-diagnostician-task-read-model.js';

/** Options for pd candidate list */
export interface CandidateListOptions {
  taskId: string;
  stateManager: RuntimeStateManager;
}

/** Result for pd candidate list */
export interface CandidateListResult {
  readonly taskId: string;
  readonly candidates: readonly CandidateRecord[];
}

/** Options for pd candidate show */
export interface CandidateShowOptions {
  candidateId: string;
  stateManager: RuntimeStateManager;
}

/** Result for pd candidate show */
export interface CandidateShowResult {
  readonly candidateId: string;
  readonly artifactId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly confidence: number | null;
  readonly sourceRunId: string;
  readonly status: 'pending' | 'consumed' | 'expired';
  readonly createdAt: string;
  readonly ledgerEntryId: string | null;
  /** F10-1: present when sourceRunId references a non-existent run (lineage corruption). */
  readonly warning?: string;
  readonly reason?: string;
  readonly nextAction?: string;
}

/** Options for pd artifact show */
export interface ArtifactShowOptions {
  artifactId: string;
  stateManager: RuntimeStateManager;
}

/** Result for pd artifact show */
export interface ArtifactShowResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly artifactKind: string;
  readonly contentJson: string;
  readonly createdAt: string;
  readonly candidates: readonly CandidateRecord[];
}

/** Options for the run() CLI function. */
export interface DiagnoseRunOptions {
  /** Task ID to execute diagnostician for. */
  taskId: string;
  /** Initialized RuntimeStateManager instance. */
  stateManager: RuntimeStateManager;
  /** DiagnosticianRunner instance (already configured with deps). */
  runner: DiagnosticianRunnerLike;
}

/** Options for the status() CLI function. */
export interface DiagnoseStatusOptions {
  /** Task ID to inspect. */
  taskId: string;
  /** Initialized RuntimeStateManager instance. */
  stateManager: RuntimeStateManager;
  /** Age threshold in seconds for classifying task as stalled (default: 300) */
  stalledThresholdSeconds?: number;
}

/** Structured status result per D-03, extended per CLIV-04 for commit/candidate info. */
export interface DiagnoseStatusResult {
  readonly taskId: string;
  readonly status: TaskRecord['status'];
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastError: TaskRecord['lastError'];
  /** Populated only when status is 'succeeded' — the committed commit ID */
  readonly commitId: string | null;
  /** Populated only when status is 'succeeded' — the committed artifact ID */
  readonly artifactId: string | null;
  /** Populated only when status is 'succeeded' — number of candidates registered */
  readonly candidateCount: number | null;
  // Extended fields for stalled tasks (PRI-377)
  readonly inputRef?: string | null;
  readonly age?: number | null;
  readonly reason?: string | null;
  readonly nextAction?: string | null;
}

/**
 * Execute the diagnostician runner for a task.
 *
 * Thin wrapper over DiagnosticianRunner.run().
 * Returns the raw RunnerResult for full visibility.
 */
export async function run(options: DiagnoseRunOptions): Promise<RunnerResult> {
  return options.runner.run(options.taskId);
}

/**
 * Inspect diagnostician task status.
 *
 * Per D-03: Returns key TaskRecord fields only.
 * Returns null if the task does not exist.
 */
export async function status(options: DiagnoseStatusOptions): Promise<DiagnoseStatusResult | null> {
  const task = await options.stateManager.getTask(options.taskId);
  if (!task) {
    return null;
  }

  // Per CLIV-04: populate commit fields only for succeeded tasks
  let commitId: string | null = null;
  let artifactId: string | null = null;
  let candidateCount: number | null = null;

  if (task.status === 'succeeded') {
    const commit = await options.stateManager.getCommitByTaskId(options.taskId);
    if (commit) {
      const { commitId: cid, artifactId: aid } = commit;
      commitId = cid;
      artifactId = aid;
      const candidates = await options.stateManager.getCandidatesByTaskId(options.taskId);
      candidateCount = candidates.length;
    }
  }

  // Check if task is stalled (PRI-377)
  const readModel = new StalledDiagnosticianTaskReadModel({ stateManager: options.stateManager });
  const stalledInfo = await readModel.checkStalledTask(options.taskId, options.stalledThresholdSeconds);

  return {
    taskId: task.taskId,
    status: task.status,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    lastError: task.lastError,
    commitId,
    artifactId,
    candidateCount,
    ...(stalledInfo ? {
      inputRef: stalledInfo.inputRef,
      age: stalledInfo.age,
      reason: stalledInfo.reason,
      nextAction: stalledInfo.nextAction,
    } : {}),
  };
}

/**
 * List principle candidates for a task.
 *
 * Per CLIV-01: pd candidate list --task-id <taskId>
 * Per D-05: joins through tasks→runs→commits→principle_candidates
 */
export async function candidateList(
  options: CandidateListOptions,
): Promise<CandidateListResult> {
  const candidates = await options.stateManager.getCandidatesByTaskId(options.taskId);
  return {
    taskId: options.taskId,
    candidates,
  };
}

/**
 * Show detail for a single candidate.
 *
 * Per CLIV-02: pd candidate show <candidateId>
 * Returns title, description, confidence, source (runId), status
 * Returns null if candidate not found.
 */
export async function candidateShow(
  options: CandidateShowOptions & { ledgerAdapter?: LedgerAdapter },
): Promise<CandidateShowResult | null> {
  const candidate = await options.stateManager.getCandidate(options.candidateId);
  if (!candidate) {
    return null;
  }

  let ledgerEntryId: string | null = null;
  if (options.ledgerAdapter) {
    const entry = options.ledgerAdapter.existsForCandidate(options.candidateId);
    if (entry) {
      ledgerEntryId = entry.id;
    }
  }

  // F10-1: Validate source_run_id → runs.run_id reference. A dangling
  // sourceRunId means the lineage chain is broken — the candidate's origin
  // cannot be traced. Emit warning + reason + nextAction instead of silently
  // returning corrupted data (rc-9-no-silent-fallback, rc-6-lineage-
  // consistency; related ERR: ERR-002).
  let warning: string | undefined;
  let reason: string | undefined;
  let nextAction: string | undefined;
  try {
    const runRecord = await options.stateManager.getRun(candidate.sourceRunId);
    if (!runRecord) {
      warning = `source_run_id "${candidate.sourceRunId}" does not exist in runs table — lineage is broken`;
      reason = `dangling_source_run_id: ${candidate.sourceRunId}`;
      nextAction = 'Run `pd runtime internalization integrity` for full chain diagnostics. Investigate run deletion or data corruption.';
    }
  } catch {
    // Treat lookup failure as dangling — fail loud rather than silent (rc-9).
    warning = `source_run_id "${candidate.sourceRunId}" could not be verified (run lookup failed) — lineage may be broken`;
    reason = `source_run_id_lookup_failed: ${candidate.sourceRunId}`;
    nextAction = 'Run `pd runtime internalization integrity` for full chain diagnostics. Check database integrity.';
  }

  return {
    candidateId: candidate.candidateId,
    artifactId: candidate.artifactId,
    taskId: candidate.taskId,
    title: candidate.title,
    description: candidate.description,
    confidence: candidate.confidence,
    sourceRunId: candidate.sourceRunId,
    status: candidate.status,
    createdAt: candidate.createdAt,
    ledgerEntryId,
    ...(warning ? { warning } : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

/**
 * Show artifact content and its associated candidates.
 *
 * Per CLIV-03: pd artifact show <artifactId>
 * Per D-06: single query with JOIN, returns artifact + inline candidates array
 * Returns null if artifact not found.
 */
export async function artifactShow(
  options: ArtifactShowOptions,
): Promise<ArtifactShowResult | null> {
  const result = await options.stateManager.getArtifactWithCandidates(options.artifactId);
  if (!result) {
    return null;
  }
  return {
    artifactId: result.artifact.artifactId,
    runId: result.artifact.runId,
    taskId: result.artifact.taskId,
    artifactKind: result.artifact.artifactKind,
    contentJson: result.artifact.contentJson,
    createdAt: result.artifact.createdAt,
    candidates: result.candidates,
  };
}
