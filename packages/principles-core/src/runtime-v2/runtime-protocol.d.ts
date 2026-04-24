/**
 * Canonical Runtime Protocol for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Sections 5-10, 10A
 * Source: PD Runtime-Agnostic Architecture v2, Sections 8-9
 *
 * This is the core decoupling layer between PD logic and external runtimes.
 * All adapters must implement PDRuntimeAdapter.
 */
import { type Static } from '@sinclair/typebox';
export declare const RuntimeKindSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>;
export type RuntimeKind = Static<typeof RuntimeKindSchema>;
export declare const RuntimeCapabilitiesSchema: import("@sinclair/typebox").TObject<{
    supportsStructuredJsonOutput: import("@sinclair/typebox").TBoolean;
    supportsToolUse: import("@sinclair/typebox").TBoolean;
    supportsWorkingDirectory: import("@sinclair/typebox").TBoolean;
    supportsModelSelection: import("@sinclair/typebox").TBoolean;
    supportsLongRunningSessions: import("@sinclair/typebox").TBoolean;
    supportsCancellation: import("@sinclair/typebox").TBoolean;
    supportsArtifactWriteBack: import("@sinclair/typebox").TBoolean;
    supportsConcurrentRuns: import("@sinclair/typebox").TBoolean;
    supportsStreaming: import("@sinclair/typebox").TBoolean;
    /** ISO timestamp when these capabilities were last probed. */
    capabilitiesValidUntil: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Dynamic capabilities that may vary per session or invocation. */
    dynamicCapabilities: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        toolsAvailable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        modelOptions: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    }>>;
}>;
export type RuntimeCapabilities = Static<typeof RuntimeCapabilitiesSchema>;
export declare const RuntimeHealthSchema: import("@sinclair/typebox").TObject<{
    /** Runtime is fully operational. */
    healthy: import("@sinclair/typebox").TBoolean;
    /** Runtime is usable but degraded; prefer alternatives. */
    degraded: import("@sinclair/typebox").TBoolean;
    /** Human-readable warning messages. */
    warnings: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    /** ISO timestamp of last health check. */
    lastCheckedAt: import("@sinclair/typebox").TString;
}>;
export type RuntimeHealth = Static<typeof RuntimeHealthSchema>;
export declare const RunHandleSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    runtimeKind: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>;
    startedAt: import("@sinclair/typebox").TString;
}>;
export type RunHandle = Static<typeof RunHandleSchema>;
export declare const RunExecutionStatusSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"queued">, import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"failed">, import("@sinclair/typebox").TLiteral<"timed_out">, import("@sinclair/typebox").TLiteral<"cancelled">]>;
export type RunExecutionStatus = Static<typeof RunExecutionStatusSchema>;
export declare const RunStatusSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"queued">, import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"failed">, import("@sinclair/typebox").TLiteral<"timed_out">, import("@sinclair/typebox").TLiteral<"cancelled">]>;
    startedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    endedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type RunStatus = Static<typeof RunStatusSchema>;
/**
 * Full run record used by SqliteRunStore.
 * Extends RunHandle with task linkage, attempt tracking, and payload fields.
 */
