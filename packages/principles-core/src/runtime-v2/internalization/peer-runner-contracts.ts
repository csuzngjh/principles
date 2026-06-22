/**
 * Internalization Engine Peer Runner Contracts (PRI-61)
 *
 * Defines type-level contracts, interfaces, and pure validators for the
 * Internalization Engine's Peer Runner system. Follows ADR-0003 architecture.
 *
 * Key constraints:
 *   - PITaskRecord extends TaskRecord (no second task model)
 *   - Peer runners invoke LLM via PDRuntimeAdapter only (no direct API calls)
 *   - Peer runners do NOT directly chain to next runner (must enqueue via state manager)
 *   - Terminal task states: succeeded and failed only (retry_wait is NOT terminal)
 *   - resultRef is immutable only after status transitions to succeeded
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { TaskRecord } from '../task-status.js';

// ── Internalization Channel Types ─────────────────────────────────────────────

/**
 * The 4 channels through which principle internalization can occur.
 *
 * @see ADR-0003 Section 3.2
 */
export type InternalizationChannel =
  | 'prompt'
  | 'skill'
  | 'code_tool_hook'
  | 'defer_archive';

/**
 * The 6 peer runner kinds in the Internalization Engine.
 * All runners are peers — no main/sub hierarchy.
 *
 * @see ADR-0003 Section 3.3
 */
export type PeerRunnerKind =
  | 'dreamer'
  | 'philosopher'
  | 'scribe'
  | 'artificer'
  | 'evaluator'
  | 'rollout_reviewer';

/**
 * The 3 diagnostician stage kinds for the split pipeline.
 * These are NOT PeerRunnerKinds — they belong to a separate execution pipeline.
 *
 * @see 02-review-response-and-amendments.md §2.3
 */
export type DiagnosticianStageKind =
  | 'diag_rootcause'
  | 'diag_distiller'
  | 'diag_router';

/**
 * Broad execution-kind union — used by orchestrator for task dispatch.
 * Preserves the "6 peer runners" invariant: PeerRunnerKind and
 * DiagnosticianStageKind are disjoint sets.
 */
export type RunnerKind = PeerRunnerKind | DiagnosticianStageKind;

// ── Artifact Types ────────────────────────────────────────────────────────────

/**
 * The kinds of artifacts produced by the Internalization Engine.
 */
export type PIArtifactKind =
  | 'principle'
  | 'rule'
  | 'skill'
  | 'patch';

/**
 * Validation status of an artifact.
 */
export type PIArtifactValidationStatus =
  | 'pending'
  | 'validated'
  | 'rejected';

/**
 * Reference to an artifact. Semantically equivalent to RuntimeArtifactRef
 * but used in internalization context for clarity.
 */
export interface ArtifactRef {
  artifactType: string;
  ref: string;
}

/**
 * Describes lineage relationship between artifacts.
 */
export interface LineageRef {
  targetArtifactId: string;
  relation: 'parent' | 'derived_from' | 'validated_by';
}

/**
 * An artifact produced by the Internalization Engine.
 *
 * @see ADR-0003 Section 3.6
 */
export interface PIArtifact {
  artifactId: string;
  artifactKind: PIArtifactKind;
  sourceTaskId: string;
  sourcePrincipleId?: string;
  sourceRuleId?: string;
  lineageRefs: LineageRef[];
  validationStatus: PIArtifactValidationStatus;
}

// ── PITaskRecord ──────────────────────────────────────────────────────────────

/**
 * Internalization task record that extends TaskRecord with internalization metadata.
 *
 * Critical rules:
 *   - taskKind MUST be a valid RunnerKind (PeerRunnerKind or DiagnosticianStageKind)
 *   - status uses PDTaskStatus (pending | leased | succeeded | retry_wait | failed)
 *   - running is NOT a PDTaskStatus — it belongs to RunExecutionStatus
 *   - Terminal task states: succeeded and failed only
 *   - resultRef is immutable once task enters succeeded
 *   - lastError can be updated during retry_wait and failed transitions
 *
 * @see ADR-0003 Section 3.4
 */
export interface PITaskRecord extends TaskRecord {
  taskKind: RunnerKind;
  parentTaskId?: string;
  dependencyTaskIds: string[];
  channel: InternalizationChannel;
  correlationId?: string;
  timeoutMs: number;
  inputArtifactRefs: ArtifactRef[];
  outputArtifactRefs: ArtifactRef[];
  rejectionCount: number;
  /** Prior adversarial replay failures (PRI-428); present only on Round-2+ tasks. */
  adversarialFeedback?: string;
}

// ── Type Guards ───────────────────────────────────────────────────────────────

/**
 * All valid peer runner kinds. Useful for validation and iteration.
 */
export const PEER_RUNNER_KINDS: readonly PeerRunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rollout_reviewer',
] as const;

/**
 * All valid diagnostician stage kinds.
 */
export const DIAGNOSTICIAN_STAGE_KINDS: readonly DiagnosticianStageKind[] = [
  'diag_rootcause',
  'diag_distiller',
  'diag_router',
] as const;

