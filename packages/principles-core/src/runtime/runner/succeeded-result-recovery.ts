/**
 * Durable recovery of an already-succeeded peer runner result.
 *
 * Recovery is evidence-based, never a synthetic success: the terminal task's
 * resultRef selects the authoritative run, the run must be the fenced
 * task_completed row, its output must re-pass the runner validator, and the
 * deterministic principle artifact must exist in the current artifact view.
 */
import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { PeerRunnerResult } from './peer-runner-types.js';
import type { RunRecord } from '../runtime-protocol.js';

export type SucceededRunnerRecovery<TOutput> =
  | { readonly outcome: 'recovered'; readonly result: PeerRunnerResult<TOutput> }
  | { readonly outcome: 'invalid'; readonly reason: string };

export interface RecoverSucceededResultInput<TOutput> {
  readonly task: TaskRecord;
  readonly expectedTaskKind: string;
  readonly resultRefPrefix: string;
  readonly stateManager: Pick<RuntimeStateManager, 'getRunsByTask'>;
  readonly artifactStore: Pick<PIArtifactStore, 'getArtifactById' | 'listBySourceTaskId'>;
  readonly validateOutput: (output: unknown, taskId: string) => Promise<{ valid: boolean; errors: readonly string[] }>;
  /**
   * Runner-specific validation for an authoritative output run that is not
   * itself the clean terminal row. Evaluator completion-intent recovery can
   * legitimately persist output on run N and write terminal success on a later
   * resume run N+1 while resultRef still selects run N. This hook must verify
   * that separate completion evidence; returning null means valid. When absent,
   * an incomplete authoritative run is always invalid.
   */
  readonly validateIncompleteAuthoritativeRun?: (input: {
    readonly task: TaskRecord;
    readonly authoritativeRun: RunRecord;
    readonly runs: readonly RunRecord[];
  }) => string | null;
  /** Additional persisted-evidence consistency rule. Return null when valid. */
  readonly verifyRecoveredEvidence?: (input: {
    readonly task: TaskRecord;
    readonly output: TOutput;
    readonly artifactOutput: TOutput;
    readonly runId: string;
  }) => string | null;
}

function invalid<TOutput>(reason: string): SucceededRunnerRecovery<TOutput> {
  return { outcome: 'invalid', reason };
}

function parseJsonObject(raw: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function terminalRunError(run: RunRecord): string | null {
  if (run.executionStatus !== 'succeeded') return `authoritative_run_not_succeeded:${run.executionStatus}`;
  if (run.reason !== 'task_completed') return `authoritative_run_not_terminal:${run.reason ?? 'missing_reason'}`;
  if (run.errorCategory !== undefined) return `authoritative_run_has_error:${run.errorCategory}`;
  return null;
}

/**
 * Recover the exact successful execution result bound to a terminal task.
 * Any absent or inconsistent evidence is fail-closed; callers must not treat
 * recovery failure as permission to execute the terminal task again.
 */
export async function recoverSucceededPeerRunnerResult<TOutput>(
  input: RecoverSucceededResultInput<TOutput>,
): Promise<SucceededRunnerRecovery<TOutput>> {
  const { task } = input;
  if (task.taskKind !== input.expectedTaskKind) {
    return invalid(`task_kind_mismatch:${task.taskKind}`);
  }
  if (task.status !== 'succeeded') {
    return invalid(`task_not_succeeded:${task.status}`);
  }
  if (task.leaseOwner !== null && task.leaseOwner !== undefined) {
    return invalid('terminal_task_still_leased');
  }
  const { resultRef } = task;
  if (typeof resultRef !== 'string' || !resultRef.startsWith(`${input.resultRefPrefix}://`)) {
    return invalid('result_ref_missing_or_prefix_mismatch');
  }
  const runId = resultRef.slice(input.resultRefPrefix.length + 3);
  if (runId.length === 0) return invalid('result_ref_run_id_empty');

  const runs = await input.stateManager.getRunsByTask(task.taskId);
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run) return invalid(`authoritative_run_missing:${runId}`);
  if (run.taskId !== task.taskId) return invalid('authoritative_run_task_mismatch');
  const authoritativeTerminalError = terminalRunError(run);
  if (authoritativeTerminalError !== null) {
    const completionEvidenceError = input.validateIncompleteAuthoritativeRun === undefined
      ? authoritativeTerminalError
      : input.validateIncompleteAuthoritativeRun({
        task,
        authoritativeRun: run,
        runs,
      });
    if (completionEvidenceError !== null) return invalid(completionEvidenceError);
  }
  if (typeof run.outputPayload !== 'string' || run.outputPayload.length === 0) {
    return invalid('successor_result_unavailable:output_payload_missing');
  }
  const parsedOutput = parseJsonObject(run.outputPayload);
  if (parsedOutput === null) return invalid('successor_result_unavailable:output_payload_unparseable');
  const outputValidation = await input.validateOutput(parsedOutput, task.taskId);
  if (!outputValidation.valid) {
    return invalid(`output_payload_validation_failed:${outputValidation.errors.join(';')}`);
  }
  const output = parsedOutput as TOutput;

  const artifactId = `pi-art-${task.taskId}-${runId}`;
  const artifact = await input.artifactStore.getArtifactById(artifactId);
  if (!artifact) return invalid(`principle_artifact_missing:${artifactId}`);
  if (artifact.artifactKind !== 'principle') return invalid(`artifact_kind_mismatch:${artifact.artifactKind}`);
  if (artifact.sourceTaskId !== task.taskId) return invalid('artifact_source_task_mismatch');
  const currentArtifacts = await input.artifactStore.listBySourceTaskId(task.taskId);
  if (!currentArtifacts.some((candidate) => candidate.artifactId === artifactId)) {
    return invalid('principle_artifact_not_in_current_revision_view');
  }
  const parsedArtifactOutput = parseJsonObject(artifact.contentJson);
  if (parsedArtifactOutput === null) return invalid('artifact_content_unparseable');
  const artifactValidation = await input.validateOutput(parsedArtifactOutput, task.taskId);
  if (!artifactValidation.valid) {
    return invalid(`artifact_content_validation_failed:${artifactValidation.errors.join(';')}`);
  }
  const artifactOutput = parsedArtifactOutput as TOutput;

  const consistencyError = input.verifyRecoveredEvidence?.({
    task,
    output,
    artifactOutput,
    runId,
  }) ?? null;
  if (consistencyError !== null) return invalid(consistencyError);

  return {
    outcome: 'recovered',
    result: {
      status: 'succeeded',
      taskId: task.taskId,
      runId,
      artifactId,
      resultRef,
      output,
      attemptCount: task.attemptCount,
    },
  };
}