export declare const RunRecordSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    runtimeKind: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>;
    startedAt: import("@sinclair/typebox").TString;
    taskId: import("@sinclair/typebox").TString;
    attemptNumber: import("@sinclair/typebox").TInteger;
    executionStatus: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"queued">, import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"succeeded">, import("@sinclair/typebox").TLiteral<"failed">, import("@sinclair/typebox").TLiteral<"timed_out">, import("@sinclair/typebox").TLiteral<"cancelled">]>;
    endedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    outputRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    createdAt: import("@sinclair/typebox").TString;
    updatedAt: import("@sinclair/typebox").TString;
    inputPayload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    outputPayload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    errorCategory: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"runtime_unavailable">, import("@sinclair/typebox").TLiteral<"capability_missing">, import("@sinclair/typebox").TLiteral<"input_invalid">, import("@sinclair/typebox").TLiteral<"lease_conflict">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"execution_failed">, import("@sinclair/typebox").TLiteral<"timeout">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"output_invalid">, import("@sinclair/typebox").TLiteral<"artifact_commit_failed">, import("@sinclair/typebox").TLiteral<"max_attempts_exceeded">, import("@sinclair/typebox").TLiteral<"context_assembly_failed">, import("@sinclair/typebox").TLiteral<"history_not_found">, import("@sinclair/typebox").TLiteral<"trajectory_ambiguous">, import("@sinclair/typebox").TLiteral<"storage_unavailable">, import("@sinclair/typebox").TLiteral<"workspace_invalid">, import("@sinclair/typebox").TLiteral<"query_invalid">]>>;
}>;
export type RunRecord = Static<typeof RunRecordSchema>;
export declare const ContextItemSchema: import("@sinclair/typebox").TObject<{
    role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"system">, import("@sinclair/typebox").TLiteral<"tool">]>;
    content: import("@sinclair/typebox").TString;
}>;
export type ContextItem = Static<typeof ContextItemSchema>;
export declare const AgentSpecRefSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    schemaVersion: import("@sinclair/typebox").TString;
}>;
export type AgentSpecRef = Static<typeof AgentSpecRefSchema>;
export declare const WorkflowRefSchema: import("@sinclair/typebox").TObject<{
    workflowId: import("@sinclair/typebox").TString;
}>;
export type WorkflowRef = Static<typeof WorkflowRefSchema>;
export declare const TaskRefSchema: import("@sinclair/typebox").TObject<{
    taskId: import("@sinclair/typebox").TString;
}>;
export type TaskRef = Static<typeof TaskRefSchema>;
export declare const StartRunInputSchema: import("@sinclair/typebox").TObject<{
    agentSpec: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        schemaVersion: import("@sinclair/typebox").TString;
    }>;
    workflowRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        workflowId: import("@sinclair/typebox").TString;
    }>>;
    taskRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        taskId: import("@sinclair/typebox").TString;
    }>>;
    inputPayload: import("@sinclair/typebox").TUnknown;
    contextItems: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        role: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"user">, import("@sinclair/typebox").TLiteral<"system">, import("@sinclair/typebox").TLiteral<"tool">]>;
        content: import("@sinclair/typebox").TString;
    }>>;
    outputSchemaRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    artifactContractRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeoutMs: import("@sinclair/typebox").TNumber;
    idempotencyKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    preferredModel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    preferredRuntimeProfile: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type StartRunInput = Static<typeof StartRunInputSchema>;
export declare const StructuredRunOutputSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    payload: import("@sinclair/typebox").TUnknown;
}>;
export type StructuredRunOutput = Static<typeof StructuredRunOutputSchema>;
export declare const RuntimeArtifactRefSchema: import("@sinclair/typebox").TObject<{
    artifactType: import("@sinclair/typebox").TString;
    ref: import("@sinclair/typebox").TString;
}>;
export type RuntimeArtifactRef = Static<typeof RuntimeArtifactRefSchema>;
/**
 * The canonical runtime adapter interface.
 *
 * Every supported runtime (OpenClaw, Codex CLI, Gemini CLI, etc.)
 * must implement this interface.
 *
 * Adapters MUST NOT:
 *   - commit PD artifacts directly into PD stores
 *   - mutate task status directly
 *   - leak host-specific state into PD core
 */
export interface PDRuntimeAdapter {
    /** Identify which runtime this adapter wraps. */
    kind(): RuntimeKind;
    /** Probe the runtime's current capabilities. */
    getCapabilities(): Promise<RuntimeCapabilities>;
    /** Re-probe capabilities (optional, for runtimes with dynamic capabilities). */
    refreshCapabilities?(): Promise<RuntimeCapabilities>;
    /** Check runtime health. */
    healthCheck(): Promise<RuntimeHealth>;
    /** Start a new run. */
    startRun(input: StartRunInput): Promise<RunHandle>;
    /** Poll the status of an existing run. */
    pollRun(runId: string): Promise<RunStatus>;
    /** Cancel a running execution. */
    cancelRun(runId: string): Promise<void>;
    /** Fetch structured output from a completed run. */
    fetchOutput(runId: string): Promise<StructuredRunOutput | null>;
    /** Fetch artifact references produced by a run. */
    fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]>;
    /** Append additional context to an in-progress run (optional). */
    appendContext?(runId: string, items: ContextItem[]): Promise<void>;
}
//# sourceMappingURL=runtime-protocol.d.ts.map