/**
 * All valid internalization channels.
 */
export const INTERNALIZATION_CHANNELS: readonly InternalizationChannel[] = [
  'prompt',
  'skill',
  'code_tool_hook',
  'defer_archive',
] as const;

/**
 * All valid artifact kinds.
 */
export const PI_ARTIFACT_KINDS: readonly PIArtifactKind[] = [
  'principle',
  'rule',
  'skill',
  'patch',
] as const;

/**
 * Type guard for PeerRunnerKind.
 */
export function isPeerRunnerKind(value: string): value is PeerRunnerKind {
  return PEER_RUNNER_KINDS.includes(value as PeerRunnerKind);
}

/**
 * Type guard for DiagnosticianStageKind.
 */
export function isDiagnosticianStageKind(value: string): value is DiagnosticianStageKind {
  return DIAGNOSTICIAN_STAGE_KINDS.includes(value as DiagnosticianStageKind);
}

/**
 * Type guard for RunnerKind (either PeerRunnerKind or DiagnosticianStageKind).
 */
export function isRunnerKind(value: string): value is RunnerKind {
  return isPeerRunnerKind(value) || isDiagnosticianStageKind(value);
}

/**
 * Type guard for InternalizationChannel.
 */
export function isInternalizationChannel(value: string): value is InternalizationChannel {
  return INTERNALIZATION_CHANNELS.includes(value as InternalizationChannel);
}

/**
 * Type guard for PIArtifactKind.
 */
export function isPIArtifactKind(value: string): value is PIArtifactKind {
  return PI_ARTIFACT_KINDS.includes(value as PIArtifactKind);
}

/**
 * Checks if a task status is terminal (succeeded or failed).
 *
 * Note: retry_wait is NOT a terminal state — tasks can recover from retry_wait.
 */
export function isTerminalTaskStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed';
}

/**
 * Runtime type guard for PITaskRecord.
 *
 * Checks that a TaskRecord has all required internalization fields.
 * This is a structural check — the record must have:
 *   - taskKind in the set of valid RunnerKind values (PeerRunnerKind or DiagnosticianStageKind)
 *   - dependencyTaskIds as array
 *   - channel as string (valid InternalizationChannel)
 *   - timeoutMs as number
 *   - inputArtifactRefs as array
 *   - outputArtifactRefs as array
 *   - rejectionCount as finite non-negative number (PRI-141)
 */
export function isValidPITaskRecord(record: TaskRecord): record is PITaskRecord {
  // Must have a valid runner kind (PeerRunnerKind or DiagnosticianStageKind)
  if (!isRunnerKind(record.taskKind)) {
    return false;
  }

  const dependencyTaskIds = Reflect.get(record, 'dependencyTaskIds');
  const channel = Reflect.get(record, 'channel');
  const timeoutMs = Reflect.get(record, 'timeoutMs');
  const inputArtifactRefs = Reflect.get(record, 'inputArtifactRefs');
  const outputArtifactRefs = Reflect.get(record, 'outputArtifactRefs');
  const rejectionCount = Reflect.get(record, 'rejectionCount');
  const adversarialFeedback = Reflect.get(record, 'adversarialFeedback');

  return (
    Array.isArray(dependencyTaskIds) &&
    typeof channel === 'string' &&
    isInternalizationChannel(channel) &&
    typeof timeoutMs === 'number' &&
    Array.isArray(inputArtifactRefs) &&
    Array.isArray(outputArtifactRefs) &&
    typeof rejectionCount === 'number' &&
    Number.isFinite(rejectionCount) &&
    rejectionCount >= 0 &&
    (!Object.hasOwn(record, 'adversarialFeedback') ||
      adversarialFeedback === undefined ||
      (typeof adversarialFeedback === 'string' && adversarialFeedback.trim() !== ''))
  );
}

/**
 * Re-inject a runner-owned lineage field into LLM output when absent.
 *
 * Uses `Object.hasOwn` (ERR-013) so that present-but-falsy values
 * (`''`, `0`, `false`, `null`) are never overwritten — they must reach
 * the validator and fail loud (Runtime Contract Rule 3).
 *
 * Only fills when the property is truly absent from the object's own keys.
 *
 * @param output   The parsed LLM output (untrusted — may be any shape).
 * @param key      The lineage field to inject (e.g. 'taskId').
 * @param value    The runner-owned value to inject.
 */
export function injectRunnerLineageIfAbsent(
  output: unknown,
  key: string,
  value: string,
): void {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (!Object.hasOwn(record, key)) {
      record[key] = value;
    }
  }
}

/**
 * Creates a minimal PITaskRecord for testing purposes.
 * Not for production use — real tasks should be created via RuntimeStateManager.
 */
export function createMinimalPITaskRecord(
  taskId: string,
  taskKind: RunnerKind,
  channel: InternalizationChannel,
): PITaskRecord {
  return {
    taskId,
    taskKind,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    dependencyTaskIds: [],
    channel,
    timeoutMs: 60000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    rejectionCount: 0,
  };
}
