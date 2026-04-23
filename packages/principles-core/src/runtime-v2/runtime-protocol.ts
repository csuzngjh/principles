/**
 * Canonical Runtime Protocol for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Sections 5-10, 10A
 * Source: PD Runtime-Agnostic Architecture v2, Sections 8-9
 *
 * This is the core decoupling layer between PD logic and external runtimes.
 * All adapters must implement PDRuntimeAdapter.
 */
import { Type, type Static } from '@sinclair/typebox';
import { PDErrorCategorySchema } from './error-categories.js';

// ── Runtime Kind ──

export const RuntimeKindSchema = Type.Union([
  Type.Literal('openclaw'),
  Type.Literal('openclaw-history'), // compatibility import from OpenClaw trajectory.db
  Type.Literal('claude-cli'),
  Type.Literal('codex-cli'),
  Type.Literal('gemini-cli'),
  Type.Literal('local-worker'),
  Type.Literal('test-double'),
]);
 
export type RuntimeKind = Static<typeof RuntimeKindSchema>;

// ── Runtime Capabilities ──

export const RuntimeCapabilitiesSchema = Type.Object({
  supportsStructuredJsonOutput: Type.Boolean(),
  supportsToolUse: Type.Boolean(),
  supportsWorkingDirectory: Type.Boolean(),
  supportsModelSelection: Type.Boolean(),
  supportsLongRunningSessions: Type.Boolean(),
  supportsCancellation: Type.Boolean(),
  supportsArtifactWriteBack: Type.Boolean(),
  supportsConcurrentRuns: Type.Boolean(),
  supportsStreaming: Type.Boolean(),
  /** ISO timestamp when these capabilities were last probed. */
  capabilitiesValidUntil: Type.Optional(Type.String()),
  /** Dynamic capabilities that may vary per session or invocation. */
  dynamicCapabilities: Type.Optional(Type.Object({
    toolsAvailable: Type.Optional(Type.Array(Type.String())),
    modelOptions: Type.Optional(Type.Array(Type.String())),
  })),
});
export type RuntimeCapabilities = Static<typeof RuntimeCapabilitiesSchema>;

// ── Runtime Health ──

export const RuntimeHealthSchema = Type.Object({
  /** Runtime is fully operational. */
  healthy: Type.Boolean(),
  /** Runtime is usable but degraded; prefer alternatives. */
  degraded: Type.Boolean(),
  /** Human-readable warning messages. */
  warnings: Type.Array(Type.String()),
  /** ISO timestamp of last health check. */
  lastCheckedAt: Type.String(),
});
export type RuntimeHealth = Static<typeof RuntimeHealthSchema>;

// ── Run Lifecycle ──

export const RunHandleSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  runtimeKind: RuntimeKindSchema,
  startedAt: Type.String(),
});
export type RunHandle = Static<typeof RunHandleSchema>;

export const RunExecutionStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('timed_out'),
  Type.Literal('cancelled'),
]);
export type RunExecutionStatus = Static<typeof RunExecutionStatusSchema>;

export const RunStatusSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  status: RunExecutionStatusSchema,
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});
export type RunStatus = Static<typeof RunStatusSchema>;

/**
 * Full run record used by SqliteRunStore.
 * Extends RunHandle with task linkage, attempt tracking, and payload fields.
 */
export const RunRecordSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  runtimeKind: RuntimeKindSchema,
  startedAt: Type.String(),
  taskId: Type.String({ minLength: 1 }),
  attemptNumber: Type.Integer({ minimum: 0 }),
  executionStatus: RunExecutionStatusSchema,
  endedAt: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  outputRef: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  inputPayload: Type.Optional(Type.String()),
  outputPayload: Type.Optional(Type.String()),
  errorCategory: Type.Optional(PDErrorCategorySchema),
});
export type RunRecord = Static<typeof RunRecordSchema>;

// ── Context Item (for runtime context injection) ──

export const ContextItemSchema = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('system'), Type.Literal('tool')]),
  content: Type.String(),
});
export type ContextItem = Static<typeof ContextItemSchema>;

// ── References (lightweight refs, not full objects) ──

export const AgentSpecRefSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  schemaVersion: Type.String({ minLength: 1 }),
});
export type AgentSpecRef = Static<typeof AgentSpecRefSchema>;

export const WorkflowRefSchema = Type.Object({ workflowId: Type.String({ minLength: 1 }) });
export type WorkflowRef = Static<typeof WorkflowRefSchema>;

export const TaskRefSchema = Type.Object({ taskId: Type.String({ minLength: 1 }) });
export type TaskRef = Static<typeof TaskRefSchema>;

// ── StartRunInput ──

export const StartRunInputSchema = Type.Object({
  agentSpec: AgentSpecRefSchema,
  workflowRef: Type.Optional(WorkflowRefSchema),
  taskRef: Type.Optional(TaskRefSchema),
  inputPayload: Type.Unknown(),
  contextItems: Type.Array(ContextItemSchema),
  outputSchemaRef: Type.Optional(Type.String()),
  artifactContractRef: Type.Optional(Type.String()),
  timeoutMs: Type.Number({ minimum: 0 }),
  idempotencyKey: Type.Optional(Type.String()),
  preferredModel: Type.Optional(Type.String()),
  preferredRuntimeProfile: Type.Optional(Type.String()),
});
export type StartRunInput = Static<typeof StartRunInputSchema>;

// ── Run Output ──

export const StructuredRunOutputSchema = Type.Object({
  runId: Type.String(),
  payload: Type.Unknown(),
});
export type StructuredRunOutput = Static<typeof StructuredRunOutputSchema>;

export const RuntimeArtifactRefSchema = Type.Object({
  artifactType: Type.String(),
  ref: Type.String(),
});
export type RuntimeArtifactRef = Static<typeof RuntimeArtifactRefSchema>;

// ── PDRuntimeAdapter ──

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
