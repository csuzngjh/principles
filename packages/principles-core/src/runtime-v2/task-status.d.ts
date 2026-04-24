/**
 * Canonical task and run status types for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 12
 * Source: Diagnostician v2 Detailed Design, Section 7
 *
 * MIGRATION NOTE:
 *   - openclaw-plugin's QueueStatus ('in_progress', 'completed', 'canceled')
 *     is the LEGACY status model. New code uses PDTaskStatus.
 *   - principles-core's EvolutionTaskRecord.status (free-form string)
 *     will be migrated to PDTaskStatus in M2.
 *   - The new status model introduces 'leased' and 'retry_wait' which
 *     do not exist in the legacy model.
 */
import { type Static } from '@sinclair/typebox';
/**
 * The canonical task status model for PD Runtime v2.
 *
 * State transitions:
 *   pending → leased → succeeded
 *                     → retry_wait → pending (via lease expiry recovery)
 *                     → failed
 */
export declare const PDTaskStatusSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"pending">, import("@sinclair/typebox").TLiteral<"leased">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"retry_wait">, import("@sinclair/typebox").TLiteral<"failed">]>;
export type PDTaskStatus = Static<typeof PDTaskStatusSchema>;
export declare const TaskRecordSchema: import("@sinclair/typebox").TObject<{
    /** Unique task identifier. */
    taskId: import("@sinclair/typebox").TString;
    /** Kind of task (e.g., "diagnostician", "principle_candidate_intake"). */
    taskKind: import("@sinclair/typebox").TString;
    /** Current task status. */
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"pending">, import("@sinclair/typebox").TLiteral<"leased">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"retry_wait">, import("@sinclair/typebox").TLiteral<"failed">]>;
    /** ISO timestamp of task creation. */
    createdAt: import("@sinclair/typebox").TString;
    /** ISO timestamp of last status update. */
    updatedAt: import("@sinclair/typebox").TString;
    /** Current lease owner identifier. */
    leaseOwner: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** ISO timestamp when the current lease expires. */
    leaseExpiresAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Number of execution attempts made so far. */
    attemptCount: import("@sinclair/typebox").TInteger;
    /** Maximum number of attempts before forced failure. */
    maxAttempts: import("@sinclair/typebox").TInteger;
    /** Last error category, if the task is in a failure-related state. */
    lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"runtime_unavailable">, import("@sinclair/typebox").TLiteral<"capability_missing">, import("@sinclair/typebox").TLiteral<"input_invalid">, import("@sinclair/typebox").TLiteral<"lease_conflict">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"execution_failed">, import("@sinclair/typebox").TLiteral<"timeout">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"output_invalid">, import("@sinclair/typebox").TLiteral<"artifact_commit_failed">, import("@sinclair/typebox").TLiteral<"max_attempts_exceeded">, import("@sinclair/typebox").TLiteral<"context_assembly_failed">, import("@sinclair/typebox").TLiteral<"history_not_found">, import("@sinclair/typebox").TLiteral<"trajectory_ambiguous">, import("@sinclair/typebox").TLiteral<"storage_unavailable">, import("@sinclair/typebox").TLiteral<"workspace_invalid">, import("@sinclair/typebox").TLiteral<"query_invalid">]>>;
    /** Reference to the task's input data. */
    inputRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Reference to the task's result data. */
    resultRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type TaskRecord = Static<typeof TaskRecordSchema>;
export declare const DiagnosticianTaskRecordSchema: import("@sinclair/typebox").TIntersect<[import("@sinclair/typebox").TObject<{
    /** Unique task identifier. */
    taskId: import("@sinclair/typebox").TString;
    /** Kind of task (e.g., "diagnostician", "principle_candidate_intake"). */
    taskKind: import("@sinclair/typebox").TString;
    /** Current task status. */
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"pending">, import("@sinclair/typebox").TLiteral<"leased">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"retry_wait">, import("@sinclair/typebox").TLiteral<"failed">]>;
    /** ISO timestamp of task creation. */
    createdAt: import("@sinclair/typebox").TString;
    /** ISO timestamp of last status update. */
    updatedAt: import("@sinclair/typebox").TString;
    /** Current lease owner identifier. */
    leaseOwner: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** ISO timestamp when the current lease expires. */
    leaseExpiresAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Number of execution attempts made so far. */
    attemptCount: import("@sinclair/typebox").TInteger;
    /** Maximum number of attempts before forced failure. */
    maxAttempts: import("@sinclair/typebox").TInteger;
    /** Last error category, if the task is in a failure-related state. */
    lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"runtime_unavailable">, import("@sinclair/typebox").TLiteral<"capability_missing">, import("@sinclair/typebox").TLiteral<"input_invalid">, import("@sinclair/typebox").TLiteral<"lease_conflict">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"execution_failed">, import("@sinclair/typebox").TLiteral<"timeout">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"output_invalid">, import("@sinclair/typebox").TLiteral<"artifact_commit_failed">, import("@sinclair/typebox").TLiteral<"max_attempts_exceeded">, import("@sinclair/typebox").TLiteral<"context_assembly_failed">, import("@sinclair/typebox").TLiteral<"history_not_found">, import("@sinclair/typebox").TLiteral<"trajectory_ambiguous">, import("@sinclair/typebox").TLiteral<"storage_unavailable">, import("@sinclair/typebox").TLiteral<"workspace_invalid">, import("@sinclair/typebox").TLiteral<"query_invalid">]>>;
    /** Reference to the task's input data. */
    inputRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Reference to the task's result data. */
    resultRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>, import("@sinclair/typebox").TObject<{
    taskKind: import("@sinclair/typebox").TLiteral<"diagnostician">;
    /** Pain signal that triggered this diagnosis. */
    sourcePainId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Workspace directory for the diagnosis. */
    workspaceDir: import("@sinclair/typebox").TString;
    /** Severity hint from the pain signal. */
    severity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Source hint from the pain signal. */
    source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Session ID hint for context assembly. */
    sessionIdHint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Agent ID hint for context assembly. */
    agentIdHint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Human-readable summary of why this task was created. */
    reasonSummary: import("@sinclair/typebox").TString;
}>]>;
export type DiagnosticianTaskRecord = Static<typeof DiagnosticianTaskRecordSchema>;
//# sourceMappingURL=task-status.d.ts.map