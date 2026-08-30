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
import type { RepairPayload, RunnerDecision, RolloutRevisionPayload, RunnerCompletionIntent, HumanReviewContext, OwnerResolutionRecord } from './pitask-metadata.js';

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
  /** Evaluator repair payload (PRI-509); present only on artificer repair tasks. */
  repairPayload?: RepairPayload;
  /** Runner decision (evaluator/rollout_reviewer LLM verdict) — transition control (INV-02). */
  runnerDecision?: RunnerDecision;
  /** Times this task has been reopened for revision (bounded revision budget). */
  revisionCount?: number;
  /** Feedback injected when this task is reopened by rollout needs_revision routing. */
  revisionFeedback?: string;
  /** P0-4 stable revision identity — same-cause reopen replays are no-ops. */
  revisionCauseId?: string;
  /** Rollout needs_revision routing payload; present on rollout_reviewer tasks that routed a revision. */
  rolloutRevisionPayload?: RolloutRevisionPayload;
  /**
   * P0 (verdict drift): durable completion intent of one LLM verdict. Pending
   * intent in the same revision epoch is the recovery authority — re-runs
   * resume it instead of re-invoking the LLM. See pitask-metadata.ts.
   */
  completionIntent?: RunnerCompletionIntent;
  /** PRI-629: structured context written atomically with needs_human_review. */
  humanReviewContext?: HumanReviewContext;
  /** PRI-629: task-scoped Owner resolution log (append-only; not a state source). */
  ownerResolutions?: readonly OwnerResolutionRecord[];
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

/** Top-level lineage field the runner owns, with its authoritative value. */
export interface LineageEchoFieldRule {
  field: string;
  authoritativeValue: string;
}

/** Nested trace object reconciliation (e.g. sourceTrace.evaluatorArtifactId). */
export interface LineageEchoTraceRule {
  /** Object field name on the output, e.g. 'sourceTrace'. */
  traceField: string;
  fields: LineageEchoFieldRule[];
}

/**
 * Shared lineage echo gate for peer runners (PRI-541 / ERR-004 / ERR-008).
 *
 * LLMs routinely truncate or alter long IDs when echoing runner-owned lineage
 * back (taskId, source*ArtifactId, sourceTrace.*). A mismatch is classified
 * `output_invalid` — a permanent error with no retry — dead-ending the
 * candidate before it can reach the approval queue. Lineage is runner-owned
 * metadata (rc-6): the task record and the artifact store read in
 * buildContext() are the single source of truth, so a corrupted echo of a
 * known value is corrected rather than trusted.
 *
 * Two distinct cases, handled by two distinct mechanisms:
 *   1. ABSENT field → injectRunnerLineageIfAbsent semantics (ERR-049 / rc-3:
 *      present-but-falsy values are left untouched to fail loud in the
 *      validator).
 *   2. PRESENT but wrong echo → overwrite with the authoritative value.
 *
 * Pure logic, zero I/O. Returns the list of corrected field names; the caller
 * MUST emit telemetry when non-empty (rc-9-no-silent-fallback), typically as
 * `<runner>_lineage_echo_corrected`.
 *
 * @param output  The parsed LLM output (untrusted — may be any shape).
 * @param rules   Authoritative top-level fields and optional trace rule.
 * @returns Names of fields that were injected or corrected.
 */
export function reconcileLineageEcho(
  output: unknown,
  rules: { topFields?: LineageEchoFieldRule[]; trace?: LineageEchoTraceRule },
): string[] {
  const correctedFields: string[] = [];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return correctedFields;
  }
  const record = output as Record<string, unknown>;

  for (const rule of rules.topFields ?? []) {
    if (!Object.hasOwn(record, rule.field)) {
      injectRunnerLineageIfAbsent(record, rule.field, rule.authoritativeValue);
      continue;
    }
    if (record[rule.field] !== rule.authoritativeValue) {
      record[rule.field] = rule.authoritativeValue;
      correctedFields.push(rule.field);
    }
  }

  if (rules.trace) {
    const { traceField, fields } = rules.trace;
    const trace = record[traceField];
    if (trace !== null && typeof trace === 'object' && !Array.isArray(trace)) {
      const traceRecord = trace as Record<string, unknown>;
      for (const field of fields) {
        if (traceRecord[field.field] !== field.authoritativeValue) {
          traceRecord[field.field] = field.authoritativeValue;
          correctedFields.push(`${traceField}.${field.field}`);
        }
      }
    } else {
      // Trace absent or malformed — inject the minimal required object so
      // structural validation has the required lineage fields.
      const injected: Record<string, string> = {};
      for (const field of fields) {
        injected[field.field] = field.authoritativeValue;
      }
      record[traceField] = injected;
      correctedFields.push(traceField);
    }
  }

  return correctedFields;
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
